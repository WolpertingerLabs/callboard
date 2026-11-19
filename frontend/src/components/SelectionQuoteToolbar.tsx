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
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { SELECTION_TOOLBAR_ATTR, type SelectionRect } from "../hooks/useMessageTextSelection";

export interface SelectionToolbarAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Tooltip; defaults to the label. */
  title?: string;
  onSelect: () => void;
}

interface Props {
  rect: SelectionRect;
  actions: readonly SelectionToolbarAction[];
}

const GAP = 8;
/** Below a touch selection, clear of the platform's drag handles. */
const TOUCH_GAP = 28;
/** Keep the bar's centre this far from the viewport's sides — about half its width. */
const EDGE = 72;

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export default function SelectionQuoteToolbar({ rect, actions }: Props) {
  const touch = isCoarsePointer();
  const below = touch || rect.top < 56;
  const width = window.innerWidth || 0;
  const centre = (rect.left + rect.right) / 2;
  const left = width > EDGE * 2 ? Math.min(Math.max(centre, EDGE), width - EDGE) : centre;
  const top = below ? rect.bottom + (touch ? TOUCH_GAP : GAP) : rect.top - GAP;

  return createPortal(
    <div
      {...{ [SELECTION_TOOLBAR_ATTR]: "" }}
      role="toolbar"
      aria-label="Selected text"
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
    >
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          title={action.title ?? action.label}
          onClick={action.onSelect}
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
      ))}
    </div>,
    document.body,
  );
}
