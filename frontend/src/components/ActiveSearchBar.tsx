import { Search, X } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

interface ActiveSearchBarProps {
  /** The submitted query — not the draft in the search box. */
  query: string;
  /**
   * Chats that matched. Counted as matches, not rows: a matching parent and
   * fork share one tree card, so "chats" would disagree with what is on screen.
   */
  resultCount: number;
  /** The count is not final yet: the search, or the full list it filters, is still loading. */
  isSearching: boolean;
  /**
   * `fromKeyboard` is true when the button was activated from the keyboard
   * (it had focus and the click carries no pointer clicks), so the caller can
   * move focus somewhere useful without popping a mobile keyboard on a tap.
   */
  onClear: (fromKeyboard: boolean) => void;
  /** Horizontal padding, matching the filter bar above it. */
  inset: number;
}

/**
 * A one-line reminder, under the search box, that the list is narrowed by a
 * content search — and the way out of it. The search box alone does not say
 * so: its draft can differ from the query that produced the list, and a
 * submitted search stays in force after the box is scrolled past or edited.
 *
 * The strip it sits in (border, background, vertical rhythm) belongs to the
 * caller, because "Search all spaces" shares it.
 */
export default function ActiveSearchBar({ query, resultCount, isSearching, onClear, inset }: ActiveSearchBarProps) {
  const isMobile = useIsMobile();
  const count = isSearching ? "…" : `${resultCount} ${resultCount === 1 ? "match" : "matches"}`;
  // 28px matches the sidebar header's icon buttons; a finger gets 32.
  const buttonSize = isMobile ? 32 : 28;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        // The button's box, not its glyph, ends on the filter bar's right edge.
        padding: `0 ${inset}px`,
        fontSize: 13,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <Search size={13} style={{ flexShrink: 0 }} aria-hidden />
      {/* The live region is the text alone, so the button's label is not
          re-announced with it. A flex row so that only the query truncates:
          the count is the part that changes, and must stay readable. The
          `{" "}` nodes are not laid out in a flex container, but they keep
          the announced text one sentence. */}
      <span role="status" style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 4, whiteSpace: "nowrap" }}>
        <span style={{ flexShrink: 0 }}>Searching for</span>{" "}
        {/* The quotes sit outside the truncating span so a long query still
            reads as closed: "a long que…" rather than "a long que… */}
        <span style={{ display: "flex", minWidth: 0, color: "var(--text)", fontWeight: 500 }}>
          &quot;
          <span title={query} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {query}
          </span>
          &quot;
        </span>{" "}
        <span style={{ flexShrink: 0 }}>{`· ${count}`}</span>
      </span>
      <button
        type="button"
        className="active-search-clear"
        // `detail === 0` as well as focus: Chrome (Android included) focuses a
        // button on tap, so focus alone would not tell a tap from Enter/Space.
        onClick={(e) => onClear(e.detail === 0 && document.activeElement === e.currentTarget)}
        aria-label="Clear search"
        title="Clear search"
        style={{
          width: buttonSize,
          height: buttonSize,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          padding: 0,
          boxSizing: "border-box",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        <X size={isMobile ? 16 : 14} />
      </button>
    </div>
  );
}
