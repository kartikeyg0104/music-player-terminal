import { Emitter } from '../core/events.js';
import { ValidationError } from '../core/errors.js';
import { clampInt } from '../core/util.js';
import { SETTING_SPECS, SETTINGS_BY_KEY, defaultSettings } from '../config/defaults.js';

/**
 * Typed, validated key/value settings backed by sqlite.
 *
 * Values are validated against `SETTING_SPECS` on the way in *and* on the way
 * out, so a hand-edited or corrupt row silently falls back to the default
 * instead of breaking the UI.
 */
export class SettingsService extends Emitter {
  #db;
  #cache;
  #logger;

  constructor({ db, logger, overrides = {} }) {
    super();
    this.#db = db;
    this.#logger = logger;
    this.readStmt = db.prepare('SELECT key, value FROM settings');
    this.writeStmt = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.#cache = this.#load(overrides);
  }

  #load(overrides) {
    const values = defaultSettings();
    for (const row of this.readStmt.all()) {
      const spec = SETTINGS_BY_KEY[row.key];
      if (!spec) continue;
      const parsed = parse(spec, row.value);
      if (parsed === undefined) {
        this.#logger?.warn('discarding invalid persisted setting', { key: row.key });
        continue;
      }
      values[row.key] = parsed;
    }
    // Environment overrides win over persisted values but are not written back,
    // so unsetting the env var restores the user's stored preference.
    for (const [key, value] of Object.entries(overrides)) {
      if (value == null || value === '') continue;
      const spec = SETTINGS_BY_KEY[key];
      if (!spec) continue;
      const coerced = coerce(spec, value);
      if (coerced !== undefined) values[key] = coerced;
    }
    return values;
  }

  /** @returns {Record<string, any>} a frozen snapshot */
  all() {
    return Object.freeze({ ...this.#cache });
  }

  get(key) {
    return this.#cache[key];
  }

  /**
   * @param {string} key
   * @param {any} value
   * @returns {any} the stored (coerced) value
   */
  set(key, value) {
    const spec = SETTINGS_BY_KEY[key];
    if (!spec) throw new ValidationError(`unknown setting "${key}"`);
    const coerced = coerce(spec, value);
    if (coerced === undefined) {
      throw new ValidationError(`invalid value for ${key}`, {
        userMessage: `"${spec.label}" rejected that value`,
        hint: describeValid(spec),
      });
    }
    this.#cache[key] = coerced;
    this.writeStmt.run(key, JSON.stringify(coerced), new Date().toISOString());
    this.emit('change', { key, value: coerced });
    return coerced;
  }

  /** Cycle an enum/boolean setting to its next value (used by the settings UI). */
  cycle(key, direction = 1) {
    const spec = SETTINGS_BY_KEY[key];
    if (!spec) throw new ValidationError(`unknown setting "${key}"`);
    const current = this.#cache[key];
    if (spec.type === 'boolean') return this.set(key, !current);
    if (spec.type === 'enum') {
      const values = spec.values;
      const index = Math.max(0, values.indexOf(current));
      const next = (index + direction + values.length) % values.length;
      return this.set(key, values[next]);
    }
    if (spec.type === 'integer') {
      const step = spec.step ?? 1;
      return this.set(key, clampInt(current + step * direction, spec.min, spec.max));
    }
    return current;
  }

  /** Restore every setting to its declared default. */
  resetAll() {
    const tx = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM settings').run();
    });
    tx();
    this.#cache = defaultSettings();
    this.emit('reset');
    return this.all();
  }

  get specs() {
    return SETTING_SPECS;
  }
}

function parse(spec, raw) {
  try {
    return coerce(spec, JSON.parse(raw));
  } catch {
    return coerce(spec, raw);
  }
}

/** @returns {any|undefined} undefined means "rejected" */
function coerce(spec, value) {
  switch (spec.type) {
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      return undefined;
    }
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return clampInt(n, spec.min ?? Number.MIN_SAFE_INTEGER, spec.max ?? Number.MAX_SAFE_INTEGER);
    }
    case 'enum': {
      const text = String(value);
      return spec.values.includes(text) ? text : undefined;
    }
    case 'path':
    case 'string': {
      if (value == null) return '';
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      return String(value).trim();
    }
    default:
      return undefined;
  }
}

function describeValid(spec) {
  if (spec.type === 'enum') return `Allowed: ${spec.values.join(', ')}.`;
  if (spec.type === 'integer') return `Allowed: ${spec.min} to ${spec.max}.`;
  if (spec.type === 'boolean') return 'Allowed: on or off.';
  return null;
}
