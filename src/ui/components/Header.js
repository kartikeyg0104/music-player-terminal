import { box, text, h } from '../h.js';
import { Badge } from './primitives.js';
import { truncate } from '../../core/util.js';

/**
 * Application header: identity, active provider, connection and audio status.
 *
 * Deliberately one line plus a rule - no ASCII banner. The right-hand side
 * carries the facts you need at a glance and nothing else.
 */
export function Header({ theme, width, provider, connection, backend, demo, context }) {
  const c = theme.colors;
  const g = theme.glyphs;

  const right = [];
  if (demo) right.push({ label: 'DEMO', tone: 'warning' });
  right.push({ label: provider.label, tone: provider.configured ? 'accent' : 'danger' });
  right.push({
    label: connection.online ? 'online' : 'offline',
    tone: connection.online ? 'success' : 'danger',
  });
  right.push({ label: backend, tone: backend === 'no audio backend' ? 'danger' : 'neutral' });

  const rightText = right.map((r) => r.label).join('  ');
  const leftWidth = Math.max(10, width - rightText.length - right.length * 2 - 4);

  return box(
    { flexDirection: 'column', width },
    box(
      { flexDirection: 'row', width },
      text({ color: c.accent, bold: true }, ` ${g.note} termify`),
      context
        ? text({ color: c.textFaint }, `  ${g.dot}  ${truncate(context, leftWidth - 12)}`)
        : text({ color: c.textFaint }, '  your music, your terminal'),
      box(
        { flexGrow: 1, justifyContent: 'flex-end', flexDirection: 'row' },
        ...right.map((item, i) =>
          h(Badge, { key: item.label + i, theme, label: item.label, tone: item.tone }),
        ),
      ),
    ),
    text({ color: c.line }, g.hLine.repeat(Math.max(0, width))),
  );
}
