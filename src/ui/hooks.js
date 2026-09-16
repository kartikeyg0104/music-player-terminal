import { React } from './h.js';

/**
 * Bridges the service layer (plain emitters) into React.
 *
 * Services stay framework-free; these hooks are the only place that knows
 * about both worlds.
 */

/**
 * Subscribe to an emitter's 'change' event and re-render with a fresh
 * snapshot. `read` must return a value that changes identity when the data
 * changes, which every service snapshot does.
 */
export function useServiceState(emitter, read, deps = []) {
  const [state, setState] = React.useState(() => read());
  React.useEffect(() => {
    setState(read());
    if (!emitter?.on) return undefined;
    return emitter.on('change', () => setState(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emitter, ...deps]);
  return state;
}

/** Re-read a value whenever `emitter` changes, or when `token` changes. */
export function useDerived(emitter, compute, token) {
  const [value, setValue] = React.useState(() => compute());
  React.useEffect(() => {
    setValue(compute());
    if (!emitter?.on) return undefined;
    return emitter.on('change', () => setValue(compute()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emitter, token]);
  return value;
}

/**
 * List cursor with clamping, paging and wrap-free bounds.
 * Returns helpers rather than raw setState so every view moves identically.
 */
export function useListCursor(length, { pageSize = 10 } = {}) {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    setIndex((i) => Math.max(0, Math.min(i, Math.max(0, length - 1))));
  }, [length]);

  const move = React.useCallback(
    (delta) => setIndex((i) => Math.max(0, Math.min(length - 1, i + delta))),
    [length],
  );

  return {
    index: Math.max(0, Math.min(index, Math.max(0, length - 1))),
    setIndex: (value) => setIndex(Math.max(0, Math.min(length - 1, value))),
    up: () => move(-1),
    down: () => move(1),
    pageUp: () => move(-pageSize),
    pageDown: () => move(pageSize),
    home: () => setIndex(0),
    end: () => setIndex(Math.max(0, length - 1)),
  };
}

/**
 * A ticking clock for time-dependent UI (sleep timer countdown, relative
 * timestamps). Pauses entirely when `active` is false so an idle Termify
 * does no work.
 */
export function useTicker(intervalMs = 1000, active = true) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return tick;
}

/**
 * Debounced value. The search box uses this so typing never fires one request
 * per keystroke; `delay: 0` disables debouncing entirely.
 */
export function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Latest-value ref, for callbacks registered once but reading fresh state. */
export function useLatest(value) {
  const ref = React.useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Best-effort connectivity signal.
 *
 * There is no reliable "is the internet up" check that does not cost a
 * request, so this reflects what actually happened: it starts optimistic and
 * flips when a provider call fails with a network error, then flips back on
 * the next success.
 */
export function useConnectionStatus(searchService) {
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    if (!searchService?.on) return undefined;
    return searchService.on('change', (state) => {
      if (state.status === 'error') {
        const title = state.error?.title ?? '';
        if (/network|timed out|unreachable/i.test(title)) setOnline(false);
      } else if (state.status === 'ready' || state.status === 'empty') {
        setOnline(true);
      }
    });
  }, [searchService]);
  return { online };
}
