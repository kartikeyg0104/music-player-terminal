import crypto from 'node:crypto';

/**
 * TTL cache for provider responses, persisted in sqlite.
 *
 * Providers ask for and store raw payloads here so repeated searches, paging
 * back and forth, and re-resolving a track do not hammer an API. Entries carry
 * an explicit expiry; a TTL of 0 disables caching entirely (respecting
 * providers that ask clients not to store responses).
 */
export class CacheService {
  #db;
  #ttlMinutes;
  #logger;
  #memory = new Map();

  constructor({ db, ttlMinutes = 60, logger } = {}) {
    this.#db = db;
    this.#ttlMinutes = ttlMinutes;
    this.#logger = logger;
    this.getStmt = db.prepare('SELECT payload, expires_at FROM metadata_cache WHERE key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO metadata_cache (key, provider, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET payload = excluded.payload,
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
    );
  }

  setTtlMinutes(minutes) {
    this.#ttlMinutes = Math.max(0, Number(minutes) || 0);
    if (this.#ttlMinutes === 0) this.#memory.clear();
  }

  get enabled() {
    return this.#ttlMinutes > 0;
  }

  /** @returns {any|null} */
  get(provider, key) {
    if (!this.enabled) return null;
    const hash = hashKey(provider, key);
    const hot = this.#memory.get(hash);
    if (hot && hot.expires > Date.now()) return hot.payload;

    const row = this.getStmt.get(hash);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.#db.prepare('DELETE FROM metadata_cache WHERE key = ?').run(hash);
      return null;
    }
    try {
      const payload = JSON.parse(row.payload);
      this.#memory.set(hash, { payload, expires: Date.parse(row.expires_at) });
      return payload;
    } catch {
      this.#db.prepare('DELETE FROM metadata_cache WHERE key = ?').run(hash);
      return null;
    }
  }

  set(provider, key, payload) {
    if (!this.enabled) return false;
    const hash = hashKey(provider, key);
    const now = Date.now();
    const expires = now + this.#ttlMinutes * 60000;
    try {
      this.setStmt.run(
        hash,
        provider,
        JSON.stringify(payload),
        new Date(now).toISOString(),
        new Date(expires).toISOString(),
      );
      this.#memory.set(hash, { payload, expires });
      return true;
    } catch (error) {
      this.#logger?.warn('cache write failed', { error: error.message });
      return false;
    }
  }

  /** Remove expired rows. Called at boot. */
  prune() {
    return this.#db
      .prepare('DELETE FROM metadata_cache WHERE expires_at <= ?')
      .run(new Date().toISOString()).changes;
  }

  clear() {
    this.#memory.clear();
    return this.#db.prepare('DELETE FROM metadata_cache').run().changes;
  }

  stats() {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
                SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired
           FROM metadata_cache`,
      )
      .get(new Date().toISOString());
    return {
      entries: row.entries,
      bytes: row.bytes,
      expired: row.expired ?? 0,
      ttlMinutes: this.#ttlMinutes,
    };
  }
}

function hashKey(provider, key) {
  return `${provider}:${crypto.createHash('sha1').update(String(key)).digest('hex')}`;
}
