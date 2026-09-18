import { useApp, useInput, useWindowSize } from 'ink';
import { box, text, h, React } from './h.js';
import { createTheme } from './theme.js';
import { Header } from './components/Header.js';
import { Sidebar, CompactNav, NAV_ITEMS } from './components/Sidebar.js';
import { NowPlaying } from './components/NowPlaying.js';
import { KeyHintBar, StatusBlock } from './components/primitives.js';
import { ToastStack, useToasts } from './components/Toasts.js';
import { homeRows } from './views/HomeView.js';
import { parseQuery } from './views/SearchView.js';
import { buildSettingsRows } from './views/SettingsView.js';
import { buildRail, firstSelectableRailIndex } from './views/DiscoverView.js';
import { HelpView } from './views/HelpView.js';
import { ModalLayer } from './components/Modal.js';
import { renderView } from './render.js';
import { handleViewInput } from './keymap.js';
import { createActions, renderModal } from './actions.js';
import { VERSION, MIN_COLUMNS, MIN_ROWS, COMPACT_BREAKPOINT } from './constants.js';
import {
  useServiceState,
  useListCursor,
  useTicker,
  useDebouncedValue,
  useConnectionStatus,
  useLatest,
} from './hooks.js';
import { matchesQuery } from '../core/util.js';
import { PLAYBACK_STATE } from '../playback/engine.js';
import { LevelAnalyser } from '../playback/levelAnalyser.js';
import { playbackSource } from '../core/track.js';

/**
 * Root component.
 *
 * Owns three things and delegates everything else:
 *   1. Layout - header, nav, content, Now Playing, hints, toasts.
 *   2. Focus - which pane receives keys, and whether a text field has them.
 *   3. Command dispatch - translating a key into a service call.
 *
 * Views are pure renderers: they receive data and cursors, and render. No
 * view touches a service directly, which is why they can be rendered in a
 * test with fixture data.
 */
export function App({ container, onExit, initialView }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const {
    playback,
    search: searchService,
    settings,
    playlists,
    favorites,
    history,
    stats,
    smartPlaylists,
    registry,
    lyrics: lyricsService,
    artwork,
    cache,
    paths,
    demo,
    boot,
  } = container;

  // ------------------------------------------------------------ settings
  const settingsSnapshot = useServiceState(settings, () => settings.all());
  const theme = React.useMemo(
    () =>
      createTheme({
        theme: settingsSnapshot.theme,
        unicode: settingsSnapshot.unicode && container.capabilities.unicode,
        animations: settingsSnapshot.animations && !container.capabilities.reducedMotion,
        colorDepth: container.capabilities.colorDepth,
      }),
    [
      settingsSnapshot.theme,
      settingsSnapshot.unicode,
      settingsSnapshot.animations,
      container.capabilities,
    ],
  );

  // --------------------------------------------------------------- state
  const [view, setView] = React.useState(initialView ?? settingsSnapshot.startView ?? 'home');
  const [focusPane, setFocusPane] = React.useState('content'); // 'nav' | 'content'
  const [navIndex, setNavIndex] = React.useState(() =>
    Math.max(
      0,
      NAV_ITEMS.findIndex((i) => i.id === (initialView ?? settingsSnapshot.startView ?? 'home')),
    ),
  );
  const [modal, setModal] = React.useState(null);
  const [showHelp, setShowHelp] = React.useState(false);
  const [inputFocus, setInputFocus] = React.useState(null); // 'search' | 'filter' | null
  const [reordering, setReordering] = React.useState(false);
  const [toasts, toast] = useToasts();

  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const [discoverPane, setDiscoverPane] = React.useState('rail');
  const [playlistPane, setPlaylistPane] = React.useState('list');
  const [dataVersion, setDataVersion] = React.useState(0);
  const refresh = React.useCallback(() => setDataVersion((v) => v + 1), []);

  const playbackState = useServiceState(playback, () => playback.state);
  const searchState = useServiceState(searchService, () => searchService.state);
  const connection = useConnectionStatus(searchService);
  useTicker(1000, Boolean(playbackState.sleepTimer));

  // --------------------------------------------------------- library data
  React.useEffect(() => {
    const offs = [
      playlists.on('change', refresh),
      favorites.on('change', refresh),
      history.on('change', refresh),
    ];
    return () => offs.forEach((off) => off());
  }, [playlists, favorites, history, refresh]);

  /*
   * Library reads are cheap sqlite queries recomputed when `dataVersion`
   * ticks. That counter is a change token: the services emit 'change',
   * `refresh()` bumps it, and these memos re-run. The linter cannot see a
   * token that the callback body never reads, so the rule is disabled for
   * this block specifically - the dependency is real, just invisible to
   * static analysis.
   */
  /* eslint-disable react-hooks/exhaustive-deps */
  const favoriteIds = React.useMemo(() => favorites.ids(), [favorites, dataVersion]);
  const favoriteTracks = React.useMemo(() => favorites.list(), [favorites, dataVersion]);
  const historyEntries = React.useMemo(() => history.list({ limit: 200 }), [history, dataVersion]);
  const playlistRows = React.useMemo(() => playlists.list(), [playlists, dataVersion]);
  const libraryCounts = React.useMemo(() => stats.libraryCounts(), [stats, dataVersion]);
  const statsData = React.useMemo(
    () => ({
      summary: stats.summary(),
      topTracks: stats.topTracks({ limit: 10 }),
      topArtists: stats.topArtists({ limit: 8 }),
      topGenres: stats.topGenres({ limit: 6 }),
      activity: stats.activity({ days: 14 }),
    }),
    [stats, dataVersion, view],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  // ------------------------------------------------------------- provider
  const providerInfo = React.useMemo(() => {
    const { provider } = registry.select(settingsSnapshot.defaultProvider);
    const status = provider.status();
    return {
      id: provider.id,
      label: provider.label,
      configured: status.configured,
      capabilities: provider.capabilities,
      isLive: provider.isLive,
      instance: provider,
    };
  }, [registry, settingsSnapshot.defaultProvider]);

  // ------------------------------------------------------------- discover
  const [discoverData, setDiscoverData] = React.useState({
    sections: [],
    genres: [],
    smartRecipes: [],
  });
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      providerInfo.instance.featuredSections().catch(() => []),
      providerInfo.instance.genres().catch(() => []),
    ]).then(([sections, genres]) => {
      if (cancelled) return;
      setDiscoverData({ sections, genres, smartRecipes: smartPlaylists.recipes() });
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the provider id: the instance is stable for a given id, and
    // depending on it directly would refetch on every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerInfo.id, smartPlaylists]);

  const railItems = React.useMemo(() => buildRail(discoverData), [discoverData]);

  // --------------------------------------------------------------- lyrics
  const [lyricsData, setLyricsData] = React.useState({ lyrics: null, loading: false });
  React.useEffect(() => {
    const track = playbackState.track;
    if (!track || view !== 'lyrics') return undefined;
    let cancelled = false;
    setLyricsData({ lyrics: null, loading: true });
    lyricsService
      .fetch(track)
      .then((result) => !cancelled && setLyricsData({ lyrics: result, loading: false }))
      .catch(() => !cancelled && setLyricsData({ lyrics: null, loading: false }));
    return () => {
      cancelled = true;
    };
    // Keyed on the track id, not the track object, so a position tick does
    // not re-request lyrics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackState.track?.id, view, lyricsService, settingsSnapshot.lyricsSource]);

  // ----------------------------------------------------------- visualizer
  const analyser = React.useMemo(
    () => new LevelAnalyser({ logger: container.logger }),
    [container],
  );
  const [levels, setLevels] = React.useState({ available: false, values: [], reason: null });
  React.useEffect(() => () => analyser.dispose(), [analyser]);
  React.useEffect(() => analyser.on('change', setLevels), [analyser]);
  React.useEffect(() => {
    if (
      settingsSnapshot.visualizer !== 'levels' ||
      playbackState.status !== PLAYBACK_STATE.PLAYING
    ) {
      analyser.stop();
      setLevels({ available: false, values: [], reason: null });
      return;
    }
    const source = playbackState.track ? playbackSource(playbackState.track) : null;
    analyser.start(source, playbackState.position);
    // Restart analysis on track change only. `position` is read once, at
    // start; depending on it would respawn ffmpeg twice a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSnapshot.visualizer, playbackState.status, playbackState.track?.id, analyser]);

  // -------------------------------------------------------------- notices
  React.useEffect(() => {
    const offs = [
      playback.on('notice', ({ level, message }) => toast.push({ level, title: message })),
      playback.on('playback-error', (error) => toast.error(error.title, error.hint)),
      playback.on('queue-finished', () => toast.info('Reached the end of the queue')),
    ];
    return () => offs.forEach((off) => off());
  }, [playback, toast]);

  React.useEffect(() => {
    if (boot.databaseRecovered) {
      toast.warn(
        'Database was unreadable and has been rebuilt',
        'The damaged file was kept as a backup.',
      );
    }
    if (boot.audioFallbackReason) toast.warn('Audio backend', boot.audioFallbackReason);
    if (boot.restoredTracks) toast.info(`Restored ${boot.restoredTracks} queued tracks`);
    if (demo) toast.warn('Demo mode', 'All results are built-in sample data.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------- geometry
  const compact = settingsSnapshot.compactMode || columns < COMPACT_BREAKPOINT;
  const tiny = columns < MIN_COLUMNS || rows < MIN_ROWS;
  const sidebarWidth = compact ? 0 : 22;
  const contentWidth = Math.max(24, columns - sidebarWidth - (compact ? 0 : 2));
  const chromeHeight = 2 + (compact ? 1 : 0) + 7 + (toasts.length ? toasts.length : 0) + 1;
  const contentHeight = Math.max(4, rows - chromeHeight);

  // --------------------------------------------------------------- lists
  const homeListHeight = Math.max(2, Math.floor((contentHeight - 12) / 2));
  const homeTrackRows = React.useMemo(
    () => homeRows(historyEntries, favoriteTracks, homeListHeight),
    [historyEntries, favoriteTracks, homeListHeight],
  );
  const filteredFavorites = React.useMemo(
    () =>
      filter && view === 'favorites'
        ? favoriteTracks.filter((t) =>
            [t.title, t.artist, t.album].some((f) => matchesQuery(f, filter)),
          )
        : favoriteTracks,
    [favoriteTracks, filter, view],
  );
  const listCursor = useListCursor(playlistRows.length, { pageSize: 8 });
  // Falls back to the first playlist so the detail pane is never blank while
  // the cursor settles after a delete.
  const activePlaylist = playlistRows[listCursor.index] ?? playlistRows[0] ?? null;
  const playlistTracks = React.useMemo(
    () =>
      activePlaylist
        ? playlists.tracks(activePlaylist.id, { filter: view === 'playlists' ? filter : '' })
        : [],
    // Only the id matters: a new summary object for the same playlist must
    // not re-read every track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePlaylist?.id, dataVersion, filter, view, playlists],
  );

  const searchCursor = useListCursor(searchState.tracks.length, { pageSize: 8 });
  const homeCursor = useListCursor(homeTrackRows.length, { pageSize: 5 });
  const queueCursor = useListCursor(playbackState.queueLength, { pageSize: 8 });
  const favoritesCursor = useListCursor(filteredFavorites.length, { pageSize: 8 });
  const historyCursor = useListCursor(historyEntries.length, { pageSize: 8 });
  const railCursor = useListCursor(railItems.length, { pageSize: 6 });
  // Headings occupy rows but are not selectable, so the cursor must never
  // start (or be left) on one.
  React.useEffect(() => {
    if (railItems[railCursor.index]?.kind === 'heading' || railItems.length === 0) {
      railCursor.setIndex(firstSelectableRailIndex(railItems));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railItems]);
  const playlistTrackCursor = useListCursor(playlistTracks.length, { pageSize: 8 });

  const settingsRows = React.useMemo(
    () => buildSettingsRows(settings.specs, settingsSnapshot),
    [settings, settingsSnapshot],
  );
  const settingsCursor = useListCursor(settingsRows.length, { pageSize: 8 });

  // ------------------------------------------------------- debounced search
  const debouncedQuery = useDebouncedValue(
    settingsSnapshot.searchOnType ? query : '',
    settingsSnapshot.searchDebounceMs,
  );
  React.useEffect(() => {
    if (!settingsSnapshot.searchOnType) return;
    if (view !== 'search') return;
    const parsed = parseQuery(debouncedQuery);
    if (!parsed.text && !parsed.artist && !parsed.album && !parsed.genre) {
      searchService.reset();
      return;
    }
    searchService.search({ ...parsed, providerId: settingsSnapshot.defaultProvider });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, settingsSnapshot.searchOnType, settingsSnapshot.defaultProvider]);

  // ------------------------------------------------------ selected track
  const selectedTrack = React.useMemo(() => {
    switch (view) {
      case 'home':
        return homeTrackRows[homeCursor.index] ?? null;
      case 'search':
        return searchState.tracks[searchCursor.index] ?? null;
      case 'discover':
        return discoverPane === 'results' ? (searchState.tracks[searchCursor.index] ?? null) : null;
      case 'queue':
        return playback.queue.ordered[queueCursor.index]?.track ?? null;
      case 'favorites':
        return filteredFavorites[favoritesCursor.index] ?? null;
      case 'history':
        return historyEntries[historyCursor.index]?.track ?? null;
      case 'playlists':
        return playlistPane === 'tracks'
          ? (playlistTracks[playlistTrackCursor.index] ?? null)
          : null;
      default:
        return null;
    }
    // The queue is read live from the engine rather than copied into state;
    // `queueLength` is the signal that its contents moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    homeTrackRows,
    homeCursor.index,
    searchState.tracks,
    searchCursor.index,
    discoverPane,
    queueCursor.index,
    filteredFavorites,
    favoritesCursor.index,
    historyEntries,
    historyCursor.index,
    playlistPane,
    playlistTracks,
    playlistTrackCursor.index,
    playbackState.queueLength,
  ]);

  const selectedTrackRef = useLatest(selectedTrack);

  // -------------------------------------------------------------- actions
  const actions = React.useMemo(
    () =>
      createActions({
        container,
        toast,
        refresh,
        setModal,
        setView,
        setFilter,
        setQuery,
        setInputFocus,
        setReordering,
        getSelected: () => selectedTrackRef.current,
      }),
    [container, toast, refresh, selectedTrackRef],
  );

  const goToView = React.useCallback((id) => {
    setView(id);
    setNavIndex(
      Math.max(
        0,
        NAV_ITEMS.findIndex((item) => item.id === id),
      ),
    );
    setInputFocus(id === 'search' ? 'search' : null);
    setReordering(false);
    setFilter('');
    setFocusPane('content');
  }, []);

  // ------------------------------------------------------------ keyboard
  const textFieldActive = inputFocus !== null;
  useInput(
    (input, key) => {
      // Ctrl+C is handled by the process-level SIGINT handler in index.js
      // so cleanup runs exactly once, whoever triggers the exit.
      if (key.ctrl && input === 'c') {
        onExit?.();
        exit();
        return;
      }

      if (showHelp) {
        if (key.escape || input === '?' || input === 'q') setShowHelp(false);
        return;
      }
      if (modal) return; // the modal owns input

      if (textFieldActive) {
        // Only the keys that leave the field are handled here; everything
        // else belongs to TextInput, which is rendered focused.
        if (key.escape) {
          setInputFocus(null);
          if (inputFocus === 'filter') setFilter('');
        }
        if (key.tab) setInputFocus(null);
        return;
      }

      if (input === '?') {
        setShowHelp(true);
        return;
      }

      // --- global transport (works from every screen) -------------------
      if (input === ' ') return void playback.togglePlayPause();
      if (input === 'n' && view !== 'playlists') return void playback.next();
      if (input === 'b') return void playback.previous();
      if (input === '.') return void playback.stop();
      if (input === '+' || input === '=') return void playback.adjustVolume(5);
      if (input === '-' || input === '_') return void playback.adjustVolume(-5);
      if (input === 's') {
        const on = playback.toggleShuffle();
        toast.info(on ? 'Shuffle on' : 'Shuffle off');
        return;
      }
      if (input === 'r') {
        const mode = playback.cycleRepeat();
        toast.info(`Repeat: ${mode}`);
        return;
      }
      if (input === 'T') return actions.openSleepTimer(playbackState.sleepTimer);

      // --- navigation ---------------------------------------------------
      const numberTarget = NAV_ITEMS.find((item) => item.key === input);
      if (numberTarget) return goToView(numberTarget.id);

      if (key.tab) {
        if (key.shift) {
          setFocusPane((pane) => (pane === 'nav' ? 'content' : 'nav'));
        } else if (view === 'discover') {
          setDiscoverPane((pane) => (pane === 'rail' ? 'results' : 'rail'));
        } else if (view === 'playlists') {
          setPlaylistPane((pane) => (pane === 'list' ? 'tracks' : 'list'));
        } else if (view === 'search') {
          setInputFocus('search');
        } else {
          setFocusPane((pane) => (pane === 'nav' ? 'content' : 'nav'));
        }
        return;
      }

      if (key.escape) {
        if (reordering) return setReordering(false);
        if (filter) return setFilter('');
        if (view !== 'home') return goToView('home');
        return;
      }

      if (input === 'q') {
        if (reordering) return setReordering(false);
        if (view !== 'home') return goToView('home');
        onExit?.();
        exit();
        return;
      }

      if (focusPane === 'nav') {
        if (key.upArrow || input === 'k') return setNavIndex((i) => Math.max(0, i - 1));
        if (key.downArrow || input === 'j')
          return setNavIndex((i) => Math.min(NAV_ITEMS.length - 1, i + 1));
        if (key.return) return goToView(NAV_ITEMS[navIndex].id);
        if (key.rightArrow) return setFocusPane('content');
        return;
      }

      // --- per-view keys -------------------------------------------------
      handleViewInput({
        input,
        key,
        view,
        actions,
        playback,
        playbackState,
        settings,
        settingsSnapshot,
        searchService,
        searchState,
        cursors: {
          home: homeCursor,
          search: searchCursor,
          queue: queueCursor,
          favorites: favoritesCursor,
          history: historyCursor,
          rail: railCursor,
          playlists: listCursor,
          playlistTracks: playlistTrackCursor,
          settings: settingsCursor,
        },
        data: {
          railItems,
          playlistRows,
          activePlaylist,
          playlistTracks,
          historyEntries,
          filteredFavorites,
          homeTrackRows,
          settingsRows,
          discoverPane,
          playlistPane,
        },
        state: { filter, reordering, query },
        setters: {
          setFilter,
          setInputFocus,
          setReordering,
          setDiscoverPane,
          setPlaylistPane,
          setQuery,
        },
        toast,
        refresh,
      });
    },
    { isActive: true },
  );

  // --------------------------------------------------------------- render
  if (tiny) {
    return box(
      { flexDirection: 'column', width: columns, height: rows },
      h(StatusBlock, {
        theme,
        icon: theme.glyphs.warn,
        tone: 'warning',
        title: 'Terminal too small',
        lines: [
          `Termify needs about ${MIN_COLUMNS}x${MIN_ROWS}; this window is ${columns}x${rows}.`,
          'Resize and the interface returns automatically.',
        ],
      }),
    );
  }

  const content = showHelp
    ? h(HelpView, {
        theme,
        width: contentWidth,
        height: contentHeight,
        version: VERSION,
        backend: playback.adapterInfo.label,
        dataDir: paths.dataDir,
      })
    : modal
      ? h(
          ModalLayer,
          { width: contentWidth, height: contentHeight },
          renderModal({ theme, modal, width: Math.min(64, contentWidth - 4), setModal }),
        )
      : renderView({
          view,
          theme,
          contentWidth,
          contentHeight,
          searchState,
          searchCursor,
          query,
          setQuery,
          inputFocus,
          setInputFocus,
          providerInfo,
          favoriteIds,
          playbackState,
          statsData,
          libraryCounts,
          historyEntries,
          favoriteTracks: filteredFavorites,
          homeCursor,
          homeListHeight,
          queueCursor,
          favoritesCursor,
          historyCursor,
          railCursor,
          discoverData,
          discoverPane,
          playlistRows,
          listCursor,
          playlistTracks,
          playlistTrackCursor,
          playlistPane,
          filter,
          setFilter,
          reordering,
          settingsRows,
          settingsCursor,
          settingsSnapshot,
          registry,
          cache,
          paths,
          demo,
          boot,
          playback,
          lyricsData,
          smartPlaylists,
          container,
        });

  return box(
    { flexDirection: 'column', width: columns, height: rows },
    h(Header, {
      theme,
      width: columns,
      provider: providerInfo,
      connection,
      backend: playback.adapterInfo.label,
      demo,
      context: contextLabel(view, { searchState, activePlaylist }),
    }),
    compact ? h(CompactNav, { theme, active: view, width: columns }) : null,
    box(
      { flexDirection: 'row', flexGrow: 1 },
      compact
        ? null
        : box(
            { flexDirection: 'column', width: sidebarWidth, flexShrink: 0 },
            h(Sidebar, {
              theme,
              active: view,
              focused: focusPane === 'nav',
              width: sidebarWidth,
              navIndex,
              counts: {
                queue: playbackState.queueLength || undefined,
                playlists: libraryCounts.playlists || undefined,
                favorites: libraryCounts.favorites || undefined,
                history: libraryCounts.history || undefined,
              },
            }),
          ),
      compact ? null : text({ color: theme.colors.line }, ' '),
      box({ flexDirection: 'column', flexGrow: 1 }, content),
    ),
    h(NowPlaying, {
      theme,
      width: columns,
      playback: playbackState,
      artworkService: artwork,
      showArtwork: settingsSnapshot.showArtwork,
      visualizerMode: settingsSnapshot.visualizer,
      levels,
      upcoming: playback.queue.upcoming(2),
      compact,
      favorite: playbackState.track ? favoriteIds.has(playbackState.track.id) : false,
    }),
    toasts.length ? h(ToastStack, { theme, toasts, width: columns }) : null,
    h(KeyHintBar, { theme, width: columns, hints: hintsFor(view, { inputFocus, reordering }) }),
  );
}

// ---------------------------------------------------------------- helpers

function contextLabel(view, { searchState, activePlaylist }) {
  if (view === 'search' && searchState.query?.text) return `search: ${searchState.query.text}`;
  if (view === 'playlists' && activePlaylist) return `playlist: ${activePlaylist.name}`;
  return null;
}

function hintsFor(view, { inputFocus, reordering }) {
  if (inputFocus) {
    return [
      { keys: 'enter', label: 'run' },
      { keys: 'esc', label: 'leave field' },
      { keys: 'ctrl+u', label: 'clear' },
    ];
  }
  if (reordering) {
    return [
      { keys: 'up/down', label: 'move item' },
      { keys: 'enter', label: 'drop' },
      { keys: 'esc', label: 'cancel' },
    ];
  }
  const common = [
    { keys: 'space', label: 'play/pause' },
    { keys: '/', label: 'search' },
    { keys: '?', label: 'help' },
  ];
  const perView = {
    home: [
      { keys: 'enter', label: 'play' },
      { keys: 'f', label: 'favorite' },
    ],
    search: [
      { keys: 'enter', label: 'play' },
      { keys: 'a', label: 'queue' },
      { keys: 'A', label: 'playlist' },
      { keys: '[ ]', label: 'page' },
    ],
    discover: [
      { keys: 'tab', label: 'pane' },
      { keys: 'enter', label: 'open' },
    ],
    queue: [
      { keys: 'enter', label: 'jump' },
      { keys: 'd', label: 'remove' },
      { keys: 'm', label: 'reorder' },
      { keys: 'X', label: 'clear' },
    ],
    playlists: [
      { keys: 'n', label: 'new' },
      { keys: 'R', label: 'rename' },
      { keys: 'd', label: 'delete' },
      { keys: 'enter', label: 'play' },
    ],
    favorites: [
      { keys: 'enter', label: 'play' },
      { keys: 'f', label: 'unfavorite' },
    ],
    history: [
      { keys: 'enter', label: 'replay' },
      { keys: 'X', label: 'clear' },
    ],
    settings: [
      { keys: 'left/right', label: 'change' },
      { keys: 'enter', label: 'edit/run' },
    ],
    stats: [],
    lyrics: [],
  };
  return [...(perView[view] ?? []), ...common];
}
