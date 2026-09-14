/**
 * Persists a queue snapshot between runs.
 *
 * Only stable track ids are stored - never stream URLs - so a restored queue
 * re-resolves through the provider exactly like a fresh one.
 */
export class SessionService {
  #db;
  #tracks;
  #logger;

  constructor({ db, tracks, logger }) {
    this.#db = db;
    this.#tracks = tracks;
    this.#logger = logger;
  }

  /** @param {import('../playback/queue.js').Queue} queue */
  save(queue) {
    try {
      const snapshot = queue.snapshot();
      // Make sure every referenced track still exists in the dictionary.
      this.#tracks.upsertAll(queue.items);
      this.#db
        .prepare(
          `INSERT INTO playback_state (id, payload, updated_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(snapshot), new Date().toISOString());
      return true;
    } catch (error) {
      this.#logger?.warn('could not save session', { error: error.message });
      return false;
    }
  }

  /** @returns {{snapshot: object, updatedAt: string}|null} */
  load() {
    try {
      const row = this.#db
        .prepare('SELECT payload, updated_at FROM playback_state WHERE id = 1')
        .get();
      if (!row) return null;
      const snapshot = JSON.parse(row.payload);
      if (!Array.isArray(snapshot?.trackIds) || !snapshot.trackIds.length) return null;
      return { snapshot, updatedAt: row.updated_at };
    } catch (error) {
      this.#logger?.warn('could not read session', { error: error.message });
      return null;
    }
  }

  /**
   * Restore into a queue. Missing tracks are skipped silently by the queue.
   * @returns {number} tracks restored
   */
  restore(queue) {
    const saved = this.load();
    if (!saved) return 0;
    return queue.restore(saved.snapshot, (id) => this.#tracks.get(id));
  }

  clear() {
    this.#db.prepare('DELETE FROM playback_state').run();
  }
}
