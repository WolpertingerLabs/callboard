import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { CardSummary, CardPatch } from "../api";
import { listCards, updateCard, bulkSetCardLifecycle } from "../api";
import { useMetadataVersion } from "../contexts/SessionContext";
import { getBoardClosedExpanded, saveBoardClosedExpanded } from "../utils/localStorage";
import { uniqueCategories } from "../utils/cardCategories";
import CardTile from "../components/board/CardTile";
import BoardSelectionBar from "../components/board/BoardSelectionBar";
import CardDrawer from "../components/board/CardDrawer";
import { ChevronRight, ChevronDown, ChevronLeft, LayoutGrid } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

/** A category's cards inside one status section. `label: null` is uncategorized. */
type Group = { key: string; label: string | null; cards: CardSummary[] };
type Section = { key: string; label: string; groups: Group[]; count: number };

/** Higher = more urgent; used to order cards inside a group. */
const ROLLUP_RANK: Record<CardSummary["rollup"], number> = { needs_you: 3, job_running: 2, active: 1, idle: 0 };

/** Rank of one card, tolerating a rollup value this bundle predates. */
const rank = (card: CardSummary): number => ROLLUP_RANK[card.rollup] ?? 0;

/** The rollups that are NOT idle — the live half of the board. */
const LIVE_ROLLUPS: CardSummary["rollup"][] = ["needs_you", "job_running", "active"];

/**
 * The status sections, in board order. Status is the OUTER grouping and
 * category the inner one, never the other way around: the question the board
 * answers first is "what needs me", and a category split at the top level
 * scatters that answer across every group on screen. Category still earns its
 * place — but as a sub-heading inside the bucket, where it tells you which
 * area an idle pile belongs to without hiding the pile itself.
 *
 * Idle is the RESIDUAL bucket, not an equality test on "idle". A tab can be
 * running a bundle older than the daemon it talks to, so a rollup value added
 * server-side must land somewhere: matched exactly, a fifth value would drop
 * those cards off the board entirely, which is the one outcome worse than
 * filing them under the wrong heading.
 */
const BUCKETS: { key: string; label: string; match: (c: CardSummary) => boolean }[] = [
  { key: "needs_you", label: "Needs you", match: (c) => c.rollup === "needs_you" },
  { key: "running", label: "Running", match: (c) => c.rollup === "job_running" || c.rollup === "active" },
  { key: "idle", label: "Idle", match: (c) => !LIVE_ROLLUPS.includes(c.rollup) },
];

/**
 * Pinned first, then urgency, then activity. Two idle cards sort STALEST
 * first — a gentle nudge to close out or kick forward — while anything live
 * sorts freshest first.
 *
 * The direction branches on the RANK, not on `rollup === "idle"`. Ranks are
 * already equal by the time it is reached, so rank 0 means "both sit in the
 * Idle section" — which, since that section is residual, includes a rollup
 * value this bundle predates. Branching on the string instead would compare
 * (idle, idle) stalest-first and (idle, unknown) freshest-first, and a
 * comparator that disagrees with itself across a set is not merely wrong once:
 * it makes the rendered order a function of the order the server happened to
 * return the cards in.
 */
function sortCards(cards: CardSummary[]): CardSummary[] {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    if (rank(a) === 0) return a.lastActivityAt.localeCompare(b.lastActivityAt);
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

/** Rank of the most urgent card in a group — decides where the group sorts. */
function peakUrgency(cards: CardSummary[]): number {
  return cards.reduce((max, c) => Math.max(max, rank(c)), 0);
}

/**
 * The stalest card in a group.
 *
 * Deliberately NOT `cards[0]`, which a pin can occupy: a pinned card is where
 * the user parked something, and letting it stand in for the group's age would
 * make pinning silently reorder the categories around it.
 */
function stalestActivity(cards: CardSummary[]): string {
  return cards.reduce((oldest, c) => (c.lastActivityAt.localeCompare(oldest) < 0 ? c.lastActivityAt : oldest), cards[0].lastActivityAt);
}

/**
 * Split one status section's cards by category.
 *
 * Groups lead with peak urgency, then — in the Idle section only — with their
 * stalest card, so the most neglected category leads the pile the same way the
 * most neglected card leads its group. That is the whole point of the section,
 * and it is stable there: an idle card is by definition not accruing activity.
 *
 * The live sections fall straight through to alphabetical instead. Keying them
 * on activity would re-sort whole blocks of tiles under the cursor on every
 * 15s poll, which moves a different card under a click already on its way —
 * and it buys little, since a header reading "Running" has already said the
 * one thing recency would add. Uncategorized loses the alphabetical tie: it is
 * a residue, not a category, so it reads better after the named ones when
 * nothing else separates them. Note it can still lead a section outright on
 * urgency or staleness — it is never pinned to the bottom.
 */
function groupByCategory(cards: CardSummary[], categories: string[], orderByStaleness: boolean): Group[] {
  const groups = [
    ...categories.map((category) => ({ key: `category:${category}`, label: category, cards: cards.filter((c) => c.category === category) })),
    { key: "category:none", label: null, cards: cards.filter((c) => !c.category) },
  ].filter((group) => group.cards.length > 0);

  // Sort keys are computed once per group rather than inside the comparator,
  // which would recompute both on every comparison.
  return groups
    .map((group) => {
      const sorted = sortCards(group.cards);
      return { group: { ...group, cards: sorted }, urgency: peakUrgency(sorted), stalest: stalestActivity(sorted) };
    })
    .sort((a, b) => {
      if (a.urgency !== b.urgency) return b.urgency - a.urgency;
      if (orderByStaleness) {
        const activity = a.stalest.localeCompare(b.stalest);
        if (activity !== 0) return activity;
      }
      if (a.group.label === null || b.group.label === null) return a.group.label === null ? 1 : -1;
      return a.group.label.localeCompare(b.group.label);
    })
    .map((entry) => entry.group);
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

  // Open cards always split by status first; category subdivides each status
  // section once any open card carries one.
  const openCategories = uniqueCategories(open);
  const sections: Section[] = BUCKETS.map((bucket) => {
    const cards = open.filter(bucket.match);
    return { key: bucket.key, label: bucket.label, groups: groupByCategory(cards, openCategories, bucket.key === "idle"), count: cards.length };
  }).filter((section) => section.count > 0);
  // Sub-headings are suppressed for a section whose cards are all
  // uncategorized — an "Uncategorized" heading over the whole section says
  // nothing the section header didn't. A lone *named* group still shows its
  // name, so a category never silently disappears from the board.
  const showsGroupLabel = (section: Section) => section.groups.length > 1 || section.groups[0].label !== null;

  const openCard = openCardId ? cards.find((c) => c.id === openCardId) : undefined;

  // The one order that shift+click ranges are read from — flattened out of
  // the very arrays rendered above, open sections first then the closed strip.
  // Ranges cross section boundaries, matching Finder and Explorer.
  const orderedIds = [...sections.flatMap((s) => s.groups.flatMap((g) => g.cards.map((c) => c.id))), ...closed.map((c) => c.id)];

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

  // Real headings, not styled spans: status and category are a two-level
  // hierarchy now, and h2/h3 under the page's h1 is what lets a screen reader
  // walk it. It doubles as the handle the grouping tests read the outline
  // through, so the order on screen is asserted through the same structure a
  // user navigates.
  const sectionHeader = (label: string, count: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span role="heading" aria-level={2} style={{ fontSize: 12, fontWeight: 700, color: "var(--board-section-label-text)", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: "var(--board-section-label-text)" }}>{count}</span>
    </div>
  );

  // Deliberately quieter than the status header above it — not uppercase, not
  // bold — so a glance still lands on the status band first and only then
  // reads the categories inside it.
  const groupHeader = (label: string | null, count: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
      <span role="heading" aria-level={3} style={{ fontSize: 12, fontWeight: 600, color: label === null ? "var(--board-group-label-muted-text)" : "var(--board-group-label-text)" }}>
        {label ?? "Uncategorized"}
      </span>
      <span style={{ fontSize: 11, color: "var(--board-section-label-text)" }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: "var(--board-group-rule)" }} />
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
                No open cards. Start a chat — every top-level conversation is a card.
              </div>
            )}

            {sections.map((section) => (
              <div key={section.key} style={{ marginBottom: 28 }}>
                {sectionHeader(section.label, section.count)}
                {section.groups.map((group, i) => (
                  <div key={group.key} style={{ marginBottom: i === section.groups.length - 1 ? 0 : 18 }}>
                    {showsGroupLabel(section) && groupHeader(group.label, group.cards.length)}
                    <div style={grid}>
                      {group.cards.map((card) => (
                        <CardTile key={card.id} card={card} onClick={() => setOpenCardId(card.id)} {...selectionProps(card)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}

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
          onClose={() => setOpenCardId(null)}
        />
      )}


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
