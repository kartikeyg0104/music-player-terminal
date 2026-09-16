import { useInput } from 'ink';
import { box, text, h, React } from '../h.js';
import { TextInput } from './TextInput.js';

/**
 * Keyboard-accessible dialogs.
 *
 * Only one is mounted at a time and it takes input priority, so the keys
 * behind it can never fire. Escape always cancels; Enter always confirms the
 * focused choice.
 */

/** Shared chrome so every dialog looks the same. */
function Frame({ theme, title, tone = 'accent', width, children, hint }) {
  const c = theme.colors;
  const toneColor = { accent: c.accent, danger: c.danger, warning: c.warning }[tone] ?? c.accent;
  return box(
    {
      flexDirection: 'column',
      borderStyle: theme.unicode ? 'round' : 'classic',
      borderColor: toneColor,
      paddingX: 2,
      paddingY: 0,
      width,
    },
    text({ color: toneColor, bold: true }, title),
    box({ flexDirection: 'column', marginTop: 1 }, children),
    hint ? box({ marginTop: 1 }, text({ color: c.textFaint }, hint)) : null,
  );
}

/** Yes/no with a highlighted default. */
export function ConfirmModal({
  theme,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onCancel,
  width,
}) {
  const c = theme.colors;
  const [choice, setChoice] = React.useState(0); // 0 = confirm, 1 = cancel

  useInput((input, key) => {
    if (key.escape || input === 'q') return onCancel();
    if (key.leftArrow || key.rightArrow || key.tab) return setChoice((i) => (i + 1) % 2);
    if (input === 'y' || input === 'Y') return onConfirm();
    if (input === 'n' || input === 'N') return onCancel();
    if (key.return) return choice === 0 ? onConfirm() : onCancel();
    return undefined;
  });

  const button = (label, active, tone) =>
    text(
      active ? { backgroundColor: tone, color: c.surface, bold: true } : { color: c.textMuted },
      ` ${label} `,
    );

  return h(
    Frame,
    {
      theme,
      title,
      tone: danger ? 'danger' : 'accent',
      width,
      hint: 'y confirm  ·  n cancel  ·  esc dismiss',
    },
    text({ color: c.text }, message),
    box(
      { flexDirection: 'row', marginTop: 1 },
      button(confirmLabel, choice === 0, danger ? c.danger : c.accent),
      text(null, '  '),
      button('Cancel', choice === 1, c.textMuted),
    ),
  );
}

/** Single text field dialog: new playlist, rename, sleep timer minutes. */
export function PromptModal({
  theme,
  title,
  message,
  initialValue = '',
  placeholder,
  onSubmit,
  onCancel,
  width,
  validate,
}) {
  const c = theme.colors;
  const [value, setValue] = React.useState(initialValue);
  const error = validate ? validate(value) : null;

  return h(
    Frame,
    { theme, title, width, hint: 'enter confirm  ·  esc cancel' },
    message ? text({ color: c.textMuted }, message) : null,
    box(
      {
        flexDirection: 'row',
        marginTop: message ? 1 : 0,
        borderStyle: theme.unicode ? 'single' : 'classic',
        borderColor: error ? c.danger : c.line,
        paddingX: 1,
      },
      h(TextInput, {
        theme,
        value,
        onChange: setValue,
        placeholder,
        width: Math.max(10, (width ?? 50) - 8),
        onSubmit: () => {
          if (!error) onSubmit(value);
        },
        onCancel,
      }),
    ),
    error ? text({ color: c.danger }, error) : null,
  );
}

/** Pick one option from a list. */
export function SelectModal({ theme, title, message, options, onSelect, onCancel, width }) {
  const c = theme.colors;
  const [index, setIndex] = React.useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'q') return onCancel();
    if (key.upArrow || input === 'k') return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow || input === 'j') return setIndex((i) => Math.min(options.length - 1, i + 1));
    if (key.return) return onSelect(options[index]);
    const numeric = Number.parseInt(input, 10);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= options.length) {
      return onSelect(options[numeric - 1]);
    }
    return undefined;
  });

  return h(
    Frame,
    { theme, title, width, hint: 'up/down move  ·  enter choose  ·  esc cancel' },
    message ? text({ color: c.textMuted }, message) : null,
    box(
      { flexDirection: 'column', marginTop: message ? 1 : 0 },
      ...options
        .slice(0, 12)
        .map((option, i) =>
          box(
            { key: option.value ?? i, flexDirection: 'row' },
            text(
              { color: i === index ? c.accent : c.textFaint },
              i === index ? `${theme.glyphs.chevron} ` : '  ',
            ),
            text({ color: i === index ? c.textStrong : c.text, bold: i === index }, option.label),
            option.hint ? text({ color: c.textFaint }, `  ${option.hint}`) : null,
          ),
        ),
      options.length > 12 ? text({ color: c.textFaint }, `  +${options.length - 12} more`) : null,
    ),
  );
}

/**
 * Centres a dialog inside the content region.
 *
 * Modals take over the main panel rather than floating above it: overlaying
 * absolutely-positioned boxes over live text is where TUIs pick up redraw
 * artefacts. The header, navigation and Now Playing bar stay visible, so you
 * never lose your place or your playback controls.
 */
export function ModalLayer({ children, width, height }) {
  return box(
    { width, height, justifyContent: 'center', alignItems: 'center', flexDirection: 'column' },
    children,
  );
}
