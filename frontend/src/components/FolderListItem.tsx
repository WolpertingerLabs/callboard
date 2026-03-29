import { useMemo } from "react";
import { GitBranch, Plus, Zap, Clock, Bell } from "lucide-react";
import type { FolderSummary } from "../api";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

interface Props {
  folder: FolderSummary;
  isActive?: boolean;
  onClick: () => void;
  onNewChat: () => void;
  /** Current time in ms, passed from parent to avoid impure render calls */
  now: number;
}

function formatRelativeTime(isoDate: string, now: number): string {
  const diff = now - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function FolderListItem({ folder, isActive, onClick, onNewChat, now }: Props) {
  const isStale = useMemo(() => now - new Date(folder.lastUpdatedAt).getTime() > TWELVE_HOURS_MS, [now, folder.lastUpdatedAt]);
  const newChatDisabled = folder.status === "ongoing";

  return (
    <div
      onClick={onClick}
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        borderLeft: isActive ? "3px solid var(--chatlist-item-active-border)" : "3px solid transparent",
        opacity: isStale ? 0.5 : 1,
        transition: "opacity 0.2s",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Row 1: Status dot + folder name + triggered/cron icon */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {folder.status === "ongoing" && (
            <span
              title="Running"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--status-green, #22c55e)",
                flexShrink: 0,
                boxShadow: "0 0 4px var(--status-green, #22c55e)",
              }}
            />
          )}
          {folder.status === "waiting" && (
            <span
              title="Waiting for input"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--warning, #f59e0b)",
                flexShrink: 0,
              }}
            />
          )}
          {folder.isTriggered && (
            <span
              title={folder.triggeredBy === "cron" ? "Cron job" : "Triggered"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-triggered-bg)",
                color: "var(--chatlist-badge-triggered-text)",
                flexShrink: 0,
              }}
            >
              {folder.triggeredBy === "cron" ? <Clock size={10} /> : <Zap size={10} />}
            </span>
          )}
          {folder.hasSummon && (
            <span
              title="Attention needed"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-summon-bg)",
                color: "var(--chatlist-summon-text)",
                flexShrink: 0,
                animation: "pulse 2s ease-in-out infinite",
              }}
            >
              <Bell size={10} />
            </span>
          )}
          {folder.chatStatus && (
            <span
              title={folder.chatStatus}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 500,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-status-bg)",
                color: "var(--chatlist-badge-status-text)",
                flexShrink: 0,
                maxWidth: 140,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {folder.chatStatusEmoji && <span>{folder.chatStatusEmoji}</span>}
              {folder.chatStatus}
            </span>
          )}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--chatlist-item-title-text)",
            }}
          >
            {folder.displayName}
          </div>
        </div>

        {/* Row 2: Full path */}
        <div
          title={folder.folder}
          style={{
            fontSize: 12,
            color: "var(--chatlist-item-path-text)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            textAlign: "left",
          }}
        >
          {folder.folder}
        </div>

        {/* Row 3: Timestamps + branch + chat count */}
        <div style={{ fontSize: 11, color: "var(--chatlist-item-time-text)", marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span title={`Created: ${new Date(folder.mostRecentChatCreatedAt).toLocaleString()}`}>
            Created {formatRelativeTime(folder.mostRecentChatCreatedAt, now)}
          </span>
          <span style={{ opacity: 0.5 }}>&middot;</span>
          <span title={`Updated: ${new Date(folder.lastUpdatedAt).toLocaleString()}`}>Updated {formatRelativeTime(folder.lastUpdatedAt, now)}</span>
          {folder.isGitRepo && folder.gitBranch && (
            <span
              title={`Branch: ${folder.gitBranch}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-item-time-text)",
                maxWidth: 140,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <GitBranch size={10} style={{ flexShrink: 0 }} />
              {folder.gitBranch}
            </span>
          )}
          <span style={{ opacity: 0.5 }}>({folder.chatCount})</span>
        </div>
      </div>

      {/* New chat button */}
      <div style={{ marginLeft: 8, flexShrink: 0 }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!newChatDisabled) onNewChat();
          }}
          disabled={newChatDisabled}
          title={newChatDisabled ? "Chat in progress" : "New chat in this folder"}
          style={{
            background: newChatDisabled ? "var(--bg-secondary)" : "var(--accent)",
            color: newChatDisabled ? "var(--text-muted)" : "var(--text-on-accent)",
            padding: "6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: newChatDisabled ? "not-allowed" : "pointer",
            opacity: newChatDisabled ? 0.4 : 1,
            border: "none",
          }}
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
