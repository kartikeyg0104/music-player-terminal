import { box, text, h } from '../h.js';
import { Divider, StatusBlock } from '../components/primitives.js';
import { formatListeningTime } from '../../core/track.js';
import { truncate } from '../../core/util.js';

/**
 * Listening statistics.
 *
 * Everything on this screen is computed from the history table. Sections
 * whose input data does not exist say "no data" rather than rendering an
 * empty chart that reads as "you listened to nothing".
 */
export function StatsView({
  theme,
  width,
  height,
  summary,
  topTracks,
  topArtists,
  topGenres,
  activity,
}) {
  const c = theme.colors;
  const g = theme.glyphs;

  if (!summary.available) {
    return h(StatusBlock, {
      theme,
      icon: g.info,
      title: 'No listening data yet',
      lines: [
        'Statistics are derived from your play history.',
        'Play a few tracks and this screen fills in.',
        'History is currently recorded only if enabled in Settings.',
      ],
    });
  }

  const colWidth = Math.floor((width - 4) / 2);

  return box(
    { flexDirection: 'column', width, height },
    box(
      { flexDirection: 'row' },
      h(Stat, {
        theme,
        label: 'Total listening',
        value: formatListeningTime(summary.seconds),
        width: colWidth / 2,
      }),
      h(Stat, { theme, label: 'Plays', value: String(summary.plays), width: colWidth / 2 }),
      h(Stat, {
        theme,
        label: 'Distinct tracks',
        value: String(summary.uniqueTracks),
        width: colWidth / 2,
      }),
      h(Stat, {
        theme,
        label: 'Since',
        value: new Date(summary.firstPlay).toLocaleDateString(),
        width: colWidth / 2,
      }),
    ),
    h(Divider, { theme, width, label: 'Activity (last 14 days)' }),
    h(Sparkline, { theme, activity, width: width - 4 }),
    box(
      { flexDirection: 'row', marginTop: 1 },
      box(
        { flexDirection: 'column', width: colWidth },
        text({ color: c.textFaint }, ' MOST PLAYED'),
        ...(topTracks.length
          ? topTracks
              .slice(0, Math.max(3, Math.floor((height - 14) / 2)))
              .map((row, i) =>
                box(
                  { key: row.track.id, flexDirection: 'row' },
                  text({ color: c.textFaint }, ` ${String(i + 1).padStart(2)} `),
                  text(
                    { color: c.text },
                    truncate(row.track.title, colWidth - 18).padEnd(colWidth - 18),
                  ),
                  text({ color: c.accent }, String(row.plays).padStart(3)),
                  text({ color: c.textFaint }, ` ${g.dot} ${formatListeningTime(row.seconds)}`),
                ),
              )
          : [text({ color: c.textFaint }, '  no data')]),
      ),
      box(
        { flexDirection: 'column', width: colWidth, marginLeft: 2 },
        text({ color: c.textFaint }, ' TOP ARTISTS'),
        ...(topArtists.length
          ? topArtists
              .slice(0, Math.max(3, Math.floor((height - 14) / 2)))
              .map((row, i) =>
                box(
                  { key: row.artist, flexDirection: 'row' },
                  text({ color: c.textFaint }, ` ${String(i + 1).padStart(2)} `),
                  text(
                    { color: c.text },
                    truncate(row.artist, colWidth - 18).padEnd(colWidth - 18),
                  ),
                  text({ color: c.accent }, String(row.plays).padStart(3)),
                  text({ color: c.textFaint }, ` ${g.dot} ${row.tracks} tracks`),
                ),
              )
          : [text({ color: c.textFaint }, '  no data')]),
      ),
    ),
    box(
      { flexDirection: 'row', marginTop: 1 },
      text({ color: c.textFaint }, ' TOP GENRES  '),
      topGenres.length
        ? box(
            { flexDirection: 'row' },
            ...topGenres.map((row) =>
              text(
                { key: row.genre, color: c.text },
                `${row.genre} `,
                text({ color: c.textFaint }, `${row.plays}  `),
              ),
            ),
          )
        : text(
            { color: c.textFaint },
            'no genre metadata in your history (providers do not always supply it)',
          ),
    ),
  );
}

function Stat({ theme, label, value, width }) {
  const c = theme.colors;
  const w = Math.max(10, Math.floor(width));
  return box(
    { flexDirection: 'column', width: w },
    text({ color: c.textFaint }, ` ${truncate(label.toUpperCase(), w - 2)}`),
    text({ color: c.textStrong, bold: true }, ` ${truncate(value, w - 2)}`),
  );
}

/** Per-day plays, scaled to the busiest day. Zero days render as a baseline. */
function Sparkline({ theme, activity, width }) {
  const c = theme.colors;
  const ramp = theme.glyphs.levels;
  const max = Math.max(1, ...activity.map((d) => d.plays));
  const cells = activity.slice(-Math.max(7, Math.min(activity.length, width - 12)));

  return box(
    { flexDirection: 'row' },
    text(null, ' '),
    ...cells.map((day, i) => {
      const level =
        day.plays === 0 ? 0 : Math.max(1, Math.round((day.plays / max) * (ramp.length - 1)));
      return text(
        {
          key: day.day,
          color: day.plays === 0 ? c.line : i === cells.length - 1 ? c.accent : c.accentSoft,
        },
        ramp[level],
      );
    }),
    text({ color: c.textFaint }, `  peak ${max}/day`),
  );
}
