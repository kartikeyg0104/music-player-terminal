import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchService } from '../../src/services/searchService.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MusicProvider, buildResult } from '../../src/providers/base.js';
import { NetworkError } from '../../src/core/errors.js';
import { parseQuery } from '../../src/ui/views/SearchView.js';
import { makeServices, makeTracks, nullLogger } from '../helpers.js';

/** A provider whose responses a test can drive directly. */
class ScriptedProvider extends MusicProvider {
  static id = 'mock';
  static label = 'Scripted';
  constructor(script) {
    super({});
    this.script = script;
    this.calls = [];
  }
  async search(query, options) {
    this.calls.push(query);
    return this.script(query, options);
  }
  async featured(sectionId, options) {
    this.calls.push({ sectionId });
    return this.script({ sectionId }, options);
  }
  async featuredSections() {
    return [{ id: 'top', label: 'Top', description: '' }];
  }
}

function harness(provider) {
  const services = makeServices({ settings: { defaultProvider: 'mock' } });
  const registry = new ProviderRegistry({ providers: [provider] });
  const search = new SearchService({
    registry,
    settings: services.settings,
    tracks: services.tracks,
    logger: nullLogger,
  });
  return { search, services, registry, close: () => services.close() };
}

test('search: an empty query returns to the idle state without a request', async (t) => {
  const provider = new ScriptedProvider(() => buildResult('mock', makeTracks(2)));
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: '   ' });
  assert.equal(h.search.state.status, 'idle');
  assert.equal(provider.calls.length, 0, 'no network request for an empty query');
});

test('search: a successful search publishes tracks and pagination', async (t) => {
  const provider = new ScriptedProvider(() =>
    buildResult('mock', makeTracks(5), { total: 42, page: 1, limit: 5 }),
  );
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: 'hello' });
  const state = h.search.state;
  assert.equal(state.status, 'ready');
  assert.equal(state.tracks.length, 5);
  assert.equal(state.total, 42);
  assert.equal(state.hasMore, true);
  assert.equal(state.providerId, 'mock');
});

test('search: results are cached into the track repository for later reference', async (t) => {
  const provider = new ScriptedProvider(() => buildResult('mock', makeTracks(3)));
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: 'hello' });
  assert.equal(h.services.tracks.count(), 3, 'playlists can now reference these tracks');
});

test('search: no matches is an empty state, not an error', async (t) => {
  const provider = new ScriptedProvider(() => buildResult('mock', [], { total: 0 }));
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: 'zzzz' });
  assert.equal(h.search.state.status, 'empty');
  assert.equal(h.search.state.error, null);
});

test('search: a provider failure becomes a friendly error state', async (t) => {
  const provider = new ScriptedProvider(() => {
    throw new NetworkError('offline');
  });
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: 'hello' });
  assert.equal(h.search.state.status, 'error');
  assert.equal(h.search.state.error.title, 'Network unavailable');
  assert.equal(h.search.state.error.retryable, true);
  assert.deepEqual(h.search.state.tracks, []);
});

test('search: retry re-runs the last request', async (t) => {
  let attempt = 0;
  const provider = new ScriptedProvider(() => {
    attempt += 1;
    if (attempt === 1) throw new NetworkError('offline');
    return buildResult('mock', makeTracks(2));
  });
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: 'hello' });
  assert.equal(h.search.state.status, 'error');
  await h.search.retry();
  assert.equal(h.search.state.status, 'ready');
  assert.equal(h.search.state.tracks.length, 2);
});

test('search: a slower earlier request cannot overwrite a newer one', async (t) => {
  const provider = new ScriptedProvider(async (query) => {
    // The first query is slow, the second is fast.
    const slow = query.text === 'slow';
    await new Promise((r) => setTimeout(r, slow ? 120 : 5));
    return buildResult('mock', [...makeTracks(1, { title: slow ? 'SLOW' : 'FAST' })]);
  });
  const h = harness(provider);
  t.after(h.close);

  const first = h.search.search({ text: 'slow' });
  await new Promise((r) => setTimeout(r, 10));
  const second = h.search.search({ text: 'fast' });
  await Promise.all([first, second]);

  assert.equal(h.search.state.query.text, 'fast');
  assert.equal(h.search.state.tracks[0].title, 'FAST', 'the late slow result was discarded');
  assert.equal(h.search.state.status, 'ready');
});

test('search: nextPage and previousPage walk the pages', async (t) => {
  const provider = new ScriptedProvider((query) =>
    buildResult('mock', makeTracks(5), { total: 50, page: query.page ?? 1, limit: 5 }),
  );
  const h = harness(provider);
  t.after(h.close);

  await h.search.search({ text: 'hello' });
  assert.equal(h.search.state.page, 1);
  await h.search.nextPage();
  assert.equal(h.search.state.page, 2);
  await h.search.previousPage();
  assert.equal(h.search.state.page, 1);
  await h.search.previousPage();
  assert.equal(h.search.state.page, 1, 'cannot page before the first page');
});

test('search: loadFeatured records which section is showing', async (t) => {
  const provider = new ScriptedProvider(() =>
    buildResult('mock', makeTracks(3), { note: 'Ranked by the provider.' }),
  );
  const h = harness(provider);
  t.after(h.close);

  await h.search.loadFeatured('top');
  assert.equal(h.search.state.source, 'featured');
  assert.equal(h.search.state.sectionId, 'top');
  assert.equal(h.search.state.note, 'Ranked by the provider.');
});

test('search: sample data is flagged all the way through to the state', async (t) => {
  const services = makeServices({ settings: { defaultProvider: 'mock' } });
  const registry = new ProviderRegistry({
    providers: [new MockProvider({ synthesisAvailable: false })],
  });
  const search = new SearchService({
    registry,
    settings: services.settings,
    tracks: services.tracks,
    logger: nullLogger,
  });
  t.after(() => services.close());

  await search.search({ text: 'orbit', providerId: 'mock' });
  assert.equal(search.state.isSample, true);
  assert.match(search.state.note, /Demo mode/);
});

test('search: falling back to another provider is explained in the state', async (t) => {
  const services = makeServices();
  const unconfigured = new (class extends MusicProvider {
    static id = 'archive';
    static label = 'Internet Archive';
    status() {
      return { configured: false, reason: 'offline for maintenance', hint: null };
    }
  })({});
  const registry = new ProviderRegistry({
    providers: [unconfigured, new MockProvider({ synthesisAvailable: false })],
  });
  const search = new SearchService({
    registry,
    settings: services.settings,
    tracks: services.tracks,
    logger: nullLogger,
  });
  t.after(() => services.close());

  await search.search({ text: 'orbit', providerId: 'archive' });
  assert.equal(search.state.providerId, 'mock');
  assert.match(search.state.note, /offline for maintenance/);
});

test('search: reset clears everything back to idle', async (t) => {
  const provider = new ScriptedProvider(() => buildResult('mock', makeTracks(2)));
  const h = harness(provider);
  t.after(h.close);
  await h.search.search({ text: 'hello' });
  h.search.reset();
  assert.equal(h.search.state.status, 'idle');
  assert.deepEqual(h.search.state.tracks, []);
  assert.equal(h.search.state.query.text, '');
});

// --------------------------------------------------------- query parsing

test('parseQuery: splits field prefixes from free text', () => {
  assert.deepEqual(parseQuery('artist: bonobo black sands'), {
    text: 'black sands',
    artist: 'bonobo',
    album: '',
    genre: '',
  });
});

test('parseQuery: supports quoted values and several fields', () => {
  assert.deepEqual(parseQuery('album:"kind of blue" artist:"miles davis" remaster'), {
    text: 'remaster',
    artist: 'miles davis',
    album: 'kind of blue',
    genre: '',
  });
});

test('parseQuery: plain text stays plain text', () => {
  assert.deepEqual(parseQuery('just some words'), {
    text: 'just some words',
    artist: '',
    album: '',
    genre: '',
  });
});

test('parseQuery: handles empty and nullish input', () => {
  assert.equal(parseQuery('').text, '');
  assert.equal(parseQuery(undefined).text, '');
});
