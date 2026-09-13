import { NotConfiguredError } from '../core/errors.js';

/**
 * @typedef {object} SearchQuery
 * @property {string} [text]     Free-text query.
 * @property {string} [artist]
 * @property {string} [album]
 * @property {string} [genre]
 * @property {number} [limit]
 * @property {number} [page]     1-based.
 *
 * @typedef {object} SearchResult
 * @property {import('../core/track.js').Track[]} tracks
 * @property {number|null} total      Total matches, or null when unknown.
 * @property {number} page
 * @property {boolean} hasMore
 * @property {string} provider
 * @property {boolean} isSample      True for mock/demo data.
 * @property {string|null} note      Provider caveat shown in the UI.
 */

/**
 * Contract every music source implements.
 *
 * The UI and playback engine only ever talk to this interface, so adding a
 * source means adding one file here and registering it - no other layer
 * changes.
 */
export class MusicProvider {
  /** Machine name, e.g. 'archive'. */
  static id = 'base';
  /** Human label shown in the header and result rows. */
  static label = 'Base';

  constructor({ logger } = {}) {
    this.logger = logger ?? null;
  }

  get id() {
    return /** @type {typeof MusicProvider} */ (this.constructor).id;
  }

  get label() {
    return /** @type {typeof MusicProvider} */ (this.constructor).label;
  }

  /** Does this provider return real, live data? False for the mock provider. */
  get isLive() {
    return true;
  }

  /**
   * @returns {{ configured: boolean, reason: string|null, hint: string|null }}
   */
  status() {
    return { configured: true, reason: null, hint: null };
  }

  /** Capability flags so the UI can hide controls a provider cannot honour. */
  get capabilities() {
    return {
      text: true,
      artist: false,
      album: false,
      genre: false,
      genres: false,
      featured: false,
      pagination: false,
    };
  }

  /** Throws when the provider is missing credentials. */
  assertConfigured() {
    const status = this.status();
    if (!status.configured) {
      throw new NotConfiguredError(`${this.id} is not configured: ${status.reason}`, {
        userMessage: `${this.label} is not configured`,
        hint: status.hint,
      });
    }
  }

  /**
   * @param {SearchQuery} _query
   * @param {{ signal?: AbortSignal }} [_options]
   * @returns {Promise<SearchResult>}
   */
  async search(_query, _options) {
    throw new Error(`${this.id}: search() not implemented`);
  }

  /**
   * Genres/categories this provider can browse. Empty array means the
   * provider genuinely has none - the UI then hides the genre rail.
   * @returns {Promise<{id: string, label: string}[]>}
   */
  async genres() {
    return [];
  }

  /**
   * Provider-curated listings. Only implement this when the provider actually
   * publishes such data; never synthesise a "trending" list.
   * @returns {Promise<{id: string, label: string, description: string}[]>}
   */
  async featuredSections() {
    return [];
  }

  /**
   * @param {string} _sectionId
   * @param {{ signal?: AbortSignal, limit?: number, page?: number }} [_options]
   * @returns {Promise<SearchResult>}
   */
  async featured(_sectionId, _options) {
    return emptyResult(this.id);
  }

  /**
   * Re-resolve a playable URL for a stored track.
   *
   * Stream URLs expire; playlists store provider ids. The engine calls this
   * immediately before playing so it always has a fresh URL.
   * @param {import('../core/track.js').Track} track
   * @returns {Promise<import('../core/track.js').Track>}
   */
  async resolve(track) {
    return track;
  }

  /** Release sockets/timers. */
  async dispose() {}
}

/** @returns {SearchResult} */
export function emptyResult(provider, extra = {}) {
  return {
    tracks: [],
    total: 0,
    page: 1,
    hasMore: false,
    provider,
    isSample: false,
    note: null,
    ...extra,
  };
}

/** @returns {SearchResult} */
export function buildResult(
  provider,
  tracks,
  { total = null, page = 1, limit, isSample = false, note = null } = {},
) {
  const hasMore =
    total != null ? page * (limit ?? tracks.length) < total : tracks.length >= (limit ?? Infinity);
  return { tracks, total, page, hasMore, provider, isSample, note };
}
