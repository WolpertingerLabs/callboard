import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Chat, CardSummary, CardPatch, CardPayload } from "../api";
import { listCards, listChats, createCard, updateCard, assignChatToCard, dismissFromBoard } from "../api";
import { useMetadataVersion } from "../contexts/SessionContext";
import { getBoardClosedExpanded, saveBoardClosedExpanded, getBoardInboxExpanded, saveBoardInboxExpanded } from "../utils/localStorage";
import CardTile from "../components/board/CardTile";
import CardDrawer from "../components/board/CardDrawer";
import CardPicker from "../components/board/CardPicker";
import InboxRow from "../components/board/InboxRow";
import NewCardModal from "../components/board/NewCardModal";
import { Plus, ChevronRight, ChevronDown, ChevronLeft, LayoutGrid, Inbox } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

/** How many recent non-triggered chats to consider for the inbox. */
const INBOX_FETCH_LIMIT = 30;

type Section = { key: string; label: string; cards: CardSummary[] };

export default function Board() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const metadataVersion = useMetadataVersion();
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [inboxChats, setInboxChats] = useState<Chat[] | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [pickerChatId, setPickerChatId] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(() => getBoardClosedExpanded());
  const [inboxExpanded, setInboxExpanded] = useState(() => getBoardInboxExpanded());
  const [showNewCard, setShowNewCard] = useState(false);

  const loadCards = useCallback(async () => {
    try {
      const res = await listCards();
      setCards(res.cards);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load board");
    } finally {
      setLoaded(true);
    }
  }, []);

  // The inbox scans every session file server-side (boardInbox filters out
  // carded/dismissed chats before windowing), which is the slowest query on
  // the page — so it only runs while the section is expanded.
  const loadInbox = useCallback(async () => {
    setInboxLoading(true);
    try {
      const res = await listChats(INBOX_FETCH_LIMIT, 0, undefined, true, undefined, undefined, true);
      setInboxChats(res.chats);
    } catch (err: any) {
      setError(err.message || "Failed to load inbox");
    } finally {
      setInboxLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCards();
    if (getBoardInboxExpanded()) loadInbox();
  }, [loadCards, loadInbox]);

  // Refetch shortly after any chat/card metadata change (same debounce as the sidebar).
  useEffect(() => {
    if (metadataVersion === 0) return;
    const timer = setTimeout(() => {
      loadCards();
      if (inboxExpanded) loadInbox();
    }, 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, loadCards, loadInbox, inboxExpanded]);

  const toggleInbox = () => {
    const next = !inboxExpanded;
    setInboxExpanded(next);
    saveBoardInboxExpanded(next);
    if (next && inboxChats === null) loadInbox();
  };

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
      (inboxChats ?? []).filter((chat) => {
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

  /** Refresh after a mutation — the inbox only when it's showing. */
  const refresh = useCallback(async () => {
    await Promise.all([loadCards(), inboxExpanded ? loadInbox() : Promise.resolve()]);
  }, [loadCards, loadInbox, inboxExpanded]);

  const promoteChat = async (chat: Chat) => {
    try {
      const res = await createCard({ title: chatTitle(chat).slice(0, 120) }, chat.id);
      setOpenCardId(res.card.id);
      await refresh();
    } catch (err: any) {
      setError(err.message || "Failed to create card");
    }
  };

  // "New card" drafts locally in a modal; the card is only created on save.
  const createFromModal = async (payload: CardPayload) => {
    try {
      const res = await createCard(payload);
      setShowNewCard(false);
      await loadCards();
      setOpenCardId(res.card.id);
    } catch (err: any) {
      setError(err.message || "Failed to create card");
      setShowNewCard(false);
    }
  };

  const assignFromPicker = async (cardId: string) => {
    if (!pickerChatId) return;
    try {
      await assignChatToCard(pickerChatId, cardId);
      setPickerChatId(null);
      await refresh();
    } catch (err: any) {
      setError(err.message || "Failed to assign chat");
    }
  };

  const createFromPicker = async (title: string) => {
    if (!pickerChatId) return;
    try {
      await createCard({ title }, pickerChatId);
      setPickerChatId(null);
      await refresh();
    } catch (err: any) {
      setError(err.message || "Failed to create card");
    }
  };

  const dismissChat = async (chat: Chat) => {
    try {
      await dismissFromBoard(chat.id, true);
      setInboxChats((prev) => (prev ? prev.filter((c) => c.id !== chat.id) : prev));
    } catch (err: any) {
      setError(err.message || "Failed to dismiss chat");
    }
  };

  const sectionHeader = (label: string, count: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--board-section-label-text)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</span>
      <span style={{ fontSize: 11, color: "var(--board-section-label-text)" }}>{count}</span>
    </div>
  );

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 10,
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: isMobile ? "14px 12px 48px" : "24px 24px 60px" }}>
        {/* Header — mobile gets the standard full-page back button (same
            convention as AgentList/Settings) since there's no sidebar. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: isMobile ? 16 : 24 }}>
          {isMobile && (
            <button
              onClick={() => navigate("/")}
              title="Back"
              style={{
                background: "none",
                border: "none",
                padding: "4px 8px",
                cursor: "pointer",
                color: "var(--text)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <LayoutGrid size={20} style={{ color: "var(--accent)" }} />
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", flex: 1 }}>Board</h1>
          <button
            onClick={() => setShowNewCard(true)}
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
              background: "var(--danger-bg)",
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
                No open cards. Create one, or open the inbox below to promote a recent chat.
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

            {/* Inbox — recent card-less chats. Collapsed by default and
                fetched only on expand: its server query scans every session
                file, the most expensive call on the page. */}
            <div style={{ marginBottom: 28 }}>
              <button
                onClick={toggleInbox}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 10,
                  color: "var(--board-section-label-text)",
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  cursor: "pointer",
                  background: "transparent",
                  padding: 0,
                }}
              >
                {inboxExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Inbox size={13} />
                Inbox
                {inboxChats !== null && <span style={{ fontWeight: 400 }}>{inbox.length}</span>}
              </button>
              {inboxExpanded &&
                (inboxLoading && inboxChats === null ? (
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading recent chats…</div>
                ) : inbox.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Inbox is clear — no un-filed recent chats.</div>
                ) : (
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
                ))}
            </div>

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

      {showNewCard && <NewCardModal onCreate={createFromModal} onClose={() => setShowNewCard(false)} />}
    </div>
  );
}
