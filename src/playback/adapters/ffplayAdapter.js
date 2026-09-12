import { spawn, spawnSync } from 'node:child_process';
import { AudioAdapter } from './base.js';
import { PlaybackError } from '../../core/errors.js';
import { clampInt } from '../../core/util.js';

/**
 * Matches ffplay's `-stats` line, e.g.
 *   `  12.34 M-A:  0.000 fd=   0 aq=   17KB vq=    0KB sq=    0B`
 * The leading number is the decoder's absolute position in seconds and already
 * accounts for `-ss`, so it can be used directly.
 */
const STATS_LINE = /^\s*(\d+(?:\.\d+)?)\s+[MA]-[AV]:/;

/**
 * ffplay backend - the default on machines with FFmpeg installed.
 *
 * ffplay has no runtime control channel, so pause/seek/volume are implemented
 * by stopping the process and respawning it at the exact position with `-ss`.
 * That is deterministic and gives sample-accurate resume; the cost is a short
 * re-buffer, which is surfaced as a `buffering` event rather than hidden.
 *
 * (SIGSTOP was measured first and rejected: ffplay resyncs to its external
 * clock on SIGCONT and skips forward by the paused duration.)
 */
export class FfplayAdapter extends AudioAdapter {
  static id = 'ffplay';
  static label = 'ffplay';

  static isAvailable() {
    return probe('ffplay');
  }

  #child = null;
  #generation = 0;
  #position = 0;
  #volume = 70;
  #source = null;
  #state = 'idle';
  #stderrTail = '';
  #stopping = false;
  #logger;
  #spawnFn;

  constructor({ logger, spawnFn } = {}) {
    super();
    this.#logger = logger ?? null;
    this.#spawnFn = spawnFn ?? spawn;
  }

  get capabilities() {
    return {
      remoteStreams: true,
      seek: true,
      volume: true,
      // Pause is exact, but implemented by restart rather than a true hold.
      truePause: false,
      position: true,
    };
  }

  get position() {
    return this.#position;
  }

  get state() {
    return this.#state;
  }

  async play(source, { startAt = 0, volume } = {}) {
    if (volume != null) this.#volume = clampInt(volume, 0, 100);
    this.#source = source;
    this.#position = Math.max(0, startAt);
    await this.#spawnAt(this.#position);
  }

  async pause() {
    if (this.#state !== 'playing') return;
    const at = this.#position;
    await this.#kill();
    this.#position = at;
    this.#state = 'paused';
  }

  async resume() {
    if (this.#state !== 'paused' || !this.#source) return;
    await this.#spawnAt(this.#position);
  }

  async stop() {
    await this.#kill();
    this.#state = 'idle';
    this.#position = 0;
    this.#source = null;
  }

  async seek(seconds) {
    const target = Math.max(0, seconds);
    this.#position = target;
    if (this.#state === 'playing') await this.#spawnAt(target);
    else this.emit('position', { seconds: target });
  }

  async setVolume(volume) {
    this.#volume = clampInt(volume, 0, 100);
    // ffplay only reads -volume at startup, so a live change means a restart.
    if (this.#state === 'playing') await this.#spawnAt(this.#position);
  }

  async #spawnAt(seconds) {
    await this.#kill();
    if (!this.#source) return;

    const generation = ++this.#generation;
    const args = [
      '-nodisp',
      '-autoexit',
      '-hide_banner',
      '-loglevel',
      'info',
      '-stats',
      '-volume',
      String(this.#volume),
    ];
    if (seconds > 0.05) args.push('-ss', String(seconds.toFixed(2)));
    if (this.#source.kind === 'url') {
      // Bounded reconnects so a blip does not kill a long stream, and a
      // 15s open timeout instead of hanging forever on a dead host.
      args.push(
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '4',
        '-rw_timeout',
        '15000000',
        '-user_agent',
        'Termify/1.0',
      );
    }
    args.push('-i', this.#source.value);

    this.#stderrTail = '';
    this.#state = 'playing';
    this.#position = seconds;
    this.emit('buffering', { buffering: true });

    let child;
    try {
      // argv array, never a shell: user-controlled paths and URLs are data.
      child = this.#spawnFn('ffplay', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      this.#state = 'idle';
      this.emit('buffering', { buffering: false });
      this.emit(
        'error',
        new PlaybackError(`could not start ffplay: ${error.message}`, {
          userMessage: 'Could not start the audio backend',
          hint: 'Install FFmpeg (brew install ffmpeg) or pick another backend in Settings.',
          cause: error,
        }),
      );
      return;
    }

    this.#child = child;
    let sawPosition = false;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (generation !== this.#generation) return;
      this.#stderrTail = (this.#stderrTail + chunk).slice(-2000);
      // ffplay rewrites the stats line with \r, so split on both.
      for (const line of chunk.split(/[\r\n]+/)) {
        const match = STATS_LINE.exec(line);
        if (!match) continue;
        const value = Number.parseFloat(match[1]);
        if (!Number.isFinite(value)) continue;
        if (!sawPosition) {
          sawPosition = true;
          this.emit('buffering', { buffering: false });
        }
        this.#position = value;
        this.emit('position', { seconds: value });
      }
    });

    child.on('error', (error) => {
      if (generation !== this.#generation) return;
      this.#state = 'idle';
      this.emit('buffering', { buffering: false });
      this.emit(
        'error',
        new PlaybackError(`ffplay failed: ${error.message}`, {
          userMessage: 'Audio backend failed to start',
          hint: 'Check that ffplay is installed and on your PATH.',
          cause: error,
        }),
      );
    });

    child.on('close', (code, signal) => {
      if (generation !== this.#generation) return;
      this.#child = null;
      this.emit('buffering', { buffering: false });
      if (this.#stopping || signal) return; // deliberate stop/restart
      if (code === 0) {
        this.#state = 'idle';
        this.emit('ended', { seconds: this.#position });
        return;
      }
      this.#state = 'idle';
      this.emit('error', this.#exitError(code));
    });
  }

  #exitError(code) {
    const tail = this.#stderrTail
      .split(/[\r\n]+/)
      .filter(Boolean)
      .slice(-3)
      .join(' / ');
    const offline =
      /Input\/output error|Connection refused|Name or service not known|Server returned|Protocol not found|No route to host/i.test(
        tail,
      );
    this.#logger?.warn('ffplay exited with error', { code, tail });
    return new PlaybackError(`ffplay exited with code ${code}: ${tail}`, {
      userMessage: offline ? 'Could not reach the audio stream' : 'Playback failed for this track',
      hint: offline
        ? 'The source may be offline or the link expired. Try another track.'
        : 'Skipping to the next track usually recovers.',
      retryable: true,
    });
  }

  async #kill() {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    this.#child = null;
    this.#generation += 1; // orphan any late events from this process
    await new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 1200);
      child.once('close', () => {
        clearTimeout(timer);
        done();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        done();
      }
    });
    this.#stopping = false;
  }

  async dispose() {
    await this.#kill();
    this.#state = 'idle';
    this.removeAllListeners();
  }
}

/** Is `binary` on PATH? Cached per process. */
const probeCache = new Map();
export function probe(binary) {
  if (probeCache.has(binary)) return probeCache.get(binary);
  let ok = false;
  try {
    const result = spawnSync(binary, ['-version'], { stdio: 'ignore', timeout: 4000 });
    ok = result.status === 0 || result.status === 1;
    if (result.error) ok = false;
  } catch {
    ok = false;
  }
  probeCache.set(binary, ok);
  return ok;
}
