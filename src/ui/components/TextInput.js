import { useInput } from 'ink';
import { box, text, React } from '../h.js';

/**
 * Single-line text field with a visible caret.
 *
 * Written rather than pulled from a package so it can own the one rule that
 * matters for a keyboard-driven app: while it is focused it consumes *every*
 * printable key, so global shortcuts (space, n, q, /) cannot fire mid-word.
 * The parent stops rendering it focused and the shortcuts come back.
 */
/**
 * Drop C0/C7 control characters. Written as a code-point filter rather than a
 * regex so the source stays free of literal control characters.
 */
function stripControlChars(value) {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code >= 32 && code !== 127) out += char;
  }
  return out;
}

export function TextInput({
  theme,
  value,
  onChange,
  onSubmit,
  onCancel,
  focus = true,
  placeholder = '',
  width = 40,
}) {
  const c = theme.colors;
  const [cursor, setCursor] = React.useState(value.length);
  const [blink, setBlink] = React.useState(true);

  React.useEffect(() => {
    setCursor((prev) => Math.min(prev, value.length));
  }, [value]);

  React.useEffect(() => {
    if (!focus || !theme.animations) {
      setBlink(true);
      return undefined;
    }
    const timer = setInterval(() => setBlink((b) => !b), 500);
    return () => clearInterval(timer);
  }, [focus, theme.animations]);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.leftArrow) {
        setCursor((i) => Math.max(0, i - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((i) => Math.min(value.length, i + 1));
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        onChange('');
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'w') {
        const head = value.slice(0, cursor).replace(/\s*\S+\s*$/, '');
        onChange(head + value.slice(cursor));
        setCursor(head.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor((i) => Math.max(0, i - 1));
        return;
      }
      // Ignore control sequences and modified keys; accept real text only.
      if (key.ctrl || key.meta || key.tab || !input) return;
      const clean = stripControlChars(input);
      if (!clean) return;
      onChange(value.slice(0, cursor) + clean + value.slice(cursor));
      setCursor((i) => i + clean.length);
    },
    { isActive: focus },
  );

  const showPlaceholder = !value && placeholder;
  const display = showPlaceholder ? placeholder : value;
  // Keep the caret in view on a long query.
  const overflow = Math.max(0, display.length + 1 - width);
  const scroll = Math.min(overflow, Math.max(0, cursor - width + 2));
  const visible = display.slice(scroll, scroll + width);
  const caretAt = cursor - scroll;

  if (!focus) {
    return text(
      { color: showPlaceholder ? c.textFaint : c.text },
      visible.padEnd(width).slice(0, width),
    );
  }

  const before = visible.slice(0, caretAt);
  const at = visible.slice(caretAt, caretAt + 1) || ' ';
  const after = visible.slice(caretAt + 1);

  return box(
    { flexDirection: 'row' },
    text({ color: showPlaceholder ? c.textFaint : c.text }, before),
    text(
      showPlaceholder
        ? { color: c.textFaint }
        : blink
          ? { backgroundColor: c.accent, color: c.surface }
          : { color: c.text, underline: true },
      at,
    ),
    text({ color: showPlaceholder ? c.textFaint : c.text }, after),
    text(null, ' '.repeat(Math.max(0, width - visible.length - 1))),
  );
}
