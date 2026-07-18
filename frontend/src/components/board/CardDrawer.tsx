import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CardSummary, CardPatch } from "../../api";
import { getAgentIdentityPrompt } from "../../api";
import MarkdownRenderer from "../MarkdownRenderer";
import InlineEdit from "./InlineEdit";
import { formatRelativeTime } from "../../utils/dateFormat";
import { PENDING_CHIPS } from "./pendingLabels";
import { getRecentDirectories } from "../../utils/localStorage";
import { X, Pin, PinOff, Archive, ArchiveRestore, MessageSquarePlus, Pencil, Workflow, Plus, ExternalLink } from "lucide-react";

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

/** Icon/text buttons must set a background — the global button reset leaves
 * the browser default (a light pill) otherwise. */
const ICON_BUTTON: React.CSSProperties = {
  background: "transparent",
  padding: 6,
  borderRadius: 6,
  cursor: "pointer",
};

/** Right-hand drawer with the card's editable identity, members, and actions. */
export default function CardDrawer({ card, onPatch, onClose }: CardDrawerProps) {
  const navigate = useNavigate();
  const [editingDescription, setEditingDescription] = useState(false);
  const closed = card.lifecycle === "closed";

  // Start a chat in the card's working context: the most recently active
  // member chat's folder, and — when that chat runs a configured agent —
  // the agent's identity prompt and permissions (mirrors AgentDashboard's
  // start-chat flow). Falls back to the most recent New Chat directory.
  const startChatOnCard = async () => {
    const recent = card.memberChats[0]; // sorted newest-first server-side
    const folder = recent?.folder ?? getRecentDirectories()[0]?.path;
    if (!folder) {
      // No known folder anywhere — land on the picker message rather than guessing.
      navigate("/chat/new", { state: { cardId: card.id } });
      return;
    }

    let agentState: Record<string, unknown> = {};
    if (recent?.agentAlias) {
      let systemPrompt: string | undefined;
      try {
        systemPrompt = await getAgentIdentityPrompt(recent.agentAlias);
      } catch {
        // Continue without identity prompt if fetch fails
      }
      agentState = {
        agentAlias: recent.agentAlias,
        ...(systemPrompt && { systemPrompt }),
        defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
      };
    }

    navigate(`/chat/new?folder=${encodeURIComponent(folder)}`, { state: { cardId: card.id, ...agentState } });
  };

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
            style={{ ...ICON_BUTTON, color: card.pinned ? "var(--accent)" : "var(--text-muted)" }}
          >
            {card.pinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
          <button onClick={onClose} title="Close panel" style={{ ...ICON_BUTTON, color: "var(--text-muted)" }}>
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
                style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
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

          {/* Arbitrary key→value metadata (PR urls, ticket ids, …) */}
          <MetadataSection metadata={card.metadata} onPatch={onPatch} />

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
                  {chat.pendingKind && (
                    <span
                      title={`Blocked on a ${PENDING_CHIPS[chat.pendingKind]} — open the chat to respond`}
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--board-rollup-needs-you)",
                        background: "color-mix(in srgb, var(--board-rollup-needs-you) 15%, transparent)",
                        padding: "1px 6px",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    >
                      {PENDING_CHIPS[chat.pendingKind]}
                    </span>
                  )}
                  {chat.hasSummon && !chat.pendingKind && (
                    <span
                      title="The agent summoned you — open the chat"
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--board-rollup-needs-you)",
                        background: "color-mix(in srgb, var(--board-rollup-needs-you) 15%, transparent)",
                        padding: "1px 6px",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    >
                      summon
                    </span>
                  )}
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
              onClick={startChatOnCard}
              title={
                card.memberChats[0]?.agentAlias
                  ? `Start a chat as agent "${card.memberChats[0].agentAlias}" in this card's context`
                  : "Start a chat in this card's most recent folder"
              }
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

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * Arbitrary key→value annotations (GitHub PR url, Linear ticket id, …).
 * Values that look like urls render as links; everything is editable inline.
 * Removal and edits go through the merge-patch `metadata` field — a null
 * (or blank) value deletes the key server-side.
 */
function MetadataSection({ metadata, onPatch }: { metadata?: Record<string, string>; onPatch: (patch: CardPatch) => void }) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const entries = Object.entries(metadata ?? {}).sort(([a], [b]) => a.localeCompare(b));

  const submitNew = () => {
    if (!newKey.trim() || !newValue.trim()) return;
    onPatch({ metadata: { [newKey.trim()]: newValue.trim() } });
    setNewKey("");
    setNewValue("");
    setAdding(false);
  };

  if (entries.length === 0 && !adding) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Metadata</span>
        <button
          onClick={() => setAdding(true)}
          title="Add a metadata entry (e.g. a PR url or ticket id)"
          style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
        >
          <Plus size={12} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Metadata</span>
        <button
          onClick={() => setAdding((v) => !v)}
          title="Add a metadata entry (e.g. a PR url or ticket id)"
          style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
        >
          <Plus size={12} />
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {entries.map(([key, value]) => (
          <MetadataRow key={key} name={key} value={value} onPatch={onPatch} />
        ))}
        {adding && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--accent)",
              background: "var(--board-item-bg)",
            }}
          >
            <input
              autoFocus
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
              placeholder="Key (e.g. github_pr)"
              style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
            />
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Value (url, ticket id, …)"
              style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setAdding(false)}
                style={{ background: "transparent", fontSize: 12, color: "var(--text-muted)", padding: "2px 8px", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={submitNew}
                disabled={!newKey.trim() || !newValue.trim()}
                style={{
                  fontSize: 12,
                  background: "var(--accent)",
                  color: "var(--text-on-accent)",
                  padding: "2px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  opacity: !newKey.trim() || !newValue.trim() ? 0.5 : 1,
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetadataRow({ name, value, onPatch }: { name: string; value: string; onPatch: (patch: CardPatch) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const isUrl = URL_RE.test(value);

  const commit = () => {
    setEditing(false);
    // Merge-patch: a blank value removes the key server-side.
    if (draft.trim() !== value) onPatch({ metadata: { [name]: draft.trim() || null } });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid var(--board-item-border)",
        background: "var(--board-item-bg)",
        fontSize: 12,
        minWidth: 0,
      }}
    >
      <span
        title={name}
        style={{
          color: "var(--text-muted)",
          fontWeight: 600,
          flexShrink: 0,
          maxWidth: "40%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            padding: "2px 6px",
            fontSize: 12,
          }}
        />
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
          {isUrl ? (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              title={value}
              style={{ color: "var(--accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%" }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
              <ExternalLink size={11} style={{ flexShrink: 0 }} />
            </a>
          ) : (
            <span
              title={value}
              style={{ cursor: "text" }}
              onClick={() => {
                setDraft(value);
                setEditing(true);
              }}
            >
              {value}
            </span>
          )}
        </span>
      )}
      {!editing && (
        <button
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          title="Edit value"
          style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
        >
          <Pencil size={11} />
        </button>
      )}
      <button
        onClick={() => onPatch({ metadata: { [name]: null } })}
        title="Remove this entry"
        style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
      >
        <X size={11} />
      </button>
    </div>
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
        <button onClick={onCancel} style={{ background: "transparent", fontSize: 12, color: "var(--text-muted)", padding: "4px 8px", cursor: "pointer" }}>
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
