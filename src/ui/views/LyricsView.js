import { box, text, h } from '../h.js';
import { Divider, StatusBlock, Badge, Spinner } from '../components/primitives.js';
import { formatDuration } from '../../core/track.js';
import { truncate } from '../../core/util.js';

/**
 * Lyrics screen.
 *
 * When the source provided timestamps the active line is highlighted and the
 * view auto-scrolls with playback. When it did not, lines render plainly and
 * the header says "not synchronised" - Termify never estimates timings.
 */
export function LyricsView({ theme, width, height, track, lyrics, position, loading }) {
  const c = theme.colors;
  const g = theme.glyphs;

  if (!track) {
    return h(StatusBlock, {
      theme,
      icon: g.note,
      title: 'Nothing playing',
      lines: ['Lyrics follow the current track. Start something first.'],
    });
  }

  const header = box(
    { flexDirection: 'column' },
    box(
      { flexDirection: 'row' },
      text(
        { color: c.textStrong, bold: true },
        ` ${truncate(track.title, Math.floor(width * 0.4))}`,
      ),
      text({ color: c.textFaint }, `  ${g.dot}  ${truncate(track.artist, 30)}`),
      lyrics?.status === 'synced'
        ? h(Badge, { theme, label: 'SYNCED', tone: 'success' })
        : lyrics?.status === 'plain'
          ? h(Badge, { theme, label: 'NOT SYNCHRONISED', tone: 'info' })
          : null,
      lyrics?.source ? text({ color: c.textFaint }, ` ${lyrics.source}`) : null,
    ),
    h(Divider, { theme, width }),
  );

  if (loading) {
    return box(
      { flexDirection: 'column', width, height },
      header,
      box({ paddingX: 2, paddingY: 1 }, h(Spinner, { theme, label: 'looking for lyrics' })),
    );
  }

  if (!lyrics || lyrics.status === 'none') {
    return box(
      { flexDirection: 'column', width, height },
      header,
      h(StatusBlock, {
        theme,
        icon: g.info,
        title: 'No lyrics available',
        lines: [
          lyrics?.note ?? 'Nothing found for this track.',
          'Local .lrc files sitting next to an audio file are picked up automatically.',
          'Set "Lyrics source" to lrclib in Settings to search online.',
        ],
      }),
    );
  }

  const viewport = Math.max(3, height - 3);
  const active = activeIndex(lyrics.lines, position);
  const start =
    lyrics.status === 'synced' && active >= 0
      ? Math.max(0, Math.min(active - Math.floor(viewport / 2), lyrics.lines.length - viewport))
      : 0;
  const visible = lyrics.lines.slice(start, start + viewport);

  return box(
    { flexDirection: 'column', width, height },
    header,
    box(
      { flexDirection: 'column' },
      ...visible.map((line, i) => {
        const index = start + i;
        const isActive = lyrics.status === 'synced' && index === active;
        return box(
          { key: index, flexDirection: 'row' },
          lyrics.status === 'synced'
            ? text(
                { color: isActive ? c.accent : c.textFaint },
                ` ${formatDuration(line.time).padStart(6)} `,
              )
            : text(null, '  '),
          text(
            { color: isActive ? c.textStrong : c.textMuted, bold: isActive },
            truncate(line.text || ' ', width - 12),
          ),
        );
      }),
    ),
    lyrics.note ? text({ color: c.textFaint }, ` ${g.info} ${lyrics.note}`) : null,
  );
}

function activeIndex(lines, seconds) {
  let active = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time == null) continue;
    if (lines[i].time <= seconds) active = i;
    else break;
  }
  return active;
}
