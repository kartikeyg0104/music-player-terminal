/**
 * Ordered schema migrations.
 *
 * Each entry runs exactly once, inside a transaction, in `version` order.
 * Never edit a shipped migration - add a new one. `user_version` in the
 * sqlite header records how far a database has come.
 */

/** @type {{ version: number, name: string, up: (db: import('better-sqlite3').Database) => void }[]} */
export const migrations = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(`
        -- Every track we have ever seen, keyed by the stable internal id.
        -- streamUrl lives in the JSON blob and is treated as disposable:
        -- playback always re-resolves it through the provider before use.
        CREATE TABLE tracks (
          id           TEXT PRIMARY KEY,
          provider     TEXT NOT NULL,
          provider_id  TEXT NOT NULL,
          title        TEXT NOT NULL,
          artist       TEXT NOT NULL,
          album        TEXT NOT NULL DEFAULT '',
          duration     INTEGER,
          genre        TEXT,
          year         INTEGER,
          artwork_url  TEXT,
          local_path   TEXT,
          external_url TEXT,
          availability TEXT NOT NULL DEFAULT 'available',
          is_sample    INTEGER NOT NULL DEFAULT 0,
          payload      TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          UNIQUE (provider, provider_id)
        );
        CREATE INDEX idx_tracks_artist ON tracks (artist);
        CREATE INDEX idx_tracks_provider ON tracks (provider);

        CREATE TABLE playlists (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE playlist_tracks (
          playlist_id INTEGER NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
          track_id    TEXT    NOT NULL REFERENCES tracks (id)    ON DELETE CASCADE,
          position    INTEGER NOT NULL,
          added_at    TEXT    NOT NULL,
          PRIMARY KEY (playlist_id, position)
        );
        CREATE INDEX idx_playlist_tracks_track ON playlist_tracks (track_id);

        CREATE TABLE favorites (
          track_id TEXT PRIMARY KEY REFERENCES tracks (id) ON DELETE CASCADE,
          added_at TEXT NOT NULL
        );

        -- One row per listening session, updated in place while the track
        -- plays, so progress ticks never create new rows.
        CREATE TABLE history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          track_id     TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
          played_at    TEXT NOT NULL,
          listened_sec INTEGER NOT NULL DEFAULT 0,
          completed    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_history_played_at ON history (played_at DESC);
        CREATE INDEX idx_history_track ON history (track_id);

        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Provider response cache. Keyed by a provider-scoped request hash.
        CREATE TABLE metadata_cache (
          key        TEXT PRIMARY KEY,
          provider   TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_metadata_cache_expiry ON metadata_cache (expires_at);
      `);
    },
  },
  {
    version: 2,
    name: 'playback-state-snapshot',
    up(db) {
      db.exec(`
        -- Single-row table holding the queue snapshot so a restart can offer
        -- to resume. Stored as JSON: the queue is in-memory by design.
        CREATE TABLE playback_state (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          payload    TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: 'smart-playlist-flags',
    up(db) {
      db.exec(`
        ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
        ALTER TABLE playlists ADD COLUMN rule TEXT;
      `);
    },
  },
];

export const LATEST_VERSION = migrations.at(-1).version;
