import { Emitter } from '../core/events.js';
import { relativeTime } from '../core/util.js';

/** Below this, a play is treated as a skip and not recorded. */
const MIN_SESSION_SECONDS = 3;

/**
 * Listening history.
 *
 * One row per *listening session*, not per progress tick: `startSession()`
 * inserts once, then `updateSession()` updates that same row in place as the
 * track plays. Replaying the same track back-to-back within the coalesce
 * window reuses the open session rather than piling up rows.
 */
export class HistoryService extends Emitter {
  #db;
  #tracks;
  #openSession = null;
  #enabled;

  constructor({ db, tracks, enabled = true }) {
    super();
    this.#db = db;
    this.#tracks = tracks;
    this.#enabled = enabled;
  }

  setEnabled(enabled) {
    this.#enabled = Boolean(enabled);
    if (!this.#enabled) this.#openSession = null;
  }

  get enabled() {
    return this.#enabled;
  }

  /**
   * Begin recording a play. Returns the session id, or null when history is
   * disabled.
   * @param {import('../core/track.js').Track} track
   */
  startSession(track, { now = Date.now() } = {}) {
    if (!this.#enabled || !track) return null;
    this.#tracks.upsert(track);
    const info = this.#db
      .prepare(
        'INSERT INTO history (track_id, played_at, listened_sec, completed) VALUES (?, ?, 0, 0)',
      )
      .run(track.id, new Date(now).toISOString());
    this.#openSession = { id: info.lastInsertRowid, trackId: track.id, listened: 0 };
    this.emit('change', { type: 'started', trackId: track.id });
    return this.#openSession.id;
  }

  /**
   * Update the open session's accumulated listening time. Cheap and
   * idempotent: safe to call on every progress event.
   * @param {number} listenedSeconds
   */
  updateSession(listenedSeconds, { completed = false } = {}) {
    if (!this.#enabled || !this.#openSession) return;
    const seconds = Math.max(0, Math.floor(listenedSeconds));
    if (seconds === this.#openSession.listened && !completed) return;
    this.#openSession.listened = seconds;
    this.#db
      .prepare('UPDATE history SET listened_sec = ?, completed = ? WHERE id = ?')
      .run(seconds, completed ? 1 : 0, this.#openSession.id);
  }

  /** Finalise the current session. */
  endSession({ listenedSeconds = null, completed = false } = {}) {
    if (!this.#openSession) return null;
    if (listenedSeconds != null) this.updateSession(listenedSeconds, { completed });
    else if (completed) this.updateSession(this.#openSession.listened, { completed: true });
    const finished = this.#openSession;
    this.#openSession = null;
    // Discard rows for tracks that were skipped instantly or never actually
    // started (a failed stream reports "completed" as it advances, but with
    // no listening time, and those must not pollute history or statistics).
    if (finished.listened < MIN_SESSION_SECONDS) {
      this.#db.prepare('DELETE FROM history WHERE id = ?').run(finished.id);
      return null;
    }
    this.emit('change', { type: 'ended', trackId: finished.trackId });
    return finished;
  }

  get openSessionTrackId() {
    return this.#openSession?.trackId ?? null;
  }

  /**
   * @returns {{id:number, track: import('../core/track.js').Track, playedAt: string,
   *            listenedSeconds: number, completed: boolean, relative: string}[]}
   */
  list({ limit = 200 } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT h.id, h.track_id, h.played_at, h.listened_sec, h.completed
           FROM history h ORDER BY h.played_at DESC, h.id DESC LIMIT ?`,
      )
      .all(limit);
    const tracks = new Map(
      this.#tracks.getMany([...new Set(rows.map((r) => r.track_id))]).map((t) => [t.id, t]),
    );
    return rows
      .filter((row) => tracks.has(row.track_id))
      .map((row) => ({
        id: row.id,
        track: tracks.get(row.track_id),
        playedAt: row.played_at,
        listenedSeconds: row.listened_sec,
        completed: Boolean(row.completed),
        relative: relativeTime(row.played_at),
      }));
  }

  count() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM history').get().n;
  }

  removeEntry(id) {
    return this.#db.prepare('DELETE FROM history WHERE id = ?').run(id).changes > 0;
  }

  clear() {
    const info = this.#db.prepare('DELETE FROM history').run();
    this.#openSession = null;
    this.emit('change', { type: 'cleared' });
    return info.changes;
  }
}
