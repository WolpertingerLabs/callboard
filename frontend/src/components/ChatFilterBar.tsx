import { useState } from "react";
import { SlidersHorizontal, Search, Loader2 } from "lucide-react";
import ChatFilterModal from "./ChatFilterModal";
import { activeFilterCount, activeViewOptionCount, type ChatFilters, type ChatViewOptions } from "../types/chatFilters";

interface ChatFilterBarProps {
  filters: ChatFilters;
  viewOptions: ChatViewOptions;
  onApply: (filters: ChatFilters, viewOptions: ChatViewOptions) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchSubmit: () => void;
  isSearching: boolean;
}

/**
 * Sidebar filter bar: one button that opens the filters modal, and the content
 * search box.
 *
 * Scope and layout toggles (bookmarks, triggered chats, cards-only, tree
 * layout) used to sit here as a row of icon buttons. They live in the modal
 * now — a rail of same-sized icons gave no clue what any of them did, and the
 * row grew every time a new dimension appeared. The badge keeps the one thing
 * the rail was actually good at: telling you at a glance that the list you're
 * looking at is narrowed.
 */
export default function ChatFilterBar({ filters, viewOptions, onApply, searchQuery, onSearchChange, onSearchSubmit, isSearching }: ChatFilterBarProps) {
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const activeCount = activeFilterCount(filters) + activeViewOptionCount(viewOptions);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSearchSubmit();
    }
  };

  return (
    <>
      <div
        style={{
          padding: "8px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {/* Filters + view options */}
        <button
          onClick={() => setFilterModalOpen(true)}
          style={{
            position: "relative",
            background: activeCount > 0 ? "var(--accent)" : "var(--bg-secondary)",
            color: activeCount > 0 ? "var(--text-on-accent)" : "var(--text)",
            padding: "8px",
            borderRadius: 6,
            border: activeCount > 0 ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={activeCount > 0 ? `Filters and view (${activeCount} active)` : "Filters and view"}
        >
          <SlidersHorizontal size={16} />
          {activeCount > 0 && (
            <span
              style={{
                position: "absolute",
                top: -5,
                right: -5,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 999,
                background: "var(--surface)",
                color: "var(--accent-text)",
                border: "1px solid var(--border)",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: "14px",
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {activeCount}
            </span>
          )}
        </button>

        {/* Search input with search button on the right */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "0 0 0 8px",
            minWidth: 0,
          }}
        >
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search chat contents..."
            style={{
              flex: 1,
              padding: "7px 8px",
              border: "none",
              background: "transparent",
              fontSize: 13,
              color: "var(--text)",
              outline: "none",
              minWidth: 0,
            }}
          />
          <button
            onClick={onSearchSubmit}
            disabled={isSearching}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              padding: "7px 8px",
              background: "transparent",
              border: "none",
              borderLeft: "1px solid var(--border)",
              borderTopRightRadius: 5,
              borderBottomRightRadius: 5,
              cursor: isSearching ? "default" : "pointer",
              opacity: isSearching ? 0.4 : 0.6,
              color: "var(--text)",
              transition: "opacity 0.2s",
            }}
            title="Search"
          >
            {isSearching ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Search size={14} />}
          </button>
        </div>
      </div>

      {/* Spin animation for Loader2 */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Mounted only while open so each open re-seeds from the live values. */}
      {filterModalOpen && <ChatFilterModal onClose={() => setFilterModalOpen(false)} filters={filters} viewOptions={viewOptions} onApply={onApply} />}
    </>
  );
}
