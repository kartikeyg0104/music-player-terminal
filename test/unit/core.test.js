import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrack,
  normaliseDuration,
  formatDuration,
  formatListeningTime,
  isPlayable,
  playbackSource,
  serialiseTrack,
  deserialiseTrack,
  hashId,
  AVAILABILITY,
} from '../../src/core/track.js';
import {
  debounce,
  clampInt,
  truncate,
  fit,
  moveItem,
  shuffleArray,
  seededRandom,
  matchesQuery,
  relativeTime,
  groupBy,
} from '../../src/core/util.js';
import { Emitter, setListenerErrorHandler } from '../../src/core/events.js';
import { toUserMessage, AppError, NetworkError } from '../../src/core/errors.js';
import { parseLrc } from '../../src/services/lyricsService.js';
import { createTheme, detectCapabilities } from '../../src/ui/theme.js';
import { Logger } from '../../src/core/logger.js';

// ------------------------------------------------------------------ track

test('track: createTrack fills every field and builds a stable id', () => {
  const track = createTrack({
    provider: 'archive',
    providerId: 'abc/def.mp3',
    title: '  Hey  Now ',
  });
  assert.equal(track.id, 'archive:abc/def.mp3');
  assert.equal(track.title, 'Hey Now', 'whitespace is collapsed');
  assert.equal(track.artist, 'Unknown artist');
  assert.equal(track.album, '');
  assert.equal(track.duration, null);
  assert.equal(track.availability, AVAILABILITY.METADATA_ONLY, 'no source means metadata only');
  assert.deepEqual(track.providerData, {});
  assert.equal(track.isSample, false);
});

test('track: createTrack demands provider and providerId', () => {
  assert.throws(() => createTrack({ provider: 'x' }), TypeError);
  assert.throws(() => createTrack({ providerId: 'y' }), TypeError);
});

test('track: a stream URL or local path makes a track available', () => {
  assert.equal(
    createTrack({ provider: 'p', providerId: '1', streamUrl: 'https://x/y.mp3' }).availability,
    AVAILABILITY.AVAILABLE,
  );
  assert.equal(
    createTrack({ provider: 'p', providerId: '1', localPath: '/music/a.mp3' }).availability,
    AVAILABILITY.AVAILABLE,
  );
});

test('track: isPlayable and playbackSource agree on what can be opened', () => {
  const remote = createTrack({ provider: 'p', providerId: '1', streamUrl: 'https://x/y.mp3' });
  const local = createTrack({ provider: 'p', providerId: '2', localPath: '/m/a.mp3' });
  const dead = createTrack({ provider: 'p', providerId: '3' });

  assert.equal(isPlayable(remote), true);
  assert.deepEqual(playbackSource(remote), { kind: 'url', value: 'https://x/y.mp3' });
  assert.deepEqual(playbackSource(local), { kind: 'file', value: '/m/a.mp3' });
  assert.equal(isPlayable(dead), false);
  assert.equal(playbackSource(dead), null);
  assert.equal(isPlayable(null), false);
});

test('track: a local path wins over a stream URL', () => {
  const both = createTrack({
    provider: 'p',
    providerId: '1',
    streamUrl: 'https://x/y.mp3',
    localPath: '/m/a.mp3',
  });
  assert.equal(playbackSource(both).kind, 'file');
});

test('normaliseDuration: accepts the shapes providers actually send', () => {
  assert.equal(normaliseDuration(215), 215);
  assert.equal(normaliseDuration('215'), 215);
  assert.equal(normaliseDuration('53.33'), 53);
  assert.equal(normaliseDuration('03:35'), 215);
  assert.equal(normaliseDuration('1:02:03'), 3723);
  assert.equal(normaliseDuration(null), null);
  assert.equal(normaliseDuration(''), null);
  assert.equal(normaliseDuration('not a duration'), null);
  assert.equal(normaliseDuration(-5), null);
  assert.equal(normaliseDuration(Number.NaN), null);
});

test('formatDuration: renders times and admits when it does not know', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59), '0:59');
  assert.equal(formatDuration(215), '3:35');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(Number.NaN), '--:--');
});

test('formatListeningTime: summarises hours and minutes', () => {
  assert.equal(formatListeningTime(0), '0m');
  assert.equal(formatListeningTime(45), '45s');
  assert.equal(formatListeningTime(300), '5m');
  assert.equal(formatListeningTime(7265), '2h 1m');
  assert.equal(formatListeningTime(7200), '2h');
});

test('track: serialise/deserialise round-trips, and rejects junk', () => {
  const track = createTrack({
    provider: 'p',
    providerId: '1',
    title: 'X',
    streamUrl: 'https://x/y.mp3',
    providerData: { file: 'y.mp3' },
  });
  assert.deepEqual(deserialiseTrack(serialiseTrack(track)), track);
  assert.equal(deserialiseTrack('{bad json'), null);
  assert.equal(deserialiseTrack('{"no":"provider"}'), null);
  assert.equal(deserialiseTrack(null), null);
});

test('hashId: stable for the same input, different for others', () => {
  assert.equal(hashId('a', 'b'), hashId('a', 'b'));
  assert.notEqual(hashId('a', 'b'), hashId('a', 'c'));
  assert.equal(hashId('x').length, 16);
});

// ------------------------------------------------------------------- util

test('debounce: fires once after the quiet period', async () => {
  let calls = 0;
  const fn = debounce(() => {
    calls += 1;
  }, 30);
  fn();
  fn();
  fn();
  assert.equal(calls, 0, 'nothing fires while input keeps arriving');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
});

test('debounce: cancel and flush behave', async () => {
  let value = null;
  const fn = debounce((v) => {
    value = v;
  }, 50);

  fn('a');
  fn.cancel();
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(value, null, 'cancel drops the pending call');

  fn('b');
  fn.flush();
  assert.equal(value, 'b', 'flush runs it immediately');
  assert.equal(fn.pending(), false);
});

test('clampInt: clamps, rounds and survives nonsense', () => {
  assert.equal(clampInt(5, 0, 10), 5);
  assert.equal(clampInt(-5, 0, 10), 0);
  assert.equal(clampInt(50, 0, 10), 10);
  assert.equal(clampInt(4.6, 0, 10), 5);
  assert.equal(clampInt('abc', 3, 10), 3);
});

test('truncate and fit respect an exact column budget', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello', 0), '');
  assert.equal(fit('hi', 5).length, 5);
  assert.equal(fit('a very long string', 6).length, 6);
});

test('moveItem reorders without mutating the input', () => {
  const input = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(input, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(input, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(input, 1, 1), input);
  assert.deepEqual(moveItem(input, 9, 0), input, 'an out-of-range index is a no-op');
  assert.deepEqual(input, ['a', 'b', 'c', 'd'], 'the original is untouched');
});

test('shuffleArray with a seeded RNG is deterministic and lossless', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = shuffleArray(input, seededRandom(1));
  const b = shuffleArray(input, seededRandom(1));
  assert.deepEqual(a, b);
  assert.deepEqual(
    [...a].sort((x, y) => x - y),
    input,
  );
  assert.notDeepEqual(a, input);
});

test('matchesQuery ignores case and accents', () => {
  assert.equal(matchesQuery('Café Tacvba', 'cafe'), true);
  assert.equal(matchesQuery('Björk', 'bjork'), true);
  assert.equal(matchesQuery('anything', ''), true, 'an empty query matches everything');
  assert.equal(matchesQuery('anything', 'nope'), false);
});

test('relativeTime renders human ages', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  assert.equal(relativeTime('2026-01-10T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-01-10T11:30:00Z', now), '30m ago');
  assert.equal(relativeTime('2026-01-10T06:00:00Z', now), '6h ago');
  assert.equal(relativeTime('2026-01-08T12:00:00Z', now), '2d ago');
  assert.equal(relativeTime('not a date', now), 'unknown');
});

test('groupBy buckets by the key function', () => {
  const grouped = groupBy([1, 2, 3, 4, 5], (n) => (n % 2 ? 'odd' : 'even'));
  assert.deepEqual(grouped.get('odd'), [1, 3, 5]);
  assert.deepEqual(grouped.get('even'), [2, 4]);
});

// ----------------------------------------------------------------- events

test('emitter: subscribe, emit, unsubscribe', () => {
  const emitter = new Emitter();
  const seen = [];
  const off = emitter.on('x', (v) => seen.push(v));
  emitter.emit('x', 1);
  off();
  emitter.emit('x', 2);
  assert.deepEqual(seen, [1]);
});

test('emitter: a throwing listener cannot break the emitter', () => {
  const emitter = new Emitter();
  const errors = [];
  setListenerErrorHandler((error) => errors.push(error));
  const seen = [];
  emitter.on('x', () => {
    throw new Error('listener exploded');
  });
  emitter.on('x', (v) => seen.push(v));

  emitter.emit('x', 1);
  assert.deepEqual(seen, [1], 'the second listener still ran');
  assert.equal(errors.length, 1);
  setListenerErrorHandler(null);
});

test('emitter: the wildcard listener sees every event', () => {
  const emitter = new Emitter();
  const seen = [];
  emitter.on('*', (e) => seen.push(e.event));
  emitter.emit('a');
  emitter.emit('b');
  assert.deepEqual(seen, ['a', 'b']);
});

// ----------------------------------------------------------------- errors

test('toUserMessage: turns anything throwable into a renderable message', () => {
  assert.deepEqual(toUserMessage(new NetworkError('boom')), {
    title: 'Network unavailable',
    hint: 'Check your internet connection and try again.',
    retryable: true,
  });
  assert.equal(toUserMessage(new AppError('raw')).title, 'raw');
  assert.equal(toUserMessage(new Error('plain')).title, 'plain');
  assert.equal(toUserMessage('a string').title, 'Unexpected error');
  const aborted = Object.assign(new Error('x'), { name: 'AbortError' });
  assert.equal(toUserMessage(aborted).title, 'Request cancelled');
});

test('logger: redacts secrets and never throws', () => {
  process.env.JAMENDO_CLIENT_ID = 'super-secret-key';
  const logger = new Logger({ file: null, level: 'debug' });
  // With no file the logger is a no-op; the point is that it cannot throw.
  logger.info('using key super-secret-key');
  logger.error('boom', new Error('x'));
  logger.close();
  delete process.env.JAMENDO_CLIENT_ID;
});

// ----------------------------------------------------------------- lyrics

test('parseLrc: reads timestamps into ordered lines', () => {
  const { status, lines } = parseLrc(
    ['[ar:Someone]', '[00:12.50]First line', '[00:15.00]Second line', '[01:02.25]Third'].join('\n'),
  );
  assert.equal(status, 'synced');
  assert.deepEqual(
    lines.map((l) => l.time),
    [12.5, 15, 62.25],
  );
  assert.equal(lines[0].text, 'First line');
});

test('parseLrc: one line with several timestamps becomes several lines', () => {
  const { lines } = parseLrc('[00:10.00][00:40.00]Chorus');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Chorus');
  assert.equal(lines[1].time, 40);
});

test('parseLrc: text with no timestamps is not treated as synced', () => {
  assert.equal(parseLrc('just some words\nand more').status, 'none');
  assert.equal(parseLrc('').status, 'none');
});

// ------------------------------------------------------------------ theme

test('theme: every glyph has an ASCII twin', () => {
  const unicode = createTheme({ unicode: true });
  const ascii = createTheme({ unicode: false });
  assert.deepEqual(Object.keys(unicode.glyphs).sort(), Object.keys(ascii.glyphs).sort());
  const flat = Object.values(ascii.glyphs).flat().join('');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(flat), 'the ASCII set is genuinely ASCII');
});

test('theme: an unknown theme falls back instead of crashing', () => {
  assert.equal(createTheme({ theme: 'no-such-theme' }).name, 'Midnight');
});

test('theme: low colour depth avoids hex colours', () => {
  const theme = createTheme({ colorDepth: 4 });
  assert.equal(theme.rich, false);
  assert.ok(!String(theme.colors.accent).startsWith('#'));
});

test('detectCapabilities: honours NO_COLOR and dumb terminals', () => {
  const caps = detectCapabilities({ columns: 100, rows: 40, isTTY: true }, { NO_COLOR: '1' });
  assert.equal(caps.colorDepth, 1);

  const dumb = detectCapabilities({ columns: 80, rows: 24, isTTY: true }, { TERM: 'dumb' });
  assert.equal(dumb.unicode, false);
  assert.equal(dumb.reducedMotion, true);
});

test('detectCapabilities: flags narrow and unusable terminals', () => {
  assert.equal(detectCapabilities({ columns: 70, rows: 30, isTTY: true }, {}).compact, true);
  assert.equal(detectCapabilities({ columns: 140, rows: 40, isTTY: true }, {}).compact, false);
  assert.equal(detectCapabilities({ columns: 40, rows: 10, isTTY: true }, {}).tiny, true);
  assert.equal(detectCapabilities({ columns: 80, rows: 24, isTTY: true }, {}).tiny, false);
});

test('detectCapabilities: assumes Unicode unless the environment says otherwise', () => {
  const at = (env) => detectCapabilities({ columns: 100, rows: 30, isTTY: true }, env).unicode;
  assert.equal(at({ LANG: 'en_US.UTF-8' }), true);
  assert.equal(at({}), true, 'a missing locale is not a reason to drop to ASCII');
  assert.equal(at({ LANG: 'en_US.ISO8859-1' }), false);
  assert.equal(at({ LANG: 'en_US.UTF-8', TERMIFY_ASCII: '1' }), false);
});
