import { useState, useEffect } from "react";
import type { CardSummary, CardRollupState } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { needsYouLabel, activeLabel } from "./pendingLabels";
import { useLongPress } from "../../hooks/useLongPress";
import { MessageSquare, Pin, Check } from "lucide-react";

interface CardTileProps {
  card: CardSummary;
  onClick: () => void;
  /** Every prop below is optional: with none passed the tile behaves exactly as it did before multi-select existed. */
  selectionMode?: boolean;
  selected?: boolean;
  /** False for tiles outside the selection's lifecycle scope — rendered inert and dimmed. */
  selectable?: boolean;
  /** Receives the event so the board can read shift/meta/ctrl for range and toggle. */
  onToggleSelect?: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
}

const ROLLUP_LABELS: Record<CardRollupState, string> = {
  needs_you: "Needs you",
  job_running: "Job running",
  active: "Active",
  idle: "Idle",
};

/** Rollup-state colors — themable via the --board-* section of index.css. */
export const ROLLUP_COLORS: Record<CardRollupState, string> = {
  needs_you: "var(--board-rollup-needs-you)",
  job_running: "var(--board-rollup-job-running)",
  active: "var(--board-rollup-active)",
  idle: "var(--board-rollup-idle)",
};

export default function CardTile({ card, onClick, selectionMode = false, selected = false, selectable = true, onToggleSelect, onLongPress }: CardTileProps) {
  const closed = card.lifecycle === "closed";
  const rollupColor = ROLLUP_COLORS[card.rollup];
  const live = card.rollup !== "idle" && !closed;
  const activeRun = card.memberRuns.find((r) => !r.endedAt);

  // Tick only while this tile actually has something counting down, so a board
  // of idle cards re-renders no more than it did before.
  const hasCountdown =
    !closed &&
    (card.memberChats.some((c) => c.activity?.expiresAt !== undefined) ||
      card.memberRuns.some((r) => r.nextWakeAt && (r.status === "sleeping" || r.status === "waiting_event")));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCountdown]);

  const [hovered, setHovered] = useState(false);
  const [checkboxFocused, setCheckboxFocused] = useState(false);

  const gestures = useLongPress({ onLongPress: () => onLongPress?.() });
  // Only mounted when the board asked for the gesture. Otherwise the
  // contextmenu handler's preventDefault would silently take the browser's own
  // menu away from a tile that has no selection behaviour to offer instead.
  const gestureProps = onLongPress ? gestures.handlers : {};

  const inert = selectionMode && !selectable;
  // Discoverability is the checkbox — Ctrl+click is invisible, and nobody
  // long-presses a surface that has never shown them it can be selected.
  const showCheckbox = Boolean(onToggleSelect) && selectable && (selectionMode || hovered || checkboxFocused);

  const handleClick = (e: React.MouseEvent) => {
    // A long press or a context menu has already acted on this gesture; the
    // click browsers emit afterwards must not act on it a second time.
    if (onLongPress && gestures.consumeClickSuppression()) return;
    const modified = e.metaKey || e.ctrlKey || e.shiftKey;
    if (selectionMode || (modified && onToggleSelect)) {
      onToggleSelect?.(e);
      return;
    }
    onClick();
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...gestureProps}
      style={{
        position: "relative",
        background: "var(--board-tile-bg)",
        border: `1px solid ${selected ? "var(--accent)" : live ? rollupColor : "var(--board-tile-border)"}`,
        borderRadius: 10,
        display: "flex",
        minWidth: 0,
        // A selected tile is never dimmed. An opacity dim composites the whole
        // tile, so the selection ring on a closed card would fade along with
        // the text under it and the weakest glyph would set the contrast floor.
        opacity: selected ? 1 : inert ? 0.35 : closed ? 0.65 : 1,
        boxShadow: selected ? "0 0 0 2px var(--accent)" : "var(--shadow-sm)",
        // Deliberately NOT `touch-action: none`: owning the gesture that way
        // breaks board scrolling and suppresses the pointercancel that tells
        // us a press became a scroll.
        userSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      {onToggleSelect && (
        // Always mounted, revealed by opacity rather than by mounting, so it
        // stays reachable by Tab — a checkbox that only appears on :hover is a
        // checkbox keyboard users never find. pointerEvents keeps the
        // invisible state from swallowing clicks aimed at the emoji.
        <button
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${card.title}`}
          onClick={onToggleSelect}
          // Out of tab order too, not merely invisible: a focusable button
          // still fires on Enter however transparent it is, which would let a
          // keyboard user select a card the mouse cannot reach.
          disabled={inert}
          onFocus={() => setCheckboxFocused(true)}
          onBlur={() => setCheckboxFocused(false)}
          style={{
            position: "absolute",
            top: 12,
            left: 14,
            zIndex: 1,
            width: 18,
            height: 18,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
            background: selected ? "var(--accent)" : "var(--board-tile-bg)",
            color: "var(--text-on-accent)",
            cursor: "pointer",
            opacity: showCheckbox ? 1 : 0,
            pointerEvents: showCheckbox ? "auto" : "none",
          }}
        >
          {/* A checkmark, not just a colour — colour alone is not a state. */}
          {selected && <Check size={12} strokeWidth={3} />}
        </button>
      )}

      <button
        onClick={handleClick}
        disabled={inert}
        aria-pressed={selectionMode ? selected : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "12px 14px",
          background: "transparent",
          border: "none",
          borderRadius: 10,
          textAlign: "left",
          font: "inherit",
          color: "inherit",
          cursor: inert ? "default" : "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {/* Fixed box so swapping the emoji for the checkbox shifts nothing. */}
          <span
            style={{
              fontSize: 16,
              flexShrink: 0,
              width: 18,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              visibility: showCheckbox ? "hidden" : "visible",
            }}
          >
            {card.emoji}
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--board-tile-title-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {card.title}
          </span>
          {card.pinned && <Pin size={12} style={{ color: "var(--accent-text)", flexShrink: 0 }} />}
          {card.unread && (
            <span title="Unread activity" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--board-unread-dot)", flexShrink: 0 }} />
          )}
        </div>

        {(card.status || card.statusEmoji) && (
          <div
            style={{
              fontSize: 12,
              color: "var(--board-tile-meta-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              width: "100%",
            }}
            title={card.status}
          >
            {card.statusEmoji ? `${card.statusEmoji} ` : ""}
            {card.status}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--board-tile-meta-text)", minWidth: 0, width: "100%" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: rollupColor, fontWeight: 600, flexShrink: 0 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: rollupColor,
                ...(live && { boxShadow: `0 0 5px ${rollupColor}` }),
              }}
            />
            {closed
              ? "Closed"
              : card.rollup === "needs_you"
                ? needsYouLabel(card)
                : card.rollup === "idle"
                  ? ROLLUP_LABELS.idle
                  : activeLabel(card, now)}
          </span>
          {activeRun && !closed && (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={activeRun.jobName}>
              {activeRun.jobName}
            </span>
          )}
          <span style={{ display: "flex", alignItems: "center", gap: 3, marginLeft: "auto", flexShrink: 0 }}>
            <MessageSquare size={11} />
            {card.chatCount}
          </span>
          <span style={{ flexShrink: 0 }}>{formatRelativeTime(card.lastActivityAt)}</span>
        </div>
      </button>
    </div>
  );
}
