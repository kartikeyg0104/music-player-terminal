import { ArchiveProvider } from './archiveProvider.js';
import { JamendoProvider } from './jamendoProvider.js';
import { LocalProvider } from './localProvider.js';
import { MockProvider } from './mockProvider.js';
import { ValidationError } from '../core/errors.js';

/**
 * Builds and owns the set of providers.
 *
 * Nothing above this layer knows which concrete providers exist: the UI asks
 * the registry for "the providers that are usable" and gets back objects
 * implementing `MusicProvider`.
 */
export class ProviderRegistry {
  #providers = new Map();
  #logger;

  constructor({ providers = [], logger } = {}) {
    this.#logger = logger;
    for (const provider of providers) this.#providers.set(provider.id, provider);
  }

  /**
   * Construct the standard provider set from config.
   * @param {object} deps
   * @param {ReturnType<import('../config/env.js').readEnv>} deps.env
   * @param {import('../services/settingsService.js').SettingsService} deps.settings
   * @param {import('../services/cacheService.js').CacheService} deps.cache
   * @param {string} deps.cacheDir
   * @param {boolean} [deps.demo] force demo mode
   */
  static standard({ env, settings, cache, cacheDir, logger, demo = false }) {
    const timeoutMs = env.httpTimeoutMs;
    const providers = [
      new ArchiveProvider({
        collection: env.archive.collection || null,
        contact: env.archive.contact || null,
        cache,
        timeoutMs,
        logger,
      }),
      new JamendoProvider({ clientId: env.jamendo.clientId, cache, timeoutMs, logger }),
      new LocalProvider({
        musicDir: settings.get('musicDir') || env.musicDir || null,
        logger,
      }),
      new MockProvider({ cacheDir, logger }),
    ];
    const registry = new ProviderRegistry({ providers, logger });
    registry.demo = demo;
    return registry;
  }

  /** @returns {import('./base.js').MusicProvider[]} */
  all() {
    return [...this.#providers.values()];
  }

  /** Providers that can serve a request right now. */
  usable() {
    return this.all().filter((p) => p.status().configured);
  }

  /** @returns {import('./base.js').MusicProvider} */
  get(id) {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new ValidationError(`unknown provider "${id}"`, {
        userMessage: `Unknown provider "${id}"`,
      });
    }
    return provider;
  }

  has(id) {
    return this.#providers.has(id);
  }

  /**
   * Resolve the provider to use, degrading gracefully: requested -> demo
   * override -> first usable -> mock. Returns the provider plus the reason if
   * we had to fall back, so the UI can explain itself.
   * @returns {{ provider: import('./base.js').MusicProvider, fallbackReason: string|null }}
   */
  select(requestedId) {
    if (this.demo) {
      return { provider: this.get('mock'), fallbackReason: null };
    }
    if (requestedId && this.#providers.has(requestedId)) {
      const provider = this.get(requestedId);
      if (provider.status().configured) return { provider, fallbackReason: null };
      const fallback = this.usable()[0] ?? this.get('mock');
      return {
        provider: fallback,
        fallbackReason: `${provider.label} is not configured (${provider.status().reason})`,
      };
    }
    const fallback = this.usable()[0] ?? this.get('mock');
    return {
      provider: fallback,
      fallbackReason: requestedId ? `unknown provider "${requestedId}"` : null,
    };
  }

  /** Provider rows for the Settings screen. */
  describe() {
    return this.all().map((provider) => {
      const status = provider.status();
      return {
        id: provider.id,
        label: provider.label,
        isLive: provider.isLive,
        configured: status.configured,
        reason: status.reason,
        hint: status.hint,
        capabilities: provider.capabilities,
      };
    });
  }

  async dispose() {
    for (const provider of this.all()) {
      try {
        await provider.dispose();
      } catch (error) {
        this.#logger?.warn('provider dispose failed', { id: provider.id, error: error.message });
      }
    }
  }
}
