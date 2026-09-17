import { box, text, h } from '../h.js';
import { Divider, TrackRow, StatusBlock, Badge } from '../components/primitives.js';
import { formatListeningTime } from '../../core/track.js';
import { relativeTime, truncate } from '../../core/util.js';

/**
 * Home: a short status board plus the two lists you actually reach for.
 *
 * Numbers here are only ever things Termify has measured. When there is no
 * history yet the tiles say so rather than showing a confident zero.
 */
export function HomeView({
  theme,
  width,
  height,
  stats,
  counts,
  recent,
  favorites,
  cursor,
  currentTrackId,
  favoriteIds,
  provider,
  demo,
  boot,
}) {
  const c = theme.colors;
  const g = theme.glyphs;

  const summary = stats.summary;
  const tileWidth = Math.floor((width - 4) / 4);
  const listHeight = Math.max(2, Math.floor((height - 12) / 2));
  const rows = [...recent.slice(0, listHeight), ...favorites.slice(0, listHeight)];

  return box(
    { flexDirection: 'column', width, height },
    // --- tiles ----------------------------------------------------------
    box(
      { flexDirection: 'row', width },
      h(Tile, {
        theme,
        label: 'Listening time',
        value: summary.available ? formatListeningTime(summary.seconds) : 'no data yet',
        muted: !summary.available,
        width: tileWidth,
      }),
      h(Tile, {
        theme,
        label: 'Tracks played',
        value: summary.available ? String(summary.plays) : 'no data yet',
        muted: !summary.available,
        width: tileWidth,
      }),
      h(Tile, {
        theme,
        label: 'Favorites',
        value: String(counts.favorites),
        width: tileWidth,
      }),
      h(Tile, {
        theme,
        label: 'Playlists',
        value: String(counts.playlists),
        width: tileWidth,
      }),
    ),
    box(
      { flexDirection: 'row', marginTop: 1 },
      text({ color: c.textFaint }, ` ${g.dot} source: `),
      text({ color: provider.configured ? c.accent : c.danger }, provider.label),
      demo ? h(Badge, { theme, label: 'DEMO MODE - sample data only', tone: 'warning' }) : null,
      boot?.audioFallbackReason
        ? text({ color: c.warning }, `  ${g.warn} ${boot.audioFallbackReason}`)
        : null,
    ),
    h(Divider, { theme, width, label: 'Recently played' }),
    recent.length
      ? box(
          { flexDirection: 'column' },
          ...recent.slice(0, listHeight).map((entry, i) =>
            box(
              { key: entry.id ?? i, flexDirection: 'row' },
              h(TrackRow, {
                theme,
                track: entry.track,
                selected: cursor.index === i,
                playing: entry.track.id === currentTrackId,
                favorite: favoriteIds.has(entry.track.id),
                width: width - 12,
                trailing: relativeTime(entry.playedAt),
              }),
            ),
          ),
        )
      : h(StatusBlock, {
          theme,
          icon: g.dot,
          title: 'Nothing played yet',
          lines: ['Press / to search, or 3 to browse what your provider offers.'],
        }),
    h(Divider, { theme, width, label: 'Favorites' }),
    favorites.length
      ? box(
          { flexDirection: 'column' },
          ...favorites.slice(0, listHeight).map((track, i) =>
            h(TrackRow, {
              key: track.id,
              theme,
              track,
              selected: cursor.index === recent.slice(0, listHeight).length + i,
              playing: track.id === currentTrackId,
              favorite: true,
              width,
            }),
          ),
        )
      : h(StatusBlock, {
          theme,
          icon: g.heartEmpty,
          title: 'No favorites yet',
          lines: ['Press f on any track to save it here.'],
        }),
    rows.length
      ? box(
          { marginTop: 1 },
          text(
            { color: c.textFaint },
            ` ${g.dot} enter plays  ${g.dot}  f favorite  ${g.dot}  a queue`,
          ),
        )
      : null,
  );
}

function Tile({ theme, label, value, width, muted }) {
  const c = theme.colors;
  return box(
    { flexDirection: 'column', width, marginRight: 1 },
    text({ color: c.textFaint }, truncate(label.toUpperCase(), width - 1)),
    text({ color: muted ? c.textFaint : c.textStrong, bold: !muted }, truncate(value, width - 1)),
  );
}

/** Flattened selectable rows for Home, so the cursor maps to a real track. */
export function homeRows(recent, favorites, listHeight) {
  return [
    ...recent.slice(0, listHeight).map((entry) => entry.track),
    ...favorites.slice(0, listHeight),
  ];
}
