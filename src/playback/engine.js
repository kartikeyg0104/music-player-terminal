import { Emitter } from '../core/events.js';
import { Queue } from './queue.js';
import { PlaybackError, toUserMessage } from '../core/errors.js';
import { clampInt } from '../core/util.js';
import { isPlayable, playbackSource } from '../core/track.js';

/**
 * Playback states. Transitions are explicit so the UI never has to guess.
 *
 *   idle --play--> loading --> playing <--> paused
 *                     |            |
 *                     +--error-----+--> error --(next/retry)--> loading
 */
export const PLAYBACK_STATE = /** @type {const} */ ({
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error',
});

/** Pressing "previous" past this point restarts the track instead. */
const RESTART_THRESHOLD_SECONDS = 4;
/** Consecutive failures before we stop auto-skipping and ask the user. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Orchestrates queue + provider + audio adapter.
 *
 * Deliberately knows nothing about React: it exposes a plain immutable state
 * object and a 'change' event. Every async edge (a late 'ended' from a track
 * we already skipped, a resolve that finishes after the user moved on) is
 * guarded by a monotonically increasing `#epoch`.
 */
export class PlaybackEngine extends Emitter {
  #adapter;
  #registry;
  #history;
  #settings;
  #logger;
  #queue;

  #state = PLAYBACK_STATE.IDLE;
  #position = 0;
  #duration = null;
  #buffering = false;
  #volume = 70;
  #error = null;
  #epoch = 0;
  #listenedSeconds = 0;
  #lastPositionAt = 0;
  #consecutiveFailures = 0;
  #sleepTimer = null;
  #unsubscribers = [];
  #disposed = false;
  #positionEstimated = false;
  /**
   * The current track after the provider re-resolved it. The queue keeps the
   * original (stable ids, no expiring URLs); the UI wants the resolved copy so
   * artwork, duration and availability reflect what is actually playing.
   */
  #resolved = null;

  /**
   * @param {object} deps
   * @param {import('./adapters/base.js').AudioAdapter} deps.adapter
   * @param {import('../providers/registry.js').ProviderRegistry} deps.registry
   * @param {import('../services/historyService.js').HistoryService} deps.history
   * @param {import('../services/settingsService.js').SettingsService} deps.settings
   */
  constructor({ adapter, registry, history, settings, logger, random }) {
    super();
    this.#adapter = adapter;
    this.#registry = registry;
    this.#history = history;
    this.#settings = settings;
    this.#logger = logger ?? null;
    this.#queue = new Queue({ random });

    this.#volume = clampInt(settings?.get('volume') ?? 70, 0, 100);
    this.#queue.setShuffle(Boolean(settings?.get('shuffle')));
    this.#queue.setRepeat(settings?.get('repeat') ?? 'off');

    this.#unsubscribers.push(this.#queue.on('change', () => this.#publish()));
    this.#bindAdapter(adapter);
  }

  // ----------------------------------------------------------------- state

  get queue() {
    return this.#queue;
  }

  get adapterInfo() {
    return {
      id: this.#adapter.id,
      label: this.#adapter.label,
      capabilities: this.#adapter.capabilities,
    };
  }

  /** Immutable snapshot consumed by the UI. */
  get state() {
    const queued = this.#queue.current;
    const track = this.#resolved?.id === queued?.id ? this.#resolved : queued;
    return {
      status: this.#state,
      track,
      position: this.#position,
      duration: this.#duration,
      positionEstimated: this.#positionEstimated,
      buffering: this.#buffering,
      volume: this.#volume,
      shuffle: this.#queue.shuffle,
      repeat: this.#queue.repeat,
      error: this.#error,
      queueLength: this.#queue.length,
      queuePosition: this.#queue.ordered.findIndex((i) => i.isCurrent),
      hasNext: this.#queue.hasNext,
      hasPrevious: this.#queue.hasPrevious,
      sleepTimer: this.#sleepTimerState(),
      canSeek: this.#adapter.capabilities.seek,
      canSetVolume: this.#adapter.capabilities.volume,
    };
  }

  #publish() {
    if (this.#disposed) return;
    this.emit('change', this.state);
  }

  // -------------------------------------------------------------- commands

  /**
   * Replace the queue with `tracks` and start at `startIndex`.
   * @param {import('../core/track.js').Track[]} tracks
   */
  async playTracks(tracks, startIndex = 0) {
    if (!tracks?.length) return;
    this.#queue.replace(tracks, startIndex);
    await this.#startCurrent();
  }

  /** Play a single track now, leaving the rest of the queue intact after it. */
  async playNow(track) {
    this.#queue.addNext(track);
    this.#queue.next({ auto: false });
    await this.#startCurrent();
  }

  async play() {
    if (this.#state === PLAYBACK_STATE.PAUSED) return this.resume();
    if (this.#state === PLAYBACK_STATE.PLAYING) return;
    if (!this.#queue.current && !this.#queue.isEmpty) this.#queue.jumpTo(0);
    if (this.#queue.current) await this.#startCurrent();
  }

  async pause() {
    if (this.#state !== PLAYBACK_STATE.PLAYING) return;
    await this.#adapter.pause();
    this.#state = PLAYBACK_STATE.PAUSED;
    this.#publish();
  }

  async resume() {
    if (this.#state !== PLAYBACK_STATE.PAUSED) return;
    this.#state = PLAYBACK_STATE.PLAYING;
    this.#lastPositionAt = Date.now();
    this.#publish();
    try {
      await this.#adapter.resume();
    } catch (error) {
      this.#onAdapterError(error);
    }
  }

  async togglePlayPause() {
    if (this.#state === PLAYBACK_STATE.PLAYING) return this.pause();
    if (this.#state === PLAYBACK_STATE.PAUSED) return this.resume();
    return this.play();
  }

  async stop() {
    this.#epoch += 1;
    this.#finishHistory({ completed: false });
    await this.#adapter.stop();
    this.#state = PLAYBACK_STATE.IDLE;
    this.#position = 0;
    this.#buffering = false;
    this.#error = null;
    this.#resolved = null;
    this.#publish();
  }

  /** @param {{auto?: boolean}} [options] */
  async next({ auto = false } = {}) {
    this.#finishHistory({ completed: auto });
    const track = this.#queue.next({ auto });
    if (!track) {
      await this.stop();
      this.emit('queue-finished');
      return;
    }
    await this.#startCurrent();
  }

  async previous() {
    // Standard player behaviour: restart if we are past the threshold.
    if (this.#position > RESTART_THRESHOLD_SECONDS && this.#queue.current) {
      await this.seekTo(0);
      return;
    }
    this.#finishHistory({ completed: false });
    const track = this.#queue.previous();
    if (track) await this.#startCurrent();
  }

  /** Jump to a position in the queue (playback order). */
  async jumpTo(position) {
    const track = this.#queue.jumpTo(position);
    if (!track) return;
    this.#finishHistory({ completed: false });
    await this.#startCurrent();
  }

  async seekTo(seconds) {
    if (!this.#adapter.capabilities.seek) {
      this.emit('notice', {
        level: 'warn',
        message: `${this.#adapter.label} cannot seek`,
      });
      return;
    }
    const max = this.#duration ?? Number.MAX_SAFE_INTEGER;
    const target = Math.max(0, Math.min(seconds, Math.max(0, max - 1)));
    this.#position = target;
    this.#publish();
    try {
      await this.#adapter.seek(target);
    } catch (error) {
      this.#onAdapterError(error);
    }
  }

  async seekBy(delta) {
    return this.seekTo(this.#position + delta);
  }

  async setVolume(volume) {
    this.#volume = clampInt(volume, 0, 100);
    this.#settings?.set('volume', this.#volume);
    this.#publish();
    if (!this.#adapter.capabilities.volume) {
      this.emit('notice', {
        level: 'warn',
        message: `${this.#adapter.label} cannot change volume`,
      });
      return;
    }
    try {
      await this.#adapter.setVolume(this.#volume);
    } catch (error) {
      this.#onAdapterError(error);
    }
  }

  async adjustVolume(delta) {
    return this.setVolume(this.#volume + delta);
  }

  toggleShuffle() {
    const value = this.#queue.toggleShuffle();
    this.#settings?.set('shuffle', value);
    return value;
  }

  cycleRepeat() {
    const value = this.#queue.cycleRepeat();
    this.#settings?.set('repeat', value);
    return value;
  }

  // ---------------------------------------------------------- queue facade

  enqueue(tracks) {
    const added = this.#queue.add(tracks);
    // Starting empty? The first enqueue becomes the current track, but we do
    // not auto-play: adding to a queue should never surprise you with sound.
    if (this.#queue.currentIndex < 0 && added) this.#queue.jumpTo(0);
    return added;
  }

  enqueueNext(tracks) {
    const added = this.#queue.addNext(tracks);
    if (this.#queue.currentIndex < 0 && added) this.#queue.jumpTo(0);
    return added;
  }

  async clearQueue() {
    await this.stop();
    this.#queue.clear();
  }

  // ------------------------------------------------------------ sleep timer

  /** @param {number} minutes */
  startSleepTimer(minutes) {
    this.cancelSleepTimer();
    const ms = Math.max(1, Math.round(minutes)) * 60000;
    const endsAt = Date.now() + ms;
    const timeout = setTimeout(async () => {
      this.#sleepTimer = null;
      await this.pause();
      this.emit('notice', { level: 'info', message: 'Sleep timer finished - playback paused' });
      this.#publish();
    }, ms);
    timeout.unref?.();
    this.#sleepTimer = { timeout, endsAt, minutes: Math.round(minutes) };
    this.#publish();
    return this.#sleepTimerState();
  }

  cancelSleepTimer() {
    if (!this.#sleepTimer) return false;
    clearTimeout(this.#sleepTimer.timeout);
    this.#sleepTimer = null;
    this.#publish();
    return true;
  }

  #sleepTimerState() {
    if (!this.#sleepTimer) return null;
    return {
      minutes: this.#sleepTimer.minutes,
      endsAt: this.#sleepTimer.endsAt,
      remainingSeconds: Math.max(0, Math.round((this.#sleepTimer.endsAt - Date.now()) / 1000)),
    };
  }

  // -------------------------------------------------------------- internals

  /** Resolve a fresh playback URL and hand it to the adapter. */
  async #startCurrent() {
    const track = this.#queue.current;
    if (!track) return;

    const epoch = ++this.#epoch;
    this.#resolved = null;
    this.#state = PLAYBACK_STATE.LOADING;
    this.#position = 0;
    this.#listenedSeconds = 0;
    this.#duration = track.duration ?? null;
    this.#error = null;
    this.#buffering = true;
    this.#positionEstimated = !this.#adapter.capabilities.position;
    this.#publish();

    let resolved = track;
    try {
      // Stream URLs expire; always re-resolve through the provider first.
      if (this.#registry?.has(track.provider)) {
        resolved = await this.#registry.get(track.provider).resolve(track);
      }
    } catch (error) {
      this.#logger?.warn('track resolve failed', { id: track.id, error: error.message });
    }
    if (epoch !== this.#epoch) return; // superseded while resolving

    if (!isPlayable(resolved)) {
      this.#failCurrent(
        new PlaybackError(`track is not playable: ${resolved.id}`, {
          userMessage: `"${resolved.title}" is not available`,
          hint:
            resolved.availability === 'metadata-only'
              ? 'This provider only supplies metadata for this track.'
              : 'The source may have been removed.',
        }),
      );
      return;
    }

    const source = playbackSource(resolved);
    if (source.kind === 'url' && !this.#adapter.capabilities.remoteStreams) {
      this.#failCurrent(
        new PlaybackError(`${this.#adapter.id} cannot play remote streams`, {
          userMessage: `${this.#adapter.label} cannot stream online audio`,
          hint: 'Install FFmpeg or mpv, then pick it in Settings.',
        }),
      );
      return;
    }

    if (resolved.duration) this.#duration = resolved.duration;
    this.#resolved = resolved;
    this.#publish();

    try {
      await this.#adapter.play(source, {
        startAt: 0,
        volume: this.#volume,
        duration: this.#duration ?? 0,
      });
      if (epoch !== this.#epoch) return;
      this.#state = PLAYBACK_STATE.PLAYING;
      this.#consecutiveFailures = 0;
      this.#lastPositionAt = Date.now();
      this.#history?.startSession(resolved);
      this.emit('track-started', resolved);
      this.#publish();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#failCurrent(error);
    }
  }

  #failCurrent(error) {
    this.#state = PLAYBACK_STATE.ERROR;
    this.#buffering = false;
    this.#error = toUserMessage(error);
    this.#consecutiveFailures += 1;
    this.#logger?.warn('playback failed', {
      error: error.message,
      failures: this.#consecutiveFailures,
    });
    this.emit('playback-error', this.#error);
    this.#publish();

    // Skip past a dead track automatically, but stop if the whole queue is
    // failing - repeatedly skipping would just spin.
    if (
      this.#settings?.get('autoAdvance') &&
      this.#queue.hasNext &&
      this.#consecutiveFailures < MAX_CONSECUTIVE_FAILURES
    ) {
      setTimeout(() => {
        if (this.#state === PLAYBACK_STATE.ERROR) this.next({ auto: true }).catch(() => {});
      }, 900);
    } else if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.emit('notice', {
        level: 'error',
        message: 'Several tracks in a row failed - stopping. Check your connection.',
      });
    }
  }

  #bindAdapter(adapter) {
    this.#unsubscribers.push(
      adapter.on('position', ({ seconds, estimated }) => {
        if (this.#state !== PLAYBACK_STATE.PLAYING && this.#state !== PLAYBACK_STATE.LOADING)
          return;
        if (this.#state === PLAYBACK_STATE.LOADING) this.#state = PLAYBACK_STATE.PLAYING;
        const now = Date.now();
        // Accumulate only forward, real-time progress so a seek does not
        // inflate the listening figure recorded in history.
        const deltaWall = (now - this.#lastPositionAt) / 1000;
        if (deltaWall > 0 && deltaWall < 3 && seconds >= this.#position) {
          this.#listenedSeconds += Math.min(deltaWall, seconds - this.#position + 0.05);
        }
        this.#lastPositionAt = now;
        this.#position = seconds;
        if (estimated != null) this.#positionEstimated = Boolean(estimated);
        this.#history?.updateSession(this.#listenedSeconds);
        this.#publish();
      }),
    );

    this.#unsubscribers.push(
      adapter.on('buffering', ({ buffering }) => {
        this.#buffering = Boolean(buffering);
        this.#publish();
      }),
    );

    this.#unsubscribers.push(
      adapter.on('ended', () => {
        if (this.#state === PLAYBACK_STATE.IDLE) return;
        this.#finishHistory({ completed: true });
        if (!this.#settings || this.#settings.get('autoAdvance')) {
          this.next({ auto: true }).catch((error) => this.#onAdapterError(error));
        } else {
          this.#state = PLAYBACK_STATE.IDLE;
          this.#publish();
        }
      }),
    );

    this.#unsubscribers.push(adapter.on('error', (error) => this.#onAdapterError(error)));

    this.#unsubscribers.push(
      adapter.on('warning', ({ message }) => {
        this.emit('notice', { level: 'warn', message });
      }),
    );
  }

  #onAdapterError(error) {
    this.#failCurrent(error instanceof Error ? error : new PlaybackError(String(error)));
  }

  #finishHistory({ completed }) {
    if (!this.#listenedSeconds && !completed) {
      this.#history?.endSession({ listenedSeconds: 0, completed: false });
      return;
    }
    this.#history?.endSession({ listenedSeconds: this.#listenedSeconds, completed });
    this.#listenedSeconds = 0;
  }

  /** Swap the audio backend at runtime (Settings). */
  async replaceAdapter(adapter) {
    const wasPlaying = this.#state === PLAYBACK_STATE.PLAYING;
    const position = this.#position;
    await this.stop();
    for (const off of this.#unsubscribers.splice(0)) off();
    await this.#adapter.dispose().catch(() => {});
    this.#adapter = adapter;
    this.#unsubscribers.push(this.#queue.on('change', () => this.#publish()));
    this.#bindAdapter(adapter);
    this.#publish();
    if (wasPlaying && this.#queue.current) {
      await this.#startCurrent();
      if (position > 1) await this.seekTo(position);
    }
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancelSleepTimer();
    this.#finishHistory({ completed: false });
    for (const off of this.#unsubscribers.splice(0)) off();
    await this.#adapter.dispose().catch(() => {});
    this.removeAllListeners();
  }
}
