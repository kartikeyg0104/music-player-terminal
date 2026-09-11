import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StorageError } from '../core/errors.js';
import { runMigrations } from './migrate.js';

/**
 * Open (and migrate) the Termify database.
 *
 * If the file on disk turns out to be corrupt we do not crash: the damaged
 * file is moved aside with a timestamp and a fresh database is created, so the
 * app always starts. The caller is told via the returned `recovered` flag and
 * surfaces a toast.
 *
 * @param {object} options
 * @param {string} options.file  Path to the sqlite file, or ':memory:'.
 * @param {import('../core/logger.js').Logger} options.logger
 * @returns {{ db: import('better-sqlite3').Database, recovered: string|null, version: number }}
 */
export function openDatabase({ file, logger }) {
  try {
    return connectAndMigrate(file, logger);
  } catch (error) {
    if (file === ':memory:' || !isCorruption(error)) {
      throw new StorageError(`Could not open database at ${file}: ${error.message}`, {
        userMessage: 'Could not open the Termify database',
        hint: `Check permissions on ${path.dirname(file)} or set TERMIFY_DATA_DIR.`,
        cause: error,
      });
    }
    const quarantined = quarantine(file, logger);
    const result = connectAndMigrate(file, logger);
    return { ...result, recovered: quarantined };
  }
}

function connectAndMigrate(file, logger) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Fails loudly here (rather than at first query) if the file is damaged.
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') {
    db.close();
    throw new Error(`integrity check failed: ${check}`);
  }
  const version = runMigrations(db, logger);
  return { db, recovered: null, version };
}

function isCorruption(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    message.includes('malformed') ||
    message.includes('not a database') ||
    message.includes('integrity check failed') ||
    message.includes('database disk image')
  );
}

function quarantine(file, logger) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${file}${suffix}`;
    if (fs.existsSync(from)) {
      try {
        fs.renameSync(from, `${target}${suffix}`);
      } catch {
        try {
          fs.unlinkSync(from);
        } catch {
          /* best effort */
        }
      }
    }
  }
  logger?.warn('database was corrupt, starting fresh', { quarantined: target });
  return target;
}
