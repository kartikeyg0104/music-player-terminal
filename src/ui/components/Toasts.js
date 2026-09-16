import { box, text, React } from '../h.js';

/**
 * Transient notifications.
 *
 * Toasts stack newest-last, auto-dismiss on a timer scaled to severity
 * (errors linger), and are capped so a burst of failures cannot push the
 * layout around.
 */
const MAX_VISIBLE = 3;
const LIFETIMES = { success: 2600, info: 3000, warn: 4200, error: 6000 };

export function useToasts() {
  const [toasts, setToasts] = React.useState([]);
  const nextId = React.useRef(0);
  const timers = React.useRef(new Map());

  const dismiss = React.useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = React.useCallback(
    (toast) => {
      const id = ++nextId.current;
      const level = toast.level ?? 'info';
      const entry = { id, level, title: toast.title, hint: toast.hint ?? null };
      setToasts((list) => [...list, entry].slice(-MAX_VISIBLE));
      const timer = setTimeout(() => dismiss(id), LIFETIMES[level] ?? 3000);
      timer.unref?.();
      timers.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const helpers = React.useMemo(
    () => ({
      push,
      dismiss,
      success: (title, hint) => push({ level: 'success', title, hint }),
      info: (title, hint) => push({ level: 'info', title, hint }),
      warn: (title, hint) => push({ level: 'warn', title, hint }),
      error: (title, hint) => push({ level: 'error', title, hint }),
      clear: () => setToasts([]),
    }),
    [push, dismiss],
  );

  return [toasts, helpers];
}

export function ToastStack({ theme, toasts, width }) {
  const c = theme.colors;
  const g = theme.glyphs;
  if (!toasts.length) return null;
  const tones = {
    success: { color: c.success, icon: g.check },
    info: { color: c.info, icon: g.info },
    warn: { color: c.warning, icon: g.warn },
    error: { color: c.danger, icon: g.cross },
  };

  return box(
    { flexDirection: 'column', width },
    ...toasts.map((toast) => {
      const tone = tones[toast.level] ?? tones.info;
      return box(
        { key: toast.id, flexDirection: 'row' },
        text({ color: tone.color, bold: true }, ` ${tone.icon} `),
        text({ color: c.text }, toast.title),
        toast.hint ? text({ color: c.textFaint }, `  ${g.dot} ${toast.hint}`) : null,
      );
    }),
  );
}
