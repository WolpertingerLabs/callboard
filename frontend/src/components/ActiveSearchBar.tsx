import { X } from "lucide-react";

interface ActiveSearchBarProps {
  /** The submitted query — not the draft in the search box. */
  query: string;
  /** Chats the list is showing for this query. */
  resultCount: number;
  /** A request for this query is in flight; the count is not meaningful yet. */
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
  const count = isSearching ? "…" : `${resultCount} ${resultCount === 1 ? "chat" : "chats"}`;
  return (
    <div
      role="status"
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
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={query}>
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
