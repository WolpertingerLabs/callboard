import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, GitBranch } from "lucide-react";
import type { CardSummary } from "../api";
import { listCards } from "../api";
import { useMetadataVersion } from "../contexts/SessionContext";
import { useSpaces } from "../contexts/SpaceContext";
import BranchesView from "../components/git/BranchesView";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePolling } from "../hooks/usePolling";
import { errorMessage } from "../utils/errorMessage";

/**
 * The cards each space's Git page showed last, so reopening the page paints
 * its rows at once instead of waiting on the card list again. Keyed by space
 * ("" when spaces are off); a handful of spaces at most, but bounded anyway.
 */
const CARD_CACHE_LIMIT = 16;
const lastCards = new Map<string, CardSummary[]>();

/**
 * Forget every remembered card list. Called on logout: what one login saw
 * must not be what the next one is shown first.
 */
export function clearGitPageCache(): void {
  lastCards.clear();
}

/**
 * The Git page: every worktree that unarchived conversations are working in,
 * grouped by repository, with the conversations attached as chips.
 *
 * The page itself only holds the open cards (one per top-level conversation)
 * for the active space — `BranchesView` fetches the git overview and joins
 * its rows to these by id. The two requests go out together; neither waits
 * for the other. A chip opens the conversation's root chat.
 */
export default function Git() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const metadataVersion = useMetadataVersion();
  const { enabled: spacesEnabled, activeSpaceId } = useSpaces();
  const spaceKey = spacesEnabled && activeSpaceId ? activeSpaceId : "";
  const [cards, setCards] = useState<CardSummary[]>(() => lastCards.get(spaceKey) ?? []);
  const [loaded, setLoaded] = useState(() => lastCards.has(spaceKey));
  const [error, setError] = useState<string | null>(null);
  // Counts the card refetches a metadata change caused, once each has landed.
  const [cardsRefetched, setCardsRefetched] = useState(0);
  // Polls and metadata refetches can overlap; only the newest may land.
  const requestSeq = useRef(0);

  /** Resolves true when this request was still the newest as it settled. */
  const loadCards = useCallback(async (): Promise<boolean> => {
    const seq = ++requestSeq.current;
    try {
      // Only open cards become chips, so ask for no archived ones at all.
      // Scoped to the active space: a chip from another space would open a
      // chat the sidebar is not showing.
      const res = await listCards(false, { ...(spacesEnabled && activeSpaceId && { space: activeSpaceId }), lifecycle: "open" });
      if (seq !== requestSeq.current) return false;
      // A daemon older than the `lifecycle` parameter returns archived cards
      // too; BranchesView only chips open ones, so that is harmless.
      setCards(res.cards);
      lastCards.delete(spaceKey);
      lastCards.set(spaceKey, res.cards);
      while (lastCards.size > CARD_CACHE_LIMIT) lastCards.delete(lastCards.keys().next().value as string);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return false;
      setError(errorMessage(err, "Failed to load conversations"));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
    return true;
  }, [spacesEnabled, activeSpaceId, spaceKey]);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  // Refetch shortly after any chat/card metadata change (same debounce as the sidebar).
  useEffect(() => {
    if (metadataVersion === 0) return;
    // The overview is asked again only once these cards have settled (even
    // if they failed): told at the change itself, it would be asked once now
    // and again when a changed card list landed.
    const timer = setTimeout(() => {
      void loadCards().then((newest) => {
        if (newest) setCardsRefetched((n) => n + 1);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, loadCards]);

  // Rollup states also change WITHOUT a metadata event (a session starting or
  // stopping bumps the session version, not metadataVersion), so poll every
  // 15s as a safety net. Skipped while the tab is hidden; a visibility change
  // refreshes immediately to catch up.
  usePolling(() => loadCards(), 15_000);

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: isMobile ? "14px 12px 48px" : "24px 24px 60px" }}>
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
          <GitBranch size={20} style={{ color: "var(--accent-text)" }} />
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", flex: 1 }}>Git</h1>
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

        {/* Mounted at once, so the overview is asked for alongside the cards
            rather than after them. */}
        <BranchesView cards={cards} cardsLoaded={loaded} reloadToken={cardsRefetched} onOpenChat={(chatId) => navigate(`/chat/${chatId}`)} />
      </div>
    </div>
  );
}
