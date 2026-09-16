import { MIN_COLUMNS, MIN_ROWS, COMPACT_BREAKPOINT } from './constants.js';

/**
 * Termify's design system.
 *
 * One restrained accent per theme, a fixed neutral ramp, and a glyph table
 * with an ASCII twin for every symbol. Components never hard-code a colour or
 * a character - they ask the theme, so `unicode: false` or a theme change is
 * a single switch rather than a sweep through the views.
 */

const NEUTRALS = {
  text: '#e6e6e6',
  textStrong: '#ffffff',
  textMuted: '#8b8b96',
  textFaint: '#5c5c66',
  line: '#2a2a33',
  surface: '#16161c',
  surfaceRaised: '#1e1e26',
};

const SEMANTIC = {
  success: '#4ec9a5',
  warning: '#e3b341',
  danger: '#f2555a',
  info: '#6cb6ff',
};

const PALETTES = {
  midnight: { accent: '#1DB954', accentSoft: '#137a37', name: 'Midnight' },
  mono: { accent: '#d4d4d8', accentSoft: '#71717a', name: 'Mono' },
  ember: { accent: '#ff7a45', accentSoft: '#a8441f', name: 'Ember' },
  forest: { accent: '#7bc96f', accentSoft: '#3f6b38', name: 'Forest' },
};

const UNICODE_GLYPHS = {
  play: '▶',
  pause: '⏸',
  stop: '■',
  next: '⏭',
  prev: '⏮',
  shuffle: '⇄',
  repeat: '↻',
  repeatOne: '↺',
  heart: '♥',
  heartEmpty: '♡',
  note: '♪',
  dot: '·',
  bullet: '•',
  arrowRight: '›',
  chevron: '❯',
  check: '✓',
  cross: '✕',
  warn: '⚠',
  info: 'ℹ',
  barFull: '━',
  barEmpty: '─',
  barHead: '●',
  blockFull: '█',
  blockUpper: '▀',
  vLine: '│',
  hLine: '─',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  levels: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  volume: '◉',
  clock: '◴',
  sample: '◌',
};

const ASCII_GLYPHS = {
  play: '>',
  pause: '||',
  stop: '#',
  next: '>>',
  prev: '<<',
  shuffle: 'x',
  repeat: 'o',
  repeatOne: '1',
  heart: '*',
  heartEmpty: '-',
  note: '~',
  dot: '.',
  bullet: '*',
  arrowRight: '>',
  chevron: '>',
  check: 'v',
  cross: 'x',
  warn: '!',
  info: 'i',
  barFull: '=',
  barEmpty: '-',
  barHead: 'O',
  blockFull: '#',
  blockUpper: '^',
  vLine: '|',
  hLine: '-',
  spinner: ['-', '\\', '|', '/'],
  levels: ['.', ':', '-', '=', '+', '*', '#', '@'],
  volume: 'o',
  clock: '@',
  sample: '?',
};

/**
 * @param {{theme?: string, unicode?: boolean, animations?: boolean, colorDepth?: number}} options
 */
export function createTheme({
  theme = 'midnight',
  unicode = true,
  animations = true,
  colorDepth = 8,
} = {}) {
  const palette = PALETTES[theme] ?? PALETTES.midnight;
  // Below true colour we avoid hex and let Ink map to the 16-colour names.
  const rich = colorDepth >= 8;
  const colors = rich
    ? { ...NEUTRALS, ...SEMANTIC, ...palette }
    : {
        text: 'white',
        textStrong: 'whiteBright',
        textMuted: 'gray',
        textFaint: 'gray',
        line: 'gray',
        surface: undefined,
        surfaceRaised: undefined,
        success: 'green',
        warning: 'yellow',
        danger: 'red',
        info: 'cyan',
        accent: theme === 'mono' ? 'white' : 'green',
        accentSoft: 'gray',
        name: palette.name,
      };

  return {
    id: theme,
    name: palette.name,
    unicode,
    animations,
    rich,
    colors,
    glyphs: unicode ? UNICODE_GLYPHS : ASCII_GLYPHS,
    /** Consistent spacing scale so panels line up. */
    space: { xs: 0, sm: 1, md: 2 },
  };
}

export const THEME_IDS = Object.keys(PALETTES);

/**
 * Terminal capability sniffing.
 *
 * Respects NO_COLOR, dumb terminals, and the de-facto reduced-motion signals
 * so Termify is usable over ssh, in CI logs and in minimal shells.
 */
export function detectCapabilities(stdout = process.stdout, env = process.env) {
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const noColor = Boolean(env.NO_COLOR) || env.TERM === 'dumb';
  const colorDepth = noColor ? 1 : (stdout?.getColorDepth?.() ?? 4);

  // Unicode is assumed unless something says otherwise: TERMIFY_ASCII forces
  // the ASCII glyph set, a dumb terminal cannot render box drawing, and a
  // locale that explicitly names a non-UTF-8 charset is taken at its word.
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  const unicode =
    !env.TERMIFY_ASCII &&
    env.TERM !== 'dumb' &&
    (locale === '' || !locale.includes('.') || /utf-?8/i.test(locale));

  const reducedMotion = Boolean(env.TERMIFY_NO_ANIMATION) || env.TERM === 'dumb' || !stdout?.isTTY;

  return {
    columns,
    rows,
    colorDepth,
    unicode,
    reducedMotion,
    isTTY: Boolean(stdout?.isTTY),
    // Below this the sidebar collapses into a tab strip.
    compact: columns < COMPACT_BREAKPOINT,
    // Below this there is not enough room for a usable layout at all.
    tiny: columns < MIN_COLUMNS || rows < MIN_ROWS,
  };
}
