import process from 'node:process';
import fs from 'node:fs';
import { loadEnv } from './config/env.js';
import { resolvePaths, ensurePaths } from './config/paths.js';
import { detectAdapters } from './playback/adapters/index.js';
import { detectCapabilities } from './ui/theme.js';
import { createContainer } from './container.js';
import { VERSION } from './ui/constants.js';

/**
 * `termify --doctor`
 *
 * A non-interactive environment report. This is what to run first when
 * something does not work: it says exactly which providers are configured,
 * which audio backends exist, and whether the database opens - without
 * starting the UI or needing a TTY.
 *
 * Exit code 0 means Termify can play audio; 1 means it cannot.
 */
export async function runDoctor({ dataDir } = {}) {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  const env = loadEnv();
  const paths = resolvePaths({ dataDir: dataDir ?? env.dataDir });
  const capabilities = detectCapabilities(process.stdout, process.env);

  out(`termify ${VERSION} - environment check`);
  out('');

  out('runtime');
  out(`  node            ${process.version}`);
  out(`  platform        ${process.platform} ${process.arch}`);
  out(`  tty             ${capabilities.isTTY ? 'yes' : 'no (the UI needs one)'}`);
  out(
    `  terminal        ${capabilities.columns}x${capabilities.rows}, ${capabilities.colorDepth}-bit colour`,
  );
  out(`  unicode         ${capabilities.unicode ? 'yes' : 'no (ASCII fallback will be used)'}`);
  out('');

  out('audio backends');
  const backends = detectAdapters();
  for (const backend of backends) {
    out(`  ${backend.id.padEnd(15)} ${backend.available ? 'available' : 'not found'}`);
  }
  const playable = backends.find((b) => b.available && b.id !== 'null');
  if (!playable) {
    out('  -> no real audio backend found. Install one:');
    out('       brew install mpv        (best: true pause, live volume)');
    out('       brew install ffmpeg     (streams anything, used by ffplay)');
  }
  out('');

  out('storage');
  let dbOk = false;
  try {
    ensurePaths(paths);
    out(`  data dir        ${paths.dataDir}`);
    out(`  cache dir       ${paths.cacheDir}`);
    const writable = checkWritable(paths.dataDir);
    out(`  writable        ${writable ? 'yes' : 'NO - check permissions'}`);
    dbOk = writable;
  } catch (error) {
    out(`  ERROR           ${error.message}`);
  }
  out('');

  out('providers');
  let container;
  try {
    container = await createContainer({ dataDir });
    for (const provider of container.registry.describe()) {
      const state = provider.configured
        ? provider.isLive
          ? 'ready'
          : 'ready (sample data)'
        : `not configured - ${provider.reason}`;
      out(`  ${provider.id.padEnd(15)} ${state}`);
      if (!provider.configured && provider.hint) out(`  ${' '.repeat(15)} ${provider.hint}`);
    }
    out('');
    out('database');
    const version = container.db.pragma('user_version', { simple: true });
    out(`  file            ${container.paths.databaseFile}`);
    out(`  schema version  ${version}`);
    out(`  tracks          ${container.tracks.count()}`);
    out(`  playlists       ${container.playlists.list().length}`);
    out(`  favorites       ${container.favorites.count()}`);
    out(`  history entries ${container.history.count()}`);
    if (container.boot.databaseRecovered) {
      out(
        `  NOTE            previous database was corrupt, kept at ${container.boot.databaseRecovered}`,
      );
    }
    dbOk = true;
  } catch (error) {
    out(`  ERROR           ${error.message}`);
    dbOk = false;
  } finally {
    await container?.dispose();
  }

  out('');
  const ok = Boolean(playable) && dbOk;
  out(ok ? 'Result: ready to play.' : 'Result: not ready - see the notes above.');
  if (!env.jamendo.clientId) {
    out('');
    out('Optional: set JAMENDO_CLIENT_ID in .env to enable the Jamendo provider.');
    out('The Internet Archive provider needs no credentials and is enabled by default.');
  }
  return ok ? 0 : 1;
}

function checkWritable(dir) {
  const probe = `${dir}/.termify-write-test`;
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
