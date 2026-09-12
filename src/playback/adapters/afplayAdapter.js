import { spawn, spawnSync } from 'node:child_process';
import { AudioAdapter } from './base.js';
import { PlaybackError } from '../../core/errors.js';
import { clampInt } from '../../core/util.js';

/**
 * macOS `afplay` backend - the last resort.
 *
 * afplay ships with macOS so it always works, but it can only play *local
 * files*, reports no position, and has no pause. Termify therefore:
 *   - refuses remote URLs here (the engine checks `capabilities.remoteStreams`)
 *   - estimates position from wall-clock, and says so in the UI
 *   - implements pause as stop + restart from the estimated offset
 *
 * It exists so a Mac with no FFmpeg can still play a local library.
 */
export class AfplayAdapter extends AudioAdapter {
  static id = 'afplay';
  static label = 'afplay (local files only)';

  static isAvailable() {
    if (process.platform !== 'darwin') return false;
    try {
      const result = spawnSync('afplay', ['--help'], { stdio: 'ignore', timeout: 4000 });
      return !result.error;
    } catch {
      return false;
    }
  }

  #child = null;
  #generation = 0;
  #source = null;
  #volume = 70;
  #offset = 0;
  #startedAt = 0;
  #ticker = null;
  #state = 'idle';
  #stopping = false;

  get capabilities() {
    return {
      remoteStreams: false,
      seek: true,
      volume: true,
      truePause: false,
      // Wall-clock estimate, not a decoder position - flagged for the UI.
      position: false,
    };
  }

  get position() {
    if (this.#state !== 'playing') return this.#offset;
    return this.#offset + (Date.now() - this.#startedAt) / 1000;
  }

  async play(source, { startAt = 0, volume } = {}) {
    if (source.kind !== 'file') {
      throw new PlaybackError('afplay cannot play remote streams', {
        userMessage: 'This backend only plays local files',
        hint: 'Install FFmpeg or mpv to stream online music.',
      });
    }
    if (volume != null) this.#volume = clampInt(volume, 0, 100);
    this.#source = source;
    this.#offset = Math.max(0, startAt);
    await this.#spawn();
  }

  async pause() {
    if (this.#state !== 'playing') return;
    const at = this.position;
    await this.#kill();
    this.#offset = at;
    this.#state = 'paused';
  }

  async resume() {
    if (this.#state !== 'paused' || !this.#source) return;
    await this.#spawn();
  }

  async stop() {
    await this.#kill();
    this.#state = 'idle';
    this.#offset = 0;
    this.#source = null;
  }

  async seek(seconds) {
    this.#offset = Math.max(0, seconds);
    if (this.#state === 'playing') await this.#spawn();
    else this.emit('position', { seconds: this.#offset });
  }

  async setVolume(volume) {
    this.#volume = clampInt(volume, 0, 100);
    if (this.#state === 'playing') {
      const at = this.position;
      this.#offset = at;
      await this.#spawn();
    }
  }

  async #spawn() {
    await this.#kill();
    if (!this.#source) return;
    const generation = ++this.#generation;
    // afplay has no seek flag. Rather than silently ignoring an offset, we
    // tell the engine the request could not be honoured and start from zero.
    if (this.#offset > 0.05) {
      this.emit('warning', {
        message: 'afplay cannot seek; restarting this track from the beginning.',
      });
      this.#offset = 0;
    }

    this.#state = 'playing';
    this.#startedAt = Date.now();
    this.emit('buffering', { buffering: false });

    // -v is a linear gain multiplier, not a percentage. argv array, no shell.
    const args = ['-v', (this.#volume / 100).toFixed(3), this.#source.value];
    const child = spawn('afplay', args, { stdio: 'ignore' });
    this.#child = child;

    child.on('error', (error) => {
      if (generation !== this.#generation) return;
      this.#state = 'idle';
      this.emit(
        'error',
        new PlaybackError(`afplay failed: ${error.message}`, {
          userMessage: 'Playback failed',
          cause: error,
        }),
      );
    });
    child.on('close', (code, signal) => {
      if (generation !== this.#generation) return;
      this.#child = null;
      this.#stopTicker();
      if (this.#stopping || signal) return;
      this.#state = 'idle';
      if (code === 0) this.emit('ended', { seconds: this.position });
      else {
        this.emit(
          'error',
          new PlaybackError(`afplay exited with code ${code}`, {
            userMessage: 'Could not play this file',
            hint: 'The format may be unsupported by afplay.',
            retryable: true,
          }),
        );
      }
    });

    this.#startTicker();
  }

  #startTicker() {
    this.#stopTicker();
    this.#ticker = setInterval(() => {
      this.emit('position', { seconds: this.position, estimated: true });
    }, 500);
    this.#ticker.unref?.();
  }

  #stopTicker() {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
  }

  async #kill() {
    this.#stopTicker();
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    this.#child = null;
    this.#generation += 1;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, 800);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
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
