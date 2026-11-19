/**
 * The small floating bar shown over a text selection in a message bubble —
 * Quote, Ask, and whatever further actions the page passes.
 *
 * Portaled to `<body>` and positioned `fixed` from the selection's viewport
 * rect, so it never shifts the transcript's layout or the bubbles' memo. It
 * sits above the selection with a mouse, and below it on a touch screen,
 * where the platform's own copy / select-all callout takes the space above.
 *
 * Its buttons prevent `mousedown`, which would otherwise collapse the
 * selection before the click; the root carries {@link SELECTION_TOOLBAR_ATTR}
 * so `useMessageTextSelection` holds the selection through a tap on touch.
 *
 * Keyboard: being portaled to the end of `<body>` puts it out of any sensible
 * Tab order, so it is reached by shortcut instead. Each action may carry an
 * Alt+letter shortcut that works while the bar is up, {@link FOCUS_SHORTCUT}
 * moves focus into the bar (the usual "go to toolbar" key), and inside it the
 * arrow keys, Home and End move between buttons (one tab stop, roving).
 * Alt+letter rather than Ctrl/Cmd+Shift+letter: Ctrl+Shift+Q quits Chrome on
 * Windows and Linux, and Cmd+Shift+Q logs out of macOS. See
 * {@link matchesShortcutLetter} for how the letter is recognised. Focus taken
 * by Alt+F10 goes back where it came from when the bar closes, unless the
 * action moved it on (Ask puts it in the composer).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SELECTION_TOOLBAR_ATTR, type SelectionRect } from "../hooks/useMessageTextSelection";

export interface SelectionToolbarAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Tooltip; defaults to the label (plus the shortcut, if any). */
  title?: string;
  /** Alt + this letter runs the action while the bar is shown — `"Q"` for Alt+Q. */
  shortcutKey?: string;
  onSelect: () => void;
}

interface Props {
  rect: SelectionRect;
  actions: readonly SelectionToolbarAction[];
}

/** Moves keyboard focus into the bar. */
export const FOCUS_SHORTCUT = { code: "F10", label: "Alt+F10" };

const GAP = 8;
/** Below a touch selection, clear of the platform's drag handles. */
const TOUCH_GAP = 28;
/** Keep the bar's centre this far from the viewport's sides — about half its width. */
const EDGE = 72;

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export const shortcutLabel = (letter: string) => `Alt+${letter.toUpperCase()}`;

/**
 * Whether a key event is the given letter. By the character the layout
 * produced when that is a plain ASCII letter — so Alt+Q is the key labelled Q
 * on AZERTY too, where it sits at QWERTY's A — and by the physical key only
 * when it is not: macOS Option+letter types a symbol (Option+Q is `œ`).
 */
export function matchesShortcutLetter(e: Pick<KeyboardEvent, "key" | "code">, letter: string): boolean {
  const wanted = letter.toUpperCase();
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase() === wanted;
  return e.code === `Key${wanted}`;
}

export default function SelectionQuoteToolbar({ rect, actions }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  /** Where focus was when Alt+F10 took it into the bar. */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Closing (Quote, Escape, the selection going) removes the focused button
  // and drops focus on <body>; put it back. Not when an action moved it on.
  useEffect(
    () => () => {
      const back = returnFocusRef.current;
      const now = document.activeElement;
      if (back?.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isEditable(e.target)) return;
      if (e.code === FOCUS_SHORTCUT.code) {
        e.preventDefault();
        const root = rootRef.current;
        const from = document.activeElement;
        if (from instanceof HTMLElement && from !== document.body && !root?.contains(from)) returnFocusRef.current = from;
        root?.querySelectorAll("button")[0]?.focus();
        setActive(0);
        return;
      }
      const action = actionsRef.current.find((a) => a.shortcutKey && matchesShortcutLetter(e, a.shortcutKey));
      if (!action) return;
      e.preventDefault();
      action.onSelect();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const move = (to: number) => {
    const buttons = rootRef.current?.querySelectorAll("button");
    if (!buttons || buttons.length === 0) return;
    const next = (to + buttons.length) % buttons.length;
    setActive(next);
    buttons[next].focus();
  };

  const touch = isCoarsePointer();
  const below = touch || rect.top < 56;
  const width = window.innerWidth || 0;
  const centre = (rect.left + rect.right) / 2;
  const left = width > EDGE * 2 ? Math.min(Math.max(centre, EDGE), width - EDGE) : centre;
  const top = below ? rect.bottom + (touch ? TOUCH_GAP : GAP) : rect.top - GAP;
  const current = Math.min(active, actions.length - 1);

  return createPortal(
    <div
      ref={rootRef}
      {...{ [SELECTION_TOOLBAR_ATTR]: "" }}
      role="toolbar"
      aria-label="Selected text"
      aria-orientation="horizontal"
      aria-keyshortcuts={FOCUS_SHORTCUT.label}
      style={{
        position: "fixed",
        top,
        left,
        transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
        zIndex: 1000,
        display: "flex",
        gap: 2,
        padding: 3,
        background: "var(--bg-popout)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "var(--shadow-md)",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      // Keep the selection: a mousedown here would collapse it.
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") move(current + 1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(current - 1);
        else if (e.key === "Home") move(0);
        else if (e.key === "End") move(actions.length - 1);
        else return;
        e.preventDefault();
      }}
    >
      {actions.map((action, i) => {
        const shortcut = action.shortcutKey ? shortcutLabel(action.shortcutKey) : undefined;
        return (
          <button
            key={action.key}
            type="button"
            tabIndex={i === current ? 0 : -1}
            title={`${action.title ?? action.label}${shortcut ? ` (${shortcut})` : ""}`}
            aria-keyshortcuts={shortcut}
            onClick={action.onSelect}
            onFocus={() => setActive(i)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 9px",
              minHeight: 30,
              fontSize: 13,
              color: "var(--text)",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {action.icon}
            {action.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
