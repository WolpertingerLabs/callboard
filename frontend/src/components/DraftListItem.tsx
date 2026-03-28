import { X, FileText } from "lucide-react";
import type { QueueItem } from "../api";

interface Props {
  draft: QueueItem;
  isActive?: boolean;
  onClick: () => void;
  onDelete: (id: string) => void;
}

export default function DraftListItem({ draft, isActive, onClick, onDelete }: Props) {
  const target = draft.folder ? draft.folder.split("/").pop() || draft.folder : "Continue chat";
  const created = new Date(draft.created_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const preview = draft.user_message.length > 100 ? draft.user_message.slice(0, 100) + "..." : draft.user_message;

  return (
    <div
      onClick={onClick}
      style={{
        padding: "10px 20px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        borderLeft: isActive ? "3px solid var(--accent)" : "3px solid var(--badge-info-bg)",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FileText size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--chatlist-item-title-text)",
            }}
          >
            {preview}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--chatlist-item-time-text)", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
          {created}
          <span
            style={{
              fontSize: 10,
              padding: "0 5px",
              borderRadius: 3,
              background: "var(--chatlist-badge-agent-bg)",
              color: "var(--chatlist-item-time-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 140,
            }}
          >
            {target}
          </span>
        </div>
      </div>
      <div style={{ marginLeft: 8, flexShrink: 0 }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(draft.id);
          }}
          style={{
            background: "none",
            color: "var(--chatlist-icon-delete)",
            fontSize: 18,
            padding: "4px 8px",
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
