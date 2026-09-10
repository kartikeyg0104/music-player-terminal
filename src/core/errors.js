/**
 * Centralised error taxonomy.
 *
 * Every layer throws `AppError` subclasses so the UI can render a friendly,
 * actionable message without caring where the failure came from. Raw errors
 * are never shown to the user; `toUserMessage()` is the single translation
 * point.
 */

export class AppError extends Error {
  /**
   * @param {string} message developer-facing message (goes to the log file)
   * @param {object} [options]
   * @param {string} [options.userMessage] short message rendered in the UI
   * @param {string} [options.hint] one-line recovery instruction
   * @param {unknown} [options.cause]
   * @param {Record<string, unknown>} [options.context]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.userMessage = options.userMessage ?? message;
    this.hint = options.hint ?? null;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? false;
  }
}

/** Provider replied, but with something we cannot use. */
export class ProviderError extends AppError {}

/** The network itself failed: DNS, offline, connection reset. */
export class NetworkError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      userMessage: 'Network unavailable',
      hint: 'Check your internet connection and try again.',
      retryable: true,
      ...options,
    });
  }
}

/** Request exceeded the configured timeout. */
export class TimeoutError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      userMessage: 'Request timed out',
      hint: 'The provider is slow or unreachable. Try again in a moment.',
      retryable: true,
      ...options,
    });
  }
}

/** HTTP 429 or a documented provider quota response. */
export class RateLimitError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      userMessage: 'Rate limited by the provider',
      hint: 'Too many requests. Termify will back off — try again shortly.',
      retryable: true,
      ...options,
    });
  }
}

/** Missing or rejected credentials. */
export class AuthError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      userMessage: 'Provider authentication failed',
      hint: 'Check the provider credentials in your .env file.',
      ...options,
    });
  }
}

/** Provider is present but not usable yet (e.g. no API key configured). */
export class NotConfiguredError extends AppError {}

/** The audio backend could not play something. */
export class PlaybackError extends AppError {}

/** Persistence-layer failure. */
export class StorageError extends AppError {}

/** User input failed validation. */
export class ValidationError extends AppError {}

/**
 * Turn anything throwable into `{ title, hint }` suitable for a toast.
 * @param {unknown} error
 * @returns {{ title: string, hint: string | null, retryable: boolean }}
 */
export function toUserMessage(error) {
  if (error instanceof AppError) {
    return { title: error.userMessage, hint: error.hint, retryable: error.retryable };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { title: 'Request cancelled', hint: null, retryable: true };
    }
    return { title: error.message || 'Unexpected error', hint: null, retryable: false };
  }
  return { title: 'Unexpected error', hint: null, retryable: false };
}
