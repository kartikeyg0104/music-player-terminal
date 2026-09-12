import { spawn } from 'node:child_process';
import { Emitter } from '../core/events.js';
import { probe } from './adapters/ffplayAdapter.js';

/**
 * Real audio level analysis.
 *
 * Runs a second, silent ffmpeg pass over the *same local file* at native rate
 * (`-re`) and reads per-window RMS out of the `astats` filter. Those are
 * genuine measurements of the audio, so the `levels` visualiser mode shows
 * real data - unlike the decorative mode, which never claims to.
 *
 * Restricted to local files on purpose: a second pass over a network stream
 * would double bandwidth and drift out of sync with playback, which would
 * make the display wrong rather than merely decorative.
 */
export class LevelAnalyser extends Emitter {
  #child = null;
  #values = [];
  #window = 28;
  #logger;
  #source = null;

  constructor({ logger, windowSize = 28 } = {}) {
    super();
    this.#logger = logger;
    this.#window = windowSize;
  }

  static isAvailable() {
    return probe('ffmpeg');
  }

  get state() {
    if (!this.#source) {
      return { available: false, values: [], reason: 'analysis idle' };
    }
    if (!this.#values.length) {
      return { available: false, values: [], reason: 'measuring...' };
    }
    return { available: true, values: [...this.#values], reason: null };
  }

  /**
   * @param {{kind: 'file'|'url', value: string}} source
   * @param {number} startAt seconds
   */
  start(source, startAt = 0) {
    this.stop();
    if (!source || source.kind !== 'file') {
      this.#source = null;
      this.emit('change', {
        available: false,
        values: [],
        reason: 'real analysis needs a local file',
      });
      return false;
    }
    if (!LevelAnalyser.isAvailable()) {
      this.#source = null;
      this.emit('change', { available: false, values: [], reason: 'ffmpeg not installed' });
      return false;
    }

    this.#source = source;
    this.#values = [];

    const args = [
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'error',
      '-re', // decode at playback speed so levels track what you hear
      '-ss',
      String(Math.max(0, startAt).toFixed(2)),
      '-i',
      source.value,
      '-af',
      'asetnsamples=n=2048,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f',
      'null',
      '-',
    ];

    // argv array; `source.value` is a verified local path, never shell input.
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.#child = child;

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = /RMS_level=(-?\d+(?:\.\d+)?|-inf)/.exec(line);
        if (!match) continue;
        this.#push(match[1] === '-inf' ? 0 : dbToUnit(Number(match[1])));
      }
    });
    child.on('error', (error) => {
      this.#logger?.debug('level analyser failed', { error: error.message });
      this.#source = null;
      this.emit('change', { available: false, values: [], reason: 'analysis unavailable' });
    });
    child.on('close', () => {
      this.#child = null;
    });
    return true;
  }

  #push(value) {
    this.#values.push(value);
    if (this.#values.length > this.#window) this.#values.shift();
    this.emit('change', this.state);
  }

  stop() {
    if (this.#child) {
      try {
        this.#child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.#child = null;
    }
    this.#values = [];
    this.#source = null;
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }
}

/** Map dBFS (roughly -60..0) onto 0..1. */
function dbToUnit(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
