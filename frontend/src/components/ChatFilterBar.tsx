import { useState } from "react";
import { SlidersHorizontal, Search, Loader2, Archive } from "lucide-react";
import ChatFilterModal from "./ChatFilterModal";
import { activeFilterCount, activeViewOptionCount, type ChatFilters, type ChatViewOptions } from "../types/chatFilters";

interface ChatFilterBarProps {
  filters: ChatFilters;
  viewOptions: ChatViewOptions;
  /**
   * Commit filters and view options. The modal calls this behind its Apply
   * button; the "Archived" toggle here calls it straight from the click — see
   * the note on that button.
   */
  onApply: (filters: ChatFilters, viewOptions: ChatViewOptions) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchSubmit: () => void;
  isSearching: boolean;
}

/**
 * Sidebar filter bar: the button that opens the filters modal, the archived
 * scope toggle, and the content search box.
 *
 * Scope toggles (bookmarks, triggered chats, cards-only) used to sit here as a
 * row of same-sized icon buttons, and were moved into the modal on two counts:
 * that rail gave no clue what any of them did, and it grew every time a new
 * dimension appeared. The archived toggle is back out here as an icon, which
 * means only ONE of those two objections has been answered — and it is worth
 * being straight about which.
 *
 * Answered: the growth. This is one control, not a rail, and the bar is closed
 * to a second — anything that needs a companion control belongs in the modal,
 * where a label and a hint fit. It earns the slot because it is flipped more
 * often than everything in the modal put together: most of the chats on a real
 * data dir are on archived cards, so this is the difference between a sidebar
 * showing a handful of rows and one showing all of them.
 *
 * NOT answered: legibility. This shipped briefly with an "Archived" text label
 * for exactly that reason, and the label was dropped deliberately in favour of
 * a compact bar — at the 350px minimum sidebar width it was taking about 90px
 * from the search field. So the icon, `aria-pressed` and the tooltip now carry
 * the whole meaning, and the honest cost is that a first-time user has to
 * hover to find out what the icon does. That is a chosen tradeoff, not an
 * oversight; anyone reopening it should know the label existed and why it went,
 * rather than rediscovering the argument from scratch. The accessible name
 * lives in `aria-label` so that stripping the text costs a screen reader
 * nothing.
 *
 * The badge on the modal button keeps the one thing the rail was good at:
 * telling you at a glance that the list is narrowed. It deliberately does not
 * count `showArchived` — that state is visible right here, and a badge on a
 * modal that contains nothing to look at would send the user hunting.
 */
export default function ChatFilterBar({ filters, viewOptions, onApply, searchQuery, onSearchChange, onSearchSubmit, isSearching }: ChatFilterBarProps) {
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const activeCount = activeFilterCount(filters) + activeViewOptionCount(viewOptions);
  const { showArchived } = viewOptions;

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

        {/* Archived scope.

            Committed on the click, with no Apply: that is not an oversight, it
            is the reason this control was pulled out of the modal. `onApply` is
            the same commit path the modal uses on Apply — `handleApplyFilters`
            in ChatList persists the choice and `load` closes over
            `viewOptions`, so the refetch follows from the state change. The
            modal stages instead because a half-typed regex must not reshuffle
            the list on every keystroke; a boolean has no half-typed state.

            Same accent treatment, padding and icon size as the filters button,
            so the two read as siblings and "on" means the same thing in both
            places.

            Three separate jobs, deliberately not folded together now that
            there is no text: `aria-label` is the NAME ("what is this?"),
            `aria-pressed` is the STATE ("which way is it set?"), and the
            `title` spells the state out in words for a pointer user, since it
            replaced a switch whose position answered that without being asked.
            The name must stay state-free — a control that renames itself as it
            toggles is announced as a different control each time. */}
        <button
          type="button"
          onClick={() => onApply(filters, { ...viewOptions, showArchived: !showArchived })}
          aria-label="Archived"
          aria-pressed={showArchived}
          style={{
            background: showArchived ? "var(--accent)" : "var(--bg-secondary)",
            color: showArchived ? "var(--text-on-accent)" : "var(--text)",
            padding: "8px",
            borderRadius: 6,
            border: showArchived ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
            transition: "background 0.15s, color 0.15s",
          }}
          title={showArchived ? "Showing chats on archived cards — click to hide them" : "Archived chats are hidden — click to show them"}
        >
          <Archive size={16} />
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
