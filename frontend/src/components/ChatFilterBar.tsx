import { useState } from "react";
import { Bookmark, SlidersHorizontal, Search, Loader2, Zap } from "lucide-react";
import ChatFilterModal from "./ChatFilterModal";
import { hasActiveFilters, type ChatFilters } from "../types/chatFilters";

interface ChatFilterBarProps {
  bookmarkFilter: boolean;
  onToggleBookmark: () => void;
  showTriggered: boolean;
  onToggleTriggered: () => void;
  filters: ChatFilters;
  onFiltersChange: (filters: ChatFilters) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchSubmit: () => void;
  isSearching: boolean;
}

export default function ChatFilterBar({
  bookmarkFilter,
  onToggleBookmark,
  showTriggered,
  onToggleTriggered,
  filters,
  onFiltersChange,
  searchQuery,
  onSearchChange,
  onSearchSubmit,
  isSearching,
}: ChatFilterBarProps) {
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const filtersActive = hasActiveFilters(filters);

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
        {/* Bookmark toggle */}
        <button
          onClick={onToggleBookmark}
          style={{
            background: bookmarkFilter ? "var(--accent)" : "var(--bg-secondary)",
            color: bookmarkFilter ? "#fff" : "var(--text)",
            padding: "8px",
            borderRadius: 6,
            border: bookmarkFilter ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={bookmarkFilter ? "Show all chats" : "Show bookmarked chats"}
        >
          <Bookmark size={16} fill={bookmarkFilter ? "currentColor" : "none"} />
        </button>

        {/* Triggered chats toggle */}
        <button
          onClick={onToggleTriggered}
          style={{
            background: showTriggered ? "var(--accent)" : "var(--bg-secondary)",
            color: showTriggered ? "#fff" : "var(--text)",
            padding: "8px",
            borderRadius: 6,
            border: showTriggered ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={showTriggered ? "Hide triggered chats" : "Show triggered chats"}
        >
          <Zap size={16} fill={showTriggered ? "currentColor" : "none"} />
        </button>

        {/* Filter button */}
        <button
          onClick={() => setFilterModalOpen(true)}
          style={{
            background: filtersActive ? "var(--accent)" : "var(--bg-secondary)",
            color: filtersActive ? "#fff" : "var(--text)",
            padding: "8px",
            borderRadius: 6,
            border: filtersActive ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title="Advanced filters"
        >
          <SlidersHorizontal size={16} />
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

      <ChatFilterModal isOpen={filterModalOpen} onClose={() => setFilterModalOpen(false)} filters={filters} onApply={onFiltersChange} />
    </>
  );
}
