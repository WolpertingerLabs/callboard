import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Check, Layers, Settings2, X } from "lucide-react";
import type { CardSummary } from "shared/types/index.js";
import { ALL_SPACES, DEFAULT_SPACE_ID } from "shared/types/space.js";
import { useSpaces } from "../contexts/SpaceContext";
import { SpaceDot, spaceLabel } from "./SpaceChip";
import { HEADER_BUTTON_STYLE } from "./headerButtonStyle";

interface SpaceSwitcherProps {
  /**
   * Every card the sidebar knows about, from its unscoped card index. The
   * switcher counts the open, blocked ones per space from it, so a chat
   * waiting on you in another space is never hidden by separation — at no
   * extra request.
   */
  cards: CardSummary[];
  /**
   * Mobile: a one-line trigger that sits at the start of the filter row
   * instead of a full-width row of its own. The root is unpositioned, so the
   * menu anchors to the filter row (which is `position: relative`) and still
   * spans the sidebar's full width. The notice is not rendered here — the
   * caller places a `SpaceNotice` below the row, where it has room.
   */
  compact?: boolean;
  /** Inset of the anchoring row, so a compact menu lines up with its edges. */
  inset?: number;
}

/** Open cards whose rollup is needs_you, by space. */
export function needsYouBySpace(cards: CardSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.lifecycle !== "open" || card.hidden || card.rollup !== "needs_you") continue;
    const space = card.spaceId ?? DEFAULT_SPACE_ID;
    counts.set(space, (counts.get(space) ?? 0) + 1);
  }
  return counts;
}

function CountBadge({ n, title }: { n: number; title: string }) {
  if (n <= 0) return null;
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        borderRadius: 9,
        background: "var(--warning-bg)",
        color: "var(--board-rollup-needs-you)",
        fontSize: 11,
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {n}
    </span>
  );
}

/** The space picker at the top of the sidebar. */
/** The "switched to this chat's space" notice, with its dismiss button. */
export function SpaceNotice({ style }: { style?: React.CSSProperties }) {
  const { notice, dismissNotice } = useSpaces();
  if (!notice) return null;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 8,
        background: "var(--info-bg)",
        color: "var(--text)",
        fontSize: 12,
        ...style,
      }}
    >
      <span style={{ flex: 1 }}>{notice}</span>
      <button
        onClick={dismissNotice}
        aria-label="Dismiss"
        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "flex" }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export default function SpaceSwitcher({ cards, compact = false, inset = 20 }: SpaceSwitcherProps) {
  const { spaces, activeSpaceId, activeSpace, setActiveSpace } = useSpaces();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => needsYouBySpace(cards), [cards]);
  // The badge is the sum of the rows the menu will show: live spaces other
  // than the one on screen. An archived space has no row, so its blocked
  // cards are not counted here (they still surface on the board).
  const elsewhere = activeSpaceId === ALL_SPACES ? 0 : spaces.reduce((sum, space) => (space.id === activeSpaceId ? sum : sum + (counts.get(space.id) ?? 0)), 0);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Focus the selected item (or the first) when the menu opens.
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]');
    const selected = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (selected ?? items?.[0])?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  /** Arrow keys move through the items, Home/End jump, Escape closes and returns focus. */
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const choose = (id: string) => {
    close(true);
    setActiveSpace(id);
  };

  const isAll = activeSpaceId === ALL_SPACES;
  const current = isAll ? (compact ? "All" : "All spaces") : (compact ? activeSpace?.name : spaceLabel(activeSpace)) || "General";

  const row = (key: string, selected: boolean, onClick: () => void, children: React.ReactNode) => (
    <button
      key={key}
      role="menuitemradio"
      aria-checked={selected}
      tabIndex={-1}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        minHeight: 36,
        padding: "6px 10px",
        border: "none",
        borderRadius: 6,
        background: selected ? "var(--accent-light)" : "transparent",
        color: "var(--text)",
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      {children}
      <span style={{ flex: 1 }} />
      {selected && <Check size={14} color="var(--accent-text)" />}
    </button>
  );

  return (
    <div
      ref={rootRef}
      // Full: 20px sides to line up with SidebarHeader and the ChatFilterBar
      // row below; the -2px bottom margin trims the filter row's 8px top
      // padding to a 6px gap, so the switcher and the filters read as one group.
      // Compact: a flex item in the filter row, deliberately unpositioned so the
      // menu anchors to the row rather than to this narrow trigger.
      style={compact ? { display: "flex", flex: "0 1 auto", minWidth: 0, maxWidth: 112 } : { position: "relative", padding: "8px 20px 0", marginBottom: -2 }}
      data-testid="space-switcher"
    >
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={compact ? `Space: ${current} — switch space` : "Switch space"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: compact ? 5 : 8,
          width: "100%",
          minWidth: 0,
          ...(compact ? { height: HEADER_BUTTON_STYLE.height, boxSizing: "border-box" as const, padding: "0 6px 0 8px" } : { padding: "6px 10px" }),
          borderRadius: compact ? 6 : 8,
          border: "1px solid var(--chatlist-item-border)",
          background: "var(--bg-secondary)",
          color: "var(--text)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {/* Compact (mobile, closed) is the name alone — no dot, emoji or icon.
            The room goes to the name and the search field; the open menu and
            the desktop trigger still show both. */}
        {!compact && (isAll ? <Layers size={14} color="var(--text-muted)" /> : <SpaceDot space={activeSpace} />)}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{current}</span>
        {!compact && <span style={{ flex: 1 }} />}
        <CountBadge n={elsewhere} title={`${elsewhere} card${elsewhere === 1 ? "" : "s"} in other spaces need you`} />
        <ChevronDown size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Spaces"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            left: compact ? inset : 20,
            right: compact ? inset : 20,
            top: "calc(100% + 4px)",
            zIndex: 50,
            padding: 6,
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--bg-popout)",
            boxShadow: "var(--shadow-lg)",
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {spaces.map((space) =>
            row(
              space.id,
              space.id === activeSpaceId,
              () => choose(space.id),
              <>
                <SpaceDot space={space} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{spaceLabel(space)}</span>
                <CountBadge n={counts.get(space.id) ?? 0} title={`${counts.get(space.id)} need you`} />
              </>,
            ),
          )}
          {row(
            ALL_SPACES,
            isAll,
            () => choose(ALL_SPACES),
            <>
              <Layers size={14} color="var(--text-muted)" />
              <span>All spaces</span>
            </>,
          )}
          <div style={{ height: 1, background: "var(--border)", margin: "6px 4px" }} />
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              navigate("/settings/spaces");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 10px",
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <Settings2 size={14} /> Manage spaces…
          </button>
        </div>
      )}

      {!compact && <SpaceNotice style={{ marginTop: 6 }} />}
    </div>
  );
}
