import fs from 'node:fs';
import { SECRET_ENV_KEYS } from '../config/env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * File-only logger.
 *
 * Writing to stdout/stderr while Ink owns the terminal corrupts the frame, so
 * every diagnostic goes to a log file instead. Values are redacted before they
 * are serialised.
 */
export class Logger {
  #stream = null;
  #level;
  #file;
  #secrets;

  constructor({ file, level = 'warn' } = {}) {
    this.#level = LEVELS[level] ?? LEVELS.warn;
    this.#file = file ?? null;
    this.#secrets = collectSecrets();
  }

  get file() {
    return this.#file;
  }

  #write(level, message, meta) {
    if ((LEVELS[level] ?? 99) > this.#level) return;
    if (!this.#file) return;
    if (!this.#stream) {
      try {
        this.#stream = fs.createWriteStream(this.#file, { flags: 'a' });
        this.#stream.on('error', () => {
          this.#stream = null;
          this.#file = null;
        });
      } catch {
        this.#file = null;
        return;
      }
    }
    const line = {
      t: new Date().toISOString(),
      level,
      msg: this.#redact(String(message)),
      ...(meta ? { meta: this.#redact(serialise(meta)) } : {}),
    };
    try {
      this.#stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      /* logging must never throw into the caller */
    }
  }

  #redact(value) {
    if (typeof value === 'string') {
      let out = value;
      for (const secret of this.#secrets) out = out.split(secret).join('«redacted»');
      return out;
    }
    if (value && typeof value === 'object') {
      return JSON.parse(this.#redact(JSON.stringify(value)));
    }
    return value;
  }

  error(message, meta) {
    this.#write('error', message, meta);
  }
  warn(message, meta) {
    this.#write('warn', message, meta);
  }
  info(message, meta) {
    this.#write('info', message, meta);
  }
  debug(message, meta) {
    this.#write('debug', message, meta);
  }

  close() {
    this.#stream?.end();
    this.#stream = null;
  }
}

function collectSecrets() {
  return SECRET_ENV_KEYS.map((key) => process.env[key])
    .filter((v) => typeof v === 'string' && v.length >= 6)
    .sort((a, b) => b.length - a.length);
}

function serialise(meta) {
  if (meta instanceof Error) {
    return { name: meta.name, message: meta.message, stack: meta.stack };
  }
  try {
    JSON.stringify(meta);
    return meta;
  } catch {
    return { unserialisable: String(meta) };
  }
}

/** A logger that discards everything — used by tests. */
export const nullLogger = /** @type {Logger} */ ({
  error() {},
  warn() {},
  info() {},
  debug() {},
  close() {},
  file: null,
});
