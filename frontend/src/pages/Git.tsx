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
 * The Git page: every worktree that unarchived conversations are working in,
 * grouped by repository, with the conversations attached as chips.
 *
 * The page itself only holds the open cards (one per top-level conversation)
 * for the active space — `BranchesView` fetches the git overview and joins
 * its rows to these by id. A chip opens the conversation's root chat.
 */
export default function Git() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const metadataVersion = useMetadataVersion();
  const { enabled: spacesEnabled, activeSpaceId } = useSpaces();
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Polls and metadata refetches can overlap; only the newest may land.
  const requestSeq = useRef(0);

  const loadCards = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      // Only open cards become chips, so ask for no archived ones at all.
      // Scoped to the active space: a chip from another space would open a
      // chat the sidebar is not showing.
      const res = await listCards(false, { closedLimit: 0 }, spacesEnabled && activeSpaceId ? { space: activeSpaceId } : {});
      if (seq !== requestSeq.current) return;
      setCards(res.cards);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(errorMessage(err, "Failed to load conversations"));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  }, [spacesEnabled, activeSpaceId]);

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

        {!loaded ? (
          <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading…</div>
        ) : (
          <BranchesView cards={cards} onOpenChat={(chatId) => navigate(`/chat/${chatId}`)} />
        )}
      </div>
    </div>
  );
}
