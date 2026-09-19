import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migrations, LATEST_VERSION } from '../../src/db/migrations/index.js';
import { StorageError, ValidationError } from '../../src/core/errors.js';
import { TrackRepository } from '../../src/services/trackRepository.js';
import { PlaylistService } from '../../src/services/playlistService.js';
import { FavoritesService } from '../../src/services/favoritesService.js';
import { HistoryService } from '../../src/services/historyService.js';
import { StatsService } from '../../src/services/statsService.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { CacheService } from '../../src/services/cacheService.js';
import { SmartPlaylistService } from '../../src/services/smartPlaylistService.js';
import { SessionService } from '../../src/services/sessionService.js';
import { Queue } from '../../src/playback/queue.js';
import { createTrack } from '../../src/core/track.js';
import { makeServices, makeTrack, makeTracks, tempDir, nullLogger } from '../helpers.js';

// --------------------------------------------------------------- schema

test('migrations: a fresh database reaches the latest version', () => {
  const services = makeServices();
  assert.equal(services.db.pragma('user_version', { simple: true }), LATEST_VERSION);
  const tables = services.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  for (const expected of [
    'tracks',
    'playlists',
    'playlist_tracks',
    'favorites',
    'history',
    'settings',
    'metadata_cache',
    'playback_state',
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  services.close();
});

test('migrations: running them twice is a no-op', () => {
  const services = makeServices();
  const before = services.db.pragma('user_version', { simple: true });
  assert.equal(runMigrations(services.db, nullLogger), before);
  assert.equal(runMigrations(services.db, nullLogger), before);
  services.close();
});

test('migrations: an old database is upgraded in place, keeping its data', () => {
  const db = new Database(':memory:');
  // Start at v1 only.
  migrations[0].up(db);
  db.pragma('user_version = 1');
  db.prepare(
    `INSERT INTO tracks (id, provider, provider_id, title, artist, album, availability, payload, updated_at)
     VALUES ('p:1', 'p', '1', 'Old Track', 'Old Artist', '', 'available', '{"provider":"p","providerId":"1","title":"Old Track"}', '2020-01-01')`,
  ).run();

  const version = runMigrations(db, nullLogger);
  assert.equal(version, LATEST_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 1, 'data survived');
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'playback_state'").get(),
    'later migrations ran',
  );
  const columns = db
    .prepare('PRAGMA table_info(playlists)')
    .all()
    .map((c) => c.name);
  assert.ok(columns.includes('kind'), 'v3 columns were added');
  db.close();
});

test('migrations: a database from the future is refused, not silently used', () => {
  const db = new Database(':memory:');
  db.pragma(`user_version = ${LATEST_VERSION + 10}`);
  assert.throws(() => runMigrations(db, nullLogger), StorageError);
  db.close();
});

test('database: a corrupt file is moved aside and the app still starts', () => {
  const dir = tempDir();
  const file = path.join(dir.path, 'termify.db');
  fs.writeFileSync(file, 'this is definitely not a sqlite database');

  const { db, recovered, version } = openDatabase({ file, logger: nullLogger });
  assert.ok(recovered, 'the damaged file was quarantined');
  assert.ok(fs.existsSync(recovered), 'and kept as a backup rather than deleted');
  assert.equal(version, LATEST_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 0);
  db.close();
  dir.cleanup();
});

// ------------------------------------------------------------- playlists

test('playlists: full CRUD lifecycle', () => {
  const s = makeServices();
  const created = s.playlists.create('Evening', { description: 'wind down' });
  assert.equal(created.name, 'Evening');
  assert.equal(created.trackCount, 0);
  assert.equal(created.kind, 'manual');

  s.playlists.rename(created.id, 'Late evening');
  assert.equal(s.playlists.get(created.id).name, 'Late evening');

  assert.equal(s.playlists.remove(created.id), true);
  assert.equal(s.playlists.get(created.id), null);
  assert.equal(s.playlists.remove(created.id), false, 'deleting twice is harmless');
  s.close();
});

test('playlists: names are validated and unique', () => {
  const s = makeServices();
  s.playlists.create('Unique');
  assert.throws(() => s.playlists.create('Unique'), ValidationError);
  assert.throws(() => s.playlists.create('unique'), ValidationError, 'case-insensitive');
  assert.throws(() => s.playlists.create('   '), ValidationError);
  assert.throws(() => s.playlists.create('x'.repeat(200)), ValidationError);
  s.close();
});

test('playlists: tracks keep their order and count correctly', () => {
  const s = makeServices();
  const pl = s.playlists.create('Ordered');
  s.playlists.addTracks(pl.id, makeTracks(4));

  assert.deepEqual(
    s.playlists.tracks(pl.id).map((t) => t.title),
    ['Track 1', 'Track 2', 'Track 3', 'Track 4'],
  );
  const summary = s.playlists.get(pl.id);
  assert.equal(summary.trackCount, 4);
  assert.equal(summary.duration, 101 + 102 + 103 + 104);
  assert.equal(summary.durationPartial, false);
  s.close();
});

test('playlists: a track with unknown duration marks the total as approximate', () => {
  const s = makeServices();
  const pl = s.playlists.create('Partial');
  s.playlists.addTracks(pl.id, [makeTrack(1), makeTrack(2, { duration: null })]);
  const summary = s.playlists.get(pl.id);
  assert.equal(summary.durationPartial, true);
  s.close();
});

test('playlists: reordering keeps a dense, gap-free position sequence', () => {
  const s = makeServices();
  const pl = s.playlists.create('Reorder');
  s.playlists.addTracks(pl.id, makeTracks(5));

  s.playlists.move(pl.id, 4, 0);
  assert.deepEqual(
    s.playlists.tracks(pl.id).map((t) => t.title),
    ['Track 5', 'Track 1', 'Track 2', 'Track 3', 'Track 4'],
  );
  const positions = s.db
    .prepare('SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
    .all(pl.id)
    .map((r) => r.position);
  assert.deepEqual(positions, [0, 1, 2, 3, 4]);
  s.close();
});

test('playlists: duplicates are allowed and removed by position', () => {
  const s = makeServices();
  const pl = s.playlists.create('Dupes');
  const track = makeTrack(1);
  s.playlists.addTrack(pl.id, track);
  const second = s.playlists.addTrack(pl.id, track);
  assert.equal(second.duplicate, true);
  assert.equal(second.added, true);
  assert.equal(s.playlists.get(pl.id).trackCount, 2);

  s.playlists.removeAt(pl.id, 0);
  assert.equal(s.playlists.get(pl.id).trackCount, 1, 'only one copy was removed');
  s.close();
});

test('playlists: duplicates can be refused when the caller asks', () => {
  const s = makeServices();
  const pl = s.playlists.create('NoDupes');
  const track = makeTrack(1);
  s.playlists.addTrack(pl.id, track);
  const again = s.playlists.addTrack(pl.id, track, { allowDuplicate: false });
  assert.equal(again.added, false);
  assert.equal(s.playlists.get(pl.id).trackCount, 1);
  s.close();
});

test('playlists: filtering searches title, artist and album', () => {
  const s = makeServices();
  const pl = s.playlists.create('Filter');
  s.playlists.addTracks(pl.id, makeTracks(6));
  assert.equal(s.playlists.tracks(pl.id, { filter: 'Track 3' }).length, 1);
  assert.equal(s.playlists.tracks(pl.id, { filter: 'Artist 1' }).length, 2);
  assert.equal(s.playlists.tracks(pl.id, { filter: 'nothing here' }).length, 0);
  s.close();
});

test('playlists: an unavailable track stays visible rather than vanishing', () => {
  const s = makeServices();
  const pl = s.playlists.create('Broken');
  s.playlists.addTracks(pl.id, makeTracks(2));
  const [first] = s.playlists.tracks(pl.id);
  s.tracks.markUnavailable(first.id);

  const tracks = s.playlists.tracks(pl.id);
  assert.equal(tracks.length, 2, 'the entry is still in the playlist');
  assert.equal(tracks[0].availability, 'unavailable');
  assert.equal(tracks[0].streamUrl, null);
  s.close();
});

test('playlists: deleting a playlist does not delete the tracks themselves', () => {
  const s = makeServices();
  const pl = s.playlists.create('Temp');
  s.playlists.addTracks(pl.id, makeTracks(3));
  s.playlists.remove(pl.id);
  assert.equal(s.tracks.count(), 3, 'tracks live in a shared dictionary');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM playlist_tracks').get().n, 0);
  s.close();
});

// ------------------------------------------------------------- favorites

test('favorites: adding twice cannot create a duplicate', () => {
  const s = makeServices();
  const track = makeTrack(1);
  assert.equal(s.favorites.add(track), true);
  assert.equal(s.favorites.add(track), false);
  assert.equal(s.favorites.count(), 1);
  s.close();
});

test('favorites: toggle flips both ways and reports which happened', () => {
  const s = makeServices();
  const track = makeTrack(1);
  assert.equal(s.favorites.toggle(track).favorited, true);
  assert.equal(s.favorites.has(track.id), true);
  assert.equal(s.favorites.toggle(track).favorited, false);
  assert.equal(s.favorites.has(track.id), false);
  s.close();
});

test('favorites: listing is newest first and ids() is cheap to check', () => {
  const s = makeServices();
  const tracks = makeTracks(3);
  for (const track of tracks) s.favorites.add(track);
  assert.equal(s.favorites.list().length, 3);
  const ids = s.favorites.ids();
  assert.ok(ids.has(tracks[0].id));
  assert.equal(ids.size, 3);
  s.close();
});

// --------------------------------------------------------------- history

test('history: a session is one row, updated in place as it plays', () => {
  const s = makeServices();
  const track = makeTrack(1);
  s.history.startSession(track);
  for (let seconds = 1; seconds <= 30; seconds += 1) s.history.updateSession(seconds);
  s.history.endSession({ listenedSeconds: 30, completed: true });

  assert.equal(s.history.count(), 1, 'thirty progress updates produced one row');
  const [entry] = s.history.list();
  assert.equal(entry.listenedSeconds, 30);
  assert.equal(entry.completed, true);
  s.close();
});

test('history: a track skipped after a moment is not recorded', () => {
  const s = makeServices();
  s.history.startSession(makeTrack(1));
  s.history.updateSession(1);
  s.history.endSession({ listenedSeconds: 1 });
  assert.equal(s.history.count(), 0);
  s.close();
});

test('history: disabling it stops recording immediately', () => {
  const s = makeServices();
  s.history.setEnabled(false);
  assert.equal(s.history.startSession(makeTrack(1)), null);
  assert.equal(s.history.count(), 0);
  s.close();
});

test('history: entries can be removed individually or all at once', () => {
  const s = makeServices();
  for (const track of makeTracks(3)) {
    s.history.startSession(track);
    s.history.endSession({ listenedSeconds: 30, completed: true });
  }
  assert.equal(s.history.count(), 3);
  const [first] = s.history.list();
  assert.equal(s.history.removeEntry(first.id), true);
  assert.equal(s.history.count(), 2);
  assert.equal(s.history.clear(), 2);
  assert.equal(s.history.count(), 0);
  s.close();
});

// ----------------------------------------------------------------- stats

test('stats: reports "no data" rather than a misleading zero', () => {
  const s = makeServices();
  const summary = s.stats.summary();
  assert.equal(summary.available, false);
  assert.equal(summary.plays, 0);
  assert.deepEqual(s.stats.topTracks(), []);
  s.close();
});

test('stats: aggregates plays, artists and genres from real history', () => {
  const s = makeServices();
  const tracks = makeTracks(3);
  // Track 1 twice, Track 2 once.
  for (const track of [tracks[0], tracks[0], tracks[1]]) {
    s.history.startSession(track);
    s.history.endSession({ listenedSeconds: 60, completed: true });
  }

  const summary = s.stats.summary();
  assert.equal(summary.available, true);
  assert.equal(summary.plays, 3);
  assert.equal(summary.uniqueTracks, 2);
  assert.equal(summary.seconds, 180);

  const top = s.stats.topTracks({ limit: 5 });
  assert.equal(top[0].track.title, 'Track 1');
  assert.equal(top[0].plays, 2);

  assert.ok(s.stats.topArtists().length >= 1);
  assert.ok(s.stats.topGenres().length >= 1);
  s.close();
});

test('stats: the activity series always covers the requested window', () => {
  const s = makeServices();
  const activity = s.stats.activity({ days: 14 });
  assert.equal(activity.length, 14);
  assert.ok(activity.every((day) => day.plays === 0));
  s.close();
});

// -------------------------------------------------------------- settings

test('settings: defaults apply, and valid changes persist', () => {
  const s = makeServices();
  assert.equal(s.settings.get('volume'), 70);
  s.settings.set('volume', 45);
  assert.equal(s.settings.get('volume'), 45);

  // A second service over the same database sees the stored value.
  const reopened = new SettingsService({ db: s.db, logger: nullLogger });
  assert.equal(reopened.get('volume'), 45);
  s.close();
});

test('settings: invalid values are refused with an explanation', () => {
  const s = makeServices();
  assert.throws(() => s.settings.set('theme', 'neon-pink'), ValidationError);
  assert.throws(() => s.settings.set('volume', 'loud'), ValidationError);
  assert.throws(() => s.settings.set('nonexistent', 1), ValidationError);
  assert.equal(s.settings.get('theme'), 'midnight', 'the old value is kept');
  s.close();
});

test('settings: integers are clamped rather than rejected', () => {
  const s = makeServices();
  assert.equal(s.settings.set('volume', 500), 100);
  assert.equal(s.settings.set('volume', -20), 0);
  s.close();
});

test('settings: a corrupt stored row falls back to the default', () => {
  const s = makeServices();
  s.db
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('theme', '"not-a-theme"', new Date().toISOString());
  const reopened = new SettingsService({ db: s.db, logger: nullLogger });
  assert.equal(reopened.get('theme'), 'midnight');
  s.close();
});

test('settings: cycle walks enums, booleans and integers', () => {
  const s = makeServices();
  assert.equal(s.settings.cycle('repeat', 1), 'one');
  assert.equal(s.settings.cycle('repeat', 1), 'queue');
  assert.equal(s.settings.cycle('repeat', 1), 'off', 'it wraps');
  assert.equal(s.settings.cycle('repeat', -1), 'queue', 'and goes backwards');
  assert.equal(s.settings.cycle('shuffle', 1), true);
  assert.equal(s.settings.cycle('volume', 1), 75);
  s.close();
});

test('settings: an environment override wins but is not written back', () => {
  const s = makeServices({ settings: { defaultProvider: 'mock' } });
  assert.equal(s.settings.get('defaultProvider'), 'mock');
  const stored = s.db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider'").get();
  assert.equal(stored, undefined, 'the env override left no row behind');
  s.close();
});

test('settings: reset restores every default', () => {
  const s = makeServices();
  s.settings.set('volume', 10);
  s.settings.set('theme', 'ember');
  s.settings.resetAll();
  assert.equal(s.settings.get('volume'), 70);
  assert.equal(s.settings.get('theme'), 'midnight');
  s.close();
});

// ----------------------------------------------------------------- cache

test('cache: stores, reads back and expires', () => {
  const s = makeServices();
  s.cache.set('archive', 'https://x/y', { hello: 'world' });
  assert.deepEqual(s.cache.get('archive', 'https://x/y'), { hello: 'world' });
  assert.equal(s.cache.get('archive', 'https://other'), null);
  assert.equal(s.cache.get('jamendo', 'https://x/y'), null, 'keys are provider-scoped');

  const stats = s.cache.stats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.bytes > 0);
  s.close();
});

test('cache: a TTL of zero disables it entirely', () => {
  const s = makeServices();
  s.cache.setTtlMinutes(0);
  assert.equal(s.cache.enabled, false);
  assert.equal(s.cache.set('archive', 'k', { a: 1 }), false);
  assert.equal(s.cache.get('archive', 'k'), null);
  s.close();
});

test('cache: expired rows are not served and are pruned', () => {
  const s = makeServices();
  const cache = new CacheService({ db: s.db, ttlMinutes: 60, logger: nullLogger });
  cache.set('archive', 'k', { a: 1 });
  // Backdate the row.
  s.db
    .prepare('UPDATE metadata_cache SET expires_at = ?')
    .run(new Date(Date.now() - 1000).toISOString());
  const fresh = new CacheService({ db: s.db, ttlMinutes: 60, logger: nullLogger });
  assert.equal(fresh.get('archive', 'k'), null);
  s.close();
});

// ------------------------------------------------------- smart playlists

test('smart playlists: report missing data instead of returning an empty list', () => {
  const s = makeServices();
  const smart = new SmartPlaylistService({
    db: s.db,
    tracks: s.tracks,
    favorites: s.favorites,
    history: s.history,
    playlists: s.playlists,
  });
  const result = smart.generate('recently-played');
  assert.equal(result.available, false);
  assert.match(result.reason, /listening history/);
  s.close();
});

test('smart playlists: build from real history and can be materialised', () => {
  const s = makeServices();
  const smart = new SmartPlaylistService({
    db: s.db,
    tracks: s.tracks,
    favorites: s.favorites,
    history: s.history,
    playlists: s.playlists,
  });
  for (const track of makeTracks(4)) {
    s.history.startSession(track);
    s.history.endSession({ listenedSeconds: 60, completed: true });
  }

  const generated = smart.generate('recently-played');
  assert.equal(generated.available, true);
  assert.equal(generated.tracks.length, 4);

  const saved = smart.materialise('recently-played');
  assert.equal(saved.created, true);
  assert.equal(saved.playlist.kind, 'smart');
  assert.equal(saved.playlist.trackCount, 4);

  // Re-running replaces the same playlist rather than making another.
  smart.materialise('recently-played');
  assert.equal(s.playlists.list().filter((p) => p.kind === 'smart').length, 1);
  s.close();
});

test('smart playlists: favourite-artists uses your actual favourites', () => {
  const s = makeServices();
  const smart = new SmartPlaylistService({
    db: s.db,
    tracks: s.tracks,
    favorites: s.favorites,
    history: s.history,
    playlists: s.playlists,
  });
  const tracks = makeTracks(6);
  s.tracks.upsertAll(tracks);
  s.favorites.add(tracks[0]); // Artist 2

  const result = smart.generate('favorite-artists');
  assert.equal(result.available, true);
  assert.ok(result.tracks.every((t) => t.artist === tracks[0].artist));
  s.close();
});

// --------------------------------------------------------------- session

test('session: a queue survives a restart, dropping tracks that vanished', () => {
  const s = makeServices();
  const session = new SessionService({ db: s.db, tracks: s.tracks, logger: nullLogger });

  const queue = new Queue();
  queue.replace(makeTracks(4), 2);
  queue.setRepeat('queue');
  queue.setShuffle(true);
  assert.equal(session.save(queue), true);

  const restored = new Queue();
  assert.equal(session.restore(restored), 4);
  assert.equal(restored.length, 4);
  assert.equal(restored.repeat, 'queue');
  assert.equal(restored.shuffle, true);
  assert.ok(restored.current);
  s.close();
});

test('session: only stable ids are persisted, never stream URLs', () => {
  const s = makeServices();
  const session = new SessionService({ db: s.db, tracks: s.tracks, logger: nullLogger });
  const queue = new Queue();
  queue.replace(makeTracks(2), 0);
  session.save(queue);

  const row = s.db.prepare('SELECT payload FROM playback_state WHERE id = 1').get();
  assert.ok(!row.payload.includes('https://'), 'the snapshot holds ids, not URLs');
  s.close();
});

test('session: an empty or missing snapshot restores nothing, quietly', () => {
  const s = makeServices();
  const session = new SessionService({ db: s.db, tracks: s.tracks, logger: nullLogger });
  assert.equal(session.restore(new Queue()), 0);

  s.db
    .prepare('INSERT INTO playback_state (id, payload, updated_at) VALUES (1, ?, ?)')
    .run('{not json', new Date().toISOString());
  assert.equal(session.restore(new Queue()), 0, 'corrupt state does not crash the boot');
  s.close();
});

// ---------------------------------------------------- across a "restart"

test('persistence: playlists, favourites and history survive reopening the file', () => {
  const dir = tempDir();
  const file = path.join(dir.path, 'termify.db');

  {
    const { db } = openDatabase({ file, logger: nullLogger });
    const tracks = new TrackRepository(db);
    const playlists = new PlaylistService({ db, tracks });
    const favorites = new FavoritesService({ db, tracks });
    const history = new HistoryService({ db, tracks });
    const settings = new SettingsService({ db, logger: nullLogger });

    const pl = playlists.create('Persisted', { description: 'should survive' });
    playlists.addTracks(pl.id, makeTracks(3));
    favorites.add(makeTrack(1));
    history.startSession(makeTrack(2));
    history.endSession({ listenedSeconds: 42, completed: true });
    settings.set('theme', 'ember');
    settings.set('volume', 33);
    db.close();
  }

  {
    const { db, recovered } = openDatabase({ file, logger: nullLogger });
    assert.equal(recovered, null, 'the file reopened cleanly');
    const tracks = new TrackRepository(db);
    const playlists = new PlaylistService({ db, tracks });
    const favorites = new FavoritesService({ db, tracks });
    const history = new HistoryService({ db, tracks });
    const stats = new StatsService({ db, tracks });
    const settings = new SettingsService({ db, logger: nullLogger });

    const [pl] = playlists.list();
    assert.equal(pl.name, 'Persisted');
    assert.equal(pl.trackCount, 3);
    assert.deepEqual(
      playlists.tracks(pl.id).map((t) => t.title),
      ['Track 1', 'Track 2', 'Track 3'],
      'order survived too',
    );
    assert.equal(favorites.count(), 1);
    assert.equal(history.count(), 1);
    assert.equal(stats.summary().seconds, 42);
    assert.equal(settings.get('theme'), 'ember');
    assert.equal(settings.get('volume'), 33);
    db.close();
  }

  dir.cleanup();
});

test('persistence: a track referenced by a playlist is not pruned as an orphan', () => {
  const s = makeServices();
  const pl = s.playlists.create('Keep');
  s.playlists.addTracks(pl.id, makeTracks(2));
  s.tracks.upsert(makeTrack(99)); // referenced by nothing

  assert.equal(s.tracks.count(), 3);
  assert.equal(s.tracks.pruneOrphans(), 1);
  assert.equal(s.tracks.count(), 2);
  assert.equal(s.playlists.get(pl.id).trackCount, 2);
  s.close();
});

test('persistence: upserting a track merges rather than losing known fields', () => {
  const s = makeServices();
  s.tracks.upsert(
    createTrack({ provider: 'p', providerId: '1', title: 'A', duration: 200, genre: 'jazz' }),
  );
  // A later provider response omits the duration and genre.
  s.tracks.upsert(createTrack({ provider: 'p', providerId: '1', title: 'A (remaster)' }));

  const stored = s.tracks.get('p:1');
  assert.equal(stored.title, 'A (remaster)', 'new values win');
  assert.equal(stored.duration, 200, 'but known metadata is not erased');
  assert.equal(stored.genre, 'jazz');
  s.close();
});
