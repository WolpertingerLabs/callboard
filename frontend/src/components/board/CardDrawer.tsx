import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CardSummary, CardPatch } from "../../api";
import MarkdownRenderer from "../MarkdownRenderer";
import InlineEdit from "./InlineEdit";
import { formatRelativeTime } from "../../utils/dateFormat";
import { X, Pin, PinOff, Archive, ArchiveRestore, MessageSquarePlus, Pencil, Workflow } from "lucide-react";

interface CardDrawerProps {
  card: CardSummary;
  onPatch: (patch: CardPatch) => void;
  onClose: () => void;
}

/** Live-status dot colors — themable via the --board-* section of index.css. */
const CHAT_STATUS_COLORS: Record<string, string> = {
  ongoing: "var(--board-rollup-active)",
  waiting: "var(--board-rollup-needs-you)",
  stopped: "var(--board-rollup-idle)",
};

/** Right-hand drawer with the card's editable identity, members, and actions. */
export default function CardDrawer({ card, onPatch, onClose }: CardDrawerProps) {
  const navigate = useNavigate();
  const [editingDescription, setEditingDescription] = useState(false);
  const closed = card.lifecycle === "closed";

  return (
    <>
      {/* Click-away backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", zIndex: 100 }} />

      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(440px, 92vw)",
          background: "var(--board-drawer-bg)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 101,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 20 }}>{card.emoji}</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
            <InlineEdit value={card.title} onSave={(title) => title.trim() && onPatch({ title })} placeholder="Card title" />
          </div>
          <button
            onClick={() => onPatch({ pinned: !card.pinned })}
            title={card.pinned ? "Unpin" : "Pin to top"}
            style={{ padding: 6, borderRadius: 6, color: card.pinned ? "var(--accent)" : "var(--text-muted)", cursor: "pointer" }}
          >
            {card.pinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
          <button onClick={onClose} title="Close panel" style={{ padding: 6, borderRadius: 6, color: "var(--text-muted)", cursor: "pointer" }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Narrative status */}
          {(card.status || card.statusEmoji) && (
            <div
              style={{
                fontSize: 13,
                color: "var(--text)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 12px",
              }}
            >
              {card.statusEmoji ? `${card.statusEmoji} ` : ""}
              {card.status}
            </div>
          )}

          {/* Description */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Description</span>
              <button
                onClick={() => setEditingDescription((v) => !v)}
                title="Edit description"
                style={{ display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)", cursor: "pointer" }}
              >
                <Pencil size={12} />
              </button>
            </div>
            {editingDescription ? (
              <InlineEditDescription
                value={card.description}
                onSave={(description) => {
                  onPatch({ description });
                  setEditingDescription(false);
                }}
                onCancel={() => setEditingDescription(false)}
              />
            ) : card.description ? (
              <div style={{ fontSize: 13 }}>
                <MarkdownRenderer content={card.description} />
              </div>
            ) : (
              <div onClick={() => setEditingDescription(true)} style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", cursor: "text" }}>
                Describe the topic…
              </div>
            )}
          </div>

          {/* Member job runs */}
          {card.memberRuns.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Job runs
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {card.memberRuns.map((run) => (
                  <div
                    key={run.runId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--board-item-border)",
                      background: "var(--board-item-bg)",
                      fontSize: 12,
                      color: "var(--text)",
                    }}
                  >
                    <Workflow size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{run.title || run.jobName}</span>
                    <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{run.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Member chats */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
              Chats ({card.memberChats.length})
            </div>
            {card.memberChats.length === 0 && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No chats yet — start one below.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {card.memberChats.map((chat) => (
                <div
                  key={chat.chatId}
                  onClick={() => navigate(`/chat/${chat.chatId}`)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--board-item-border)",
                    background: "var(--board-item-bg)",
                    cursor: "pointer",
                    minWidth: 0,
                  }}
                >
                  <span title={chat.status} style={{ width: 7, height: 7, borderRadius: "50%", background: CHAT_STATUS_COLORS[chat.status], flexShrink: 0 }} />
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {chat.title || "Untitled chat"}
                  </span>
                  {chat.chatStatusEmoji && <span style={{ fontSize: 11, flexShrink: 0 }}>{chat.chatStatusEmoji}</span>}
                  {chat.unread && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--board-unread-dot)", flexShrink: 0 }} />}
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{formatRelativeTime(chat.updatedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          {!closed && (
            <button
              onClick={() => navigate("/chat/new", { state: { cardId: card.id } })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                padding: "8px 12px",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <MessageSquarePlus size={14} />
              New chat on card
            </button>
          )}
          <button
            onClick={() => onPatch({ lifecycle: closed ? "open" : "closed" })}
            title={closed ? "Reopen this card" : "Close: hides the card from the open board; chats and sessions are untouched"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginLeft: "auto",
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {closed ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {closed ? "Reopen" : "Close card"}
          </button>
        </div>
      </div>
    </>
  );
}

/** Description editor with explicit save/cancel (markdown preview is the display state). */
function InlineEditDescription({ value, onSave, onCancel }: { value: string; onSave: (value: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <textarea
        autoFocus
        value={draft}
        rows={Math.max(5, draft.split("\n").length + 1)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Markdown supported"
        style={{
          width: "100%",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--accent)",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 13,
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 8px", cursor: "pointer" }}>
          Cancel
        </button>
        <button
          onClick={() => onSave(draft)}
          style={{ fontSize: 12, background: "var(--accent)", color: "var(--text-on-accent)", padding: "4px 12px", borderRadius: 6, cursor: "pointer" }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
