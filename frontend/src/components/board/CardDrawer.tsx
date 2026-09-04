import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CardSummary, CardPatch } from "../../api";
import { getAgentIdentityPrompt, CARD_CATEGORY_MAX } from "../../api";
import MarkdownRenderer from "../MarkdownRenderer";
import InlineEdit from "./InlineEdit";
import CardPathLabel from "./CardPathLabel";
import { formatRelativeTime } from "../../utils/dateFormat";
import { PENDING_CHIPS } from "./pendingLabels";
import { getRecentDirectories } from "../../utils/localStorage";
import { X, Pin, PinOff, Archive, ArchiveRestore, MessageSquarePlus, Pencil, Workflow, Plus, Tag, Folder } from "lucide-react";

/** Mirrors the limits in backend/src/services/card-fields.ts. */
const METADATA_KEY_MAX = 64;
const METADATA_VALUE_MAX = 2048;

interface CardDrawerProps {
  card: CardSummary;
  /** Existing category labels offered as autocomplete suggestions. */
  categories: string[];
  /** Resolves false when the patch was rejected — editors stay open so input isn't lost. */
  onPatch: (patch: CardPatch) => Promise<boolean>;
  /** Close the drawer (card deletion is root-chat deletion in the chat UI). */
  onClose: () => void;
  /**
   * Opens the chat list filtered to one folder — how a list row's folder entry
   * drills in. Absent behaves exactly as the drawer always has, and the filter
   * is always visible and always clearable: one the user can neither see nor
   * escape is a drawer that appears to have lost their chats.
   */
  initialFolderFilter?: string;
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
export default function CardDrawer({ card, categories, onPatch, onClose, initialFolderFilter }: CardDrawerProps) {
  const navigate = useNavigate();
  const [editingDescription, setEditingDescription] = useState(false);
  // Seeded from the prop and owned here after that, so clearing it is a local
  // gesture rather than a round-trip through the board's open-card state.
  const [folderFilter, setFolderFilter] = useState(initialFolderFilter);
  const closed = card.lifecycle === "closed";

  const shownChats = folderFilter ? card.memberChats.filter((c) => c.folder === folderFilter) : card.memberChats;

  // Start a chat in the card's working context: the most recently active
  // member chat's folder, and — when that chat runs a configured agent —
  // the agent's identity prompt and permissions (mirrors AgentDashboard's
  // start-chat flow). Falls back to the most recent New Chat directory.
  const startChatOnCard = async () => {
    // From the FILTERED list: the chip above says which folder the drawer is
    // showing, so a new chat that landed in the card's most recent folder
    // instead would contradict the only context on screen.
    const recent = shownChats[0]; // sorted newest-first server-side
    // `folderFilter` between them, because `shownChats` can be empty while a
    // filter is set — a folder emptying out under the 15s poll, which is the
    // state the chat list below already explains to the user in so many
    // words. Falling straight through to the global New Chat MRU there lands
    // the new chat in whatever project was opened last and then joins it to
    // THIS card, so a card silently acquires a folder from an unrelated repo.
    // The chip on screen names a real path the user is looking at, which is
    // strictly a better guess than another project.
    //
    // Nothing sits between the filter and the MRU: `shownChats` is the whole
    // member list whenever there is no filter, so `card.memberChats[0]` here
    // is either `recent` itself or, on a card with no member rows at all,
    // equally absent.
    const folder = recent?.folder ?? folderFilter ?? getRecentDirectories()[0]?.path;
    if (!folder) {
      // No known folder anywhere — land on the picker message rather than guessing.
      // parentChatId = the card's root chat: the new chat joins the card by
      // joining the tree (membership is lineage).
      navigate("/chat/new", { state: { parentChatId: card.id } });
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

    navigate(`/chat/new?folder=${encodeURIComponent(folder)}`, { state: { parentChatId: card.id, ...agentState } });
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

          {/* Category */}
          <CategorySection category={card.category} categories={categories} onPatch={onPatch} />

          {/* Metadata */}
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
                    <Workflow size={12} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
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
              {/* "3 of 8" rather than "3": a bare count under a filter reads
                  as the card having lost five chats. */}
              Chats ({folderFilter ? `${shownChats.length} of ${card.memberChats.length}` : card.memberChats.length})
            </div>
            {folderFilter && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 6,
                  padding: "4px 6px 4px 8px",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  minWidth: 0,
                }}
              >
                <Folder size={11} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                <CardPathLabel path={folderFilter} color="var(--text)" fontSize={12} />
                <button
                  onClick={() => setFolderFilter(undefined)}
                  aria-label="Clear folder filter"
                  title="Show every chat on this card"
                  style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)", flexShrink: 0 }}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {card.memberChats.length === 0 && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No chats yet — start one below.</div>}
            {/* A folder can empty out under a poll while the drawer is open —
                say so, rather than showing a filter over a blank space. */}
            {card.memberChats.length > 0 && shownChats.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No chats in this folder — clear the filter to see the rest.</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {shownChats.map((chat) => (
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

/**
 * Optional free-form category the board groups open cards under. Display is a
 * tag chip (or an "add" affordance); editing is an input with autocomplete
 * from the other cards' categories. Saving blank clears the category.
 */
function CategorySection({
  category,
  categories,
  onPatch,
}: {
  category?: string;
  categories: string[];
  onPatch: (patch: CardPatch) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category ?? "");
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    setDraft(category ?? "");
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (await onPatch({ category: draft.trim() || null })) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Category</span>
        <button
          onClick={() => (editing ? setEditing(false) : startEditing())}
          title="Edit category"
          style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
        >
          <Pencil size={12} />
        </button>
      </div>

      {editing ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            autoFocus
            value={draft}
            maxLength={CARD_CATEGORY_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setEditing(false);
            }}
            list="card-drawer-category-options"
            placeholder="Category (blank to clear)"
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--accent)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
            }}
          />
          {categories.length > 0 && (
            <datalist id="card-drawer-category-options">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          )}
          <button
            onClick={() => void save()}
            disabled={saving}
            style={{ fontSize: 12, background: "var(--accent)", color: "var(--text-on-accent)", padding: "4px 12px", borderRadius: 6, cursor: "pointer" }}
          >
            Save
          </button>
        </div>
      ) : category ? (
        <span
          onClick={startEditing}
          title="Click to edit category"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12,
            color: "var(--text)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "3px 10px",
            cursor: "pointer",
            maxWidth: "100%",
          }}
        >
          <Tag size={11} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{category}</span>
        </span>
      ) : (
        <div onClick={startEditing} style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", cursor: "pointer" }}>
          Group this card under a category…
        </div>
      )}
    </div>
  );
}

/**
 * Arbitrary key→value cross-references (PR URLs, ticket ids, conversation
 * links). Every mutation is a per-key patch — `{ [key]: value }` to set,
 * `{ [key]: null }` to delete — so concurrent agent writes to other keys
 * survive.
 */
function MetadataSection({ metadata, onPatch }: { metadata?: Record<string, string>; onPatch: (patch: CardPatch) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(metadata ?? {});

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Metadata</span>
        <button
          onClick={() => setAdding((v) => !v)}
          title="Add a field"
          style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)" }}
        >
          <Plus size={12} />
        </button>
      </div>

      {entries.length === 0 && !adding && (
        <div onClick={() => setAdding(true)} style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", cursor: "pointer" }}>
          Link a PR, ticket, or conversation…
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {entries.map(([key, value]) => (
          <div
            key={key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--board-item-border)",
              background: "var(--board-item-bg)",
              fontSize: 12,
            }}
          >
            <span title={key} style={{ color: "var(--text-muted)", flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {key}
            </span>
            <div style={{ flex: 1, minWidth: 0, color: "var(--text)" }}>
              <MetadataValue value={value} onSave={(next) => onPatch({ metadata: { [key]: next.trim() || null } })} />
            </div>
            <button
              onClick={() => onPatch({ metadata: { [key]: null } })}
              title={`Remove "${key}"`}
              style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)", flexShrink: 0 }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {adding && (
        <AddMetadataField
          existingKeys={entries.map(([key]) => key)}
          // Close only once the patch lands — a rejected add (entry cap,
          // over-limit value) would otherwise discard what the user typed.
          onAdd={async (key, value) => {
            if (await onPatch({ metadata: { [key]: value } })) setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** URL values render as links; anything else is click-to-edit text. */
function MetadataValue({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const isUrl = /^https?:\/\//.test(value);

  if (isUrl && !editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          title={value}
          style={{ color: "var(--accent-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {value}
        </a>
        <button onClick={() => setEditing(true)} title="Edit value" style={{ ...ICON_BUTTON, display: "flex", alignItems: "center", padding: 2, color: "var(--text-muted)", flexShrink: 0 }}>
          <Pencil size={10} />
        </button>
      </div>
    );
  }

  return (
    <InlineEdit
      value={value}
      onSave={onSave}
      // A URL row's display state is a link, so the pencil has to open the
      // editor directly; ending the edit returns it to link rendering.
      startEditing={editing}
      onEditingEnd={() => setEditing(false)}
      maxLength={METADATA_VALUE_MAX}
      placeholder="Empty — click to set"
      style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      inputStyle={{ fontSize: 12 }}
    />
  );
}

/** Key + value inputs for a new entry, with client-side empty/duplicate rejection. */
function AddMetadataField({ existingKeys, onAdd, onCancel }: { existingKeys: string[]; onAdd: (key: string, value: string) => Promise<void>; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const trimmedKey = key.trim();
  const trimmedValue = value.trim();
  const hint = !trimmedKey
    ? key
      ? "Key can't be blank."
      : null
    : existingKeys.includes(trimmedKey)
      ? `"${trimmedKey}" already exists — edit it above.`
      : !trimmedValue && value
        ? "Value can't be blank."
        : null;
  // A blank value would persist an empty string, which the edit path treats as
  // a delete — so there is no way to add an entry we couldn't then clear.
  const canAdd = trimmedKey.length > 0 && trimmedValue.length > 0 && !hint && !saving;

  // The parent closes this editor only on success, so a rejected add leaves the
  // typed key and value in place to correct.
  const submit = async () => {
    if (!canAdd) return;
    setSaving(true);
    try {
      await onAdd(trimmedKey, trimmedValue);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: "var(--bg)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    minWidth: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          autoFocus
          value={key}
          maxLength={METADATA_KEY_MAX}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          placeholder="key (e.g. github-pr)"
          style={{ ...inputStyle, flex: "0 0 40%" }}
        />
        <input
          value={value}
          maxLength={METADATA_VALUE_MAX}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="value"
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>
      {hint && <div style={{ fontSize: 11, color: "var(--danger)" }}>{hint}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ background: "transparent", fontSize: 12, color: "var(--text-muted)", padding: "4px 8px", cursor: "pointer" }}>
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={!canAdd}
          style={{
            fontSize: 12,
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            padding: "4px 12px",
            borderRadius: 6,
            cursor: canAdd ? "pointer" : "not-allowed",
            opacity: canAdd ? 1 : 0.5,
          }}
        >
          Add
        </button>
      </div>
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
