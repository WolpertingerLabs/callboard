import type { Chat } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { SquarePlus, FolderInput, X } from "lucide-react";

interface InboxRowProps {
  chat: Chat;
  onOpen: () => void;
  onPromote: () => void;
  onAddToCard: () => void;
  onDismiss: () => void;
}

function folderName(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

/** A card-less chat in the board inbox: promote it, file it, or sweep it away. */
export default function InboxRow({ chat, onOpen, onPromote, onAddToCard, onDismiss }: InboxRowProps) {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(chat.metadata || "{}");
  } catch {}
  const title = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || "Untitled chat";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        minWidth: 0,
      }}
    >
      <div onClick={onOpen} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 8 }}>
          <span>{folderName(chat.folder)}</span>
          {chat.git_branch && <span>{chat.git_branch}</span>}
          <span>{formatRelativeTime(chat.updated_at)}</span>
        </div>
      </div>
      <button
        onClick={onPromote}
        title="Promote to a new card"
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--accent)", padding: "4px 8px", borderRadius: 6, cursor: "pointer" }}
      >
        <SquarePlus size={14} />
        Card
      </button>
      <button
        onClick={onAddToCard}
        title="Add to an existing card"
        style={{ display: "flex", alignItems: "center", padding: 4, borderRadius: 6, color: "var(--text-muted)", cursor: "pointer" }}
      >
        <FolderInput size={14} />
      </button>
      <button
        onClick={onDismiss}
        title="Dismiss from inbox (chat is untouched)"
        style={{ display: "flex", alignItems: "center", padding: 4, borderRadius: 6, color: "var(--text-muted)", cursor: "pointer" }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
