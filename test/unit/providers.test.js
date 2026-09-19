import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ArchiveProvider } from '../../src/providers/archiveProvider.js';
import { JamendoProvider } from '../../src/providers/jamendoProvider.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { LocalProvider } from '../../src/providers/localProvider.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { HttpClient } from '../../src/providers/http.js';
import { AuthError, ProviderError, NotConfiguredError } from '../../src/core/errors.js';
import { AVAILABILITY } from '../../src/core/track.js';
import { fakeFetch } from '../helpers.js';

const archiveItem = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../fixtures/archiveItem.json', import.meta.url)), 'utf8'),
);

// ---------------------------------------------------------------- archive

test('archive: normalises an item into one track per recording', () => {
  const provider = new ArchiveProvider();
  const tracks = provider.normaliseItem('demo-concert-1999', archiveItem, {});

  assert.equal(tracks.length, 3, 'two tagged songs plus the untitled jam');
  const [first, second, third] = tracks;

  assert.equal(first.title, 'Opening');
  assert.equal(first.artist, 'Demo Band');
  assert.equal(first.album, '1999-07-04 Example Hall');
  assert.equal(first.duration, 215, 'the FLAC duration in seconds wins over "03:35"');
  assert.equal(first.provider, 'archive');
  assert.equal(first.id, 'archive:demo-concert-1999/db1999-07-04d1t01.mp3');
  assert.equal(first.availability, AVAILABILITY.AVAILABLE);
  assert.equal(first.year, 1999);
  assert.equal(first.license, 'http://creativecommons.org/licenses/by-nc-nd/4.0/');

  assert.equal(second.title, 'Second Song');
  assert.equal(third.title, 'untitled jam', 'a filename-derived title is cleaned up');
});

test('archive: prefers the streamable MP3 derivative over the lossless original', () => {
  const provider = new ArchiveProvider();
  const [first] = provider.normaliseItem('demo-concert-1999', archiveItem, {});
  assert.match(first.streamUrl, /db1999-07-04d1t01\.mp3$/);
  assert.equal(first.providerData.format, 'VBR MP3');
});

test('archive: skips non-audio files', () => {
  const provider = new ArchiveProvider();
  const tracks = provider.normaliseItem('demo-concert-1999', archiveItem, {});
  assert.ok(!tracks.some((t) => /spectrogram|\.xml|__ia_thumb/.test(t.providerData.file)));
});

test('archive: encodes filenames with spaces into a usable URL', () => {
  const provider = new ArchiveProvider();
  const tracks = provider.normaliseItem('demo-concert-1999', archiveItem, {});
  const jam = tracks.find((t) => t.title === 'untitled jam');
  assert.equal(
    jam.streamUrl,
    'https://archive.org/download/demo-concert-1999/03%20untitled%20jam.mp3',
  );
});

test('archive: stores a stable provider id, never the stream URL', () => {
  const provider = new ArchiveProvider();
  const [first] = provider.normaliseItem('demo-concert-1999', archiveItem, {});
  assert.equal(first.providerId, 'demo-concert-1999/db1999-07-04d1t01.mp3');
  assert.ok(!first.providerId.startsWith('http'));
});

test('archive: search neutralises Lucene operators in user input', async () => {
  const fetchImpl = fakeFetch({
    'advancedsearch.php': { body: { response: { numFound: 0, docs: [] } } },
  });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  await provider.search({ text: 'AC/DC (live)) [1979]:', limit: 5 });
  const q = new URL(fetchImpl.calls[0].url).searchParams.get('q');
  assert.ok(
    !/[()[\]/]/.test(q.replace(/^mediatype:\(audio\) AND \(|\) AND collection:\(.*\)$/g, '')),
  );
  assert.match(q, /AC DC live 1979/);
});

test('archive: search scopes to the music collections by default', async () => {
  const fetchImpl = fakeFetch({
    'advancedsearch.php': { body: { response: { numFound: 0, docs: [] } } },
  });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'jazz' });
  assert.match(new URL(fetchImpl.calls[0].url).searchParams.get('q'), /collection:\(audio_music/);
  assert.match(result.note, /music collections/);
});

test('archive: an explicit collection overrides the default scope', async () => {
  const fetchImpl = fakeFetch({
    'advancedsearch.php': { body: { response: { numFound: 0, docs: [] } } },
  });
  const provider = new ArchiveProvider({
    collection: 'etree',
    http: new HttpClient({ fetchImpl }),
  });
  await provider.search({ text: 'jazz' });
  assert.match(new URL(fetchImpl.calls[0].url).searchParams.get('q'), /collection:\(etree\)/);
});

test('archive: search paginates and reports the item total', async () => {
  const fetchImpl = fakeFetch({
    'advancedsearch.php': {
      body: { response: { numFound: 412, docs: [{ identifier: 'demo-concert-1999' }] } },
    },
    'metadata/demo-concert-1999': { body: archiveItem },
  });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'demo', page: 3, limit: 2 });

  assert.equal(result.total, 412);
  assert.equal(result.page, 3);
  assert.equal(result.tracks.length, 2, 'the page is capped to the requested limit');
  assert.match(result.note, /Showing 2 of 3 tracks/);
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('page'), '3');
});

test('archive: one broken item does not sink the whole page', async () => {
  const fetchImpl = fakeFetch({
    'advancedsearch.php': {
      body: {
        response: {
          numFound: 2,
          docs: [{ identifier: 'broken' }, { identifier: 'demo-concert-1999' }],
        },
      },
    },
    'metadata/broken': { status: 503, body: { error: 'nope' } },
    'metadata/demo-concert-1999': { body: archiveItem },
  });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'demo', limit: 10 });
  assert.equal(result.tracks.length, 3, 'the good item still produced tracks');
});

test('archive: an unexpected payload becomes a provider error', async () => {
  const fetchImpl = fakeFetch({ 'advancedsearch.php': { body: { nonsense: true } } });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  await assert.rejects(() => provider.search({ text: 'x' }), ProviderError);
});

test('archive: resolve marks a vanished file unavailable', async () => {
  const fetchImpl = fakeFetch({
    'metadata/demo-concert-1999': { body: { ...archiveItem, files: [] } },
  });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  const [track] = new ArchiveProvider().normaliseItem('demo-concert-1999', archiveItem, {});
  const resolved = await provider.resolve(track);
  assert.equal(resolved.availability, AVAILABILITY.UNAVAILABLE);
  assert.equal(resolved.streamUrl, null);
});

test('archive: resolve refreshes the URL when the file is still there', async () => {
  const fetchImpl = fakeFetch({ 'metadata/demo-concert-1999': { body: archiveItem } });
  const provider = new ArchiveProvider({ http: new HttpClient({ fetchImpl }) });
  const [track] = new ArchiveProvider().normaliseItem('demo-concert-1999', archiveItem, {});
  const resolved = await provider.resolve(track);
  assert.equal(resolved.availability, AVAILABILITY.AVAILABLE);
  assert.equal(resolved.streamUrl, track.streamUrl);
});

// ---------------------------------------------------------------- jamendo

const jamendoRow = {
  id: '1886711',
  name: 'Sunburst',
  duration: 231,
  artist_id: '338191',
  artist_name: 'Thomas Chauvet',
  album_name: 'Horizons',
  album_image: 'https://usercontent.jamendo.com/cover.jpg',
  releasedate: '2016-03-14',
  license_ccurl: 'http://creativecommons.org/licenses/by-nc-nd/3.0/',
  audio: 'https://prod-1.storage.jamendo.com/?trackid=1886711&format=mp32',
  shareurl: 'https://www.jamendo.com/track/1886711/sunburst',
  musicinfo: { tags: { genres: ['electronic', 'chillout'] } },
};

test('jamendo: reports itself unconfigured without a client id', async () => {
  const provider = new JamendoProvider({ clientId: '' });
  const status = provider.status();
  assert.equal(status.configured, false);
  assert.match(status.reason, /JAMENDO_CLIENT_ID/);
  await assert.rejects(() => provider.search({ text: 'x' }), NotConfiguredError);
});

test('jamendo: normalises a track row into the internal schema', () => {
  const provider = new JamendoProvider({ clientId: 'test' });
  const track = provider.normaliseTrack(jamendoRow);
  assert.equal(track.id, 'jamendo:1886711');
  assert.equal(track.title, 'Sunburst');
  assert.equal(track.artist, 'Thomas Chauvet');
  assert.equal(track.album, 'Horizons');
  assert.equal(track.duration, 231);
  assert.equal(track.genre, 'electronic');
  assert.equal(track.year, 2016);
  assert.equal(track.availability, AVAILABILITY.AVAILABLE);
  assert.equal(track.providerData.artistId, '338191');
});

test('jamendo: a row with no audio URL is metadata-only, not broken', () => {
  const provider = new JamendoProvider({ clientId: 'test' });
  const track = provider.normaliseTrack({ ...jamendoRow, audio: '', audiodownload: '' });
  assert.equal(track.availability, AVAILABILITY.METADATA_ONLY);
  assert.equal(track.streamUrl, null);
});

test('jamendo: search sends the documented parameters and reads the total', async () => {
  const fetchImpl = fakeFetch({
    'api.jamendo.com': {
      body: {
        headers: { status: 'success', results_fullcount: 87 },
        results: [jamendoRow],
      },
    },
  });
  const provider = new JamendoProvider({ clientId: 'abc123', http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'sunburst', page: 2, limit: 10 });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('client_id'), 'abc123');
  assert.equal(url.searchParams.get('namesearch'), 'sunburst');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('offset'), '10', 'page 2 offsets by one page');
  assert.equal(result.total, 87);
  assert.equal(result.hasMore, true);
  assert.equal(result.tracks.length, 1);
});

test('jamendo: a credential rejection surfaces as an auth error', async () => {
  const fetchImpl = fakeFetch({
    'api.jamendo.com': {
      body: { headers: { status: 'failed', error_message: 'Your client_id is invalid' } },
    },
  });
  const provider = new JamendoProvider({ clientId: 'bad', http: new HttpClient({ fetchImpl }) });
  await assert.rejects(() => provider.search({ text: 'x' }), AuthError);
});

test('jamendo: the cache key never contains the client id', async () => {
  const stored = [];
  const cache = { get: () => null, set: (_p, key) => stored.push(key) };
  const fetchImpl = fakeFetch({
    // A complete response: an empty page with no results_fullcount would be
    // treated as truncated and deliberately not cached.
    'api.jamendo.com': {
      body: { headers: { status: 'success', results_fullcount: 0 }, results: [] },
    },
  });
  const provider = new JamendoProvider({
    clientId: 'secret-key-value',
    cache,
    http: new HttpClient({ fetchImpl }),
  });
  await provider.search({ text: 'x' });
  assert.ok(stored.length > 0);
  assert.ok(!stored[0].includes('secret-key-value'));
});

// ------------------------------------------------------------------- mock

test('mock: returns deterministic, clearly-flagged sample data', async () => {
  const provider = new MockProvider({ synthesisAvailable: false });
  const a = await provider.search({ text: 'pale orbit' });
  const b = await provider.search({ text: 'pale orbit' });

  assert.deepEqual(
    a.tracks.map((t) => t.id),
    b.tracks.map((t) => t.id),
  );
  assert.ok(a.tracks.length > 0);
  assert.ok(a.tracks.every((t) => t.isSample));
  assert.equal(a.isSample, true);
  assert.match(a.note, /Demo mode/);
  assert.equal(provider.isLive, false);
});

test('mock: without ffmpeg the demo tracks are honestly metadata-only', async () => {
  const provider = new MockProvider({ synthesisAvailable: false });
  const { tracks } = await provider.featured('all', { limit: 3 });
  assert.ok(tracks.every((t) => t.availability === AVAILABILITY.METADATA_ONLY));
});

test('mock: search filters across title, artist, album and genre', async () => {
  const provider = new MockProvider({ synthesisAvailable: false });
  assert.ok((await provider.search({ artist: 'Hana Ito' })).tracks.length >= 2);
  assert.ok((await provider.search({ genre: 'techno' })).tracks.length >= 3);
  assert.equal((await provider.search({ text: 'no such song at all' })).tracks.length, 0);
});

test('mock: pagination slices the fixture consistently', async () => {
  const provider = new MockProvider({ synthesisAvailable: false });
  const page1 = await provider.featured('all', { page: 1, limit: 5 });
  const page2 = await provider.featured('all', { page: 2, limit: 5 });
  assert.equal(page1.tracks.length, 5);
  assert.equal(page2.tracks.length, 5);
  assert.equal(page1.total, 20);
  assert.equal(page1.hasMore, true);
  assert.equal(
    new Set([...page1.tracks, ...page2.tracks].map((t) => t.id)).size,
    10,
    'pages do not overlap',
  );
});

// ------------------------------------------------------------------ local

test('local: reports itself unconfigured with no folder set', async () => {
  const provider = new LocalProvider({});
  assert.equal(provider.status().configured, false);
  await assert.rejects(() => provider.search({ text: 'x' }), NotConfiguredError);
});

test('local: setting a root clears the cached index', () => {
  const provider = new LocalProvider({ musicDir: '/tmp/a' });
  assert.equal(provider.status().configured, true);
  provider.setRoot('/tmp/b');
  assert.match(provider.root, /\/tmp\/b$/);
  assert.equal(provider.stats.count, null, 'the index is dropped, not stale');
});

// --------------------------------------------------------------- registry

test('registry: select falls back when the requested provider is unconfigured', () => {
  const registry = new ProviderRegistry({
    providers: [
      new JamendoProvider({ clientId: '' }),
      new MockProvider({ synthesisAvailable: false }),
    ],
  });
  const { provider, fallbackReason } = registry.select('jamendo');
  assert.equal(provider.id, 'mock');
  assert.match(fallbackReason, /not configured/);
});

test('registry: demo mode pins everything to the mock provider', () => {
  const registry = new ProviderRegistry({
    providers: [new ArchiveProvider(), new MockProvider({ synthesisAvailable: false })],
  });
  registry.demo = true;
  assert.equal(registry.select('archive').provider.id, 'mock');
});

test('registry: describe reports configuration for the settings screen', () => {
  const registry = new ProviderRegistry({
    providers: [new ArchiveProvider(), new JamendoProvider({ clientId: '' })],
  });
  const rows = registry.describe();
  assert.equal(rows.find((r) => r.id === 'archive').configured, true);
  assert.equal(rows.find((r) => r.id === 'jamendo').configured, false);
  assert.ok(rows.find((r) => r.id === 'jamendo').hint);
});

// ---------------------------------------------- jamendo: live-API quirks

/**
 * Both behaviours below were found by running the adapter against the live
 * v3.0 API, and both would silently corrupt results if unhandled.
 */

const jamendoOk = (results, fullcount) => ({
  headers: { status: 'success', results_count: results.length, results_fullcount: fullcount },
  results,
});

/** What Jamendo actually returns when a page comes back truncated. */
const jamendoTruncated = { headers: { status: 'success', results_count: 0 }, results: [] };

test('jamendo: always requests fullcount, without which there is no total', async () => {
  const fetchImpl = fakeFetch({ 'api.jamendo.com': { body: jamendoOk([jamendoRow], 87) } });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'x' });
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('fullcount'), 'true');
  assert.equal(result.total, 87);
});

test('jamendo: retries a truncated page instead of reporting no results', async () => {
  const fetchImpl = fakeFetch({
    'api.jamendo.com': [
      { body: jamendoTruncated },
      { body: jamendoTruncated },
      { body: jamendoOk([jamendoRow], 13096) },
    ],
  });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'piano' });

  assert.equal(fetchImpl.calls.length, 3, 'it retried past both truncated pages');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.total, 13096);
});

test('jamendo: a genuine no-match is not retried and is not an error', async () => {
  const fetchImpl = fakeFetch({ 'api.jamendo.com': { body: jamendoOk([], 0) } });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  const result = await provider.search({ text: 'zzzznothing' });

  assert.equal(fetchImpl.calls.length, 1, 'results_fullcount: 0 is a definitive answer');
  assert.equal(result.tracks.length, 0);
  assert.equal(result.total, 0);
});

test('jamendo: a page still truncated after retries is an error, not "no results"', async () => {
  const fetchImpl = fakeFetch({ 'api.jamendo.com': { body: jamendoTruncated } });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  await assert.rejects(
    () => provider.search({ text: 'piano' }),
    (error) => {
      assert.match(error.userMessage, /incomplete response/);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('jamendo: a truncated page is never written to the cache', async () => {
  const written = [];
  const cache = { get: () => null, set: (_p, key) => written.push(key) };
  const fetchImpl = fakeFetch({
    'api.jamendo.com': [{ body: jamendoTruncated }, { body: jamendoOk([jamendoRow], 5) }],
  });
  const provider = new JamendoProvider({
    clientId: 'abc',
    cache,
    http: new HttpClient({ fetchImpl }),
  });
  await provider.search({ text: 'piano' });
  assert.equal(written.length, 1, 'only the good page was cached');
});

test('jamendo: a truncated lookup keeps the stored track rather than killing it', async () => {
  const fetchImpl = fakeFetch({ 'api.jamendo.com': { body: jamendoTruncated } });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  const track = provider.normaliseTrack(jamendoRow);

  const resolved = await provider.resolve(track);
  assert.equal(resolved.availability, AVAILABILITY.AVAILABLE, 'flakiness must not kill a track');
  assert.equal(resolved.streamUrl, track.streamUrl);
});

test('jamendo: a definitive empty lookup does mark the track unavailable', async () => {
  const fetchImpl = fakeFetch({ 'api.jamendo.com': { body: jamendoOk([], 0) } });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  const track = provider.normaliseTrack(jamendoRow);

  const resolved = await provider.resolve(track);
  assert.equal(resolved.availability, AVAILABILITY.UNAVAILABLE);
  assert.equal(resolved.streamUrl, null);
});

test('jamendo: resolve re-issues a fresh stream URL for the same stable id', async () => {
  const refreshed = {
    ...jamendoRow,
    audio: 'https://prod-1.storage.jamendo.com/?trackid=1886711&t=new',
  };
  const fetchImpl = fakeFetch({ 'api.jamendo.com': { body: jamendoOk([refreshed], 1) } });
  const provider = new JamendoProvider({ clientId: 'abc', http: new HttpClient({ fetchImpl }) });
  const track = provider.normaliseTrack(jamendoRow);

  const resolved = await provider.resolve(track);
  assert.equal(resolved.id, track.id, 'the identity is stable');
  assert.notEqual(resolved.streamUrl, track.streamUrl, 'but the URL is re-issued');
  assert.equal(resolved.availability, AVAILABILITY.AVAILABLE);
});
