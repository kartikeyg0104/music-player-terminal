import { Emitter } from '../../core/events.js';

/**
 * Contract for an audio backend.
 *
 * The playback engine owns *what* plays; an adapter owns *how* it is made
 * audible. Adapters emit:
 *
 *   'position'  { seconds }     real decoder position, not a wall-clock guess
 *   'buffering' { buffering }   backend is loading/seeking
 *   'ended'     {}              the source played to completion
 *   'error'     Error           playback failed for this source
 *
 * Every adapter must be safe to `stop()` twice and must never leave a child
 * process behind.
 */
export class AudioAdapter extends Emitter {
  static id = 'base';

  /** Human name for the status bar. */
  static label = 'Base';

  /** Is the underlying binary present on this machine? */
  static isAvailable() {
    return false;
  }

  get id() {
    return /** @type {typeof AudioAdapter} */ (this.constructor).id;
  }

  get label() {
    return /** @type {typeof AudioAdapter} */ (this.constructor).label;
  }

  /** What this backend can actually do, so the UI can grey out the rest. */
  get capabilities() {
    return {
      remoteStreams: false,
      seek: false,
      volume: false,
      truePause: false,
      position: false,
    };
  }

  /**
   * Start playing a source from `startAt` seconds.
   * @param {{kind: 'file'|'url', value: string}} _source
   * @param {{startAt?: number, volume?: number}} [_options]
   * @returns {Promise<void>}
   */
  async play(_source, _options) {
    throw new Error(`${this.id}: play() not implemented`);
  }

  /** @returns {Promise<void>} */
  async pause() {}

  /** @returns {Promise<void>} */
  async resume() {}

  /** @returns {Promise<void>} */
  async stop() {}

  /** @param {number} _seconds absolute position */
  async seek(_seconds) {}

  /** @param {number} _volume 0-100 */
  async setVolume(_volume) {}

  /** Last known position in seconds. */
  get position() {
    return 0;
  }

  /** Release every OS resource. Must be idempotent. */
  async dispose() {
    await this.stop();
    this.removeAllListeners();
  }
}
