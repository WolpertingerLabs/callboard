import { useState } from "react";
import { Globe, Monitor, X, Bookmark, Bot, Zap, GitBranch, Bell, Workflow } from "lucide-react";
import type { Chat } from "../api";
import { dismissSummon } from "../api";
import ProviderBadge from "./ProviderBadge";
import FolderPathPill from "./FolderPathPill";

interface Props {
  chat: Chat;
  isActive?: boolean;
  onClick: () => void;
  onDelete: () => void;
  onToggleBookmark?: (bookmarked: boolean) => void;
  sessionStatus?: { active: boolean; type: string };
}

export default function ChatListItem({ chat, isActive, onClick, onDelete, onToggleBookmark, sessionStatus }: Props) {
  const [hovered, setHovered] = useState(false);
  const displayPath = chat.displayFolder || chat.folder;
  const folderName = displayPath?.split("/").pop() || displayPath || "Chat";
  const time = new Date(chat.updated_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let title: string | undefined;
  let preview: string | undefined;
  let isBookmarked = false;
  let agentAlias: string | undefined;
  let isTriggered = false;
  let lastReadAt: string | undefined;
  let chatStatus: string | undefined;
  let chatStatusEmoji: string | undefined;
  let summon: { message: string; urgency: string; createdAt: string } | undefined;
  let provider: string | undefined;
  let jobRunId: string | undefined;
  let jobStepId: string | undefined;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    title = meta.title;
    preview = meta.preview;
    isBookmarked = meta.bookmarked === true;
    agentAlias = meta.agentAlias;
    isTriggered = meta.triggered === true;
    lastReadAt = meta.lastReadAt;
    chatStatus = meta.chatStatus || undefined;
    chatStatusEmoji = meta.chatStatusEmoji || undefined;
    summon = meta.summon || undefined;
    provider = meta.provider || undefined;
    jobRunId = meta.jobRunId || undefined;
    jobStepId = meta.jobStepId || undefined;
  } catch {}

  const hasUnread = lastReadAt ? new Date(chat.updated_at) > new Date(lastReadAt) : false;

  const displayName = title || (preview ? (preview.length > 60 ? preview.slice(0, 60) + "..." : preview) : folderName);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        borderLeft: isActive ? "3px solid var(--chatlist-item-active-border)" : "3px solid transparent",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            flexWrap: "nowrap",
            fontSize: 11,
            color: "var(--chatlist-item-time-text)",
          }}
        >
          {time}
          {chat.git_branch && (
            <span
              title={chat.folder !== chat.displayFolder ? `Worktree: ${chat.git_branch}` : `Branch: ${chat.git_branch}`}
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
                minWidth: 0,
                flexShrink: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <GitBranch size={10} style={{ flexShrink: 0 }} />
              {chat.git_branch}
            </span>
          )}
          {displayPath && <FolderPathPill path={displayPath} />}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          {isBookmarked && <Bookmark size={14} style={{ color: "var(--chatlist-bookmark-icon)", flexShrink: 0 }} fill="var(--chatlist-bookmark-icon)" />}
          {agentAlias && (
            <span
              title={`Agent: ${agentAlias}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-badge-agent-text)",
                flexShrink: 0,
              }}
            >
              <Bot size={10} style={{ color: "var(--chatlist-badge-agent-text)" }} />
              {agentAlias}
            </span>
          )}
          {jobRunId && (
            <span
              title={`Job step${jobStepId ? `: ${jobStepId}` : ""} (run ${jobRunId})`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-badge-agent-text)",
                flexShrink: 0,
              }}
            >
              <Workflow size={10} style={{ color: "var(--chatlist-badge-agent-text)" }} />
              {jobStepId || "job"}
            </span>
          )}
          {isTriggered && !jobRunId && (
            <span
              title="Triggered (automated)"
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
              <Zap size={10} style={{ color: "var(--chatlist-badge-triggered-text)" }} />
            </span>
          )}
          <ProviderBadge provider={provider} compact />
          {summon && (
            <span
              title={`Summon: ${summon.message}`}
              onClick={(e) => {
                e.stopPropagation();
                dismissSummon(chat.id).catch(() => {});
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: summon.urgency === "urgent" ? "var(--chatlist-summon-urgent-bg)" : "var(--chatlist-summon-bg)",
                color: summon.urgency === "urgent" ? "var(--chatlist-summon-urgent-text)" : "var(--chatlist-summon-text)",
                flexShrink: 0,
                cursor: "pointer",
                animation: summon.urgency === "urgent" ? "pulse 2s ease-in-out infinite" : undefined,
              }}
            >
              <Bell size={10} />
              {summon.message.length > 30 ? summon.message.slice(0, 30) + "..." : summon.message}
            </span>
          )}
          {hasUnread && (
            <span
              title="Unread messages"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--chatlist-unread-dot)",
                flexShrink: 0,
              }}
            />
          )}
          <div
            style={{
              fontSize: 14,
              fontWeight: hasUnread ? 600 : 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--chatlist-item-title-text)",
            }}
          >
            {displayName}
          </div>
          {sessionStatus?.active && (
            <div
              style={{
                fontSize: 10,
                padding: "1px 4px",
                borderRadius: 3,
                background: sessionStatus.type === "web" ? "var(--chatlist-badge-session-web-bg)" : "var(--chatlist-badge-session-cli-bg)",
                color: "var(--chatlist-badge-session-text)",
                fontWeight: 500,
              }}
            >
              {sessionStatus.type === "web" ? <Globe size={10} /> : <Monitor size={10} />}
            </div>
          )}
        </div>
        {chatStatus && (
          <div
            title={chatStatus}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              fontSize: 10,
              fontWeight: 500,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--chatlist-badge-status-bg)",
              color: "var(--chatlist-badge-status-text)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              width: "fit-content",
              maxWidth: "100%",
            }}
          >
            {chatStatusEmoji && <span>{chatStatusEmoji}</span>}
            {chatStatus}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          marginLeft: 6,
          flexShrink: 0,
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
          transition: "opacity 0.12s ease",
        }}
      >
        {onToggleBookmark && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleBookmark(!isBookmarked);
            }}
            title={isBookmarked ? "Remove bookmark" : "Bookmark this chat"}
            style={{
              background: "none",
              color: isBookmarked ? "var(--chatlist-bookmark-icon)" : "var(--chatlist-icon)",
              padding: "2px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Bookmark size={14} fill={isBookmarked ? "currentColor" : "none"} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            background: "none",
            color: "var(--chatlist-icon-delete)",
            padding: "2px 4px",
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
