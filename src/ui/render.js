import { h } from './h.js';
import { HomeView } from './views/HomeView.js';
import { SearchView } from './views/SearchView.js';
import { DiscoverView } from './views/DiscoverView.js';
import { QueueView } from './views/QueueView.js';
import { PlaylistsView } from './views/PlaylistsView.js';
import { FavoritesView, HistoryView } from './views/LibraryViews.js';
import { StatsView } from './views/StatsView.js';
import { LyricsView } from './views/LyricsView.js';
import { SettingsView } from './views/SettingsView.js';

/**
 * Maps the active view id to its component and the props it needs.
 *
 * Kept apart from `App` so the layout file stays about layout, and so a view
 * can be rendered standalone in a test by calling this with fixture data.
 */
export function renderView(props) {
  const {
    view,
    theme,
    contentWidth: width,
    contentHeight: height,
    playbackState,
    favoriteIds,
  } = props;

  const currentTrackId = playbackState.track?.id ?? null;

  switch (view) {
    case 'home':
      return h(HomeView, {
        theme,
        width,
        height,
        stats: props.statsData,
        counts: props.libraryCounts,
        recent: props.historyEntries,
        favorites: props.favoriteTracks,
        cursor: props.homeCursor,
        currentTrackId,
        favoriteIds,
        provider: props.providerInfo,
        demo: props.demo,
        boot: props.boot,
      });

    case 'search':
      return h(SearchView, {
        theme,
        width,
        height,
        search: props.searchState,
        query: props.query,
        onQueryChange: props.setQuery,
        onSubmit: () => props.setInputFocus(null),
        inputFocused: props.inputFocus === 'search',
        cursor: props.searchCursor,
        favorites: favoriteIds,
        currentTrackId,
        provider: props.providerInfo,
      });

    case 'discover':
      return h(DiscoverView, {
        theme,
        width,
        height,
        sections: props.discoverData.sections,
        genres: props.discoverData.genres,
        smartRecipes: props.discoverData.smartRecipes,
        smartAvailability: props.smartPlaylists.availability(),
        activePane: props.discoverPane,
        sectionCursor: props.railCursor,
        resultCursor: props.searchCursor,
        search: props.searchState,
        favorites: favoriteIds,
        currentTrackId,
        provider: props.providerInfo,
      });

    case 'queue':
      return h(QueueView, {
        theme,
        width,
        height,
        queue: props.playback.queue,
        cursor: props.queueCursor,
        favorites: favoriteIds,
        reordering: props.reordering,
        shuffle: playbackState.shuffle,
        repeat: playbackState.repeat,
      });

    case 'playlists':
      return h(PlaylistsView, {
        theme,
        width,
        height,
        playlists: props.playlistRows,
        tracks: props.playlistTracks,
        activePane: props.playlistPane,
        listCursor: props.listCursor,
        trackCursor: props.playlistTrackCursor,
        filter: props.filter,
        filterFocused: props.inputFocus === 'filter',
        onFilterChange: props.setFilter,
        onFilterSubmit: () => props.setInputFocus(null),
        favorites: favoriteIds,
        currentTrackId,
        reordering: props.reordering,
      });

    case 'favorites':
      return h(FavoritesView, {
        theme,
        width,
        height,
        tracks: props.favoriteTracks,
        cursor: props.favoritesCursor,
        filter: props.filter,
        filterFocused: props.inputFocus === 'filter',
        onFilterChange: props.setFilter,
        onFilterSubmit: () => props.setInputFocus(null),
        currentTrackId,
      });

    case 'history':
      return h(HistoryView, {
        theme,
        width,
        height,
        entries: props.historyEntries,
        cursor: props.historyCursor,
        favorites: favoriteIds,
        currentTrackId,
      });

    case 'stats':
      return h(StatsView, { theme, width, height, ...props.statsData });

    case 'lyrics':
      return h(LyricsView, {
        theme,
        width,
        height,
        track: playbackState.track,
        lyrics: props.lyricsData.lyrics,
        loading: props.lyricsData.loading,
        position: playbackState.position,
      });

    case 'settings':
      return h(SettingsView, {
        theme,
        width,
        height,
        rows: props.settingsRows,
        cursor: props.settingsCursor,
        providers: props.registry.describe(),
        backends: props.boot.audioBackends,
        cacheStats: props.cache.stats(),
        paths: props.paths,
        demo: props.demo,
      });

    default:
      return null;
  }
}
