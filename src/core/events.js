/**
 * Minimal synchronous event emitter.
 *
 * Deliberately not `node:events`: listeners here are React subscriptions, and
 * a thrown listener must never take down the emitting service (a crashing
 * render should not stop audio playback).
 */
export class Emitter {
  #listeners = new Map();

  /**
   * @param {string} event
   * @param {(payload?: any) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  /**
   * @param {string} event
   * @param {(payload?: any) => void} listener
   */
  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
  }

  /**
   * @param {string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const direct = this.#listeners.get(event);
    if (direct) {
      for (const listener of [...direct]) safeCall(listener, payload, event);
    }
    const wildcard = this.#listeners.get('*');
    if (wildcard) {
      for (const listener of [...wildcard]) safeCall(listener, { event, payload }, '*');
    }
  }

  removeAllListeners() {
    this.#listeners.clear();
  }
}

let onListenerError = null;

/** Install a reporter for listener exceptions (wired to the logger at boot). */
export function setListenerErrorHandler(handler) {
  onListenerError = handler;
}

function safeCall(listener, payload, event) {
  try {
    listener(payload);
  } catch (error) {
    onListenerError?.(error, event);
  }
}
