import { X } from "lucide-react";

export interface SelectionAction {
  key: string;
  label: string;
  onRun: () => void;
}

interface BoardSelectionBarProps {
  count: number;
  /** Noun for the count, singularised at 1 by the caller's data, not here. */
  noun?: string;
  /** Optional secondary control, used on mobile where the Ctrl/Cmd+A shortcut is unavailable. */
  onSelectAll?: () => void;
  allSelected?: boolean;
  actions: SelectionAction[];
  onCancel: () => void;
  busy?: boolean;
}

/**
 * The bar that appears while a multi-select gesture is live.
 *
 * Generic in its actions so a later "archive" or "recategorise" needs no
 * change here, though today the board wires exactly one: close, or reopen.
 * That singularity is the point — selection is scoped to one lifecycle, so
 * the bar always offers one unambiguous verb rather than asking the user to
 * work out what "Close 3 / Reopen 2" would do to their five selected cards.
 */
export default function BoardSelectionBar({
  count,
  noun = "selected",
  onSelectAll,
  allSelected = false,
  actions,
  onCancel,
  busy = false,
}: BoardSelectionBarProps) {
  return (
    <div
      style={{
        position: "fixed",
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
              background: "var(--accent)",
              color: "var(--text-on-accent)",
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
