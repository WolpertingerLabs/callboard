import { Globe, Monitor, X } from "lucide-react";
import type { Chat, SessionStatus } from "../api";
import { truncatePath } from "../utils/truncatePath";

interface Props {
  chat: Chat;
  onClick: () => void;
  onDelete: () => void;
  sessionStatus?: SessionStatus;
}

export default function ChatListItem({ chat, onClick, onDelete, sessionStatus }: Props) {
  const folderName = chat.folder?.split("/").pop() || chat.folder || "Chat";
  const time = new Date(chat.updated_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let preview: string | undefined;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    preview = meta.preview;
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
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          title={chat.folder}
          style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {truncatePath(chat.folder, 45)}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{time}</div>
      </div>
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
          marginLeft: 8,
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
