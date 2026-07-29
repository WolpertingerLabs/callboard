import type { CardSummary, CardRollupState } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { needsYouLabel } from "./pendingLabels";
import { MessageSquare, Pin } from "lucide-react";

interface CardTileProps {
  card: CardSummary;
  onClick: () => void;
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

export default function CardTile({ card, onClick }: CardTileProps) {
  const closed = card.lifecycle === "closed";
  const rollupColor = ROLLUP_COLORS[card.rollup];
  const live = card.rollup !== "idle" && !closed;
  const activeRun = card.memberRuns.find((r) => !r.endedAt);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      style={{
        background: "var(--board-tile-bg)",
        border: `1px solid ${live ? rollupColor : "var(--board-tile-border)"}`,
        borderRadius: 10,
        padding: "12px 14px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        opacity: closed ? 0.65 : 1,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>{card.emoji}</span>
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
          }}
          title={card.status}
        >
          {card.statusEmoji ? `${card.statusEmoji} ` : ""}
          {card.status}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--board-tile-meta-text)", minWidth: 0 }}>
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
          {closed ? "Closed" : card.rollup === "needs_you" ? needsYouLabel(card) : ROLLUP_LABELS[card.rollup]}
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
    </div>
  );
}
