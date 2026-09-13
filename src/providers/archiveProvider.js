import { MusicProvider, buildResult, emptyResult } from './base.js';
import { HttpClient } from './http.js';
import { ProviderError } from '../core/errors.js';
import { createTrack, AVAILABILITY } from '../core/track.js';

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

/**
 * Audio formats archive.org derives, best streaming candidate first.
 * We prefer the small, seekable MP3 derivatives over lossless originals.
 */
const PREFERRED_FORMATS = [
  'VBR MP3',
  '128Kbps MP3',
  'MP3',
  '64Kbps MP3',
  'Ogg Vorbis',
  '256Kbps MP3',
  'Flac',
  'WAVE',
];

/**
 * Collections that hold freely streamable, openly licensed audio. Used as the
 * browse rail.
 */
const COLLECTIONS = [
  {
    id: 'etree',
    label: 'Live Music Archive',
    description: 'Artist-authorised live concert recordings',
  },
  { id: 'audio_music', label: 'Music', description: 'The Archive-wide music collection' },
  { id: 'netlabels', label: 'Netlabels', description: 'Creative Commons netlabel releases' },
  { id: 'audio_bookspoetry', label: 'Spoken Word', description: 'Poetry and readings' },
  { id: 'oldtimeradio', label: 'Old Time Radio', description: 'Public-domain radio broadcasts' },
  { id: '78rpm', label: '78 RPM', description: 'Digitised 78rpm records and cylinders' },
];

/**
 * Default scope for free-text search.
 *
 * `mediatype:audio` alone matches the whole spoken-word half of the Archive -
 * podcasts, radio rips, conference recordings - so a search for "blues"
 * returns mostly talk. Scoping to the music collections by default makes
 * search return music. `ARCHIVE_COLLECTION` overrides this entirely.
 */
const MUSIC_SCOPE = 'audio_music OR etree OR netlabels OR 78rpm OR audio_foreign';

/**
 * Internet Archive provider.
 *
 * Needs no credentials, which is why it is Termify's default: a fresh install
 * can search and stream real audio immediately. Uses the public
 * `advancedsearch.php` and `metadata` endpoints documented at
 * https://archive.org/developers/.
 *
 * Search returns *items* (a concert, an album); each item's metadata lists its
 * audio files. We expand the top items into individual playable tracks.
 */
export class ArchiveProvider extends MusicProvider {
  static id = 'archive';
  static label = 'Internet Archive';

  #http;
  #collection;
  #cache;
  /** Items expanded per search page. Each costs one metadata request. */
  #itemsPerPage = 6;

  /**
   * @param {object} [options]
   * @param {string} [options.collection] restrict searches to one collection
   * @param {string} [options.contact] contact string for the User-Agent
   * @param {import('../services/cacheService.js').CacheService} [options.cache]
   */
  constructor(options = {}) {
    super(options);
    this.#collection = options.collection || null;
    this.#cache = options.cache ?? null;
    this.#http =
      options.http ??
      new HttpClient({
        timeoutMs: options.timeoutMs,
        contact: options.contact,
        // archive.org asks clients to be gentle; one request per 250ms.
        minIntervalMs: 250,
        logger: options.logger,
      });
  }

  get capabilities() {
    return {
      text: true,
      artist: true,
      album: true,
      genre: false,
      genres: false,
      featured: true,
      pagination: true,
    };
  }

  async featuredSections() {
    return COLLECTIONS.map((c) => ({ ...c }));
  }

  async featured(sectionId, options = {}) {
    const collection = COLLECTIONS.some((c) => c.id === sectionId) ? sectionId : 'etree';
    return this.#runSearch(
      { collection, sort: 'downloads desc', page: options.page ?? 1, limit: options.limit },
      options,
      `Most-downloaded items in the ${labelFor(collection)} collection, as ranked by archive.org.`,
    );
  }

  /**
   * @param {import('./base.js').SearchQuery} query
   * @param {{ signal?: AbortSignal }} [options]
   */
  async search(query, options = {}) {
    const clauses = [];
    if (query.text) clauses.push(`(${escapeLucene(query.text)})`);
    if (query.artist) clauses.push(`creator:(${escapeLucene(query.artist)})`);
    if (query.album) clauses.push(`title:(${escapeLucene(query.album)})`);
    if (!clauses.length) return emptyResult(this.id);

    return this.#runSearch(
      {
        terms: clauses.join(' AND '),
        collection: this.#collection ?? MUSIC_SCOPE,
        page: query.page ?? 1,
        limit: query.limit,
      },
      options,
      this.#collection
        ? `Scoped to the "${this.#collection}" collection (ARCHIVE_COLLECTION).`
        : 'Scoped to the Internet Archive music collections.',
    );
  }

  async #runSearch({ terms, collection, sort, page = 1, limit }, options, note) {
    const parts = ['mediatype:(audio)'];
    if (terms) parts.push(terms);
    if (collection) parts.push(`collection:(${collection})`);

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', parts.join(' AND '));
    for (const field of ['identifier', 'title', 'creator', 'year', 'downloads', 'subject']) {
      url.searchParams.append('fl[]', field);
    }
    if (sort) url.searchParams.set('sort[]', sort);
    url.searchParams.set('rows', String(this.#itemsPerPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('output', 'json');

    const payload = await this.#cachedJson(url.toString(), options);
    const response = payload?.response;
    if (!response || !Array.isArray(response.docs)) {
      throw new ProviderError('archive.org returned an unexpected search payload', {
        userMessage: 'Internet Archive returned an unexpected response',
        retryable: true,
      });
    }

    // Expand items into tracks. One bad item must not sink the whole page.
    const settled = await Promise.allSettled(
      response.docs.map((doc) => this.#itemTracks(doc, options)),
    );
    const tracks = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') tracks.push(...outcome.value);
      else this.logger?.warn('archive item expansion failed', { error: outcome.reason?.message });
    }

    const capped = limit ? tracks.slice(0, limit) : tracks;
    return buildResult(this.id, capped, {
      // numFound counts *items*, not tracks - the UI labels it accordingly.
      total: Number.isFinite(response.numFound) ? response.numFound : null,
      page,
      limit: this.#itemsPerPage,
      note:
        [
          note,
          tracks.length > capped.length
            ? `Showing ${capped.length} of ${tracks.length} tracks from this page of items.`
            : null,
        ]
          .filter(Boolean)
          .join(' ') || null,
    });
  }

  /** Expand one archive.org item into playable tracks. */
  async #itemTracks(doc, options) {
    const identifier = doc.identifier;
    if (!identifier) return [];
    const metadata = await this.#metadata(identifier, options);
    return this.#tracksFromMetadata(identifier, metadata, doc);
  }

  async #metadata(identifier, options = {}) {
    return this.#cachedJson(`${METADATA_ENDPOINT}/${encodeURIComponent(identifier)}`, options);
  }

  /**
   * Map an item's file list to tracks. Exported behaviour is unit-tested with
   * a recorded fixture, so the normalisation rules live in one pure function.
   */
  #tracksFromMetadata(identifier, metadata, doc = {}) {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    const itemTitle = pickString(metadata?.metadata?.title) || pickString(doc.title) || identifier;
    const itemArtist =
      pickString(metadata?.metadata?.creator) || pickString(doc.creator) || 'Internet Archive';
    const year = parseYear(metadata?.metadata?.date ?? doc.year);
    const genre = pickString(metadata?.metadata?.subject ?? doc.subject) || null;
    const license = pickString(metadata?.metadata?.licenseurl) || null;

    // Group derivatives of the same recording so we pick one file per song.
    const groups = new Map();
    for (const file of files) {
      if (!PREFERRED_FORMATS.includes(file.format)) continue;
      const key = (file.original && file.source === 'derivative' ? file.original : file.name)
        .replace(/\.[^.]+$/, '')
        .toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }

    const tracks = [];
    for (const [, candidates] of groups) {
      candidates.sort(
        (a, b) => PREFERRED_FORMATS.indexOf(a.format) - PREFERRED_FORMATS.indexOf(b.format),
      );
      const file = candidates[0];
      const duration = candidates.map((c) => c.length).find((l) => l != null && l !== '') ?? null;
      tracks.push(
        createTrack({
          provider: this.id,
          // Stable: item id + file name. Never the URL.
          providerId: `${identifier}/${file.name}`,
          title: pickString(file.title) || prettifyFilename(file.name),
          artist: pickString(file.artist) || pickString(file.creator) || itemArtist,
          album: pickString(file.album) || itemTitle,
          duration,
          genre,
          year,
          license,
          artworkUrl: `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/__ia_thumb.jpg`,
          streamUrl: buildStreamUrl(identifier, file.name),
          externalUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
          availability: AVAILABILITY.AVAILABLE,
          providerData: {
            identifier,
            file: file.name,
            format: file.format,
            track: file.track ?? null,
          },
        }),
      );
    }

    tracks.sort((a, b) => trackNumber(a) - trackNumber(b));
    return tracks;
  }

  /**
   * Stream URLs on archive.org do not expire, but the file can be removed or
   * the item made dark. Re-resolving keeps playlists honest.
   */
  async resolve(track, options = {}) {
    const identifier = track.providerData?.identifier;
    const fileName = track.providerData?.file;
    if (!identifier || !fileName) return track;
    try {
      const metadata = await this.#metadata(identifier, options);
      const stillThere = (metadata?.files ?? []).some((f) => f.name === fileName);
      if (!stillThere) {
        return createTrack({ ...track, availability: AVAILABILITY.UNAVAILABLE, streamUrl: null });
      }
      return createTrack({ ...track, streamUrl: buildStreamUrl(identifier, fileName) });
    } catch (error) {
      this.logger?.warn('archive resolve failed, using stored url', { error: error.message });
      return track;
    }
  }

  async #cachedJson(url, options = {}) {
    const cached = this.#cache?.get(this.id, url);
    if (cached) return cached;
    const payload = await this.#http.getJson(url, { ...options, provider: this.label });
    this.#cache?.set(this.id, url, payload);
    return payload;
  }

  /** Exposed for tests: pure normalisation of a metadata payload. */
  normaliseItem(identifier, metadata, doc) {
    return this.#tracksFromMetadata(identifier, metadata, doc);
  }
}

function buildStreamUrl(identifier, fileName) {
  const encodedFile = fileName.split('/').map(encodeURIComponent).join('/');
  return `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodedFile}`;
}

/**
 * archive.org search is Lucene-backed. Users type free text, so we neutralise
 * the operator characters rather than letting a stray `:` or `(` 400 the call.
 */
function escapeLucene(text) {
  return String(text)
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickString(value) {
  if (Array.isArray(value)) return pickString(value[0]);
  if (value == null) return '';
  return String(value).trim();
}

function parseYear(value) {
  const match = /\d{4}/.exec(pickString(value));
  return match ? Number(match[0]) : null;
}

function prettifyFilename(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/^[\d]{1,3}[\s._-]+/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trackNumber(track) {
  const raw = track.providerData?.track;
  const n = Number.parseInt(String(raw ?? '').split('/')[0], 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function labelFor(collectionId) {
  return COLLECTIONS.find((c) => c.id === collectionId)?.label ?? collectionId;
}

export { COLLECTIONS as ARCHIVE_COLLECTIONS };
