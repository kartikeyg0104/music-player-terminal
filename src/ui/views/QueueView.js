import { box, text, h } from '../h.js';
import { ListView, TrackRow, StatusBlock, Divider } from '../components/primitives.js';
import { formatDuration } from '../../core/track.js';

/**
 * Queue screen.
 *
 * Shows the queue in *playback* order, which is the order things will
 * actually be heard - with shuffle on that differs from the order they were
 * added, and hiding that would make the queue a lie. The current track is
 * marked and separated from what is still to come.
 */
export function QueueView({
  theme,
  width,
  height,
  queue,
  cursor,
  favorites,
  reordering,
  shuffle,
  repeat,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const items = queue.ordered;

  if (!items.length) {
    return h(StatusBlock, {
      theme,
      icon: g.note,
      title: 'The queue is empty',
      lines: [
        'Press a on any track to add it, or Enter to play it now.',
        'Shift+A queues a whole playlist; p plays a track next.',
      ],
    });
  }

  const known = items.reduce((sum, item) => sum + (item.track.duration ?? 0), 0);
  const unknown = items.filter((item) => item.track.duration == null).length;
  const currentPosition = items.findIndex((item) => item.isCurrent);

  return box(
    { flexDirection: 'column', width, height },
    box(
      { flexDirection: 'row' },
      text({ color: c.textMuted }, ` ${items.length} track${items.length === 1 ? '' : 's'}`),
      text(
        { color: c.textFaint },
        `  ${g.dot}  ${unknown ? '~' : ''}${formatDuration(known)} total${unknown ? ` (${unknown} unknown)` : ''}`,
      ),
      text(
        { color: c.textFaint },
        `  ${g.dot}  ${shuffle ? 'shuffled' : 'in order'}  ${g.dot}  repeat ${repeat}`,
      ),
      reordering
        ? box(
            { flexGrow: 1, justifyContent: 'flex-end' },
            text({ color: c.warning }, `${g.warn} reorder mode - up/down moves, enter drops`),
          )
        : null,
    ),
    h(Divider, { theme, width }),
    h(ListView, {
      theme,
      items: items.map((item) => ({ ...item, key: item.uid })),
      selectedIndex: cursor.index,
      height: Math.max(3, height - 4),
      width,
      renderItem: (item, index, selected) =>
        box(
          { flexDirection: 'row' },
          text({ color: item.isCurrent ? c.accent : c.textFaint }, String(index + 1).padStart(3)),
          box(
            { flexGrow: 1 },
            h(TrackRow, {
              theme,
              track: item.track,
              selected: selected && !reordering,
              playing: item.isCurrent,
              favorite: favorites.has(item.track.id),
              width: width - 5,
              showProvider: false,
            }),
          ),
          reordering && selected ? text({ color: c.warning }, ` ${g.arrowRight}`) : null,
        ),
    }),
    currentPosition >= 0 && currentPosition < items.length - 1
      ? text(
          { color: c.textFaint },
          ` ${g.dot} ${items.length - currentPosition - 1} still to play`,
        )
      : null,
  );
}
