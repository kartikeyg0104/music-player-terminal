import { box, text, h } from '../h.js';
import { ListView, Divider, Badge } from '../components/primitives.js';
import { truncate } from '../../core/util.js';

/**
 * Settings.
 *
 * Rows are generated from `SETTING_SPECS`, so this screen never drifts from
 * the schema. Left/right changes a value in place; Enter opens an editor for
 * free-text values. Action rows (cache, reset) live at the bottom and ask for
 * confirmation before doing anything destructive.
 */
export const SETTINGS_ACTIONS = [
  { id: 'rescan-local', label: 'Rescan local music folder', description: 'Re-read tags from disk' },
  {
    id: 'clear-cache',
    label: 'Clear metadata cache',
    description: 'Drop cached provider responses',
  },
  {
    id: 'clear-artwork',
    label: 'Clear artwork cache',
    description: 'Delete downloaded cover images',
  },
  { id: 'clear-history', label: 'Clear listening history', description: 'Cannot be undone' },
  { id: 'reset-settings', label: 'Reset all settings', description: 'Restore every default' },
];

export function SettingsView({
  theme,
  width,
  height,
  rows,
  cursor,
  providers,
  backends,
  cacheStats,
  paths,
  demo,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const listHeight = Math.max(4, height - 9);
  const labelWidth = Math.min(28, Math.floor(width * 0.3));
  const valueWidth = Math.min(24, Math.floor(width * 0.22));

  return box(
    { flexDirection: 'column', width, height },
    h(ListView, {
      theme,
      items: rows,
      selectedIndex: cursor.index,
      height: listHeight,
      width,
      renderItem: (row, index, selected) =>
        renderRow({ theme, row, selected, labelWidth, valueWidth, width }),
    }),
    h(Divider, { theme, width, label: 'Environment' }),
    box(
      { flexDirection: 'column' },
      box(
        { flexDirection: 'row' },
        text({ color: c.textFaint }, ' providers  '),
        ...providers.map((p) =>
          h(Badge, {
            key: p.id,
            theme,
            label: `${p.label}${p.configured ? '' : ' (not configured)'}`,
            tone: p.configured ? (p.isLive ? 'success' : 'warning') : 'danger',
          }),
        ),
      ),
      box(
        { flexDirection: 'row' },
        text({ color: c.textFaint }, ' audio      '),
        ...backends.map((b) =>
          h(Badge, {
            key: b.id,
            theme,
            label: b.label,
            tone: b.available ? 'success' : 'neutral',
            dim: !b.available,
          }),
        ),
      ),
      text(
        { color: c.textFaint },
        ` cache       ${cacheStats.entries} entries ${g.dot} ${formatBytes(cacheStats.bytes)} ${g.dot} ttl ${cacheStats.ttlMinutes}m`,
      ),
      text({ color: c.textFaint }, ` data        ${truncate(paths.dataDir, width - 14)}`),
      demo
        ? text({ color: c.warning }, ` ${g.warn} demo mode is on: results are built-in sample data`)
        : null,
    ),
  );
}

function renderRow({ theme, row, selected, labelWidth, valueWidth, width }) {
  const c = theme.colors;
  const g = theme.glyphs;

  if (row.kind === 'section') {
    return box({ marginTop: 1 }, text({ color: c.textFaint }, ` ${row.label.toUpperCase()}`));
  }

  if (row.kind === 'action') {
    return box(
      { flexDirection: 'row' },
      text({ color: selected ? c.accent : c.textFaint }, selected ? ` ${g.chevron} ` : '   '),
      text(
        { color: selected ? c.textStrong : c.text, bold: selected },
        truncate(row.label, labelWidth + valueWidth).padEnd(labelWidth + valueWidth),
      ),
      text(
        { color: c.textFaint },
        truncate(row.description, Math.max(0, width - labelWidth - valueWidth - 6)),
      ),
    );
  }

  const spec = row.spec;
  const value = formatValue(spec, row.value, theme);
  return box(
    { flexDirection: 'row' },
    text({ color: selected ? c.accent : c.textFaint }, selected ? ` ${g.chevron} ` : '   '),
    text(
      { color: selected ? c.textStrong : c.text, bold: selected },
      truncate(spec.label, labelWidth).padEnd(labelWidth),
    ),
    text(
      { color: selected ? c.accent : c.textMuted },
      truncate(value, valueWidth).padEnd(valueWidth),
    ),
    text(
      { color: c.textFaint },
      truncate(spec.description, Math.max(0, width - labelWidth - valueWidth - 6)),
    ),
  );
}

function formatValue(spec, value, theme) {
  const g = theme.glyphs;
  if (spec.type === 'boolean') return value ? `${g.check} on` : `${g.cross} off`;
  if (spec.type === 'integer') return String(value);
  if (spec.type === 'path') return value || '(not set)';
  return String(value);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Build the flat row model (sections, settings, actions) the list renders. */
export function buildSettingsRows(specs, settings) {
  const rows = [];
  let section = null;
  for (const spec of specs) {
    if (spec.section !== section) {
      section = spec.section;
      rows.push({ kind: 'section', key: `s:${section}`, label: section, selectable: false });
    }
    rows.push({
      kind: 'setting',
      key: spec.key,
      spec,
      value: settings[spec.key],
      selectable: true,
    });
  }
  rows.push({ kind: 'section', key: 's:actions', label: 'Actions', selectable: false });
  for (const action of SETTINGS_ACTIONS) {
    rows.push({ kind: 'action', key: action.id, ...action, selectable: true });
  }
  return rows;
}
