import { box, text } from '../h.js';

/**
 * Left navigation rail.
 *
 * Every entry has a number shortcut so you can jump anywhere in one keystroke
 * without cycling. The active item is marked with the accent bar; the focused
 * pane (nav vs content) is shown by the header chevron, not by a border, to
 * keep the frame quiet.
 */
export const NAV_ITEMS = [
  { id: 'home', label: 'Home', key: '1', group: 'Discover' },
  { id: 'search', label: 'Search', key: '2', group: 'Discover' },
  { id: 'discover', label: 'Discover', key: '3', group: 'Discover' },
  { id: 'queue', label: 'Queue', key: '4', group: 'Library' },
  { id: 'playlists', label: 'Playlists', key: '5', group: 'Library' },
  { id: 'favorites', label: 'Favorites', key: '6', group: 'Library' },
  { id: 'history', label: 'History', key: '7', group: 'Library' },
  { id: 'stats', label: 'Stats', key: '8', group: 'Library' },
  { id: 'lyrics', label: 'Lyrics', key: '9', group: 'Now playing' },
  { id: 'settings', label: 'Settings', key: '0', group: 'System' },
];

export function Sidebar({ theme, active, focused, width, counts, navIndex }) {
  const c = theme.colors;
  const g = theme.glyphs;
  const rows = [];
  let lastGroup = null;

  NAV_ITEMS.forEach((item, index) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      rows.push(
        box(
          { key: `g-${item.group}`, marginTop: rows.length ? 1 : 0 },
          text({ color: c.textFaint }, ` ${item.group.toUpperCase()}`),
        ),
      );
    }
    const isActive = item.id === active;
    const isCursor = focused && index === navIndex;
    const count = counts?.[item.id];
    const label = item.label.padEnd(Math.max(0, width - 8));
    rows.push(
      box(
        { key: item.id, flexDirection: 'row' },
        text({ color: isActive ? c.accent : c.line }, isActive ? g.blockFull : ' '),
        text({ color: isCursor ? c.accent : c.textFaint }, isCursor ? g.chevron : ' '),
        text(
          {
            color: isActive ? c.textStrong : isCursor ? c.text : c.textMuted,
            bold: isActive,
          },
          ` ${label}`,
        ),
        text({ color: c.textFaint }, count != null ? String(count).padStart(3) : '   '),
        text({ color: c.line }, ` ${item.key}`),
      ),
    );
  });

  return box({ flexDirection: 'column', width, flexShrink: 0 }, ...rows);
}

/** Horizontal tab strip used when the terminal is too narrow for the rail. */
export function CompactNav({ theme, active, width }) {
  const c = theme.colors;
  const parts = [];
  let used = 0;
  for (const item of NAV_ITEMS) {
    const piece = `${item.key} ${item.label}`;
    if (used + piece.length + 2 > width) break;
    used += piece.length + 2;
    parts.push(item);
  }
  return box(
    { flexDirection: 'row', width },
    ...parts.map((item) =>
      text(
        {
          key: item.id,
          color: item.id === active ? c.accent : c.textFaint,
          bold: item.id === active,
        },
        ` ${item.key}${item.id === active ? '·' : ' '}${item.label}`,
      ),
    ),
  );
}
