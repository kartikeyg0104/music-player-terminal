import { box, text, h, React } from '../h.js';
import { truncate } from '../../core/util.js';

/**
 * The component kit every view is built from.
 *
 * Each one takes the theme explicitly rather than reading a global, so a view
 * can be rendered in a test with any theme (including the ASCII one).
 */

/** A titled region with a left accent rule. Focus is shown on the rule. */
export function Panel({ theme, title, subtitle, focused, right, children, flexGrow, minHeight }) {
  const c = theme.colors;
  return box(
    { flexDirection: 'column', flexGrow, minHeight },
    title != null
      ? box(
          { flexDirection: 'row', marginBottom: 0 },
          text({ color: focused ? c.accent : c.textFaint }, focused ? theme.glyphs.chevron : ' '),
          text({ color: focused ? c.textStrong : c.textMuted, bold: true }, ` ${title}`),
          subtitle ? text({ color: c.textFaint }, `  ${theme.glyphs.dot}  ${subtitle}`) : null,
          right ? box({ flexGrow: 1, justifyContent: 'flex-end' }, right) : null,
        )
      : null,
    children,
  );
}

/** Thin horizontal rule used between sections. */
export function Divider({ theme, width, label }) {
  const c = theme.colors;
  const line = theme.glyphs.hLine;
  if (!label) return text({ color: c.line }, line.repeat(Math.max(0, width)));
  const prefix = line.repeat(2);
  const rest = Math.max(0, width - label.length - 4);
  return text(
    { color: c.line },
    prefix,
    text({ color: c.textFaint }, ` ${label} `),
    line.repeat(rest),
  );
}

/** Small uppercase tag: provider names, SAMPLE, LIVE, modes. */
export function Badge({ theme, label, tone = 'neutral', dim }) {
  const c = theme.colors;
  const tones = {
    neutral: c.textMuted,
    accent: c.accent,
    success: c.success,
    warning: c.warning,
    danger: c.danger,
    info: c.info,
  };
  return text({ color: tones[tone] ?? c.textMuted, dimColor: dim }, ` ${label} `);
}

/**
 * Playback progress. Renders a filled bar with a head marker and the
 * elapsed/total pair. `estimated` renders the time in a muted tone so a
 * wall-clock guess is never mistaken for a decoder position.
 */
export function ProgressBar({
  theme,
  value,
  max,
  width,
  elapsedLabel,
  totalLabel,
  estimated,
  tone,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const barWidth = Math.max(4, width);
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = max > 0 ? Math.round(ratio * barWidth) : 0;
  const head = filled > 0 && filled < barWidth ? 1 : 0;
  const color = tone ?? c.accent;

  return box(
    { flexDirection: 'row' },
    text({ color: estimated ? c.textFaint : c.textMuted }, elapsedLabel),
    text(null, ' '),
    text({ color }, g.barFull.repeat(Math.max(0, filled - head))),
    head ? text({ color: c.textStrong }, g.barHead) : null,
    text({ color: c.line }, g.barEmpty.repeat(Math.max(0, barWidth - filled))),
    text(null, ' '),
    text({ color: estimated ? c.textFaint : c.textMuted }, totalLabel),
  );
}

/** Volume as a compact discrete meter. */
export function VolumeMeter({ theme, volume, width = 10, muted }) {
  const c = theme.colors;
  const g = theme.glyphs;
  const filled = Math.round((volume / 100) * width);
  return box(
    { flexDirection: 'row' },
    text({ color: muted ? c.textFaint : c.textMuted }, `${g.volume} `),
    text({ color: muted ? c.textFaint : c.accent }, g.barFull.repeat(filled)),
    text({ color: c.line }, g.barEmpty.repeat(Math.max(0, width - filled))),
    text({ color: c.textFaint }, ` ${String(volume).padStart(3)}%`),
  );
}

/** Braille spinner; falls back to a static glyph when animations are off. */
export function Spinner({ theme, label, tone }) {
  const frames = theme.glyphs.spinner;
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!theme.animations) return undefined;
    const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), 90);
    return () => clearInterval(timer);
  }, [theme.animations, frames.length]);
  const c = theme.colors;
  return box(
    { flexDirection: 'row' },
    text({ color: tone ?? c.accent }, theme.animations ? frames[frame] : theme.glyphs.dot),
    label ? text({ color: c.textMuted }, ` ${label}`) : null,
  );
}

/** Centred message used for empty, error and loading states. */
export function StatusBlock({ theme, icon, title, lines = [], tone = 'muted', actions }) {
  const c = theme.colors;
  const tones = { muted: c.textMuted, danger: c.danger, warning: c.warning, accent: c.accent };
  return box(
    { flexDirection: 'column', paddingX: 2, paddingY: 1 },
    box(
      { flexDirection: 'row' },
      icon ? text({ color: tones[tone] ?? c.textMuted }, `${icon} `) : null,
      text({ color: c.textStrong, bold: true }, title),
    ),
    ...lines.filter(Boolean).map((line, i) => text({ key: i, color: c.textMuted }, line)),
    actions ? box({ marginTop: 1 }, actions) : null,
  );
}

/** Inline keyboard hint, e.g. `enter play`. */
export function KeyHint({ theme, keys, label, separator = true }) {
  const c = theme.colors;
  return box(
    { flexDirection: 'row' },
    text({ color: c.accentSoft, bold: true }, keys),
    text({ color: c.textFaint }, ` ${label}`),
    separator ? text({ color: c.line }, `  ${theme.glyphs.dot}  `) : null,
  );
}

/** Row of hints that truncates rather than wrapping in a narrow terminal. */
export function KeyHintBar({ theme, hints, width }) {
  const c = theme.colors;
  const parts = [];
  let used = 0;
  for (const hint of hints) {
    const piece = `${hint.keys} ${hint.label}`;
    if (used + piece.length + 3 > width) break;
    used += piece.length + 3;
    parts.push(hint);
  }
  return box(
    { flexDirection: 'row' },
    ...parts.map((hint, i) =>
      h(KeyHint, { key: hint.keys, theme, ...hint, separator: i < parts.length - 1 }),
    ),
    parts.length < hints.length
      ? text({ color: c.textFaint }, `  ${theme.glyphs.dot}  ? more`)
      : null,
  );
}

/**
 * Scrolling list with a stable viewport.
 *
 * Keeps the selection inside a margin from the edges so the list scrolls
 * before the cursor hits the boundary, which reads far better than paging.
 */
export function ListView({
  theme,
  items,
  selectedIndex,
  height,
  renderItem,
  emptyState,
  focused,
  width,
}) {
  const c = theme.colors;
  if (!items.length) return emptyState ?? null;

  const viewport = Math.max(1, height);
  const margin = Math.min(2, Math.floor(viewport / 3));
  let start = 0;
  if (items.length > viewport) {
    start = Math.min(Math.max(0, selectedIndex - (viewport - margin - 1)), items.length - viewport);
    start = Math.max(0, Math.min(start, Math.max(0, selectedIndex - margin)));
    if (selectedIndex < margin) start = 0;
    if (selectedIndex > items.length - margin - 1) start = items.length - viewport;
    start = Math.max(0, Math.min(start, items.length - viewport));
  }
  const visible = items.slice(start, start + viewport);

  return box(
    { flexDirection: 'column' },
    ...visible.map((item, i) => {
      const index = start + i;
      return h(
        React.Fragment,
        { key: item.key ?? index },
        renderItem(item, index, index === selectedIndex && focused !== false, width),
      );
    }),
    items.length > viewport
      ? text(
          { color: c.textFaint },
          `  ${start + 1}-${Math.min(items.length, start + viewport)} of ${items.length}`,
        )
      : null,
  );
}

/**
 * A single track row: selection bar, index, title/artist, badges, duration.
 * Column widths are computed from the available width so nothing wraps.
 */
export function TrackRow({
  theme,
  track,
  index,
  selected,
  playing,
  favorite,
  width,
  showProvider = true,
  trailing,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const marker = playing ? g.play : selected ? g.chevron : ' ';
  const durationText = trailing ?? formatTime(track.duration, g);
  const badges = [];
  if (track.isSample) badges.push({ label: 'SAMPLE', tone: 'warning' });
  if (track.availability === 'unavailable') badges.push({ label: 'GONE', tone: 'danger' });
  else if (track.availability === 'metadata-only')
    badges.push({ label: 'INFO ONLY', tone: 'info' });

  const badgeWidth = badges.reduce((sum, b) => sum + b.label.length + 2, 0);
  const providerLabel = showProvider ? shortProvider(track.provider) : '';
  const fixed =
    4 + durationText.length + badgeWidth + (providerLabel ? providerLabel.length + 2 : 0) + 3;
  const flexible = Math.max(12, width - fixed);
  const titleWidth = Math.max(8, Math.floor(flexible * 0.58));
  const artistWidth = Math.max(4, flexible - titleWidth);

  return box(
    { flexDirection: 'row' },
    text({ color: playing ? c.accent : selected ? c.accent : c.textFaint }, ` ${marker} `),
    text(
      {
        color: favorite ? c.danger : c.textFaint,
      },
      favorite ? g.heart : ' ',
    ),
    text(
      {
        color: playing ? c.accent : selected ? c.textStrong : c.text,
        bold: selected || playing,
      },
      ` ${truncate(track.title, titleWidth).padEnd(titleWidth)}`,
    ),
    text({ color: c.textMuted }, ` ${truncate(track.artist, artistWidth).padEnd(artistWidth)}`),
    ...badges.map((b) => h(Badge, { key: b.label, theme, label: b.label, tone: b.tone })),
    providerLabel ? text({ color: c.textFaint }, ` ${providerLabel}`) : null,
    text({ color: selected ? c.text : c.textFaint }, ` ${durationText}`),
    index != null ? null : null,
  );
}

function formatTime(seconds, glyphs) {
  if (seconds == null || !Number.isFinite(seconds)) return `--${glyphs.dot}--`;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, ' ')}:${String(s).padStart(2, '0')}`;
}

function shortProvider(provider) {
  return (
    {
      archive: 'archive',
      jamendo: 'jamendo',
      local: 'local',
      mock: 'demo',
    }[provider] ?? provider
  );
}
