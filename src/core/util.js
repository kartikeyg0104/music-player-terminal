/** Sleep that can be cancelled by an AbortSignal. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

/** Constrain a number to a range, rounding to an integer. */
export function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a float to a range. */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Trailing-edge debounce with `cancel()` and `flush()`.
 * Used by the search box so we never fire one request per keystroke.
 */
export function debounce(fn, waitMs) {
  let timer = null;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args_ = lastArgs;
      lastArgs = null;
      fn(...args_);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const args_ = lastArgs;
    lastArgs = null;
    fn(...args_);
  };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

/** Truncate to `width` columns, adding an ellipsis when it does not fit. */
export function truncate(text, width, ellipsis = '…') {
  const value = String(text ?? '');
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width <= ellipsis.length) return value.slice(0, width);
  return value.slice(0, width - ellipsis.length) + ellipsis;
}

/** Pad or truncate so the result is exactly `width` columns. */
export function fit(text, width) {
  return truncate(text, width).padEnd(width, ' ');
}

/** Deterministic Fisher-Yates using an injectable RNG (tests pass a seeded one). */
export function shuffleArray(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Small deterministic PRNG (xorshift32) so shuffle can be tested. */
export function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Case/diacritic-insensitive substring match for local filtering. */
export function matchesQuery(haystack, query) {
  if (!query) return true;
  return normaliseForSearch(haystack).includes(normaliseForSearch(query));
}

export function normaliseForSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Group an array by a key function. */
export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/** ISO string or epoch ms -> "3m ago". */
export function relativeTime(isoOrMs, now = Date.now()) {
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ts)) return 'unknown';
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Move an item inside an array, returning a new array. */
export function moveItem(items, from, to) {
  if (from === to) return [...items];
  if (from < 0 || from >= items.length) return [...items];
  const target = Math.min(items.length - 1, Math.max(0, to));
  const out = [...items];
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}
