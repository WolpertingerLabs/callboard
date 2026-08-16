import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { CardSummary, CardPatch, CardPayload } from "../api";
import { listCards, createCard, updateCard, deleteCard, bulkSetCardLifecycle } from "../api";
import { useMetadataVersion } from "../contexts/SessionContext";
import { getBoardClosedExpanded, saveBoardClosedExpanded } from "../utils/localStorage";
import { uniqueCategories } from "../utils/cardCategories";
import CardTile from "../components/board/CardTile";
import BoardSelectionBar from "../components/board/BoardSelectionBar";
import CardDrawer from "../components/board/CardDrawer";
import NewCardModal from "../components/board/NewCardModal";
import { Plus, ChevronRight, ChevronDown, ChevronLeft, LayoutGrid } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

type Section = { key: string; label: string; cards: CardSummary[] };

/** Higher = more urgent; used to order cards inside a category group. */
const ROLLUP_RANK: Record<CardSummary["rollup"], number> = { needs_you: 3, job_running: 2, active: 1, idle: 0 };

/**
 * Pinned first, then urgency, then activity. Two idle cards sort STALEST
 * first — the same nudge-to-close-out the ungrouped Idle section applies —
 * while anything live sorts freshest first.
 */
function sortWithinCategory(cards: CardSummary[]): CardSummary[] {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (ROLLUP_RANK[a.rollup] !== ROLLUP_RANK[b.rollup]) return ROLLUP_RANK[b.rollup] - ROLLUP_RANK[a.rollup];
    if (a.rollup === "idle" && b.rollup === "idle") return a.lastActivityAt.localeCompare(b.lastActivityAt);
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

/** Rank of the most urgent card in a group — decides where the group sorts. */
function peakUrgency(cards: CardSummary[]): number {
  return cards.reduce((max, c) => Math.max(max, ROLLUP_RANK[c.rollup]), 0);
}


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

  // Multi-select. Deliberately NOT persisted: a stale selection restored
  // across a reload is a way to act on the wrong cards.
  const [rawSelectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Non-null IS "in selection mode", and it scopes the selection to one
  // lifecycle. That scoping is what lets the action bar offer exactly one
  // verb — "Close 5" — instead of "Close 3 / Reopen 2", which is a small
  // puzzle every time. It costs little because closed cards already live in
  // their own collapsed strip.
  const [selectionLifecycle, setSelectionLifecycle] = useState<CardSummary["lifecycle"] | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

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
  // Sorted HERE rather than inline in the JSX, so the shift+click range order
  // and the render order are the same array by construction. Deriving the
  // order separately from what is on screen means shift+click eventually
  // selects a range the user never saw, and that drift stays invisible until
  // someone reorders a section.
  const closed = cards.filter((c) => c.lifecycle === "closed").sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  // Datalist suggestions for the category inputs — includes closed cards so a
  // category doesn't vanish from autocomplete when its last open card closes.
  const knownCategories = uniqueCategories(cards);

  // Open cards group by category once any card has one; uncategorized cards
  // collect in an "Uncategorized" group. With no categories at all, keep the
  // classic urgency sections.
  //
  // Groups are ordered by their most urgent card, NOT alphabetically: a card
  // needing you must stay near the top of the board, and alphabetical order
  // would happily bury it under an unrelated category. Alphabetical is only
  // the tie-break between equally-urgent groups. Uncategorized sorts by the
  // same rule so it isn't pinned to the bottom while holding a blocked chat.
  const openCategories = uniqueCategories(open);
  const sections: Section[] =
    openCategories.length > 0
      ? [
          ...openCategories.map((category) => ({
            key: `category:${category}`,
            label: category,
            cards: sortWithinCategory(open.filter((c) => c.category === category)),
          })),
          { key: "category:none", label: "Uncategorized", cards: sortWithinCategory(open.filter((c) => !c.category)) },
        ]
          .filter((section) => section.cards.length > 0)
          .sort((a, b) => {
            // Peak urgency, not cards[0] — a pinned idle card can lead a group
            // that also holds the one card blocked on you.
            const urgency = peakUrgency(b.cards) - peakUrgency(a.cards);
            return urgency !== 0 ? urgency : a.label.localeCompare(b.label);
          })
      : [
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

  // The one order that shift+click ranges are read from — flattened out of
  // the very arrays rendered above, open sections first then the closed strip.
  // Ranges cross section boundaries, matching Finder and Explorer.
  const orderedIds = [...sections.flatMap((s) => s.cards.map((c) => c.id)), ...closed.map((c) => c.id)];

  /**
   * The selection, reconciled against the cards that actually exist — derived
   * on every render rather than repaired in an effect after each fetch.
   *
   * The board polls every 15s, so a card another client deleted (or closed out
   * from under an open-scoped selection) would otherwise leave a selected id
   * with no tile behind it, and a count the user cannot reconcile with what is
   * on screen. Deriving it means there is no second copy to fall out of step:
   * the dead id is gone the moment the poll returns, and it can never reach the
   * bulk call.
   */
  const selectedIds = new Set([...rawSelectedIds].filter((id) => cards.some((c) => c.id === id && c.lifecycle === selectionLifecycle)));
  // Losing every selected card to that reconciliation also leaves selection
  // mode — an action bar over an empty selection has nothing to act on.
  const selectionMode = selectionLifecycle !== null && selectedIds.size > 0;

  const exitSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionLifecycle(null);
    setAnchorId(null);
  }, []);

  /**
   * Long press or context menu. Idempotent — both triggers can fire for one gesture.
   *
   * Neither this nor toggleSelect re-checks the lifecycle scope. That rule is
   * enforced in exactly one place, `selectionProps` below, which both disables
   * an out-of-scope tile and withholds its gesture handler. A second copy of
   * the check here would be unreachable, and unreachable guards are the kind
   * that quietly stop matching the one that actually runs.
   */
  const enterSelection = (card: CardSummary) => {
    setSelectionLifecycle(card.lifecycle);
    // Built from the reconciled set, never from the raw one, so ids left over
    // from a selection that has already lapsed cannot rejoin this gesture.
    // The pressed tile starts selected, so the count is never 0 on entry.
    setSelectedIds(new Set(selectedIds).add(card.id));
    setAnchorId(card.id);
  };

  const toggleSelect = (card: CardSummary, e: React.MouseEvent) => {
    const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
    const targetIndex = orderedIds.indexOf(card.id);
    if (e.shiftKey && anchorIndex !== -1 && targetIndex !== -1) {
      const [lo, hi] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      // No lifecycle filter is needed on the slice: orderedIds lists every open
      // card before every closed one, and an out-of-scope tile is inert, so
      // neither end of this range can be one. Nothing out of scope can lie
      // between two cards that are both in it.
      const next = new Set([...selectedIds, ...orderedIds.slice(lo, hi + 1)]);
      setSelectedIds(next);
      setSelectionLifecycle(card.lifecycle);
      // The anchor stays put across successive shift+clicks, as in Finder.
      return;
    }

    const next = new Set(selectedIds);
    if (next.has(card.id)) next.delete(card.id);
    else next.add(card.id);
    setSelectedIds(next);
    setSelectionLifecycle(card.lifecycle);
    // Deselecting the last card leaves selection mode by derivation, since
    // selectionMode requires a non-empty selection. The anchor has to go with
    // it explicitly though: left behind, the next shift+click would extend a
    // range from a card the user has already deselected.
    setAnchorId(next.size === 0 ? null : card.id);
  };

  const selectionProps = (card: CardSummary) => {
    const inScope = !selectionMode || selectionLifecycle === card.lifecycle;
    return {
      selectionMode,
      selected: selectedIds.has(card.id),
      selectable: inScope,
      onToggleSelect: (e: React.MouseEvent) => toggleSelect(card, e),
      onLongPress: inScope ? () => enterSelection(card) : undefined,
    };
  };

  useEffect(() => {
    if (!selectionMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "Escape") {
        exitSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedIds(new Set(cards.filter((c) => c.lifecycle === selectionLifecycle).map((c) => c.id)));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectionMode, selectionLifecycle, cards, exitSelection]);

  /**
   * No confirmation and no undo, by decision: close is reversible, its inverse
   * is one gesture away, and the closed strip is on the same screen. A modal
   * on a reversible bulk action only trains people to dismiss modals.
   */
  const runBulkLifecycle = async () => {
    if (selectionLifecycle === null || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const target = selectionLifecycle === "open" ? "closed" : "open";
    setBulkBusy(true);
    try {
      const res = await bulkSetCardLifecycle(ids, target);
      const updatedById = new Map(res.updated.map((c) => [c.id, c]));
      setCards((prev) => prev.map((c) => updatedById.get(c.id) ?? c));
      const failed = res.failed ?? [];
      if (failed.length > 0) {
        // Exactly the failed ids stay selected: retrying those is the user's
        // next move, so leaving them selected is the useful state.
        setSelectedIds(new Set(failed.map((f) => f.id)));
        setAnchorId(null);
        setError(`${failed.length} of ${ids.length} cards could not be updated`);
      } else {
        setError(null);
        exitSelection();
      }
    } catch (err: any) {
      setError(err.message || "Failed to update cards");
    } finally {
      setBulkBusy(false);
    }
  };

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

  /** Permanent removal — only offered on closed cards (the server enforces it too). */
  const removeCard = async (cardId: string) => {
    try {
      await deleteCard(cardId);
      setCards((prev) => prev.filter((c) => c.id !== cardId));
      setOpenCardId(null);
    } catch (err: any) {
      setError(err.message || "Failed to delete card");
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
      {/* The fixed selection bar sits over the last row of tiles, so the page
          has to give it room while it is up. */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: isMobile ? `14px 12px ${selectionMode ? 120 : 48}px` : `24px 24px ${selectionMode ? 132 : 60}px` }}>
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
          <LayoutGrid size={20} style={{ color: "var(--accent-text)" }} />
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
                        <CardTile key={card.id} card={card} onClick={() => setOpenCardId(card.id)} {...selectionProps(card)} />
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
                    {closed.map((card) => (
                      <CardTile key={card.id} card={card} onClick={() => setOpenCardId(card.id)} {...selectionProps(card)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {openCard && (
        <CardDrawer
          card={openCard}
          categories={knownCategories}
          onPatch={(patch) => patchCard(openCard.id, patch)}
          onDelete={() => removeCard(openCard.id)}
          onClose={() => setOpenCardId(null)}
        />
      )}

      {showNewCard && <NewCardModal categories={knownCategories} onCreate={createFromModal} onClose={() => setShowNewCard(false)} />}

      {selectionMode && (
        <BoardSelectionBar
          count={selectedIds.size}
          actions={[
            {
              key: "lifecycle",
              label: selectionLifecycle === "open" ? `Close ${selectedIds.size}` : `Reopen ${selectedIds.size}`,
              onRun: runBulkLifecycle,
            },
          ]}
          onCancel={exitSelection}
          busy={bulkBusy}
        />
      )}
    </div>
  );
}
