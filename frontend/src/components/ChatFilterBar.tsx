import { useState } from "react";
import { SlidersHorizontal, Search, Loader2, Archive, Bookmark, Zap } from "lucide-react";
import ChatFilterModal from "./ChatFilterModal";
import { HEADER_BUTTON_STYLE, HEADER_ROW_GAP } from "./headerButtonStyle";
import { activeFilterCount, type ChatFilters, type ChatViewOptions } from "../types/chatFilters";

interface ChatFilterBarProps {
  filters: ChatFilters;
  viewOptions: ChatViewOptions;
  /**
   * Commit filters and view options. The modal calls this behind its Apply
   * button; the scope toggles here call it straight from the click — see the
   * note on the group.
   */
  onApply: (filters: ChatFilters, viewOptions: ChatViewOptions) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchSubmit: () => void;
  isSearching: boolean;
}

/**
 * The three sidebar scopes, in the order they sit in the segmented group.
 *
 * `title` takes the current state rather than describing the action, because
 * this replaced a set of switches whose position answered "which way is this
 * set?" without being asked, and the icon alone does not.
 */
const SCOPE_TOGGLES: {
  key: keyof ChatViewOptions;
  /** The accessible NAME. State-free — see the note on the group. */
  label: string;
  Icon: typeof Archive;
  title: (on: boolean) => string;
}[] = [
  {
    key: "bookmarked",
    label: "Bookmarked",
    Icon: Bookmark,
    title: (on) => (on ? "Showing bookmarked chats only — click to show all chats" : "Showing all chats — click to show bookmarked only"),
  },
  {
    key: "showTriggered",
    label: "Triggered",
    Icon: Zap,
    title: (on) =>
      on
        ? "Showing chats started by automation, including native Codex subagents — click to hide them"
        : "Chats started by automation, including native Codex subagents, are hidden — click to show them",
  },
  {
    key: "showArchived",
    label: "Archived",
    Icon: Archive,
    title: (on) => (on ? "Showing chats on archived cards — click to hide them" : "Archived chats are hidden — click to show them"),
  },
];

/**
 * Sidebar filter bar: the button that opens the filters modal, the scope
 * toggles, and the content search box.
 *
 * The scope toggles are a rail again, and that is a reversal worth stating
 * plainly rather than quietly re-landing. They were pulled into the modal on
 * two counts — an undifferentiated row of same-sized icons gave no clue what
 * any of them did, and it grew a button every time a new dimension appeared —
 * and only ONE of those has since been answered.
 *
 * Answered: the growth. The three are one segmented group, bordered as a unit
 * the way the header's nav controls are, so they read as three settings of one
 * thing ("what is this list scoped to?") rather than as three unrelated buttons
 * that happen to be adjacent — and that grouping is also what bounds it. The
 * group takes SCOPES. A fourth dimension that is not one does not belong in it,
 * and anything needing a label and a hint still goes in the modal, so this does
 * not grow a button per feature the way the old row did.
 *
 * NOT answered: legibility. An icon-only control still has to be hovered to be
 * learned. "Archived" shipped briefly with a text label for exactly that
 * reason and it was dropped because at the 350px minimum sidebar width one
 * label took about 90px from the search field — three of them is not an option
 * at any width. So the icon, `aria-pressed` and the tooltip carry the whole
 * meaning, and the honest cost is a first-time user hovering to find out. That
 * is a chosen tradeoff, not an oversight; anyone reopening it should know the
 * labels existed and why they went. The accessible names live in `aria-label`,
 * so stripping the text costs a screen reader nothing.
 *
 * The room is what made the reversal affordable, and it is worth writing the
 * price down rather than implying there wasn't one. At header-button size, with
 * no gaps inside the group, the whole rail costs 88px where three of the old
 * 34px buttons and their 8px gaps would have cost 126px; the search field's own
 * left inset also halved, since it had been paying 8px of container padding and
 * 8px of input padding to put the caret in one place. The field is still 36px
 * narrower than it was with one toggle out here — measured in Chromium at a
 * 359px sidebar, 235px before and 199px now. Two extra controls are not free;
 * the density work is what makes the bill 36px instead of 84.
 *
 * The badge on the modal button counts what is IN the modal, which is now the
 * four field filters and nothing else. That is the one thing the old rail was
 * good at kept: telling you at a glance that the list is narrowed by something
 * you cannot see from here.
 */
export default function ChatFilterBar({ filters, viewOptions, onApply, searchQuery, onSearchChange, onSearchSubmit, isSearching }: ChatFilterBarProps) {
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const activeCount = activeFilterCount(filters);

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
          // Same horizontal padding as SidebarHeader, and measured rather than
          // assumed: in Chromium at a 359px sidebar the filters button's left
          // edge and the "Callboard" title's are both at 20, and the search
          // field's right edge and the last header button's are both at 339.
          // The two rows are siblings in one flex column, so there is nothing
          // between them that could inset one and not the other — which is why
          // the horizontal room this row was wasting turned out to be INSIDE
          // it (34px buttons, 8px gaps, and a search field that paid its left
          // inset twice) rather than at its margins.
          padding: "8px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: HEADER_ROW_GAP,
        }}
      >
        {/* Filters. Standalone, and deliberately not folded into the group
            beside it: it opens a dialog rather than setting a scope, and a
            segmented group says its members answer one question. */}
        <button
          onClick={() => setFilterModalOpen(true)}
          style={{
            ...HEADER_BUTTON_STYLE,
            position: "relative",
            background: activeCount > 0 ? "var(--accent)" : "var(--bg-secondary)",
            color: activeCount > 0 ? "var(--text-on-accent)" : "var(--text)",
            borderRadius: 6,
            border: activeCount > 0 ? "none" : "1px solid var(--border)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={activeCount > 0 ? `Filters (${activeCount} active)` : "Filters"}
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

        {/* Scope toggles.

            Committed on the click, with no Apply: that is not an oversight, it
            is the reason these were pulled back out of the modal. `onApply` is
            the same commit path the modal uses on Apply — `handleApplyFilters`
            in ChatList persists the choice and `load` closes over
            `viewOptions`, so the refetch follows from the state change. The
            modal stages instead because a half-typed regex must not reshuffle
            the list on every keystroke; a boolean has no half-typed state.

            One group rather than three buttons, bordered exactly as
            SidebarHeader borders its nav controls: outer corners rounded, inner
            corners square, and BOTH sides of every seam suppressed — the first
            drops its right, the last its left, the middle both. So there are no
            internal dividers at all: in the default all-off state the rail is
            one outlined box with three icons in it, measured in Chromium at
            84x28 with three 28x28 buttons and zero gap between them. Not three
            cells with a shared 1px rule between them, and not three separately
            outlined buttons with doubled 2px seams, which is what dropping the
            suppression gives you. Without it they are three loose icons again,
            which is half of what put them in the modal in the first place.

            Spelled `borderLeftWidth`/`borderRightWidth: 0` rather than
            `border-left`/`border-right: none`. It renders identically — in
            Chromium both compute to 1px/0px/1px/1px — and unlike `none` it
            survives jsdom's CSS parser, which is the only reason the seam
            suppression is assertable at all. See the note in
            ChatFilterBar.test.tsx before tidying it back.

            Three separate jobs, deliberately not folded together now that
            there is no text: `aria-label` is the NAME ("what is this?"),
            `aria-pressed` is the STATE ("which way is it set?"), and the
            `title` spells the state out in words for a pointer user, since
            these replaced switches whose position answered that without being
            asked. The name must stay state-free — a control that renames
            itself as it toggles is announced as a different control each
            time. */}
        <div style={{ display: "flex", flexShrink: 0 }}>
          {SCOPE_TOGGLES.map(({ key, label, Icon, title }, i) => {
            const on = viewOptions[key];
            const isFirst = i === 0;
            const isLast = i === SCOPE_TOGGLES.length - 1;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onApply(filters, { ...viewOptions, [key]: !on })}
                aria-label={label}
                aria-pressed={on}
                title={title(on)}
                style={{
                  ...HEADER_BUTTON_STYLE,
                  // The chatlist-nav tokens, not the generic --text/--border,
                  // because this group is claiming to be the same control as
                  // SidebarHeader's nav group and that is what the header uses.
                  // They alias to --text/--border/--text-on-accent in both
                  // built-in themes, so this is pixel-neutral today. It starts
                  // mattering the moment a custom theme in ~/.callboard/themes/
                  // gives the --chatlist-* ones their own values: on the generic
                  // tokens that leaves two rails that nearly match, which is the
                  // outcome this whole row exists to avoid. (The standalone
                  // filters button above keeps --text/--border/--text-on-accent:
                  // it pairs with the header's New Chat button, not the nav
                  // group.)
                  background: on ? "var(--accent)" : "var(--bg-secondary)",
                  color: on ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                  borderTopLeftRadius: isFirst ? 6 : 0,
                  borderBottomLeftRadius: isFirst ? 6 : 0,
                  borderTopRightRadius: isLast ? 6 : 0,
                  borderBottomRightRadius: isLast ? 6 : 0,
                  border: on ? "none" : "1px solid var(--chatlist-item-border)",
                  // Seam suppression. Width rather than `none` — see the group note.
                  ...(isFirst ? { borderRightWidth: 0 } : isLast ? { borderLeftWidth: 0 } : { borderLeftWidth: 0, borderRightWidth: 0 }),
                  cursor: "pointer",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                <Icon size={16} />
              </button>
            );
          })}
        </div>

        {/* Search input with search button on the right. Boxed to the same
            height as the buttons rather than padded to whatever its font
            gives, so the row is one header-button tall and no control sets
            the row's height on its own. */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "stretch",
            height: HEADER_BUTTON_STYLE.height,
            boxSizing: "border-box",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
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
              padding: "0 8px",
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
              padding: "0 8px",
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
      {filterModalOpen && <ChatFilterModal onClose={() => setFilterModalOpen(false)} filters={filters} onApply={onApply} viewOptions={viewOptions} />}
    </>
  );
}
