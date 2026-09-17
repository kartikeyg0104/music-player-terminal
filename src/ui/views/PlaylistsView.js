import { box, text, h } from '../h.js';
import { ListView, TrackRow, StatusBlock, Divider, Badge } from '../components/primitives.js';
import { TextInput } from '../components/TextInput.js';
import { formatDuration } from '../../core/track.js';
import { truncate } from '../../core/util.js';

/**
 * Two-pane playlists: the list on the left, its contents on the right.
 *
 * Tracks are shown even when they are no longer resolvable, marked GONE, so
 * a playlist never silently loses entries behind your back.
 */
export function PlaylistsView({
  theme,
  width,
  height,
  playlists,
  tracks,
  activePane,
  listCursor,
  trackCursor,
  filter,
  filterFocused,
  onFilterChange,
  onFilterSubmit,
  favorites,
  currentTrackId,
  reordering,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const railWidth = Math.min(34, Math.max(20, Math.floor(width * 0.32)));
  const detailWidth = width - railWidth - 3;
  // The detail pane carries a left border plus one column of padding.
  const detailInner = detailWidth - 2;
  const selected = playlists[listCursor.index] ?? null;

  return box(
    { flexDirection: 'row', width, height },
    box(
      { flexDirection: 'column', width: railWidth, flexShrink: 0 },
      box(
        { flexDirection: 'row' },
        text(
          { color: activePane === 'list' ? c.textStrong : c.textMuted, bold: true },
          `${activePane === 'list' ? g.chevron : ' '} Playlists`,
        ),
        text({ color: c.textFaint }, ` ${playlists.length}`),
      ),
      playlists.length
        ? h(ListView, {
            theme,
            items: playlists.map((p) => ({ ...p, key: p.id })),
            selectedIndex: listCursor.index,
            height: height - 3,
            focused: activePane === 'list',
            renderItem: (item, index, isSelected) =>
              box(
                { flexDirection: 'row' },
                text(
                  { color: isSelected ? c.accent : c.textFaint },
                  isSelected ? ` ${g.chevron} ` : '   ',
                ),
                text(
                  { color: isSelected ? c.textStrong : c.text, bold: isSelected },
                  truncate(item.name, railWidth - 12).padEnd(railWidth - 12),
                ),
                item.kind === 'smart' ? text({ color: c.info }, `${g.dot}`) : text(null, ' '),
                text({ color: c.textFaint }, String(item.trackCount).padStart(4)),
              ),
          })
        : h(StatusBlock, {
            theme,
            icon: g.dot,
            title: 'No playlists',
            lines: ['Press n to create one.'],
          }),
    ),
    box(
      {
        flexDirection: 'column',
        width: detailWidth,
        borderStyle: theme.unicode ? 'single' : 'classic',
        borderColor: c.line,
        borderTop: false,
        borderBottom: false,
        borderRight: false,
        paddingLeft: 1,
      },
      selected
        ? h(PlaylistDetail, {
            theme,
            width: detailInner,
            height,
            playlist: selected,
            tracks,
            trackCursor,
            activePane,
            filter,
            filterFocused,
            onFilterChange,
            onFilterSubmit,
            favorites,
            currentTrackId,
            reordering,
          })
        : h(StatusBlock, {
            theme,
            icon: g.note,
            title: 'Create your first playlist',
            lines: [
              'Press n to name one, then add tracks with A from any list.',
              'Playlists store provider ids, so they keep working after a restart.',
            ],
          }),
    ),
  );
}

function PlaylistDetail({
  theme,
  width,
  height,
  playlist,
  tracks,
  trackCursor,
  activePane,
  filter,
  filterFocused,
  onFilterChange,
  onFilterSubmit,
  favorites,
  currentTrackId,
  reordering,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const missing = tracks.filter((t) => t.availability === 'unavailable').length;

  return box(
    { flexDirection: 'column', width },
    box(
      { flexDirection: 'row' },
      text(
        { color: activePane === 'tracks' ? c.textStrong : c.textMuted, bold: true },
        `${activePane === 'tracks' ? g.chevron : ' '} ${truncate(playlist.name, width - 28)}`,
      ),
      playlist.kind === 'smart' ? h(Badge, { theme, label: 'SMART', tone: 'info' }) : null,
    ),
    box(
      { flexDirection: 'row' },
      text(
        { color: c.textFaint },
        `  ${playlist.trackCount} track${playlist.trackCount === 1 ? '' : 's'} ${g.dot} ${playlist.durationPartial ? '~' : ''}${formatDuration(playlist.duration)}`,
      ),
      missing ? text({ color: c.warning }, `  ${g.warn} ${missing} unavailable`) : null,
    ),
    box(
      { flexDirection: 'row', marginTop: 0 },
      text({ color: filterFocused ? c.accent : c.textFaint }, '  filter '),
      h(TextInput, {
        theme,
        value: filter,
        onChange: onFilterChange,
        onSubmit: onFilterSubmit,
        onCancel: onFilterSubmit,
        focus: filterFocused,
        placeholder: 'press / to filter this playlist',
        width: Math.max(10, width - 12),
      }),
    ),
    h(Divider, { theme, width }),
    tracks.length
      ? h(ListView, {
          theme,
          items: tracks.map((track, i) => ({ key: `${track.id}:${i}`, track })),
          selectedIndex: trackCursor.index,
          height: Math.max(3, height - 7),
          focused: activePane === 'tracks',
          width,
          renderItem: (item, index, isSelected) =>
            box(
              { flexDirection: 'row' },
              text({ color: c.textFaint }, String(index + 1).padStart(3)),
              box(
                { flexGrow: 1 },
                h(TrackRow, {
                  theme,
                  track: item.track,
                  selected: isSelected && !reordering,
                  playing: item.track.id === currentTrackId,
                  favorite: favorites.has(item.track.id),
                  width: width - 5,
                  showProvider: false,
                }),
              ),
              reordering && isSelected ? text({ color: c.warning }, ` ${g.arrowRight}`) : null,
            ),
        })
      : h(StatusBlock, {
          theme,
          icon: g.dot,
          title: filter ? 'No matches in this playlist' : 'This playlist is empty',
          lines: [
            filter
              ? 'Clear the filter with esc.'
              : 'Add tracks with A from search, queue or favorites.',
          ],
        }),
  );
}
