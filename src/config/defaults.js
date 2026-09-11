/**
 * Canonical settings schema.
 *
 * Every user-visible setting is declared here once: its default, its type, how
 * to validate it and how to render it. The settings service, the settings view
 * and the migration code all read from this single table, so adding a setting
 * is a one-line change.
 */

export const REPEAT_MODES = /** @type {const} */ (['off', 'one', 'queue']);
export const THEMES = /** @type {const} */ (['midnight', 'mono', 'ember', 'forest']);
export const START_VIEWS = /** @type {const} */ (['home', 'search', 'discover', 'favorites']);
export const LYRICS_SOURCES = /** @type {const} */ (['local', 'lrclib', 'off']);
export const VISUALIZER_MODES = /** @type {const} */ (['off', 'decorative', 'levels']);

/**
 * @typedef {'boolean' | 'integer' | 'string' | 'enum' | 'path'} SettingType
 * @typedef {object} SettingSpec
 * @property {string} key
 * @property {SettingType} type
 * @property {any} default
 * @property {string} label
 * @property {string} description
 * @property {string} section
 * @property {readonly string[]} [values]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 */

/** @type {SettingSpec[]} */
export const SETTING_SPECS = [
  {
    key: 'defaultProvider',
    type: 'enum',
    default: 'archive',
    values: ['archive', 'jamendo', 'local', 'mock'],
    label: 'Default provider',
    description: 'Music source used for search and discovery.',
    section: 'Providers',
  },
  {
    key: 'searchLimit',
    type: 'integer',
    default: 25,
    min: 5,
    max: 100,
    step: 5,
    label: 'Results per page',
    description: 'How many tracks a single search request asks for.',
    section: 'Providers',
  },
  {
    key: 'searchDebounceMs',
    type: 'integer',
    default: 420,
    min: 0,
    max: 2000,
    step: 60,
    label: 'Search debounce',
    description: 'Idle time before a typed query hits the network (ms).',
    section: 'Providers',
  },
  {
    key: 'searchOnType',
    type: 'boolean',
    default: true,
    label: 'Search as you type',
    description: 'Off means results only load when you press Enter.',
    section: 'Providers',
  },
  {
    key: 'metadataCacheTtlMinutes',
    type: 'integer',
    default: 60,
    min: 0,
    max: 1440,
    step: 15,
    label: 'Metadata cache TTL',
    description: 'How long provider responses stay cached (minutes, 0 = off).',
    section: 'Providers',
  },
  {
    key: 'volume',
    type: 'integer',
    default: 70,
    min: 0,
    max: 100,
    step: 5,
    label: 'Default volume',
    description: 'Volume applied when Termify starts.',
    section: 'Playback',
  },
  {
    key: 'shuffle',
    type: 'boolean',
    default: false,
    label: 'Shuffle on start',
    description: 'Restore shuffle mode at launch.',
    section: 'Playback',
  },
  {
    key: 'repeat',
    type: 'enum',
    default: 'off',
    values: REPEAT_MODES,
    label: 'Repeat on start',
    description: 'Restore repeat mode at launch.',
    section: 'Playback',
  },
  {
    key: 'seekStepSeconds',
    type: 'integer',
    default: 10,
    min: 5,
    max: 60,
    step: 5,
    label: 'Seek step',
    description: 'Seconds moved by the left/right seek keys.',
    section: 'Playback',
  },
  {
    key: 'autoAdvance',
    type: 'boolean',
    default: true,
    label: 'Auto-advance',
    description: 'Play the next queued track when one finishes.',
    section: 'Playback',
  },
  {
    key: 'audioBackend',
    type: 'enum',
    default: 'auto',
    values: ['auto', 'mpv', 'ffplay', 'afplay', 'null'],
    label: 'Audio backend',
    description: 'auto picks the best backend found on this machine.',
    section: 'Playback',
  },
  {
    key: 'theme',
    type: 'enum',
    default: 'midnight',
    values: THEMES,
    label: 'Theme',
    description: 'Accent palette for the interface.',
    section: 'Appearance',
  },
  {
    key: 'unicode',
    type: 'boolean',
    default: true,
    label: 'Unicode symbols',
    description: 'Off falls back to pure ASCII glyphs.',
    section: 'Appearance',
  },
  {
    key: 'animations',
    type: 'boolean',
    default: true,
    label: 'Animations',
    description: 'Spinners and the visualizer. Off is fully static.',
    section: 'Appearance',
  },
  {
    key: 'visualizer',
    type: 'enum',
    default: 'decorative',
    values: VISUALIZER_MODES,
    label: 'Visualizer',
    description: 'decorative = animation only; levels = real RMS via ffmpeg.',
    section: 'Appearance',
  },
  {
    key: 'showArtwork',
    type: 'boolean',
    default: true,
    label: 'Album artwork',
    description: 'Render colour-block artwork (needs ffmpeg).',
    section: 'Appearance',
  },
  {
    key: 'compactMode',
    type: 'boolean',
    default: false,
    label: 'Compact layout',
    description: 'Force the narrow layout regardless of terminal size.',
    section: 'Appearance',
  },
  {
    key: 'startView',
    type: 'enum',
    default: 'home',
    values: START_VIEWS,
    label: 'Start view',
    description: 'Screen shown when Termify opens.',
    section: 'General',
  },
  {
    key: 'lyricsSource',
    type: 'enum',
    default: 'local',
    values: LYRICS_SOURCES,
    label: 'Lyrics source',
    description: 'local = .lrc files next to audio; lrclib = lrclib.net API.',
    section: 'General',
  },
  {
    key: 'musicDir',
    type: 'path',
    default: '',
    label: 'Local music folder',
    description: 'Absolute path scanned by the Local provider.',
    section: 'General',
  },
  {
    key: 'historyEnabled',
    type: 'boolean',
    default: true,
    label: 'Record history',
    description: 'Log played tracks and listening time.',
    section: 'General',
  },
];

export const SETTING_SECTIONS = [...new Set(SETTING_SPECS.map((s) => s.section))];

/** @type {Record<string, SettingSpec>} */
export const SETTINGS_BY_KEY = Object.fromEntries(SETTING_SPECS.map((s) => [s.key, s]));

export function defaultSettings() {
  return Object.fromEntries(SETTING_SPECS.map((s) => [s.key, s.default]));
}
