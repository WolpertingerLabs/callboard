import type { Chat } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { useIsMobile } from "../../hooks/useIsMobile";
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
  const isMobile = useIsMobile();
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(chat.metadata || "{}");
  } catch {}
  const title = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || "Untitled chat";

  const iconButton: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: 6,
    borderRadius: 6,
    color: "var(--board-tile-meta-text)",
    background: "transparent",
    cursor: "pointer",
    flexShrink: 0,
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: isMobile ? 4 : 10,
        padding: isMobile ? "8px 10px" : "8px 12px",
        borderRadius: 8,
        border: "1px solid var(--board-item-border)",
        background: "var(--board-item-bg)",
        minWidth: 0,
      }}
    >
      <div onClick={onOpen} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--board-tile-title-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {/* Single line, each segment truncates instead of wrapping into columns */}
        <div
          style={{
            fontSize: 11,
            color: "var(--board-tile-meta-text)",
            display: "flex",
            gap: 8,
            minWidth: 0,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{folderName(chat.folder)}</span>
          {!isMobile && chat.git_branch && <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 2 }}>{chat.git_branch}</span>}
          <span style={{ flexShrink: 0 }}>{formatRelativeTime(chat.updated_at)}</span>
        </div>
      </div>
      <button
        onClick={onPromote}
        title="Promote to a new card"
        style={{
          ...iconButton,
          gap: 4,
          fontSize: 12,
          color: "var(--accent)",
          ...(isMobile ? {} : { padding: "4px 8px" }),
        }}
      >
        <SquarePlus size={isMobile ? 16 : 14} />
        {!isMobile && "Card"}
      </button>
      <button onClick={onAddToCard} title="Add to an existing card" style={iconButton}>
        <FolderInput size={isMobile ? 16 : 14} />
      </button>
      <button onClick={onDismiss} title="Dismiss from inbox (chat is untouched)" style={iconButton}>
        <X size={isMobile ? 16 : 14} />
      </button>
    </div>
  );
}
