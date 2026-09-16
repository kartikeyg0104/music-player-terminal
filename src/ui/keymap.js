import { parseQuery } from './views/SearchView.js';
import { SETTINGS_ACTIONS } from './views/SettingsView.js';

/**
 * Per-view key dispatch.
 *
 * `App` handles the keys that mean the same thing everywhere (transport,
 * navigation, help). Everything context-sensitive lands here, in one table,
 * so "what does d do on this screen" has exactly one answer to look up.
 *
 * This function is pure dispatch: it reads state and calls actions. That
 * makes the navigation logic testable without mounting the UI.
 */
export function handleViewInput(ctx) {
  const { input, key, view } = ctx;

  // Movement is identical on every list-shaped screen.
  const cursor = cursorFor(ctx);
  if (cursor) {
    if (key.upArrow || input === 'k') return moveCursor(ctx, cursor, -1);
    if (key.downArrow || input === 'j') return moveCursor(ctx, cursor, 1);
    if (key.pageUp) return cursor.pageUp();
    if (key.pageDown) return cursor.pageDown();
    if (input === 'g') return cursor.home();
    if (input === 'G') return cursor.end();
  }

  switch (view) {
    case 'home':
      return homeKeys(ctx);
    case 'search':
      return searchKeys(ctx);
    case 'discover':
      return discoverKeys(ctx);
    case 'queue':
      return queueKeys(ctx);
    case 'playlists':
      return playlistKeys(ctx);
    case 'favorites':
      return favoritesKeys(ctx);
    case 'history':
      return historyKeys(ctx);
    case 'settings':
      return settingsKeys(ctx);
    case 'lyrics':
    case 'stats':
      return undefined;
    default:
      return undefined;
  }
}

function cursorFor({ view, cursors, data }) {
  switch (view) {
    case 'home':
      return cursors.home;
    case 'search':
      return cursors.search;
    case 'discover':
      return data.discoverPane === 'rail' ? cursors.rail : cursors.search;
    case 'queue':
      return cursors.queue;
    case 'favorites':
      return cursors.favorites;
    case 'history':
      return cursors.history;
    case 'playlists':
      return data.playlistPane === 'list' ? cursors.playlists : cursors.playlistTracks;
    case 'settings':
      return cursors.settings;
    default:
      return null;
  }
}

/**
 * Cursor movement with two special cases:
 *  - reorder mode moves the *item*, not the selection
 *  - the settings list skips its non-selectable section headings
 */
function moveCursor(ctx, cursor, delta) {
  const { view, state, actions, data, cursors } = ctx;

  if (state.reordering) {
    if (view === 'queue') return actions.moveQueueItem(cursor.index, cursor.index + delta, cursor);
    if (view === 'playlists' && data.activePlaylist) {
      return actions.movePlaylistTrack(
        data.activePlaylist.id,
        cursor.index,
        cursor.index + delta,
        cursors.playlistTracks,
      );
    }
  }

  if (view === 'settings') {
    const rows = data.settingsRows;
    let next = cursor.index + delta;
    while (next >= 0 && next < rows.length && !rows[next].selectable) next += delta;
    if (next < 0 || next >= rows.length) return undefined;
    return cursor.setIndex(next);
  }

  if (view === 'discover' && data.discoverPane === 'rail') {
    const items = data.railItems;
    let next = cursor.index + delta;
    while (next >= 0 && next < items.length && items[next].kind === 'heading') next += delta;
    if (next < 0 || next >= items.length) return undefined;
    return cursor.setIndex(next);
  }

  return delta < 0 ? cursor.up() : cursor.down();
}

// ------------------------------------------------------------------ views

function homeKeys(ctx) {
  const { key, actions, data, cursors } = ctx;
  const track = data.homeTrackRows[cursors.home.index];
  if (key.return && track) return actions.playTrack(track, data.homeTrackRows, cursors.home.index);
  return trackKeys(ctx, track);
}

function searchKeys(ctx) {
  const { input, key, actions, searchService, searchState, cursors, setters, state } = ctx;
  const track = searchState.tracks[cursors.search.index];

  if (input === '/') {
    setters.setInputFocus('search');
    return undefined;
  }
  if (key.return && track) {
    return actions.playTrack(track, searchState.tracks, cursors.search.index);
  }
  if (input === ']' && searchState.hasMore) return void searchService.nextPage();
  if (input === '[' && searchState.page > 1) return void searchService.previousPage();
  // `r` is repeat everywhere, so re-running a search is shift+R.
  if (input === 'R') {
    if (searchState.status === 'error') return void searchService.retry();
    const parsed = parseQuery(state.query);
    return void searchService.search(parsed);
  }
  if (key.leftArrow || key.rightArrow) return undefined; // seek handled globally
  return trackKeys(ctx, track);
}

function discoverKeys(ctx) {
  const { input, key, actions, data, cursors, searchState, setters } = ctx;
  if (data.discoverPane === 'rail') {
    const item = data.railItems[cursors.rail.index];
    if (key.return) {
      if (!item || item.kind === 'heading') return undefined;
      setters.setDiscoverPane('results');
      return actions.openDiscoverItem(item);
    }
    if (key.rightArrow) return setters.setDiscoverPane('results');
    return undefined;
  }
  const track = searchState.tracks[cursors.search.index];
  if (key.leftArrow) return setters.setDiscoverPane('rail');
  if (input === 'R' && searchState.status === 'error') return void ctx.searchService.retry();
  if (key.return && track)
    return actions.playTrack(track, searchState.tracks, cursors.search.index);
  if (input === ']' && searchState.hasMore) return void ctx.searchService.nextPage();
  if (input === '[' && searchState.page > 1) return void ctx.searchService.previousPage();
  return trackKeys(ctx, track);
}

function queueKeys(ctx) {
  const { input, key, actions, playback, cursors, state, setters } = ctx;
  const entry = playback.queue.ordered[cursors.queue.index];

  if (key.return) {
    if (state.reordering) return setters.setReordering(false);
    if (entry) return void playback.jumpTo(cursors.queue.index);
    return undefined;
  }
  if (input === 'm') return setters.setReordering(!state.reordering);
  if (input === 'd' && entry) return actions.removeFromQueue(cursors.queue.index);
  if (input === 'X') return actions.confirmClearQueue();
  return trackKeys(ctx, entry?.track);
}

function playlistKeys(ctx) {
  const { input, key, actions, data, cursors, setters, state } = ctx;

  if (input === 'n') return actions.promptNewPlaylist();

  if (data.playlistPane === 'list') {
    const playlist = data.playlistRows[cursors.playlists.index];
    if (key.return && playlist) return actions.playPlaylist(playlist.id);
    if (key.rightArrow && playlist) return setters.setPlaylistPane('tracks');
    if (input === 'R' && playlist) return actions.promptRenamePlaylist(playlist);
    if (input === 'd' && playlist) return actions.confirmDeletePlaylist(playlist);
    if (input === 'a' && playlist) return actions.queuePlaylist(playlist.id);
    return undefined;
  }

  const track = data.playlistTracks[cursors.playlistTracks.index];
  const playlist = data.activePlaylist;
  if (key.leftArrow) return setters.setPlaylistPane('list');
  if (input === '/') return setters.setInputFocus('filter');
  if (key.return) {
    if (state.reordering) return setters.setReordering(false);
    if (track && playlist) {
      return actions.playTrack(track, data.playlistTracks, cursors.playlistTracks.index);
    }
    return undefined;
  }
  if (input === 'm') return setters.setReordering(!state.reordering);
  if (input === 'd' && track && playlist) {
    return actions.removeFromPlaylist(playlist.id, cursors.playlistTracks.index, track);
  }
  if (input === 'X' && playlist) return actions.confirmClearPlaylist(playlist);
  return trackKeys(ctx, track);
}

function favoritesKeys(ctx) {
  const { input, key, actions, data, cursors, setters } = ctx;
  const track = data.filteredFavorites[cursors.favorites.index];
  if (input === '/') return setters.setInputFocus('filter');
  if (key.return && track) {
    return actions.playTrack(track, data.filteredFavorites, cursors.favorites.index);
  }
  if (input === 'd' && track) return actions.toggleFavorite(track);
  return trackKeys(ctx, track);
}

function historyKeys(ctx) {
  const { input, key, actions, data, cursors } = ctx;
  const entry = data.historyEntries[cursors.history.index];
  if (key.return && entry) return actions.playTrack(entry.track, [entry.track], 0);
  if (input === 'X') return actions.confirmClearHistory();
  if (input === 'd' && entry) return actions.removeHistoryEntry(entry.id);
  return trackKeys(ctx, entry?.track);
}

function settingsKeys(ctx) {
  const { input, key, actions, data, cursors } = ctx;
  const row = data.settingsRows[cursors.settings.index];
  if (!row) return undefined;

  if (row.kind === 'action') {
    if (key.return) return actions.runSettingsAction(row.id);
    return undefined;
  }
  if (row.kind !== 'setting') return undefined;

  if (key.leftArrow || input === 'h') return actions.cycleSetting(row.spec.key, -1);
  if (key.rightArrow || input === 'l') return actions.cycleSetting(row.spec.key, 1);
  if (key.return) {
    if (row.spec.type === 'path' || row.spec.type === 'string') {
      return actions.promptSetting(row.spec, row.value);
    }
    if (row.spec.type === 'enum') return actions.chooseSetting(row.spec, row.value);
    return actions.cycleSetting(row.spec.key, 1);
  }
  return undefined;
}

/** Keys that apply to whatever track is selected, on any screen. */
function trackKeys(ctx, track) {
  const { input, actions } = ctx;
  if (!track) return undefined;
  if (input === 'a') return actions.enqueue(track);
  if (input === 'p') return actions.playNext(track);
  if (input === 'f') return actions.toggleFavorite(track);
  if (input === 'A') return actions.promptAddToPlaylist(track);
  if (input === 'i') return actions.showTrackInfo(track);
  return undefined;
}

/** Ids of the settings actions, re-exported so the action layer stays in sync. */
export const SETTINGS_ACTION_IDS = SETTINGS_ACTIONS.map((a) => a.id);
