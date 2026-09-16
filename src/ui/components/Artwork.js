import { box, text, React } from '../h.js';

/**
 * Album art rendered with half-block characters.
 *
 * Each cell draws the upper half-block: foreground colour is the top pixel,
 * background colour the bottom one, so one character row shows two pixel
 * rows. When real pixels are unavailable (no ffmpeg, no cover, still loading)
 * we draw a monogram card derived from the track's own metadata instead of
 * faking an image.
 */
export function Artwork({ theme, track, service, width = 16, height = 8 }) {
  const [art, setArt] = React.useState(() => service?.peek(track, { width, height }) ?? null);

  React.useEffect(() => {
    let cancelled = false;
    setArt(service?.peek(track, { width, height }) ?? null);
    if (!track || !service?.available) return undefined;
    service
      .load(track, { width, height })
      .then((result) => {
        if (!cancelled) setArt(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Keyed on the id: the same track re-rendered must not refetch artwork.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, service, width, height]);

  if (art?.kind === 'pixels') {
    return box(
      { flexDirection: 'column' },
      ...art.rows.map((row, y) =>
        box(
          { key: y, flexDirection: 'row' },
          ...row.map(([top, bottom], x) =>
            text({ key: x, color: top, backgroundColor: bottom }, theme.glyphs.blockUpper),
          ),
        ),
      ),
    );
  }

  return fallbackCard(theme, track, width, height);
}

/** Deterministic monogram card: initials on a hashed accent tint. */
function fallbackCard(theme, track, width, height) {
  const c = theme.colors;
  const initials = monogram(track);
  const tint = theme.rich ? tintFor(track?.id ?? '', theme) : c.accentSoft;
  const rows = [];
  const midTop = Math.floor((height - 1) / 2);

  for (let y = 0; y < height; y += 1) {
    if (y === midTop) {
      const pad = Math.max(0, Math.floor((width - initials.length) / 2));
      rows.push(
        box(
          { key: y, flexDirection: 'row' },
          text({ backgroundColor: tint, color: c.surface }, ' '.repeat(pad)),
          text({ backgroundColor: tint, color: c.textStrong, bold: true }, initials),
          text(
            { backgroundColor: tint, color: c.surface },
            ' '.repeat(Math.max(0, width - pad - initials.length)),
          ),
        ),
      );
    } else {
      rows.push(
        box({ key: y, flexDirection: 'row' }, text({ backgroundColor: tint }, ' '.repeat(width))),
      );
    }
  }
  return box({ flexDirection: 'column' }, ...rows);
}

function monogram(track) {
  if (!track) return '--';
  const source = `${track.artist ?? ''} ${track.title ?? ''}`.trim();
  const words = source.split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Stable, low-saturation tint so the card is calm but distinct per track. */
function tintFor(seed, theme) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const [r, g, b] = hslToRgb(hue / 360, 0.22, 0.24);
  if (!theme.rich) return theme.colors.accentSoft;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
  };
  return [f(0), f(8), f(4)];
}
