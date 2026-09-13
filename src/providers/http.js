import {
  AppError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  AuthError,
} from '../core/errors.js';
import { delay } from '../core/util.js';

const USER_AGENT = 'Termify/1.0 (+https://github.com/termify/termify; terminal music client)';

/**
 * Shared HTTP client for providers.
 *
 * Responsibilities kept in one place so no provider has to reimplement them:
 * request timeouts, bounded retry with jittered backoff, rate-limit
 * awareness (including `Retry-After`), and translating transport failures
 * into the app's error taxonomy.
 *
 * Retries only happen for idempotent GETs and only for failures that can
 * plausibly succeed on a second attempt - never for 4xx other than 429.
 */
export class HttpClient {
  #timeoutMs;
  #logger;
  #userAgent;
  #minIntervalMs;
  #nextAllowedAt = 0;
  #fetch;

  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.minIntervalMs] client-side throttle between calls
   * @param {string} [options.contact] appended to the User-Agent
   * @param {typeof fetch} [options.fetchImpl] injected in tests
   */
  constructor(options = {}) {
    this.#timeoutMs = options.timeoutMs ?? 12000;
    this.#logger = options.logger ?? null;
    this.#minIntervalMs = options.minIntervalMs ?? 0;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#userAgent = options.contact
      ? `${USER_AGENT.slice(0, -1)}; ${options.contact})`
      : USER_AGENT;
  }

  /**
   * GET and parse JSON.
   * @param {string} url
   * @param {{ signal?: AbortSignal, retries?: number, headers?: Record<string,string>, provider?: string }} [options]
   */
  async getJson(url, options = {}) {
    const response = await this.get(url, options);
    const text = await response.text();
    if (!text.trim()) {
      throw new ProviderError(`${options.provider ?? 'provider'} returned an empty body`, {
        userMessage: 'The provider returned an empty response',
        retryable: true,
      });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ProviderError(`${options.provider ?? 'provider'} returned malformed JSON`, {
        userMessage: 'The provider returned an unreadable response',
        hint: 'This is usually temporary. Try again.',
        cause: error,
        retryable: true,
      });
    }
  }

  /**
   * GET with retry/backoff. Resolves only on a 2xx response.
   * @returns {Promise<Response>}
   */
  async get(url, options = {}) {
    const retries = options.retries ?? 2;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.#throttle(options.signal);
        const response = await this.#once(url, options);
        if (response.ok) return response;

        const error = this.#httpError(response, options.provider);
        // 429 and 5xx may succeed later; everything else is final.
        if (!error.retryable || attempt === retries) throw error;
        lastError = error;
        await delay(this.#backoff(attempt, response), options.signal);
      } catch (error) {
        // Anything already in our taxonomy carries its own retry policy - an
        // AuthError must never be retried, and must never be relabelled as a
        // network failure just because it surfaced from the same try block.
        if (error instanceof AppError) {
          if (!error.retryable || attempt === retries) throw error;
          lastError = error;
          await delay(this.#backoff(attempt), options.signal);
          continue;
        }
        const translated = translateTransportError(error, url, options.provider);
        if (!translated.retryable || attempt === retries) throw translated;
        lastError = translated;
        await delay(this.#backoff(attempt), options.signal);
      }
    }
    throw lastError ?? new NetworkError(`request to ${url} failed`);
  }

  async #once(url, options) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    this.#logger?.debug('http get', { url: redactUrl(url), provider: options.provider });
    return this.#fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: { accept: 'application/json', 'user-agent': this.#userAgent, ...options.headers },
    });
  }

  #httpError(response, provider) {
    const label = provider ?? 'provider';
    if (response.status === 429) {
      return new RateLimitError(`${label} rate limited (429)`, {
        context: { retryAfter: response.headers.get('retry-after') },
      });
    }
    if (response.status === 401 || response.status === 403) {
      return new AuthError(`${label} rejected our credentials (${response.status})`);
    }
    if (response.status >= 500) {
      return new ProviderError(`${label} server error (${response.status})`, {
        userMessage: 'The provider is having trouble right now',
        hint: 'Try again in a moment.',
        retryable: true,
      });
    }
    return new ProviderError(`${label} request failed (${response.status})`, {
      userMessage: `Provider request failed (${response.status})`,
    });
  }

  /** Exponential backoff with jitter, honouring `Retry-After` when present. */
  #backoff(attempt, response) {
    const header = Number(response?.headers?.get?.('retry-after'));
    if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 10000);
    const base = 400 * 2 ** attempt;
    return Math.min(base + Math.random() * 250, 6000);
  }

  async #throttle(signal) {
    if (!this.#minIntervalMs) return;
    const now = Date.now();
    if (now < this.#nextAllowedAt) await delay(this.#nextAllowedAt - now, signal);
    this.#nextAllowedAt = Date.now() + this.#minIntervalMs;
  }
}

function translateTransportError(error, url, provider) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    // A caller-supplied abort (new search typed) must stay an abort so the
    // UI can ignore it rather than showing an error toast.
    if (error.name === 'AbortError' && !String(error.message).includes('timed out')) return error;
    return new TimeoutError(`request to ${redactUrl(url)} timed out`, { cause: error });
  }
  const code = error?.cause?.code ?? error?.code;
  if (
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ENETUNREACH',
      'EHOSTUNREACH',
    ].includes(code)
  ) {
    return new NetworkError(`network failure contacting ${provider ?? 'provider'} (${code})`, {
      cause: error,
    });
  }
  return new NetworkError(`request to ${redactUrl(url)} failed: ${error?.message ?? error}`, {
    cause: error,
  });
}

/** Strip query values that may carry credentials before logging a URL. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['client_id', 'apikey', 'api_key', 'token', 'access_token']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, 'redacted');
    }
    return parsed.toString();
  } catch {
    return String(url);
  }
}
