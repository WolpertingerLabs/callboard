import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Chat, CardSummary, CardPatch } from "../api";
import { listCards, listChats, createCard, updateCard, assignChatToCard, dismissFromBoard } from "../api";
import { useMetadataVersion } from "../contexts/SessionContext";
import { getBoardClosedExpanded, saveBoardClosedExpanded } from "../utils/localStorage";
import CardTile from "../components/board/CardTile";
import CardDrawer from "../components/board/CardDrawer";
import CardPicker from "../components/board/CardPicker";
import InboxRow from "../components/board/InboxRow";
import { Plus, ChevronRight, ChevronDown, LayoutGrid } from "lucide-react";

/** How many recent non-triggered chats to consider for the inbox. */
const INBOX_FETCH_LIMIT = 30;

type Section = { key: string; label: string; cards: CardSummary[] };

export default function Board() {
  const navigate = useNavigate();
  const metadataVersion = useMetadataVersion();
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [inboxChats, setInboxChats] = useState<Chat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [pickerChatId, setPickerChatId] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(() => getBoardClosedExpanded());
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      // boardInbox=true filters out carded/dismissed chats server-side, so the
      // window returns the newest un-triaged chats instead of draining as the
      // recent slots fill with already-filed ones.
      const [cardsRes, chatsRes] = await Promise.all([listCards(), listChats(INBOX_FETCH_LIMIT, 0, undefined, true, undefined, undefined, true)]);
      setCards(cardsRes.cards);
      setInboxChats(chatsRes.chats);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load board");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refetch shortly after any chat/card metadata change (same debounce as the sidebar).
  useEffect(() => {
    if (metadataVersion === 0) return;
    const timer = setTimeout(() => load(), 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, load]);

  const open = cards.filter((c) => c.lifecycle === "open");
  const closed = cards.filter((c) => c.lifecycle === "closed");
  const sections: Section[] = [
    { key: "needs_you", label: "Needs you", cards: open.filter((c) => c.rollup === "needs_you") },
    { key: "running", label: "Running", cards: open.filter((c) => c.rollup === "job_running" || c.rollup === "active") },
    // Stalest first — a gentle nudge to close out or kick forward.
    {
      key: "idle",
      label: "Idle",
      cards: open
        .filter((c) => c.rollup === "idle")
        .sort((a, b) => (a.pinned === b.pinned ? a.lastActivityAt.localeCompare(b.lastActivityAt) : a.pinned ? -1 : 1)),
    },
  ];

  // Card-less, non-dismissed chats. Membership/dismissal live in metadata.
  const inbox = useMemo(
    () =>
      inboxChats.filter((chat) => {
        try {
          const meta = JSON.parse(chat.metadata || "{}");
          return !(typeof meta.cardId === "string" && meta.cardId) && meta.boardDismissed !== true;
        } catch {
          return true;
        }
      }),
    [inboxChats],
  );

  const openCard = openCardId ? cards.find((c) => c.id === openCardId) : undefined;

  const patchCard = async (cardId: string, patch: CardPatch) => {
    try {
      const res = await updateCard(cardId, patch);
      setCards((prev) => prev.map((c) => (c.id === cardId ? res.card : c)));
    } catch (err: any) {
      setError(err.message || "Failed to update card");
    }
  };

  const chatTitle = (chat: Chat): string => {
    try {
      const meta = JSON.parse(chat.metadata || "{}");
      return (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || "Untitled chat";
    } catch {
      return "Untitled chat";
    }
  };

  const promoteChat = async (chat: Chat) => {
    try {
      const res = await createCard({ title: chatTitle(chat).slice(0, 120) }, chat.id);
      setOpenCardId(res.card.id);
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to create card");
    }
  };

  const newCard = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await createCard({ title: "New card" });
      await load();
      setOpenCardId(res.card.id);
    } catch (err: any) {
      setError(err.message || "Failed to create card");
    } finally {
      setCreating(false);
    }
  };

  const assignFromPicker = async (cardId: string) => {
    if (!pickerChatId) return;
    try {
      await assignChatToCard(pickerChatId, cardId);
      setPickerChatId(null);
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to assign chat");
    }
  };

  const createFromPicker = async (title: string) => {
    if (!pickerChatId) return;
    try {
      await createCard({ title }, pickerChatId);
      setPickerChatId(null);
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to create card");
    }
  };

  const dismissChat = async (chat: Chat) => {
    try {
      await dismissFromBoard(chat.id, true);
      setInboxChats((prev) => prev.filter((c) => c.id !== chat.id));
    } catch (err: any) {
      setError(err.message || "Failed to dismiss chat");
    }
  };

  const sectionHeader = (label: string, count: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</span>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{count}</span>
    </div>
  );

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 10,
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 24px 60px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <LayoutGrid size={20} style={{ color: "var(--accent)" }} />
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", flex: 1 }}>Board</h1>
          <button
            onClick={newCard}
            disabled={creating}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              opacity: creating ? 0.6 : 1,
            }}
          >
            <Plus size={14} />
            New card
          </button>
        </div>

        {error && (
          <div
            style={{
              marginBottom: 16,
              padding: "10px 14px",
              borderRadius: 8,
              background: "var(--danger-bg, var(--surface))",
              color: "var(--danger)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {!loaded ? (
          <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading…</div>
        ) : (
          <>
            {open.length === 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 28 }}>
                No open cards. Create one, or promote a chat from the inbox below.
              </div>
            )}

            {sections.map(
              (section) =>
                section.cards.length > 0 && (
                  <div key={section.key} style={{ marginBottom: 28 }}>
                    {sectionHeader(section.label, section.cards.length)}
                    <div style={grid}>
                      {section.cards.map((card) => (
                        <CardTile key={card.id} card={card} onClick={() => setOpenCardId(card.id)} />
                      ))}
                    </div>
                  </div>
                ),
            )}

            {/* Inbox — recent chats that belong to no card */}
            {inbox.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                {sectionHeader("Inbox", inbox.length)}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {inbox.map((chat) => (
                    <InboxRow
                      key={chat.id}
                      chat={chat}
                      onOpen={() => navigate(`/chat/${chat.id}`)}
                      onPromote={() => promoteChat(chat)}
                      onAddToCard={() => setPickerChatId(chat.id)}
                      onDismiss={() => dismissChat(chat)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Closed strip */}
            {closed.length > 0 && (
              <div>
                <button
                  onClick={() => {
                    const next = !closedExpanded;
                    setClosedExpanded(next);
                    saveBoardClosedExpanded(next);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 10,
                    color: "var(--text-muted)",
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    cursor: "pointer",
                  }}
                >
                  {closedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Closed
                  <span style={{ fontWeight: 400 }}>{closed.length}</span>
                </button>
                {closedExpanded && (
                  <div style={grid}>
                    {closed
                      .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt))
                      .map((card) => (
                        <CardTile key={card.id} card={card} onClick={() => setOpenCardId(card.id)} />
                      ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {openCard && <CardDrawer card={openCard} onPatch={(patch) => patchCard(openCard.id, patch)} onClose={() => setOpenCardId(null)} />}

      {pickerChatId && <CardPicker cards={cards} onSelect={assignFromPicker} onCreate={createFromPicker} onClose={() => setPickerChatId(null)} />}
    </div>
  );
}
