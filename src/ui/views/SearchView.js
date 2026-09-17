import { box, text, h } from '../h.js';
import { TextInput } from '../components/TextInput.js';
import {
  ListView,
  TrackRow,
  Spinner,
  StatusBlock,
  Badge,
  Divider,
} from '../components/primitives.js';

/**
 * Search screen.
 *
 * The query field owns the keyboard while it is focused, so shortcuts cannot
 * fire mid-word. Escape or Enter hands focus to the results list, where the
 * usual keys work again. Field-scoped search (artist:, album:, genre:) is
 * parsed from the query string rather than hidden behind extra UI.
 */
export function SearchView({
  theme,
  width,
  height,
  search,
  query,
  onQueryChange,
  onSubmit,
  inputFocused,
  cursor,
  favorites,
  currentTrackId,
  provider,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const { status, tracks, total, page, hasMore, note, error, isSample } = search;

  const caps = provider?.capabilities ?? {};
  const fieldHints = ['artist:', caps.album ? 'album:' : null, caps.genre ? 'genre:' : null]
    .filter(Boolean)
    .join(' ');

  const listHeight = Math.max(3, height - 6);

  return box(
    { flexDirection: 'column', width, height },
    // --- query field ---------------------------------------------------
    box(
      {
        flexDirection: 'row',
        borderStyle: theme.unicode ? 'round' : 'classic',
        borderColor: inputFocused ? c.accent : c.line,
        paddingX: 1,
      },
      text({ color: inputFocused ? c.accent : c.textFaint }, `${g.chevron} `),
      h(TextInput, {
        theme,
        value: query,
        onChange: onQueryChange,
        onSubmit,
        onCancel: () => onSubmit(query),
        focus: inputFocused,
        placeholder: `Search ${provider?.label ?? 'music'}${fieldHints ? `  (${fieldHints})` : ''}`,
        width: Math.max(10, width - 8),
      }),
    ),
    // --- result meta ---------------------------------------------------
    box(
      { flexDirection: 'row', marginTop: 0 },
      status === 'loading'
        ? h(Spinner, { theme, label: 'searching' })
        : text({ color: c.textFaint }, resultSummary({ status, tracks, total, page, provider, g })),
      isSample ? h(Badge, { theme, label: 'SAMPLE DATA', tone: 'warning' }) : null,
      hasMore || page > 1
        ? box(
            { flexGrow: 1, justifyContent: 'flex-end' },
            text({ color: c.textFaint }, `page ${page}${hasMore ? '  [ ] page' : ''}`),
          )
        : null,
    ),
    note ? text({ color: c.textFaint }, ` ${g.info} ${note}`) : null,
    h(Divider, { theme, width }),
    // --- results --------------------------------------------------------
    box(
      { flexDirection: 'column', flexGrow: 1 },
      renderBody({
        theme,
        status,
        tracks,
        error,
        cursor,
        listHeight,
        width,
        favorites,
        currentTrackId,
        inputFocused,
        provider,
      }),
    ),
  );
}

function renderBody({
  theme,
  status,
  tracks,
  error,
  cursor,
  listHeight,
  width,
  favorites,
  currentTrackId,
  inputFocused,
  provider,
}) {
  const g = theme.glyphs;

  if (status === 'idle') {
    return h(StatusBlock, {
      theme,
      icon: g.note,
      title: 'Search for something',
      lines: [
        `Type a title, an artist, or use a field prefix like "artist: bonobo".`,
        provider ? `Searching ${provider.label}.` : null,
        'Enter runs the search; Tab moves down to the results.',
      ],
    });
  }
  if (status === 'loading' && !tracks.length) {
    return h(StatusBlock, {
      theme,
      icon: g.dot,
      title: 'Searching...',
      lines: ['Contacting the provider.'],
    });
  }
  if (status === 'error') {
    return h(StatusBlock, {
      theme,
      tone: 'danger',
      icon: g.cross,
      title: error?.title ?? 'Search failed',
      lines: [error?.hint, error?.retryable ? 'Press R to retry.' : null],
    });
  }
  if (status === 'empty') {
    return h(StatusBlock, {
      theme,
      icon: g.info,
      title: 'No results',
      lines: [
        'Nothing matched that query on this provider.',
        'Try fewer words, or switch provider in Settings (0).',
      ],
    });
  }

  return h(ListView, {
    theme,
    items: tracks.map((track) => ({ key: track.id, track })),
    selectedIndex: cursor.index,
    height: listHeight,
    focused: !inputFocused,
    width,
    renderItem: (item, index, selected) =>
      h(TrackRow, {
        theme,
        track: item.track,
        index,
        selected,
        playing: item.track.id === currentTrackId,
        favorite: favorites.has(item.track.id),
        width,
      }),
  });
}

function resultSummary({ status, tracks, total, page, provider, g }) {
  if (status === 'idle') return ' ready';
  if (!tracks.length) return ' no results';
  const shown = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
  // archive.org counts matching *items*, not tracks - say so rather than
  // presenting an item count as a track count.
  const totalText =
    total != null
      ? provider?.id === 'archive'
        ? ` ${g.dot} ${total.toLocaleString()} matching items`
        : ` ${g.dot} ${total.toLocaleString()} total`
      : '';
  return ` ${shown}${totalText} ${g.dot} page ${page}`;
}

/**
 * Parse `artist: x album: y free text` into a structured query.
 * Exported for tests.
 */
export function parseQuery(raw) {
  const out = { text: '', artist: '', album: '', genre: '' };
  const pattern = /\b(artist|album|genre)\s*:\s*("([^"]*)"|[^\s]+)/gi;
  const remaining = String(raw ?? '');
  let match;
  while ((match = pattern.exec(remaining)) !== null) {
    const field = match[1].toLowerCase();
    out[field] = (match[3] ?? match[2]).trim();
  }
  out.text = remaining.replace(pattern, '').replace(/\s+/g, ' ').trim();
  return out;
}
