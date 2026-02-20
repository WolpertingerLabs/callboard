import { Globe, Monitor, X, Bookmark, Bot } from "lucide-react";
import type { Chat, SessionStatus } from "../api";

interface Props {
  chat: Chat;
  isActive?: boolean;
  onClick: () => void;
  onDelete: () => void;
  onToggleBookmark?: (bookmarked: boolean) => void;
  sessionStatus?: SessionStatus;
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

  let preview: string | undefined;
  let isBookmarked = false;
  let agentAlias: string | undefined;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    preview = meta.preview;
    isBookmarked = meta.bookmarked === true;
    agentAlias = meta.agentAlias;
  } catch {}

  const displayName = preview ? (preview.length > 60 ? preview.slice(0, 60) + "..." : preview) : folderName;

  return (
    <div
      onClick={onClick}
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--accent-light, rgba(99,102,241,0.1))" : undefined,
        borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isBookmarked && <Bookmark size={14} style={{ color: "var(--accent)", flexShrink: 0 }} fill="var(--accent)" />}
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
                background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                color: "var(--accent)",
                flexShrink: 0,
              }}
            >
              <Bot size={10} />
              {agentAlias}
            </span>
          )}
          <div style={{ fontSize: 15, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
          {sessionStatus?.active && (
            <div
              style={{
                fontSize: 10,
                padding: "1px 4px",
                borderRadius: 3,
                background: sessionStatus.type === "web" ? "var(--accent)" : "#10b981",
                color: "#fff",
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
            color: "var(--text-muted)",
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
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{time}</div>
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
              color: isBookmarked ? "var(--accent)" : "var(--text-muted)",
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
            color: "var(--text-muted)",
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
