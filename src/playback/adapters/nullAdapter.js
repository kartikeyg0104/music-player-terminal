import { AudioAdapter } from './base.js';

/**
 * Silent adapter.
 *
 * Two jobs:
 *  - deterministic fake for the test suite (drive time with `advance()`)
 *  - honest degradation when no audio binary exists on the machine, where it
 *    is labelled "no audio backend" so the UI never implies sound is playing
 *
 * It advances position with a real timer so auto-advance and progress logic
 * behave exactly as they do with a real backend.
 */
export class NullAdapter extends AudioAdapter {
  static id = 'null';
  static label = 'no audio backend';

  static isAvailable() {
    return true;
  }

  #position = 0;
  #duration = 0;
  #timer = null;
  #state = 'idle';
  #tickMs;
  #autoTick;

  /**
   * @param {{ autoTick?: boolean, tickMs?: number }} [options]
   *   `autoTick: false` makes the adapter fully deterministic for tests.
   */
  constructor({ autoTick = true, tickMs = 500 } = {}) {
    super();
    this.#autoTick = autoTick;
    this.#tickMs = tickMs;
  }

  get capabilities() {
    return { remoteStreams: true, seek: true, volume: true, truePause: true, position: true };
  }

  get position() {
    return this.#position;
  }

  get state() {
    return this.#state;
  }

  async play(source, { startAt = 0, duration = 0 } = {}) {
    this.#position = startAt;
    this.#duration = duration || source?.duration || 0;
    this.#state = 'playing';
    this.emit('buffering', { buffering: false });
    this.emit('position', { seconds: this.#position });
    this.#startTimer();
  }

  async pause() {
    this.#state = 'paused';
    this.#stopTimer();
  }

  async resume() {
    if (this.#state !== 'paused') return;
    this.#state = 'playing';
    this.#startTimer();
  }

  async stop() {
    this.#state = 'idle';
    this.#position = 0;
    this.#stopTimer();
  }

  async seek(seconds) {
    this.#position = Math.max(0, seconds);
    this.emit('position', { seconds: this.#position });
  }

  async setVolume() {}

  /** Test hook: move time forward without waiting. */
  advance(seconds) {
    this.#position += seconds;
    this.emit('position', { seconds: this.#position });
    if (this.#duration && this.#position >= this.#duration) {
      this.#state = 'idle';
      this.#stopTimer();
      this.emit('ended', { seconds: this.#position });
    }
  }

  /** Test hook: fail the current source. */
  fail(error) {
    this.#state = 'idle';
    this.#stopTimer();
    this.emit('error', error);
  }

  #startTimer() {
    if (!this.#autoTick) return;
    this.#stopTimer();
    this.#timer = setInterval(() => this.advance(this.#tickMs / 1000), this.#tickMs);
    this.#timer.unref?.();
  }

  #stopTimer() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async dispose() {
    this.#stopTimer();
    this.removeAllListeners();
  }
}
