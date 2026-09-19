import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderToString } from 'ink';
import { h } from '../../src/ui/h.js';
import { App } from '../../src/ui/App.js';
import { createContainer } from '../../src/container.js';
import { NullAdapter } from '../../src/playback/adapters/nullAdapter.js';
import { detectAdapters, createAdapter } from '../../src/playback/adapters/index.js';
import { LocalProvider, AUDIO_EXTENSIONS } from '../../src/providers/localProvider.js';
import { readEnv } from '../../src/config/env.js';
import { resolvePaths } from '../../src/config/paths.js';
import { NAV_ITEMS } from '../../src/ui/components/Sidebar.js';
import { tempDir, nullLogger } from '../helpers.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
const strip = (value) => value.replace(ANSI, '');

/** A container on a throwaway data dir with a silent audio backend. */
async function boot(options = {}) {
  const dir = tempDir('termify-app-');
  const container = await createContainer({
    demo: true,
    dataDir: dir.path,
    adapter: new NullAdapter({ autoTick: false }),
    logger: nullLogger,
    ...options,
  });
  container.capabilities = {
    columns: 120,
    rows: 40,
    colorDepth: 8,
    unicode: true,
    reducedMotion: true,
    isTTY: true,
    compact: false,
    tiny: false,
  };
  return {
    container,
    dir,
    async close() {
      await container.dispose();
      dir.cleanup();
    },
  };
}

/** Render the app at a given size and return the plain text. */
function renderApp(container, { columns = 120, rows = 40, initialView = 'home' } = {}) {
  const previous = { columns: process.stdout.columns, rows: process.stdout.rows };
  process.stdout.columns = columns;
  process.stdout.rows = rows;
  container.capabilities = { ...container.capabilities, columns, rows };
  try {
    return strip(renderToString(h(App, { container, onExit: () => {}, initialView })));
  } finally {
    process.stdout.columns = previous.columns;
    process.stdout.rows = previous.rows;
  }
}

// ------------------------------------------------------------- lifecycle

test('app: the container boots with every service wired', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;

  for (const key of [
    'settings',
    'playlists',
    'favorites',
    'history',
    'stats',
    'smartPlaylists',
    'registry',
    'search',
    'playback',
    'lyrics',
    'artwork',
    'cache',
    'session',
  ]) {
    assert.ok(c[key], `missing service: ${key}`);
  }
  assert.ok(c.paths.dataDir);
  assert.equal(c.demo, true);
  assert.ok(Array.isArray(c.boot.audioBackends));
});

test('app: the data directory is created and holds the database', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  assert.ok(fs.existsSync(app.container.paths.dataDir));
  assert.ok(fs.existsSync(app.container.paths.databaseFile));
});

test('app: dispose is idempotent and closes the database', async () => {
  const app = await boot();
  await app.container.dispose();
  await app.container.dispose();
  assert.equal(app.container.db.open, false);
  app.dir.cleanup();
});

test('app: the queue is saved on dispose and restored on the next boot', async () => {
  const dir = tempDir('termify-resume-');

  const first = await createContainer({
    demo: true,
    dataDir: dir.path,
    adapter: new NullAdapter({ autoTick: false }),
    logger: nullLogger,
  });
  const { tracks } = await first.registry.get('mock').featured('all', { limit: 4 });
  first.playback.enqueue(tracks);
  assert.equal(first.playback.queue.length, 4);
  await first.dispose();

  const second = await createContainer({
    demo: true,
    dataDir: dir.path,
    adapter: new NullAdapter({ autoTick: false }),
    logger: nullLogger,
  });
  assert.equal(second.boot.restoredTracks, 4, 'the queue came back');
  assert.equal(second.playback.queue.length, 4);
  await second.dispose();
  dir.cleanup();
});

test('app: changing a setting reconfigures the services that depend on it', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;

  c.settings.set('metadataCacheTtlMinutes', 0);
  assert.equal(c.cache.enabled, false);

  c.settings.set('historyEnabled', false);
  assert.equal(c.history.enabled, false);

  c.settings.set('musicDir', '/tmp/some-music');
  assert.match(c.registry.get('local').root, /some-music$/);
});

// ---------------------------------------------------------------- render

test('app: every view renders without throwing', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;

  const { tracks } = await c.registry.get('mock').featured('all', { limit: 8 });
  c.tracks.upsertAll(tracks);
  c.favorites.add(tracks[0]);
  const pl = c.playlists.create('Render test');
  c.playlists.addTracks(pl.id, tracks.slice(0, 3));
  c.history.startSession(tracks[1]);
  c.history.endSession({ listenedSeconds: 60, completed: true });
  c.playback.enqueue(tracks);

  for (const item of NAV_ITEMS) {
    const output = renderApp(c, { initialView: item.id });
    assert.ok(output.includes('termify'), `${item.id}: header missing`);
    assert.ok(output.split('\n').length > 10, `${item.id}: frame too short`);
  }
});

test('app: no rendered line exceeds the terminal width', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;
  const { tracks } = await c.registry.get('mock').featured('all', { limit: 20 });
  c.tracks.upsertAll(tracks);
  c.playback.enqueue(tracks);

  for (const columns of [60, 80, 100, 120, 160]) {
    for (const view of ['home', 'queue', 'playlists', 'settings', 'discover']) {
      const output = renderApp(c, { columns, rows: 32, initialView: view });
      const overflow = output.split('\n').filter((line) => line.length > columns);
      assert.equal(overflow.length, 0, `${view} at ${columns} columns wrapped:\n${overflow[0]}`);
    }
  }
});

test('app: a terminal below the minimum shows a resize prompt, not a broken frame', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const output = renderApp(app.container, { columns: 40, rows: 10 });
  assert.match(output, /too small/i);
  assert.match(output, /40x10/);
});

test('app: demo mode is labelled everywhere it shows data', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;
  const { tracks } = await c.registry.get('mock').featured('all', { limit: 5 });
  c.tracks.upsertAll(tracks);
  c.favorites.add(tracks[0]);

  const home = renderApp(c, { initialView: 'home' });
  assert.match(home, /DEMO/, 'the header carries a demo badge');
  assert.match(home, /SAMPLE/, 'sample rows are flagged');
});

test('app: an empty library shows guidance rather than blank panels', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;

  assert.match(renderApp(c, { initialView: 'home' }), /Nothing played yet/);
  assert.match(renderApp(c, { initialView: 'queue' }), /queue is empty/i);
  assert.match(renderApp(c, { initialView: 'favorites' }), /No favorites yet/);
  assert.match(renderApp(c, { initialView: 'history' }), /No listening history/);
  assert.match(renderApp(c, { initialView: 'playlists' }), /Create your first playlist/);
  assert.match(renderApp(c, { initialView: 'stats' }), /No listening data yet/);
});

test('app: the ASCII theme renders with no non-ASCII characters', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const c = app.container;
  c.settings.set('unicode', false);
  const { tracks } = await c.registry.get('mock').featured('all', { limit: 5 });
  c.tracks.upsertAll(tracks);
  c.playback.enqueue(tracks);

  const output = renderApp(c, { initialView: 'queue' });
  // eslint-disable-next-line no-control-regex
  const nonAscii = output.match(/[^\x00-\x7F]/g) ?? [];
  assert.equal(nonAscii.length, 0, `found non-ASCII: ${[...new Set(nonAscii)].join(' ')}`);
});

// ------------------------------------------------------------- providers

test('app: with no credentials the archive provider is still ready', async (t) => {
  const app = await boot({ demo: false, env: readEnv({}) });
  t.after(() => app.close());
  const rows = app.container.registry.describe();
  const archive = rows.find((r) => r.id === 'archive');
  assert.equal(archive.configured, true, 'no API key needed');
  assert.equal(archive.isLive, true);
});

test('app: missing credentials degrade gracefully instead of failing at boot', async (t) => {
  const app = await boot({ demo: false, env: readEnv({ TERMIFY_DEFAULT_PROVIDER: 'jamendo' }) });
  t.after(() => app.close());
  const { provider, fallbackReason } = app.container.registry.select('jamendo');
  assert.notEqual(provider.id, 'jamendo');
  assert.match(fallbackReason, /not configured/);
});

// ------------------------------------------------------------ local files

test('local provider: scans a folder, reads what it can and skips the rest', async (t) => {
  const dir = tempDir('termify-music-');
  t.after(() => dir.cleanup());

  fs.mkdirSync(path.join(dir.path, 'Album'), { recursive: true });
  // Not real audio - the point is that unreadable tags must not crash a scan.
  fs.writeFileSync(path.join(dir.path, 'Album', '01 First Song.mp3'), 'not really audio');
  fs.writeFileSync(path.join(dir.path, 'Album', '02 Second Song.flac'), 'not really audio');
  fs.writeFileSync(path.join(dir.path, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(dir.path, '.hidden.mp3'), 'ignored');

  const provider = new LocalProvider({ musicDir: dir.path, logger: nullLogger });
  const result = await provider.search({ text: 'song' });

  assert.equal(result.tracks.length, 2, 'only the audio files were picked up');
  assert.ok(result.tracks.every((track) => track.localPath.startsWith(dir.path)));
  assert.ok(
    result.tracks.some((track) => track.title === '01 First Song'),
    'the filename is the fallback title',
  );
  assert.equal(result.tracks[0].album, 'Album', 'the folder is the fallback album');
  assert.equal(result.tracks[0].provider, 'local');
});

test('local provider: a missing file is reported unavailable on resolve', async (t) => {
  const dir = tempDir('termify-music-');
  t.after(() => dir.cleanup());
  const file = path.join(dir.path, 'song.mp3');
  fs.writeFileSync(file, 'x');

  const provider = new LocalProvider({ musicDir: dir.path, logger: nullLogger });
  const { tracks } = await provider.search({ text: 'song' });
  fs.unlinkSync(file);

  const resolved = await provider.resolve(tracks[0]);
  assert.equal(resolved.availability, 'unavailable');
});

test('local provider: a bad folder path fails with a useful message', async () => {
  const provider = new LocalProvider({ musicDir: '/definitely/not/here', logger: nullLogger });
  await assert.rejects(
    () => provider.search({ text: 'x' }),
    (error) => {
      assert.match(error.userMessage, /folder not found/i);
      return true;
    },
  );
});

test('local provider: the supported-extension list covers the common formats', () => {
  for (const ext of ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.opus']) {
    assert.ok(AUDIO_EXTENSIONS.has(ext), `missing ${ext}`);
  }
});

// --------------------------------------------------------------- adapters

test('adapters: detection reports what this machine actually has', () => {
  const detected = detectAdapters();
  assert.deepEqual(
    detected.map((a) => a.id),
    ['mpv', 'ffplay', 'afplay', 'null'],
    'preference order is stable',
  );
  assert.equal(
    detected.find((a) => a.id === 'null').available,
    true,
    'the silent adapter is always available so the app can always start',
  );
});

test('adapters: requesting a missing backend falls back and says why', () => {
  const { adapter, fallbackReason } = createAdapter({ preferred: 'not-a-backend' });
  assert.ok(adapter);
  assert.match(fallbackReason, /unknown backend/);
});

test('adapters: every adapter declares its real capabilities', () => {
  for (const { id } of detectAdapters()) {
    const { adapter } = createAdapter({ preferred: id });
    const caps = adapter.capabilities;
    for (const flag of ['remoteStreams', 'seek', 'volume', 'truePause', 'position']) {
      assert.equal(typeof caps[flag], 'boolean', `${adapter.id}.${flag}`);
    }
  }
});

// ------------------------------------------------------------------- env

test('env: reads and defaults the documented variables', () => {
  const env = readEnv({
    JAMENDO_CLIENT_ID: '  abc  ',
    TERMIFY_HTTP_TIMEOUT_MS: '5000',
    TERMIFY_LOG_LEVEL: 'debug',
  });
  assert.equal(env.jamendo.clientId, 'abc', 'values are trimmed');
  assert.equal(env.httpTimeoutMs, 5000);
  assert.equal(env.logLevel, 'debug');

  const empty = readEnv({});
  assert.equal(empty.jamendo.clientId, '');
  assert.equal(empty.httpTimeoutMs, 12000, 'a sane default');
  assert.equal(empty.logLevel, 'warn');
  assert.equal(readEnv({ TERMIFY_HTTP_TIMEOUT_MS: 'nonsense' }).httpTimeoutMs, 12000);
});

test('paths: are platform-appropriate and overridable', () => {
  const overridden = resolvePaths({ dataDir: '/tmp/custom-termify' });
  assert.equal(overridden.dataDir, '/tmp/custom-termify');
  assert.match(overridden.databaseFile, /termify\.db$/);

  const defaults = resolvePaths({});
  assert.ok(path.isAbsolute(defaults.dataDir));
  assert.ok(path.isAbsolute(defaults.cacheDir));
});
