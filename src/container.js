import { loadEnv } from './config/env.js';
import { resolvePaths, ensurePaths } from './config/paths.js';
import { Logger, nullLogger } from './core/logger.js';
import { setListenerErrorHandler } from './core/events.js';
import { openDatabase } from './db/database.js';
import { TrackRepository } from './services/trackRepository.js';
import { SettingsService } from './services/settingsService.js';
import { CacheService } from './services/cacheService.js';
import { PlaylistService } from './services/playlistService.js';
import { FavoritesService } from './services/favoritesService.js';
import { HistoryService } from './services/historyService.js';
import { StatsService } from './services/statsService.js';
import { SmartPlaylistService } from './services/smartPlaylistService.js';
import { SessionService } from './services/sessionService.js';
import { SearchService } from './services/searchService.js';
import { LyricsService } from './services/lyricsService.js';
import { ArtworkService } from './services/artworkService.js';
import { ProviderRegistry } from './providers/registry.js';
import { PlaybackEngine } from './playback/engine.js';
import { createAdapter, detectAdapters } from './playback/adapters/index.js';

/**
 * Composition root.
 *
 * Every dependency is constructed here and injected downward; no module
 * reaches for a singleton. Tests build their own container with an in-memory
 * database and the null adapter, which is why this function takes overrides.
 *
 * @param {{ demo?: boolean, dataDir?: string, dbFile?: string, env?: object,
 *           adapter?: import('./playback/adapters/base.js').AudioAdapter,
 *           logger?: any, random?: () => number }} [options]
 */
export async function createContainer(options = {}) {
  const env = options.env ?? loadEnv();
  const paths = ensurePaths(resolvePaths({ dataDir: options.dataDir ?? env.dataDir }));

  const logger =
    options.logger ?? new Logger({ file: paths.logFile, level: env.logLevel ?? 'warn' });
  setListenerErrorHandler((error, event) =>
    logger.error('listener threw', { event, message: error?.message, stack: error?.stack }),
  );

  const { db, recovered } = openDatabase({ file: options.dbFile ?? paths.databaseFile, logger });

  const tracks = new TrackRepository(db);
  const settings = new SettingsService({
    db,
    logger,
    // env wins over stored values, but is never written back
    overrides: {
      defaultProvider: options.demo ? 'mock' : env.defaultProvider,
      musicDir: env.musicDir,
      audioBackend: env.audioBackend,
    },
  });

  const cache = new CacheService({
    db,
    ttlMinutes: settings.get('metadataCacheTtlMinutes'),
    logger,
  });
  cache.prune();

  const playlists = new PlaylistService({ db, tracks });
  const favorites = new FavoritesService({ db, tracks });
  const history = new HistoryService({ db, tracks, enabled: settings.get('historyEnabled') });
  const stats = new StatsService({ db, tracks });
  const smartPlaylists = new SmartPlaylistService({
    db,
    tracks,
    favorites,
    history,
    playlists,
  });
  const session = new SessionService({ db, tracks, logger });

  const registry = ProviderRegistry.standard({
    env,
    settings,
    cache,
    cacheDir: paths.cacheDir,
    logger,
    demo: Boolean(options.demo),
  });

  const search = new SearchService({ registry, settings, tracks, logger });
  const lyrics = new LyricsService({ settings, logger });
  const artwork = new ArtworkService({ cacheDir: paths.artworkCacheDir, logger });

  const { adapter, fallbackReason } = options.adapter
    ? { adapter: options.adapter, fallbackReason: null }
    : createAdapter({ preferred: settings.get('audioBackend'), logger });

  const playback = new PlaybackEngine({
    adapter,
    registry,
    history,
    settings,
    logger,
    random: options.random,
  });

  // Keep services in sync with settings changes the user makes at runtime.
  settings.on('change', ({ key, value }) => {
    if (key === 'metadataCacheTtlMinutes') cache.setTtlMinutes(value);
    if (key === 'historyEnabled') history.setEnabled(value);
    if (key === 'musicDir' && registry.has('local')) registry.get('local').setRoot(value || null);
    if (key === 'lyricsSource') lyrics.clear();
  });

  const restoredTracks = session.restore(playback.queue);

  const container = {
    env,
    paths,
    logger,
    db,
    tracks,
    settings,
    cache,
    playlists,
    favorites,
    history,
    stats,
    smartPlaylists,
    session,
    registry,
    search,
    lyrics,
    artwork,
    playback,
    demo: Boolean(options.demo),
    boot: {
      databaseRecovered: recovered,
      audioFallbackReason: fallbackReason,
      audioBackends: detectAdapters(),
      restoredTracks,
    },
    async dispose() {
      try {
        session.save(playback.queue);
      } catch {
        /* never block shutdown on persistence */
      }
      await playback.dispose();
      search.cancel();
      await registry.dispose();
      try {
        db.close();
      } catch {
        /* already closed */
      }
      logger.close?.();
    },
  };

  return container;
}

export { nullLogger };
