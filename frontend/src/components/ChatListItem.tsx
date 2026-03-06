import { Globe, Monitor, X, Bookmark, Bot, Zap } from "lucide-react";
import type { Chat } from "../api";

interface Props {
  chat: Chat;
  isActive?: boolean;
  onClick: () => void;
  onDelete: () => void;
  onToggleBookmark?: (bookmarked: boolean) => void;
  sessionStatus?: { active: boolean; type: string };
}

export default function ChatListItem({ chat, isActive, onClick, onDelete, onToggleBookmark, sessionStatus }: Props) {
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
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    title = meta.title;
    preview = meta.preview;
    isBookmarked = meta.bookmarked === true;
    agentAlias = meta.agentAlias;
    isTriggered = meta.triggered === true;
    lastReadAt = meta.lastReadAt;
  } catch {}

  const hasUnread = lastReadAt ? new Date(chat.updated_at) > new Date(lastReadAt) : false;

  const displayName = title || (preview ? (preview.length > 60 ? preview.slice(0, 60) + "..." : preview) : folderName);

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
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          {isTriggered && (
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
              fontSize: 15,
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
        <div
          title={displayPath}
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
          {displayPath}
        </div>
        <div style={{ fontSize: 11, color: "var(--chatlist-item-time-text)", marginTop: 2 }}>{time}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 8, flexShrink: 0 }}>
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
              padding: "4px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Bookmark size={16} fill={isBookmarked ? "currentColor" : "none"} />
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
            fontSize: 18,
            padding: "4px 8px",
          }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
