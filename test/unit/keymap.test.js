import test from 'node:test';
import assert from 'node:assert/strict';
import { handleViewInput } from '../../src/ui/keymap.js';
import { buildSettingsRows } from '../../src/ui/views/SettingsView.js';
import { buildRail, firstSelectableRailIndex } from '../../src/ui/views/DiscoverView.js';
import { SETTING_SPECS, defaultSettings } from '../../src/config/defaults.js';
import { makeTracks } from '../helpers.js';

/**
 * Keyboard dispatch is a pure function of (key, view, state), which is the
 * whole reason it lives outside the components: these tests drive real
 * navigation logic with no terminal and no React.
 */

const NO_KEY = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  return: false,
  escape: false,
  tab: false,
  shift: false,
  ctrl: false,
  meta: false,
  backspace: false,
  delete: false,
};

const key = (overrides = {}) => ({ ...NO_KEY, ...overrides });

/** A cursor that records what happened to it. */
function fakeCursor(index = 0, length = 10) {
  return {
    index,
    length,
    moves: [],
    setIndex(v) {
      this.moves.push(['set', v]);
      this.index = v;
    },
    up() {
      this.moves.push(['up']);
      this.index = Math.max(0, this.index - 1);
    },
    down() {
      this.moves.push(['down']);
      this.index = Math.min(this.length - 1, this.index + 1);
    },
    pageUp() {
      this.moves.push(['pageUp']);
    },
    pageDown() {
      this.moves.push(['pageDown']);
    },
    home() {
      this.moves.push(['home']);
      this.index = 0;
    },
    end() {
      this.moves.push(['end']);
      this.index = this.length - 1;
    },
  };
}

/** Records every action the keymap invokes. */
function fakeActions() {
  const calls = [];
  return new Proxy(
    { calls },
    {
      get(target, prop) {
        if (prop === 'calls') return calls;
        return (...args) => {
          calls.push({ name: String(prop), args });
        };
      },
    },
  );
}

function ctx(overrides = {}) {
  const tracks = makeTracks(5);
  const cursors = {
    home: fakeCursor(),
    search: fakeCursor(),
    queue: fakeCursor(),
    favorites: fakeCursor(),
    history: fakeCursor(),
    rail: fakeCursor(),
    playlists: fakeCursor(),
    playlistTracks: fakeCursor(),
    settings: fakeCursor(),
  };
  return {
    input: '',
    key: key(),
    view: 'search',
    actions: fakeActions(),
    playback: {
      queue: { ordered: tracks.map((t, i) => ({ track: t, uid: `q${i}` })) },
      jumpTo() {},
    },
    playbackState: {},
    settings: {},
    settingsSnapshot: defaultSettings(),
    searchService: { nextPage() {}, previousPage() {}, retry() {}, search() {} },
    searchState: { tracks, page: 1, hasMore: true, status: 'ready' },
    cursors,
    data: {
      railItems: [],
      playlistRows: [{ id: 1, name: 'A', trackCount: 2 }],
      activePlaylist: { id: 1, name: 'A', trackCount: 2 },
      playlistTracks: tracks,
      historyEntries: tracks.map((t, i) => ({ id: i, track: t })),
      filteredFavorites: tracks,
      homeTrackRows: tracks,
      settingsRows: buildSettingsRows(SETTING_SPECS, defaultSettings()),
      discoverPane: 'results',
      playlistPane: 'list',
    },
    state: { filter: '', reordering: false, query: '' },
    setters: {
      setFilter() {},
      setInputFocus() {},
      setReordering() {},
      setDiscoverPane() {},
      setPlaylistPane() {},
      setQuery() {},
    },
    toast: { info() {}, warn() {}, error() {}, success() {}, push() {} },
    refresh() {},
    ...overrides,
  };
}

// ------------------------------------------------------------- navigation

test('keymap: arrows and vim keys move the list cursor', () => {
  const c = ctx();
  handleViewInput({ ...c, key: key({ downArrow: true }) });
  handleViewInput({ ...c, input: 'j' });
  handleViewInput({ ...c, key: key({ upArrow: true }) });
  handleViewInput({ ...c, input: 'k' });
  assert.deepEqual(
    c.cursors.search.moves.map((m) => m[0]),
    ['down', 'down', 'up', 'up'],
  );
});

test('keymap: page keys and g/G jump', () => {
  const c = ctx();
  handleViewInput({ ...c, key: key({ pageDown: true }) });
  handleViewInput({ ...c, key: key({ pageUp: true }) });
  handleViewInput({ ...c, input: 'G' });
  handleViewInput({ ...c, input: 'g' });
  assert.deepEqual(
    c.cursors.search.moves.map((m) => m[0]),
    ['pageDown', 'pageUp', 'end', 'home'],
  );
});

test('keymap: the settings cursor skips non-selectable section headings', () => {
  const c = ctx({ view: 'settings' });
  const rows = c.data.settingsRows;
  assert.equal(rows[0].selectable, false, 'row 0 is a section heading');

  c.cursors.settings.index = 0;
  handleViewInput({ ...c, key: key({ downArrow: true }) });
  const landed = c.cursors.settings.moves.at(-1)[1];
  assert.equal(rows[landed].selectable, true, 'the cursor landed on a real setting');
});

test('keymap: the discover rail skips its headings too', () => {
  const railItems = buildRail({
    sections: [{ id: 's1', label: 'One', description: '' }],
    genres: [{ id: 'rock', label: 'Rock' }],
    smartRecipes: [],
  });
  assert.equal(railItems[0].kind, 'heading');
  assert.equal(firstSelectableRailIndex(railItems), 1);

  const c = ctx({ view: 'discover' });
  c.data = { ...c.data, railItems, discoverPane: 'rail' };
  c.cursors.rail.index = 1; // 'One'
  handleViewInput({ ...c, key: key({ downArrow: true }) });
  const landed = c.cursors.rail.moves.at(-1)[1];
  assert.notEqual(railItems[landed].kind, 'heading');
});

test('keymap: Enter on a rail heading does nothing', () => {
  const railItems = buildRail({
    sections: [{ id: 's1', label: 'One' }],
    genres: [],
    smartRecipes: [],
  });
  const c = ctx({ view: 'discover' });
  c.data = { ...c.data, railItems, discoverPane: 'rail' };
  c.cursors.rail.index = 0; // the heading
  handleViewInput({ ...c, key: key({ return: true }) });
  assert.equal(c.actions.calls.length, 0);
});

// ------------------------------------------------------------ track verbs

test('keymap: a, p, f, A and i act on the selected track from any list', () => {
  for (const view of ['search', 'favorites', 'history', 'home']) {
    const c = ctx({ view });
    handleViewInput({ ...c, input: 'a' });
    handleViewInput({ ...c, input: 'p' });
    handleViewInput({ ...c, input: 'f' });
    handleViewInput({ ...c, input: 'A' });
    handleViewInput({ ...c, input: 'i' });
    assert.deepEqual(
      c.actions.calls.map((call) => call.name),
      ['enqueue', 'playNext', 'toggleFavorite', 'promptAddToPlaylist', 'showTrackInfo'],
      `view ${view}`,
    );
  }
});

test('keymap: Enter plays the selected track with its list as context', () => {
  const c = ctx({ view: 'search' });
  c.cursors.search.index = 2;
  handleViewInput({ ...c, key: key({ return: true }) });
  const call = c.actions.calls[0];
  assert.equal(call.name, 'playTrack');
  assert.equal(call.args[0].title, 'Track 3');
  assert.equal(call.args[1].length, 5, 'the whole result list becomes the queue');
  assert.equal(call.args[2], 2);
});

// ------------------------------------------------------------------ views

test('keymap: search paging respects the available pages', () => {
  const c = ctx({ view: 'search' });
  let next = 0;
  let prev = 0;
  c.searchService = { nextPage: () => (next += 1), previousPage: () => (prev += 1) };

  handleViewInput({ ...c, input: ']' });
  assert.equal(next, 1);

  handleViewInput({ ...c, input: '[' }); // page 1, nothing before it
  assert.equal(prev, 0);

  handleViewInput({ ...c, input: '[', searchState: { ...c.searchState, page: 3 } });
  assert.equal(prev, 1);
});

test('keymap: R retries a failed search', () => {
  let retried = 0;
  const c = ctx({ view: 'search' });
  c.searchService = { retry: () => (retried += 1), search: () => {} };
  handleViewInput({ ...c, input: 'R', searchState: { ...c.searchState, status: 'error' } });
  assert.equal(retried, 1);
});

test('keymap: queue keys jump, remove, reorder and clear', () => {
  const c = ctx({ view: 'queue' });
  let jumped = -1;
  c.playback = { ...c.playback, jumpTo: (i) => (jumped = i) };
  c.cursors.queue.index = 3;

  handleViewInput({ ...c, key: key({ return: true }) });
  assert.equal(jumped, 3);

  handleViewInput({ ...c, input: 'd' });
  assert.equal(c.actions.calls.at(-1).name, 'removeFromQueue');
  assert.equal(c.actions.calls.at(-1).args[0], 3);

  handleViewInput({ ...c, input: 'X' });
  assert.equal(c.actions.calls.at(-1).name, 'confirmClearQueue');
});

test('keymap: reorder mode moves the item instead of the cursor', () => {
  const c = ctx({ view: 'queue', state: { filter: '', reordering: true, query: '' } });
  c.cursors.queue.index = 2;
  handleViewInput({ ...c, key: key({ downArrow: true }) });
  const call = c.actions.calls.at(-1);
  assert.equal(call.name, 'moveQueueItem');
  assert.deepEqual(call.args.slice(0, 2), [2, 3]);
});

test('keymap: reorder mode in a playlist moves the playlist track', () => {
  const c = ctx({ view: 'playlists', state: { filter: '', reordering: true, query: '' } });
  c.data = { ...c.data, playlistPane: 'tracks' };
  c.cursors.playlistTracks.index = 1;
  handleViewInput({ ...c, key: key({ upArrow: true }) });
  const call = c.actions.calls.at(-1);
  assert.equal(call.name, 'movePlaylistTrack');
  assert.deepEqual(call.args.slice(0, 3), [1, 1, 0]);
});

test('keymap: playlist list pane handles create, rename, delete and play', () => {
  const c = ctx({ view: 'playlists' });
  handleViewInput({ ...c, input: 'n' });
  handleViewInput({ ...c, input: 'R' });
  handleViewInput({ ...c, input: 'd' });
  handleViewInput({ ...c, input: 'a' });
  handleViewInput({ ...c, key: key({ return: true }) });
  assert.deepEqual(
    c.actions.calls.map((call) => call.name),
    [
      'promptNewPlaylist',
      'promptRenamePlaylist',
      'confirmDeletePlaylist',
      'queuePlaylist',
      'playPlaylist',
    ],
  );
});

test('keymap: left and right move between the playlist panes', () => {
  const panes = [];
  const c = ctx({ view: 'playlists' });
  c.setters = { ...c.setters, setPlaylistPane: (p) => panes.push(p) };
  handleViewInput({ ...c, key: key({ rightArrow: true }) });
  handleViewInput({
    ...c,
    key: key({ leftArrow: true }),
    data: { ...c.data, playlistPane: 'tracks' },
  });
  assert.deepEqual(panes, ['tracks', 'list']);
});

test('keymap: history offers replay, delete and clear', () => {
  const c = ctx({ view: 'history' });
  handleViewInput({ ...c, key: key({ return: true }) });
  handleViewInput({ ...c, input: 'd' });
  handleViewInput({ ...c, input: 'X' });
  assert.deepEqual(
    c.actions.calls.map((call) => call.name),
    ['playTrack', 'removeHistoryEntry', 'confirmClearHistory'],
  );
});

test('keymap: settings left/right cycles a value, Enter opens an editor', () => {
  const c = ctx({ view: 'settings' });
  const rows = c.data.settingsRows;
  const enumIndex = rows.findIndex((r) => r.kind === 'setting' && r.spec.type === 'enum');
  c.cursors.settings.index = enumIndex;

  handleViewInput({ ...c, key: key({ rightArrow: true }) });
  assert.equal(c.actions.calls.at(-1).name, 'cycleSetting');
  assert.equal(c.actions.calls.at(-1).args[1], 1);

  handleViewInput({ ...c, key: key({ leftArrow: true }) });
  assert.equal(c.actions.calls.at(-1).args[1], -1);

  handleViewInput({ ...c, key: key({ return: true }) });
  assert.equal(c.actions.calls.at(-1).name, 'chooseSetting');
});

test('keymap: Enter on a settings action row runs it', () => {
  const c = ctx({ view: 'settings' });
  const actionIndex = c.data.settingsRows.findIndex((r) => r.kind === 'action');
  c.cursors.settings.index = actionIndex;
  handleViewInput({ ...c, key: key({ return: true }) });
  assert.equal(c.actions.calls.at(-1).name, 'runSettingsAction');
  assert.equal(c.actions.calls.at(-1).args[0], c.data.settingsRows[actionIndex].id);
});

test('keymap: a text-only view ignores list keys without throwing', () => {
  for (const view of ['stats', 'lyrics', 'nonexistent']) {
    const c = ctx({ view });
    assert.doesNotThrow(() => handleViewInput({ ...c, input: 'j' }));
    assert.doesNotThrow(() => handleViewInput({ ...c, key: key({ return: true }) }));
  }
});

test('keymap: an empty list never dispatches a track action', () => {
  const c = ctx({ view: 'favorites' });
  c.data = { ...c.data, filteredFavorites: [] };
  handleViewInput({ ...c, input: 'f' });
  handleViewInput({ ...c, key: key({ return: true }) });
  assert.equal(c.actions.calls.length, 0);
});
