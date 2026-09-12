import { MpvAdapter } from './mpvAdapter.js';
import { FfplayAdapter } from './ffplayAdapter.js';
import { AfplayAdapter } from './afplayAdapter.js';
import { NullAdapter } from './nullAdapter.js';

/**
 * Backends in preference order.
 *
 * mpv first (true pause, live volume, no re-buffer), then ffplay (streams
 * anything FFmpeg can open), then afplay (local files only, macOS), then the
 * silent adapter so the app still starts on a machine with no audio tooling.
 */
export const ADAPTERS = [MpvAdapter, FfplayAdapter, AfplayAdapter, NullAdapter];

/** Which backends exist on this machine right now. */
export function detectAdapters() {
  return ADAPTERS.map((Adapter) => ({
    id: Adapter.id,
    label: Adapter.label,
    available: Adapter.isAvailable(),
  }));
}

/**
 * Build the adapter to use.
 * @param {{ preferred?: string, logger?: any }} [options]
 * @returns {{ adapter: import('./base.js').AudioAdapter, fallbackReason: string|null }}
 */
export function createAdapter({ preferred = 'auto', logger } = {}) {
  if (preferred && preferred !== 'auto') {
    const Requested = ADAPTERS.find((a) => a.id === preferred);
    if (Requested && Requested.isAvailable()) {
      return { adapter: new Requested({ logger }), fallbackReason: null };
    }
    const chosen = firstAvailable();
    return {
      adapter: new chosen({ logger }),
      fallbackReason: Requested
        ? `${Requested.label} is not installed on this machine`
        : `unknown backend "${preferred}"`,
    };
  }
  const chosen = firstAvailable();
  return { adapter: new chosen({ logger }), fallbackReason: null };
}

function firstAvailable() {
  return ADAPTERS.find((Adapter) => Adapter.isAvailable()) ?? NullAdapter;
}

export { MpvAdapter, FfplayAdapter, AfplayAdapter, NullAdapter };
