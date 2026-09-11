import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Load `.env` from the current working directory if present.
 * Real environment variables always win over the file.
 */
export function loadEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env');
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });
  return readEnv(process.env);
}

/**
 * Project the raw environment into a typed, validated config object.
 * Secrets stay in this object and are never written to the database or logs.
 * @param {NodeJS.ProcessEnv} env
 */
export function readEnv(env) {
  return {
    jamendo: {
      clientId: trimmed(env.JAMENDO_CLIENT_ID),
    },
    archive: {
      contact: trimmed(env.ARCHIVE_CONTACT),
      collection: trimmed(env.ARCHIVE_COLLECTION),
    },
    defaultProvider: trimmed(env.TERMIFY_DEFAULT_PROVIDER) || null,
    musicDir: trimmed(env.TERMIFY_MUSIC_DIR) || null,
    dataDir: trimmed(env.TERMIFY_DATA_DIR) || null,
    logLevel: trimmed(env.TERMIFY_LOG_LEVEL) || 'warn',
    audioBackend: trimmed(env.TERMIFY_AUDIO_BACKEND) || null,
    httpTimeoutMs: positiveInt(env.TERMIFY_HTTP_TIMEOUT_MS, 12000),
  };
}

/** Keys that must never appear in a log line or crash report. */
export const SECRET_ENV_KEYS = ['JAMENDO_CLIENT_ID', 'JAMENDO_CLIENT_SECRET'];

/** @param {string | undefined} value */
function trimmed(value) {
  const out = (value ?? '').trim();
  return out.length > 0 ? out : '';
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
