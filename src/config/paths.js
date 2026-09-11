import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Platform-appropriate application directories.
 * macOS gets ~/Library/Application Support, everything else follows XDG.
 */
function defaultDataDir() {
  if (process.env.TERMIFY_DATA_DIR) return path.resolve(process.env.TERMIFY_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'termify');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'termify');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'termify');
}

function defaultCacheDir(dataDir) {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'termify');
  }
  if (process.platform === 'linux' && process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, 'termify');
  }
  return path.join(dataDir, 'cache');
}

/**
 * @param {{ dataDir?: string }} [overrides]
 */
export function resolvePaths(overrides = {}) {
  const dataDir = overrides.dataDir ? path.resolve(overrides.dataDir) : defaultDataDir();
  const cacheDir = overrides.cacheDir ? path.resolve(overrides.cacheDir) : defaultCacheDir(dataDir);
  return {
    dataDir,
    cacheDir,
    databaseFile: path.join(dataDir, 'termify.db'),
    logFile: path.join(dataDir, 'termify.log'),
    artworkCacheDir: path.join(cacheDir, 'artwork'),
    lyricsCacheDir: path.join(cacheDir, 'lyrics'),
  };
}

/** Create every directory the app writes to. Safe to call repeatedly. */
export function ensurePaths(paths) {
  for (const dir of [paths.dataDir, paths.cacheDir, paths.artworkCacheDir, paths.lyricsCacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}
