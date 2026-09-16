import { box, text, React } from '../h.js';

/**
 * Playback visualiser.
 *
 * Two honest modes, and the label always says which one you are looking at:
 *
 *  - `decorative` - a smooth animation driven by a timer. It reacts to
 *    play/pause state and nothing else. Labelled "decorative" in the UI so it
 *    is never mistaken for audio analysis.
 *  - `levels` - real RMS levels sampled from the audio by `LevelAnalyser`
 *    (ffmpeg's `astats` filter). Only offered for local files, where a second
 *    decode is cheap and adds no network traffic.
 *
 * There is no third mode that dresses random numbers up as a spectrum.
 */
export function Visualizer({ theme, playing, width = 24, mode = 'decorative', levels }) {
  const c = theme.colors;
  const g = theme.glyphs;
  const bars = Math.max(4, Math.min(width, 48));
  const [phase, setPhase] = React.useState(0);

  const animate = mode === 'decorative' && playing && theme.animations;
  React.useEffect(() => {
    if (!animate) return undefined;
    const timer = setInterval(() => setPhase((p) => p + 1), 110);
    return () => clearInterval(timer);
  }, [animate]);

  if (mode === 'off') return null;

  let heights;
  let label;
  if (mode === 'levels' && levels?.available) {
    heights = spread(levels.values, bars);
    label = 'RMS';
  } else if (mode === 'levels') {
    return box(
      { flexDirection: 'row' },
      text({ color: c.textFaint }, `${g.dot} ${levels?.reason ?? 'no analysis data'}`),
    );
  } else {
    heights = decorativeShape(bars, phase, playing);
    label = 'decorative';
  }

  const ramp = g.levels;
  return box(
    { flexDirection: 'row' },
    ...heights.map((value, i) => {
      const level = Math.max(0, Math.min(ramp.length - 1, Math.round(value * (ramp.length - 1))));
      const colour = value > 0.75 ? c.accent : value > 0.4 ? c.accentSoft : c.line;
      return text({ key: i, color: playing ? colour : c.line }, ramp[level]);
    }),
    text({ color: c.textFaint }, ` ${label}`),
  );
}

/**
 * A pair of travelling sine waves. Deterministic in `phase`, so it is a
 * repeatable animation rather than noise pretending to be a spectrum.
 */
function decorativeShape(bars, phase, playing) {
  if (!playing) return new Array(bars).fill(0.06);
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    const a = Math.sin((i / bars) * Math.PI * 2 + phase * 0.22);
    const b = Math.sin((i / bars) * Math.PI * 5 - phase * 0.13);
    // Bell-shaped envelope so the middle is livelier than the edges.
    const envelope = Math.sin((i / (bars - 1)) * Math.PI) ** 0.7;
    out.push(Math.max(0.05, ((a * 0.6 + b * 0.4) * 0.5 + 0.5) * envelope));
  }
  return out;
}

/** Resample an arbitrary-length level array onto `bars` columns. */
function spread(values, bars) {
  if (!values?.length) return new Array(bars).fill(0.05);
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    const index = Math.floor((i / bars) * values.length);
    out.push(Math.max(0.03, Math.min(1, values[index] ?? 0)));
  }
  return out;
}
