import { box, text, h } from '../h.js';
import { ListView, TrackRow, StatusBlock, Divider } from '../components/primitives.js';
import { TextInput } from '../components/TextInput.js';
import { formatDuration, formatListeningTime } from '../../core/track.js';
import { relativeTime } from '../../core/util.js';

/** Favourites list with an inline filter. */
export function FavoritesView({
  theme,
  width,
  height,
  tracks,
  cursor,
  filter,
  filterFocused,
  onFilterChange,
  onFilterSubmit,
  currentTrackId,
}) {
  const c = theme.colors;
  const g = theme.glyphs;

  return box(
    { flexDirection: 'column', width, height },
    box(
      { flexDirection: 'row' },
      text({ color: c.textStrong, bold: true }, ` ${g.heart} Favorites`),
      text({ color: c.textFaint }, `  ${tracks.length}`),
      box(
        { flexGrow: 1, flexDirection: 'row', justifyContent: 'flex-end' },
        text({ color: filterFocused ? c.accent : c.textFaint }, 'filter '),
        h(TextInput, {
          theme,
          value: filter,
          onChange: onFilterChange,
          onSubmit: onFilterSubmit,
          onCancel: onFilterSubmit,
          focus: filterFocused,
          placeholder: '/ to filter',
          width: 24,
        }),
      ),
    ),
    h(Divider, { theme, width }),
    tracks.length
      ? h(ListView, {
          theme,
          items: tracks.map((track) => ({ key: track.id, track })),
          selectedIndex: cursor.index,
          height: Math.max(3, height - 3),
          width,
          renderItem: (item, index, selected) =>
            h(TrackRow, {
              theme,
              track: item.track,
              selected,
              playing: item.track.id === currentTrackId,
              favorite: true,
              width,
            }),
        })
      : h(StatusBlock, {
          theme,
          icon: g.heartEmpty,
          title: filter ? 'No favorites match that filter' : 'No favorites yet',
          lines: [
            filter ? 'Press esc to clear the filter.' : 'Press f on any track to add it here.',
            filter ? null : 'Favorites persist across restarts.',
          ],
        }),
  );
}

/**
 * Listening history.
 *
 * One row per listening session with when it happened and how much of it you
 * actually heard - progress updates never create extra rows.
 */
export function HistoryView({ theme, width, height, entries, cursor, favorites, currentTrackId }) {
  const c = theme.colors;
  const g = theme.glyphs;

  if (!entries.length) {
    return h(StatusBlock, {
      theme,
      icon: g.clock,
      title: 'No listening history yet',
      lines: [
        'Tracks appear here once you have played a few seconds of them.',
        'History can be turned off in Settings.',
      ],
    });
  }

  const totalListened = entries.reduce((sum, e) => sum + e.listenedSeconds, 0);

  return box(
    { flexDirection: 'column', width, height },
    box(
      { flexDirection: 'row' },
      text({ color: c.textStrong, bold: true }, ` ${g.clock} History`),
      text(
        { color: c.textFaint },
        `  ${entries.length} plays ${g.dot} ${formatListeningTime(totalListened)} listened`,
      ),
      box(
        { flexGrow: 1, justifyContent: 'flex-end' },
        text({ color: c.textFaint }, 'enter replays  ·  X clears all'),
      ),
    ),
    h(Divider, { theme, width }),
    h(ListView, {
      theme,
      items: entries.map((entry) => ({ key: entry.id, entry })),
      selectedIndex: cursor.index,
      height: Math.max(3, height - 3),
      width,
      renderItem: (item, index, selected) =>
        box(
          { flexDirection: 'row' },
          box(
            { flexGrow: 1 },
            h(TrackRow, {
              theme,
              track: item.entry.track,
              selected,
              playing: item.entry.track.id === currentTrackId,
              favorite: favorites.has(item.entry.track.id),
              width: width - 22,
              trailing: formatDuration(item.entry.listenedSeconds),
            }),
          ),
          text(
            { color: item.entry.completed ? c.success : c.textFaint },
            item.entry.completed ? ` ${theme.glyphs.check} ` : '   ',
          ),
          text({ color: c.textFaint }, relativeTime(item.entry.playedAt).padStart(9)),
        ),
    }),
  );
}
