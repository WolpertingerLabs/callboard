import { X } from "lucide-react";

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
  onClear: () => void;
  /** Horizontal padding, matching the filter bar above it. */
  inset: number;
}

/**
 * A one-line reminder, under the search box, that the list is narrowed by a
 * content search — and the way out of it. The search box alone does not say
 * so: its draft can differ from the query that produced the list, and a
 * submitted search stays in force after the box is scrolled past or edited.
 */
export default function ActiveSearchBar({ query, resultCount, isSearching, onClear, inset }: ActiveSearchBarProps) {
  const count = isSearching ? "…" : `${resultCount} ${resultCount === 1 ? "match" : "matches"}`;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: `0 ${inset}px 6px`,
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      {/* The live region is the text alone, so the button's label is not re-announced with it. */}
      <span role="status" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={query}>
        {`Searching for "${query}" · ${count}`}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear search"
        title="Clear search"
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          padding: 2,
          border: "none",
          borderRadius: 4,
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
