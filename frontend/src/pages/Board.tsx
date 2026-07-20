import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { CardSummary, CardPatch, CardPayload } from "../api";
import { listCards, createCard, updateCard } from "../api";
import { useMetadataVersion } from "../contexts/SessionContext";
import { getBoardClosedExpanded, saveBoardClosedExpanded } from "../utils/localStorage";
import CardTile from "../components/board/CardTile";
import CardDrawer from "../components/board/CardDrawer";
import NewCardModal from "../components/board/NewCardModal";
import { Plus, ChevronRight, ChevronDown, ChevronLeft, LayoutGrid } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

type Section = { key: string; label: string; cards: CardSummary[] };

export default function Board() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const metadataVersion = useMetadataVersion();
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(() => getBoardClosedExpanded());
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

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  // Refetch shortly after any chat/card metadata change (same debounce as the sidebar).
  useEffect(() => {
    if (metadataVersion === 0) return;
    const timer = setTimeout(() => loadCards(), 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, loadCards]);

  // Rollup states also change WITHOUT a metadata event (a session starting or
  // stopping bumps the session version, not metadataVersion), so poll the
  // cards every 15s as a safety net. Skipped while the tab is hidden; a
  // visibility change refreshes immediately to catch up.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) loadCards();
    }, 15_000);
    const onVisible = () => {
      if (!document.hidden) loadCards();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadCards]);

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

  const openCard = openCardId ? cards.find((c) => c.id === openCardId) : undefined;

  /** Resolves false when the patch was rejected, so callers can keep their editor open. */
  const patchCard = async (cardId: string, patch: CardPatch): Promise<boolean> => {
    try {
      const res = await updateCard(cardId, patch);
      setCards((prev) => prev.map((c) => (c.id === cardId ? res.card : c)));
      return true;
    } catch (err: any) {
      setError(err.message || "Failed to update card");
      return false;
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
                No open cards. Create one, or use a chat&rsquo;s ⋮ menu in the sidebar to promote it to a card.
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

      {showNewCard && <NewCardModal onCreate={createFromModal} onClose={() => setShowNewCard(false)} />}
    </div>
  );
}
