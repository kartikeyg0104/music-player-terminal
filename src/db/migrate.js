import { StorageError } from '../core/errors.js';
import { migrations, LATEST_VERSION } from './migrations/index.js';

/**
 * Bring a database up to `LATEST_VERSION`.
 *
 * Each migration runs in its own transaction; if one throws, that migration is
 * rolled back and `user_version` is left pointing at the last good state, so a
 * later run retries from exactly the right place.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('../core/logger.js').Logger} [logger]
 * @returns {number} the resulting schema version
 */
export function runMigrations(db, logger) {
  let current = Number(db.pragma('user_version', { simple: true })) || 0;

  if (current > LATEST_VERSION) {
    throw new StorageError(`database schema v${current} is newer than this build`, {
      userMessage: 'This database was written by a newer version of Termify',
      hint: 'Upgrade Termify, or point TERMIFY_DATA_DIR at a different folder.',
    });
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    try {
      apply();
    } catch (error) {
      throw new StorageError(
        `migration ${migration.version} (${migration.name}) failed: ${error.message}`,
        {
          userMessage: 'Database upgrade failed',
          hint: 'Move your termify.db aside to start fresh, then reimport if needed.',
          cause: error,
        },
      );
    }
    current = migration.version;
    logger?.info('applied migration', { version: migration.version, name: migration.name });
  }

  return current;
}

export { LATEST_VERSION };
