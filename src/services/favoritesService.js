import { Emitter } from '../core/events.js';

/**
 * Favourites are a set keyed by `tracks.id`, so adding the same track twice is
 * structurally impossible rather than merely discouraged.
 */
export class FavoritesService extends Emitter {
  #db;
  #tracks;

  constructor({ db, tracks }) {
    super();
    this.#db = db;
    this.#tracks = tracks;
    this.hasStmt = db.prepare('SELECT 1 FROM favorites WHERE track_id = ?');
    this.addStmt = db.prepare(
      'INSERT INTO favorites (track_id, added_at) VALUES (?, ?) ON CONFLICT (track_id) DO NOTHING',
    );
    this.removeStmt = db.prepare('DELETE FROM favorites WHERE track_id = ?');
  }

  /** @param {import('../core/track.js').Track} track @returns {boolean} true if newly added */
  add(track) {
    this.#tracks.upsert(track);
    const info = this.addStmt.run(track.id, new Date().toISOString());
    if (info.changes) this.emit('change', { type: 'added', id: track.id });
    return info.changes > 0;
  }

  remove(trackId) {
    const info = this.removeStmt.run(trackId);
    if (info.changes) this.emit('change', { type: 'removed', id: trackId });
    return info.changes > 0;
  }

  /** @returns {{track: import('../core/track.js').Track, favorited: boolean}} */
  toggle(track) {
    if (this.has(track.id)) {
      this.remove(track.id);
      return { track, favorited: false };
    }
    this.add(track);
    return { track, favorited: true };
  }

  has(trackId) {
    return Boolean(this.hasStmt.get(trackId));
  }

  /** @returns {Set<string>} every favourited id, for cheap list rendering */
  ids() {
    return new Set(
      this.#db
        .prepare('SELECT track_id FROM favorites')
        .all()
        .map((r) => r.track_id),
    );
  }

  /** @returns {import('../core/track.js').Track[]} newest first */
  list({ limit = 500 } = {}) {
    const ids = this.#db
      .prepare('SELECT track_id FROM favorites ORDER BY added_at DESC LIMIT ?')
      .all(limit)
      .map((r) => r.track_id);
    return this.#tracks.getMany(ids);
  }

  count() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM favorites').get().n;
  }

  clear() {
    const info = this.#db.prepare('DELETE FROM favorites').run();
    this.emit('change', { type: 'cleared' });
    return info.changes;
  }
}
