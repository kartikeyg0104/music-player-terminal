#!/usr/bin/env node
/**
 * Startup verification.
 *
 * Boots the real application against a temporary data directory and a silent
 * audio adapter, renders every screen to a string, and asserts each one
 * produced sane output. It is the answer to "does it actually start?" without
 * needing a human at a terminal, and it runs in CI.
 *
 * Usage: npm run verify
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToString } from 'ink';
import { h } from '../src/ui/h.js';
import { App } from '../src/ui/App.js';
import { createContainer } from '../src/container.js';
import { NullAdapter } from '../src/playback/adapters/nullAdapter.js';
import { createTheme, detectCapabilities } from '../src/ui/theme.js';
import { NAV_ITEMS } from '../src/ui/components/Sidebar.js';
import { MIN_COLUMNS, MIN_ROWS } from '../src/ui/constants.js';

const SIZES = [
  { columns: 120, rows: 40, label: 'wide' },
  { columns: 96, rows: 30, label: 'standard' },
  { columns: 72, rows: 24, label: 'compact' },
  { columns: 50, rows: 14, label: 'too small' },
];

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termify-verify-'));
  let failures = 0;
  const report = (ok, label, detail = '') => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  };

  console.log('termify startup verification');
  console.log(`  data dir: ${dataDir}\n`);

  console.log('container');
  const container = await createContainer({
    demo: true,
    dataDir,
    adapter: new NullAdapter({ autoTick: false }),
  });
  container.capabilities = {
    ...detectCapabilities(process.stdout, process.env),
    columns: 120,
    rows: 40,
    isTTY: true,
    colorDepth: 8,
  };
  report(Boolean(container.db), 'database opens');
  report(container.db.pragma('user_version', { simple: true }) > 0, 'migrations applied');
  report(container.registry.all().length >= 4, 'providers registered');
  report(Boolean(container.playback), 'playback engine built');

  console.log('\nseed data');
  const result = await container.registry.get('mock').search({ text: '', page: 1, limit: 5 });
  const seeded = await container.registry.get('mock').featured('all', { limit: 5 });
  const tracks = seeded.tracks;
  report(tracks.length > 0, 'demo provider returns tracks', `${tracks.length} tracks`);
  report(
    tracks.every((t) => t.isSample),
    'demo tracks are flagged as samples',
  );
  container.tracks.upsertAll(tracks);
  const playlist = container.playlists.create('Verification list');
  container.playlists.addTracks(playlist.id, tracks.slice(0, 3));
  container.favorites.add(tracks[0]);
  container.history.startSession(tracks[0]);
  container.history.updateSession(30);
  container.history.endSession({ listenedSeconds: 30, completed: true });
  container.playback.enqueue(tracks.slice(0, 4));
  report(container.playlists.list().length === 1, 'playlist persisted');
  report(container.favorites.count() === 1, 'favorite persisted');
  report(container.history.count() === 1, 'history recorded');
  report(container.playback.queue.length === 4, 'queue populated');
  void result;

  console.log('\nrendering');
  for (const size of SIZES) {
    container.capabilities = { ...container.capabilities, columns: size.columns, rows: size.rows };
    const original = { columns: process.stdout.columns, rows: process.stdout.rows };
    process.stdout.columns = size.columns;
    process.stdout.rows = size.rows;
    try {
      const output = renderToString(h(App, { container, onExit: () => {} }));
      const lines = output.split('\n');
      const tooSmall = size.columns < MIN_COLUMNS || size.rows < MIN_ROWS;
      if (tooSmall) {
        report(/too small/i.test(output), `${size.label} shows the resize prompt`);
      } else {
        report(output.includes('termify'), `${size.label} renders the header`);
        report(lines.length > 5, `${size.label} renders a full frame`, `${lines.length} lines`);
        const overflow = lines.filter((l) => stripAnsi(l).length > size.columns + 1);
        report(
          overflow.length === 0,
          `${size.label} respects the terminal width`,
          overflow.length ? `${overflow.length} long lines` : '',
        );
      }
    } catch (error) {
      report(false, `${size.label} render`, error.message);
    } finally {
      process.stdout.columns = original.columns;
      process.stdout.rows = original.rows;
    }
  }

  console.log('\nthemes and glyph fallback');
  for (const themeId of ['midnight', 'mono', 'ember', 'forest']) {
    const theme = createTheme({ theme: themeId, unicode: true });
    report(Boolean(theme.colors.accent), `theme ${themeId} builds`);
  }
  const ascii = createTheme({ unicode: false });
  report(
    // eslint-disable-next-line no-control-regex
    !/[^\x00-\x7F]/.test(Object.values(ascii.glyphs).flat().join('')),
    'ascii glyph set is pure ASCII',
  );

  console.log('\nviews');
  process.stdout.columns = 120;
  process.stdout.rows = 40;
  container.capabilities = { ...container.capabilities, columns: 120, rows: 40 };
  for (const item of NAV_ITEMS) {
    try {
      // `initialView` targets the screen directly - `startView` only accepts
      // the handful of screens that make sense as a launch destination.
      const output = renderToString(h(App, { container, onExit: () => {}, initialView: item.id }));
      const lines = output.split('\n').filter((line) => line.trim());
      report(lines.length > 8, `view ${item.id} renders`, `${lines.length} lines`);
    } catch (error) {
      report(false, `view ${item.id}`, error.message);
    }
  }

  console.log('\nshutdown');
  await container.dispose();
  report(true, 'container disposed cleanly');
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? 'All startup checks passed.' : `${failures} check(s) failed.`}`,
  );
  return failures === 0 ? 0 : 1;
}

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('verification crashed:', error);
    process.exitCode = 1;
  });
