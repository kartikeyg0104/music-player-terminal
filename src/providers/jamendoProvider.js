import { MusicProvider, buildResult, emptyResult } from './base.js';
import { HttpClient } from './http.js';
import { ProviderError, AuthError } from '../core/errors.js';
import { createTrack, AVAILABILITY } from '../core/track.js';
import { delay } from '../core/util.js';

const API_BASE = 'https://api.jamendo.com/v3.0';

/**
 * Extra attempts for a truncated page. Kept small: this works around a
 * provider-side glitch, it is not a reason to hammer their API.
 */
const TRUNCATED_RETRIES = 2;

/**
 * Jamendo provider.
 *
 * Jamendo publishes Creative Commons music and its v3.0 API returns direct,
 * non-expiring `audio` URLs for full tracks - so unlike most commercial
 * catalogues it can genuinely be streamed by a third-party client.
 *
 * Requires a free `client_id` from https://devportal.jamendo.com/. Without one
 * the provider reports itself unconfigured and Termify hides it rather than
 * failing at request time.
 *
 * Verified against the live v3.0 API. Two of its quirks are handled here and
 * nowhere else: `fullcount=true` is required before the response carries a
 * usable total, and roughly one request in five returns a truncated empty
 * page - see `isTruncated` below.
 */
export class JamendoProvider extends MusicProvider {
  static id = 'jamendo';
  static label = 'Jamendo';

  #clientId;
  #http;
  #cache;

  constructor(options = {}) {
    super(options);
    this.#clientId = options.clientId || '';
    this.#cache = options.cache ?? null;
    this.#http =
      options.http ??
      new HttpClient({ timeoutMs: options.timeoutMs, minIntervalMs: 150, logger: options.logger });
  }

  status() {
    if (!this.#clientId) {
      return {
        configured: false,
        reason: 'JAMENDO_CLIENT_ID is not set',
        hint: 'Create a free app at devportal.jamendo.com and put the Client ID in .env',
      };
    }
    return { configured: true, reason: null, hint: null };
  }

  get capabilities() {
    return {
      text: true,
      artist: true,
      album: true,
      genre: true,
      genres: true,
      featured: true,
      pagination: true,
    };
  }

  async genres() {
    // Jamendo's tag vocabulary is open-ended; these are the documented primary
    // music categories used by its own browse UI.
    return [
      'pop',
      'rock',
      'electronic',
      'hiphop',
      'jazz',
      'classical',
      'lounge',
      'metal',
      'soundtrack',
      'world',
      'folk',
      'ambient',
    ].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  }

  async featuredSections() {
    return [
      {
        id: 'popularity_month',
        label: 'Popular this month',
        description: 'Ranked by Jamendo listens over the last month',
      },
      {
        id: 'popularity_total',
        label: 'All-time popular',
        description: 'Ranked by Jamendo lifetime listens',
      },
      {
        id: 'releasedate',
        label: 'Newest releases',
        description: 'Most recently published on Jamendo',
      },
    ];
  }

  async featured(sectionId, options = {}) {
    const order = ['popularity_month', 'popularity_total', 'releasedate'].includes(sectionId)
      ? sectionId
      : 'popularity_month';
    return this.#tracksCall({ order, limit: options.limit, page: options.page ?? 1 }, options, {
      note: `Ordering supplied by Jamendo (${order}).`,
    });
  }

  async search(query, options = {}) {
    this.assertConfigured();
    const params = {};
    if (query.text) params.namesearch = query.text;
    if (query.artist) params.artist_name = query.artist;
    if (query.album) params.album_name = query.album;
    if (query.genre) params.tags = query.genre;
    if (!Object.keys(params).length) return emptyResult(this.id);

    return this.#tracksCall(
      { ...params, limit: query.limit, page: query.page ?? 1, order: 'popularity_total' },
      options,
      {},
    );
  }

  async #tracksCall(params, options, { note = null } = {}) {
    this.assertConfigured();
    const limit = clampLimit(params.limit);
    const page = Math.max(1, params.page ?? 1);

    const url = new URL(`${API_BASE}/tracks/`);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String((page - 1) * limit));
    url.searchParams.set('include', 'musicinfo+licenses');
    url.searchParams.set('audioformat', 'mp32');
    // Without this the response omits results_fullcount, so we would have no
    // total to paginate against - and no way to spot a truncated page.
    url.searchParams.set('fullcount', 'true');
    for (const [key, value] of Object.entries(params)) {
      if (['limit', 'page'].includes(key) || value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const payload = await this.#fetchTracks(url.toString(), options);
    this.#assertOk(payload);
    if (!Array.isArray(payload?.results)) {
      throw new ProviderError('jamendo returned an unexpected payload', {
        userMessage: 'Jamendo returned an unexpected response',
        retryable: true,
      });
    }

    // Still truncated after retrying: say so rather than claiming no results.
    if (isTruncated(payload)) {
      throw new ProviderError('jamendo returned a truncated page after retries', {
        userMessage: 'Jamendo returned an incomplete response',
        hint: 'Their API does this intermittently. Press R to try again.',
        retryable: true,
      });
    }

    const tracks = payload.results.map((row) => this.normaliseTrack(row)).filter(Boolean);
    const total = Number.isFinite(payload?.headers?.results_fullcount)
      ? payload.headers.results_fullcount
      : null;
    return buildResult(this.id, tracks, { total, page, limit, note });
  }

  /**
   * Fetch a tracks page, retrying a *truncated* response.
   *
   * Measured against the live API: roughly one request in five comes back
   * `{"status":"success","results_count":0}` with no `results_fullcount` and
   * no results, for a query that has thousands of matches. Because we always
   * ask for `fullcount=true`, a genuine no-match is distinguishable - it
   * carries `results_fullcount: 0` - so we can retry only the broken ones and
   * never paper over a real empty result.
   */
  async #fetchTracks(url, options) {
    let payload = null;
    for (let attempt = 0; attempt <= TRUNCATED_RETRIES; attempt += 1) {
      payload = await this.#cachedJson(url, options);
      if (!isTruncated(payload)) return payload;
      this.logger?.debug('jamendo returned a truncated page, retrying', { attempt });
      if (attempt < TRUNCATED_RETRIES) {
        await delay(200 * (attempt + 1), options.signal);
      }
    }
    return payload;
  }

  /** Translate a non-success envelope into the app's error taxonomy. */
  #assertOk(payload) {
    const status = payload?.headers?.status;
    if (!status || status === 'success') return;
    const message = payload.headers.error_message || 'request rejected';
    if (/client_id|credential|key/i.test(message)) {
      throw new AuthError(`jamendo rejected the request: ${message}`);
    }
    throw new ProviderError(`jamendo error: ${message}`, {
      userMessage: `Jamendo: ${message}`,
      retryable: false,
    });
  }

  /** Pure mapping from a Jamendo track row to the internal schema. */
  normaliseTrack(row) {
    if (!row?.id) return null;
    const stream = row.audio || row.audiodownload || null;
    return createTrack({
      provider: this.id,
      providerId: String(row.id),
      title: row.name,
      artist: row.artist_name,
      album: row.album_name,
      duration: row.duration,
      genre: Array.isArray(row.musicinfo?.tags?.genres) ? row.musicinfo.tags.genres[0] : null,
      year: row.releasedate ? Number(String(row.releasedate).slice(0, 4)) : null,
      license: row.license_ccurl || row.licenses?.[0]?.license_ccurl || null,
      artworkUrl: row.album_image || row.image || null,
      streamUrl: stream,
      externalUrl: row.shareurl || null,
      availability: stream ? AVAILABILITY.AVAILABLE : AVAILABILITY.METADATA_ONLY,
      providerData: { artistId: row.artist_id ?? null, albumId: row.album_id ?? null },
    });
  }

  /**
   * Jamendo audio URLs embed a per-request token, so we look the track up
   * again by its stable numeric id immediately before playing.
   *
   * A track is only declared unavailable on a *definitive* answer
   * (`results_fullcount: 0`). A truncated or failed lookup falls back to the
   * stored URL and lets playback try it - the same flakiness that affects
   * search must never turn a working track into a dead one.
   */
  async resolve(track, options = {}) {
    if (!this.status().configured) return track;
    const url = new URL(`${API_BASE}/tracks/`);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('id', track.providerId);
    url.searchParams.set('audioformat', 'mp32');
    url.searchParams.set('fullcount', 'true');
    try {
      const payload = await this.#fetchTracks(url.toString(), options);
      const row = payload?.results?.[0];
      if (row) return this.normaliseTrack(row) ?? track;

      if (payload?.headers?.results_fullcount === 0) {
        return createTrack({ ...track, availability: AVAILABILITY.UNAVAILABLE, streamUrl: null });
      }
      this.logger?.warn('jamendo lookup was inconclusive, keeping the stored url', {
        id: track.providerId,
      });
      return track;
    } catch (error) {
      this.logger?.warn('jamendo resolve failed, using stored url', { error: error.message });
      return track;
    }
  }

  async #cachedJson(url, options = {}) {
    // Cache key omits the client id so a rotated key does not orphan the cache.
    const key = url.replace(/client_id=[^&]*/, 'client_id=*');
    const cached = this.#cache?.get(this.id, key);
    if (cached) return cached;
    const payload = await this.#http.getJson(url, { ...options, provider: this.label });
    // Never cache a truncated page: a 60-minute TTL would turn one flaky
    // response into an hour of wrong "no results".
    if (!isTruncated(payload)) this.#cache?.set(this.id, key, payload);
    return payload;
  }
}

/**
 * Did Jamendo answer "success" with an empty page but no `results_fullcount`?
 *
 * Every request this provider makes sets `fullcount=true`, so the field is
 * present on any complete response - including a genuine no-match, which
 * reports `results_fullcount: 0`. Its absence therefore means the response
 * was truncated, not that nothing matched.
 */
function isTruncated(payload) {
  return (
    payload?.headers?.status === 'success' &&
    Array.isArray(payload.results) &&
    payload.results.length === 0 &&
    payload.headers.results_fullcount === undefined
  );
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 25;
  // Jamendo caps `limit` at 200.
  return Math.min(200, Math.max(1, Math.round(n)));
}
