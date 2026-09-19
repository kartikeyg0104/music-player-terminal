import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { TrackRepository } from '../src/services/trackRepository.js';
import { SettingsService } from '../src/services/settingsService.js';
import { PlaylistService } from '../src/services/playlistService.js';
import { FavoritesService } from '../src/services/favoritesService.js';
import { HistoryService } from '../src/services/historyService.js';
import { StatsService } from '../src/services/statsService.js';
import { CacheService } from '../src/services/cacheService.js';
import { nullLogger } from '../src/core/logger.js';
import { createTrack } from '../src/core/track.js';

/**
 * Test scaffolding.
 *
 * Everything here builds real objects against an in-memory database - no
 * mocking of our own code. Only the outside world (network, audio) is faked,
 * which is exactly where the seams were designed to be.
 */

/** A fully wired service set on an in-memory database. */
export function makeServices({ settings: overrides = {} } = {}) {
  const { db } = openDatabase({ file: ':memory:', logger: nullLogger });
  const tracks = new TrackRepository(db);
  const settings = new SettingsService({ db, logger: nullLogger, overrides });
  const playlists = new PlaylistService({ db, tracks });
  const favorites = new FavoritesService({ db, tracks });
  const history = new HistoryService({ db, tracks });
  const stats = new StatsService({ db, tracks });
  const cache = new CacheService({ db, ttlMinutes: 60, logger: nullLogger });
  return {
    db,
    tracks,
    settings,
    playlists,
    favorites,
    history,
    stats,
    cache,
    close: () => db.close(),
  };
}

/** A temporary data directory that cleans itself up. */
export function tempDir(prefix = 'termify-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Deterministic track factory. */
export function makeTrack(n, overrides = {}) {
  return createTrack({
    provider: 'mock',
    providerId: `t${n}`,
    title: `Track ${n}`,
    artist: `Artist ${(n % 3) + 1}`,
    album: `Album ${Math.ceil(n / 3)}`,
    duration: 100 + n,
    genre: ['rock', 'jazz', 'ambient'][n % 3],
    streamUrl: `https://example.invalid/${n}.mp3`,
    ...overrides,
  });
}

export function makeTracks(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) => makeTrack(i + 1, overrides));
}

/**
 * A `fetch` stand-in driven by a route table.
 * @param {Record<string, {status?: number, body?: any, headers?: Record<string,string>, delayMs?: number, throws?: Error}>} routes
 *   Keys are matched as substrings of the request URL.
 */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    // Real fetch rejects straight away for a signal that is already aborted.
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      throw reason instanceof Error
        ? reason
        : Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const route = key ? routes[key] : { status: 404, body: { error: 'not found' } };
    const entry = Array.isArray(route)
      ? route[Math.min(calls.length - 1, route.length - 1)]
      : route;

    if (entry.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, entry.delayMs);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('The operation timed out.');
          error.name = options.signal.reason?.name ?? 'TimeoutError';
          reject(error);
        });
      });
    }
    if (entry.throws) throw entry.throws;

    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body ?? {});
    return {
      ok: (entry.status ?? 200) >= 200 && (entry.status ?? 200) < 300,
      status: entry.status ?? 200,
      headers: { get: (name) => entry.headers?.[name.toLowerCase()] ?? null },
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  impl.calls = calls;
  return impl;
}

/** Collect the events an emitter emits, for assertions. */
export function recordEvents(emitter, event = 'change') {
  const seen = [];
  const off = emitter.on(event, (payload) => seen.push(payload));
  return { seen, off };
}

/** Wait for a condition, polling. Fails the await if it never becomes true. */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${label ? `: ${label}` : ''}`);
}

export { nullLogger };
