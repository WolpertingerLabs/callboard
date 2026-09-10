import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface SelectionAction {
  key: string;
  label: string;
  onRun: () => void;
  /** Renders in the danger colour — for an action with no inverse gesture. */
  danger?: boolean;
}

interface SelectionBarProps {
  count: number;
  /** Noun for the count, singularised at 1 by the caller's data, not here. */
  noun?: string;
  /** Optional secondary control, used on mobile where the Ctrl/Cmd+A shortcut is unavailable. */
  onSelectAll?: () => void;
  allSelected?: boolean;
  actions: SelectionAction[];
  onCancel: () => void;
  busy?: boolean;
  /**
   * How the bar attaches to the bottom of its surface.
   *
   * `fixed` is the board's: it owns the whole viewport, so pinning to the
   * viewport IS pinning to the board. `absolute` is for a surface that owns a
   * column of it — the sidebar chat list — where a viewport-spanning bar would
   * lie across the chat pane beside it. The caller supplies the positioned
   * ancestor; on mobile that column is the whole screen, so the same
   * `absolute` bar reads as a bottom action bar there without a second branch.
   */
  position?: "fixed" | "absolute";
  /**
   * The bar's rendered height in px, reported on mount and on every resize.
   *
   * A surface that has to keep its last row clear of the bar needs the bar's
   * height, and the bar is the only thing that knows it: the labels are the
   * caller's words, the button row wraps, and a label can wrap *inside* a
   * button when the row does not. So it is measured rather than assumed —
   * a constant is only ever right at the width it was written at.
   *
   * Never fires with 0. A layout-less environment (jsdom) reports 0 for every
   * element, and a caller that took that as "the bar needs no room" would
   * silently lose its clearance; leaving its own fallback in place is the safe
   * failure.
   */
  onMeasure?: (height: number) => void;
}

/**
 * The bar that appears while a multi-select gesture is live.
 *
 * Generic in its actions since it was written, and now generic in its surface
 * too: the board wires archive-or-unarchive, the chat list wires that plus a
 * delete. That the *board* offers exactly one verb is a property of the board's
 * selection being scoped to one lifecycle — the bar never asks a user to work
 * out what "Archive 3 / Unarchive 2" would do to their five selected rows.
 *
 * Nothing here knows what is selected. `count` and every action label are the
 * caller's words, which is what lets the chat list say "Archive 2 cards" over a
 * count of 5 chats — see the note on `bulkActions` in ChatList.
 */
export default function SelectionBar({
  count,
  noun = "selected",
  onSelectAll,
  allSelected = false,
  actions,
  onCancel,
  busy = false,
  position = "fixed",
  onMeasure,
}: SelectionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  // What the bar SAYS, as a dependency. The labels carry the counts, so a
  // changed selection can change the bar's height without resizing anything
  // the observer watches — but depending on the `actions` array itself would
  // re-measure on every render of the caller (a fresh array literal each
  // time), forcing a layout flush on every 15s poll for nothing.
  const wording = `${count}|${noun}|${onSelectAll ? "all" : ""}|${actions.map((a) => a.label).join("|")}`;

  // Re-measured on every resize, not only on mount: the sidebar is
  // user-resizable, and dragging it narrower is exactly what makes a label
  // wrap and the bar grow.
  useEffect(() => {
    const el = barRef.current;
    if (!el || !onMeasure) return;
    const report = () => {
      const height = el.offsetHeight;
      if (height > 0) onMeasure(height);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onMeasure, wording]);

  return (
    <div
      ref={barRef}
      style={{
        position,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        flexWrap: onSelectAll ? "wrap" : "nowrap",
        gap: 12,
        padding: "12px 16px",
        background: "var(--surface)",
        borderTop: "1px solid var(--border)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      {/* Announced, because the count changing is the only feedback a screen
          reader gets from a tap that toggles rather than navigates. */}
      <span aria-live="polite" style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>
        {count} {noun}
      </span>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        {onSelectAll && (
          <button
            onClick={onSelectAll}
            disabled={busy || allSelected}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text)",
              padding: "7px 12px",
              borderRadius: 6,
              fontSize: 13,
              cursor: busy || allSelected ? "default" : "pointer",
              opacity: busy || allSelected ? 0.6 : 1,
            }}
          >
            Select all
          </button>
        )}
        <button
          onClick={onCancel}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text)",
            padding: "7px 12px",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          <X size={13} />
          Cancel
        </button>
        {actions.map((action) => (
          <button
            key={action.key}
            onClick={action.onRun}
            disabled={busy || count === 0}
            style={{
              // The FILL tokens, not the ink ones: --danger is the colour of an
              // error message and is kept light enough to read on --danger-bg,
              // which is too light to carry white text as a button. See the
              // note above --danger-solid in index.css.
              background: action.danger ? "var(--danger-solid)" : "var(--accent)",
              color: action.danger ? "var(--text-on-danger)" : "var(--text-on-accent)",
              border: "none",
              padding: "7px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy || count === 0 ? "default" : "pointer",
              opacity: busy || count === 0 ? 0.6 : 1,
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
