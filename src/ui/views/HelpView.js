import { box, text, h } from '../h.js';
import { Divider } from '../components/primitives.js';

/**
 * Keyboard reference.
 *
 * Grouped the way people actually think about the app (move, play, organise)
 * rather than alphabetically, and laid out in columns that collapse to one on
 * a narrow terminal.
 */
export const SHORTCUT_GROUPS = [
  {
    title: 'Navigate',
    items: [
      ['1 - 0', 'jump straight to a section'],
      ['tab / shift+tab', 'move focus between panes'],
      ['up / down, j / k', 'move the selection'],
      ['pgup / pgdn', 'move a page'],
      ['g / G', 'first / last item'],
      ['esc', 'close a dialog, clear a filter, leave a field'],
      ['q', 'back, then quit from Home'],
      ['ctrl+c', 'quit immediately'],
    ],
  },
  {
    title: 'Play',
    items: [
      ['enter', 'play the selected track'],
      ['space', 'play / pause'],
      ['n / b', 'next / previous track'],
      ['left / right', 'seek back / forward'],
      ['+ / -', 'volume up / down'],
      ['s', 'shuffle on / off'],
      ['r', 'cycle repeat: off, one, all'],
      ['.', 'stop'],
      ['T', 'sleep timer'],
    ],
  },
  {
    title: 'Organise',
    items: [
      ['/', 'search (or filter, in a list)'],
      ['a', 'add to the end of the queue'],
      ['p', 'play next (top of the queue)'],
      ['f', 'toggle favorite'],
      ['A', 'add to a playlist'],
      ['n', 'new playlist (Playlists screen)'],
      ['R', 'rename playlist'],
      ['d', 'remove the selected item'],
      ['m', 'reorder mode (queue and playlists)'],
      ['X', 'clear the whole list'],
      ['[ / ]', 'previous / next page of results'],
      ['R', 'retry / re-run a search'],
    ],
  },
];

export function HelpView({ theme, width, height, version, backend, dataDir }) {
  const c = theme.colors;
  const g = theme.glyphs;
  const columns = width >= 96 ? 3 : width >= 64 ? 2 : 1;
  const colWidth = Math.floor((width - 2) / columns);
  const groups = [];
  for (let i = 0; i < SHORTCUT_GROUPS.length; i += columns) {
    groups.push(SHORTCUT_GROUPS.slice(i, i + columns));
  }

  return box(
    { flexDirection: 'column', width, height },
    box(
      { flexDirection: 'row' },
      text({ color: c.accent, bold: true }, ` ${g.note} Keyboard shortcuts`),
      text({ color: c.textFaint }, `   press ? or esc to close`),
    ),
    h(Divider, { theme, width }),
    ...groups.map((rowGroups, rowIndex) =>
      box(
        { key: rowIndex, flexDirection: 'row', marginBottom: 1 },
        ...rowGroups.map((group) =>
          box(
            { key: group.title, flexDirection: 'column', width: colWidth },
            text({ color: c.textFaint }, ` ${group.title.toUpperCase()}`),
            ...group.items.map(([keys, label]) =>
              box(
                { key: keys, flexDirection: 'row' },
                text({ color: c.accentSoft, bold: true }, ` ${keys.padEnd(16)}`),
                text({ color: c.textMuted }, label.slice(0, Math.max(8, colWidth - 19))),
              ),
            ),
          ),
        ),
      ),
    ),
    h(Divider, { theme, width }),
    text({ color: c.textFaint }, ` termify ${version}  ${g.dot}  audio: ${backend}`),
    text({ color: c.textFaint }, ` data: ${dataDir}`),
  );
}
