import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Check, Layers, Settings2, X } from "lucide-react";
import type { CardSummary } from "shared/types/index.js";
import { ALL_SPACES, DEFAULT_SPACE_ID } from "shared/types/space.js";
import { useSpaces } from "../contexts/SpaceContext";
import { SpaceDot, spaceLabel } from "./SpaceChip";

interface SpaceSwitcherProps {
  /**
   * Every card the sidebar knows about, from its unscoped card index. The
   * switcher counts the open, blocked ones per space from it, so a chat
   * waiting on you in another space is never hidden by separation — at no
   * extra request.
   */
  cards: CardSummary[];
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
export default function SpaceSwitcher({ cards }: SpaceSwitcherProps) {
  const { spaces, activeSpaceId, activeSpace, setActiveSpace, notice, dismissNotice } = useSpaces();
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
  const current = isAll ? "All spaces" : spaceLabel(activeSpace) || "General";

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
    <div ref={rootRef} style={{ position: "relative", padding: "8px 12px 0" }} data-testid="space-switcher">
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
        title="Switch space"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid var(--chatlist-item-border)",
          background: "var(--bg-secondary)",
          color: "var(--text)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {isAll ? <Layers size={14} color="var(--text-muted)" /> : <SpaceDot space={activeSpace} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current}</span>
        <span style={{ flex: 1 }} />
        <CountBadge n={elsewhere} title={`${elsewhere} card${elsewhere === 1 ? "" : "s"} in other spaces need you`} />
        <ChevronDown size={14} color="var(--text-muted)" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Spaces"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            left: 12,
            right: 12,
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

      {notice && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
            padding: "6px 10px",
            borderRadius: 8,
            background: "var(--info-bg)",
            color: "var(--text)",
            fontSize: 12,
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
      )}
    </div>
  );
}
