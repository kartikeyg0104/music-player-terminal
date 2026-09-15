import { Emitter } from '../core/events.js';
import { toUserMessage } from '../core/errors.js';

/**
 * Search/discovery orchestration.
 *
 * Owns exactly one in-flight request: starting a new search aborts the
 * previous one, so a fast typist never sees results from an older query
 * overwrite a newer one. State is exposed as a plain object and broadcast on
 * 'change', which the UI subscribes to.
 *
 * @typedef {'idle'|'loading'|'ready'|'empty'|'error'} SearchStatus
 */
export class SearchService extends Emitter {
  #registry;
  #logger;
  #settings;
  #controller = null;
  #requestId = 0;
  #tracks;

  #state = {
    status: /** @type {SearchStatus} */ ('idle'),
    query: { text: '', artist: '', album: '', genre: '' },
    providerId: null,
    providerLabel: null,
    isSample: false,
    tracks: [],
    total: null,
    page: 1,
    hasMore: false,
    note: null,
    error: null,
    lastUpdatedAt: null,
    source: /** @type {'search'|'featured'} */ ('search'),
    sectionId: null,
  };

  constructor({ registry, settings, tracks, logger }) {
    super();
    this.#registry = registry;
    this.#settings = settings;
    this.#tracks = tracks;
    this.#logger = logger;
  }

  get state() {
    return this.#state;
  }

  #update(patch) {
    this.#state = { ...this.#state, ...patch };
    this.emit('change', this.#state);
  }

  /** Abort whatever is in flight (called on unmount and on a new request). */
  cancel() {
    this.#controller?.abort(new DOMException('superseded', 'AbortError'));
    this.#controller = null;
  }

  /**
   * Run a search against the currently selected provider.
   * @param {{text?: string, artist?: string, album?: string, genre?: string, page?: number, providerId?: string}} query
   */
  async search(query = {}) {
    const providerId = query.providerId ?? this.#settings.get('defaultProvider');
    const { provider, fallbackReason } = this.#registry.select(providerId);
    // Trim first: "   " is an empty query, not a search for three spaces.
    const merged = {
      text: String(query.text ?? '').trim(),
      artist: String(query.artist ?? '').trim(),
      album: String(query.album ?? '').trim(),
      genre: String(query.genre ?? '').trim(),
    };
    const page = Math.max(1, query.page ?? 1);

    if (!merged.text && !merged.artist && !merged.album && !merged.genre) {
      this.cancel();
      this.#update({
        status: 'idle',
        query: merged,
        tracks: [],
        total: null,
        page: 1,
        hasMore: false,
        error: null,
        note: null,
        source: 'search',
        sectionId: null,
        providerId: provider.id,
        providerLabel: provider.label,
      });
      return this.#state;
    }

    return this.#run(
      () =>
        provider.search(
          { ...merged, page, limit: this.#settings.get('searchLimit') },
          { signal: this.#controller.signal },
        ),
      {
        provider,
        fallbackReason,
        page,
        query: merged,
        source: 'search',
        sectionId: null,
      },
    );
  }

  /**
   * Load a provider-curated section. Only sections the provider itself
   * publishes are ever requested.
   */
  async loadFeatured(sectionId, { page = 1, providerId } = {}) {
    const requested = providerId ?? this.#settings.get('defaultProvider');
    const { provider, fallbackReason } = this.#registry.select(requested);
    return this.#run(
      () =>
        provider.featured(sectionId, {
          page,
          limit: this.#settings.get('searchLimit'),
          signal: this.#controller.signal,
        }),
      {
        provider,
        fallbackReason,
        page,
        query: this.#state.query,
        source: 'featured',
        sectionId,
      },
    );
  }

  async #run(work, { provider, fallbackReason, page, query, source, sectionId }) {
    this.cancel();
    this.#controller = new AbortController();
    const requestId = ++this.#requestId;

    this.#update({
      status: 'loading',
      query,
      page,
      source,
      sectionId,
      error: null,
      providerId: provider.id,
      providerLabel: provider.label,
      isSample: !provider.isLive,
      note: fallbackReason ? `Using ${provider.label}: ${fallbackReason}` : null,
    });

    try {
      const result = await work();
      if (requestId !== this.#requestId) return this.#state; // superseded
      // Cache what we found so playlists/favourites can reference it later.
      this.#tracks.upsertAll(result.tracks);
      this.#update({
        status: result.tracks.length ? 'ready' : 'empty',
        tracks: result.tracks,
        total: result.total,
        page: result.page,
        hasMore: result.hasMore,
        isSample: result.isSample || !provider.isLive,
        note: fallbackReason ? `Using ${provider.label}: ${fallbackReason}` : result.note,
        error: null,
        lastUpdatedAt: new Date().toISOString(),
      });
      return this.#state;
    } catch (error) {
      if (requestId !== this.#requestId || error?.name === 'AbortError') return this.#state;
      this.#logger?.warn('search failed', { provider: provider.id, error: error.message });
      this.#update({ status: 'error', error: toUserMessage(error), tracks: [], total: null });
      return this.#state;
    } finally {
      if (requestId === this.#requestId) this.#controller = null;
    }
  }

  /** Re-run the last request, used by the retry affordance on the error state. */
  async retry() {
    const { source, sectionId, query, page } = this.#state;
    if (source === 'featured') return this.loadFeatured(sectionId, { page });
    return this.search({ ...query, page });
  }

  async nextPage() {
    if (!this.#state.hasMore) return this.#state;
    const page = this.#state.page + 1;
    if (this.#state.source === 'featured') {
      return this.loadFeatured(this.#state.sectionId, { page });
    }
    return this.search({ ...this.#state.query, page });
  }

  async previousPage() {
    if (this.#state.page <= 1) return this.#state;
    const page = this.#state.page - 1;
    if (this.#state.source === 'featured') {
      return this.loadFeatured(this.#state.sectionId, { page });
    }
    return this.search({ ...this.#state.query, page });
  }

  reset() {
    this.cancel();
    this.#update({
      status: 'idle',
      query: { text: '', artist: '', album: '', genre: '' },
      tracks: [],
      total: null,
      page: 1,
      hasMore: false,
      note: null,
      error: null,
      source: 'search',
      sectionId: null,
    });
  }
}
