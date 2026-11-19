import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitFork } from "lucide-react";
import type { ChatTreeNode } from "../api";
import ProviderBadge from "./ProviderBadge";
import { STATUS_DOT } from "./ChatTreeList";
import { ASIDE_ROLE, PRE_COMPRESSION_ROLE, SUPERSEDED_ROLE } from "../utils/chatRewrite";
import { useAsideActions } from "../contexts/AsideContext";

/**
 * Inline marker under a message that one or more forks branched off: a
 * "N forks" chip opening a menu of those forks, each navigating to its chat.
 *
 * Asides open in the chat page's side panel instead (AsideContext), where the
 * page has one; and while the chip or an aside's row is hovered or focused,
 * those asides' highlighted passages are emphasised. Forks still navigate.
 *
 * Rows mirror the sidebar's ChatTreeList (status dot, provider badge,
 * title). Keyboard: Arrow keys move between rows, Escape closes and returns
 * focus to the chip.
 */
/**
 * The chip's text. A lone original that this chat replaced is named for what
 * it is — it is not a fork the user made — and anything else counts forks.
 */
export function markerLabel(forks: ChatTreeNode[]): string {
  if (forks.length === 1 && forks[0]!.role === SUPERSEDED_ROLE) return "Original continues";
  if (forks.length === 1 && forks[0]!.role === PRE_COMPRESSION_ROLE) return "Uncompressed original";
  // Asides are side questions, not branches of the work: counted on their own.
  const asides = forks.filter((f) => f.role === ASIDE_ROLE).length;
  const others = forks.length - asides;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (asides === 0) return count(others, "fork");
  if (others === 0) return count(asides, "aside");
  return `${count(others, "fork")}, ${count(asides, "aside")}`;
}

/** The menu's accessible name: what it lists — forks, asides or both. */
export function menuLabel(forks: ChatTreeNode[]): string {
  const asides = forks.filter((f) => f.role === ASIDE_ROLE).length;
  if (asides === 0) return "Forks from this message";
  if (asides === forks.length) return "Asides about this message";
  return "Forks and asides from this message";
}

export default function ForkPointMarker({ forks, align }: { forks: ChatTreeNode[]; align: "left" | "right" }) {
  const navigate = useNavigate();
  const asideActions = useAsideActions();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const label = markerLabel(forks);
  const asideIds = forks.filter((f) => f.role === ASIDE_ROLE).map((f) => f.chatId);
  const loneAside = asideActions && forks.length === 1 && forks[0]!.role === ASIDE_ROLE ? forks[0]!.chatId : null;
  const emphasize = (ids: readonly string[] | null) => {
    if (asideActions && asideIds.length > 0) asideActions.emphasizeAsides(ids);
  };
  // Anything inside the marker hovered or focused emphasises its asides; a row
  // narrows that to its own (see the rows below).
  const wrapHandlers =
    asideIds.length > 0 && asideActions
      ? {
          onMouseEnter: () => emphasize(asideIds),
          onMouseLeave: () => emphasize(null),
          onFocus: (e: React.FocusEvent) => {
            if (e.target === triggerRef.current) emphasize(asideIds);
          },
          onBlur: (e: React.FocusEvent) => {
            if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) emphasize(null);
          },
        }
      : {};

  return (
    <div ref={wrapRef} style={{ position: "relative", marginTop: 4 }} {...wrapHandlers}>
      <button
        ref={triggerRef}
        // A lone aside opens straight away: a one-row menu would be a click for nothing.
        onClick={() => (loneAside ? asideActions!.openAside(loneAside) : setOpen((v) => !v))}
        aria-haspopup={loneAside ? undefined : "menu"}
        aria-expanded={loneAside ? undefined : open}
        title={loneAside ? `Open the aside about this message: ${forks[0]!.title || "Aside"}` : `Branched off this message: ${label}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          fontWeight: 500,
          padding: "2px 6px",
          borderRadius: 4,
          background: "var(--surface)",
          color: "var(--text-muted)",
          border: "1px solid var(--border)",
          cursor: "pointer",
        }}
      >
        <GitFork size={11} style={{ flexShrink: 0 }} />
        {label}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={menuLabel(forks)}
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            zIndex: 50,
            minWidth: 240,
            maxWidth: 360,
            maxHeight: 300,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md)",
            padding: "4px 0",
          }}
        >
          {forks.map((node) => (
            <button
              key={node.chatId}
              role="menuitem"
              tabIndex={-1}
              className="fork-point-menu-item"
              onClick={() => {
                setOpen(false);
                if (node.role === ASIDE_ROLE && asideActions) asideActions.openAside(node.chatId);
                else navigate(`/chat/${node.chatId}`);
              }}
              onMouseEnter={node.role === ASIDE_ROLE ? () => emphasize([node.chatId]) : undefined}
              onFocus={node.role === ASIDE_ROLE ? () => emphasize([node.chatId]) : undefined}
              title={node.title || node.folder}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                padding: "5px 12px",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <span
                title={`Status: ${node.nativeAgent?.lifecycle ?? node.status}`}
                style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: STATUS_DOT[node.status] || "var(--text-muted)" }}
              />
              <ProviderBadge provider={node.provider === "claude-code" ? undefined : node.provider} compact />
              <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {node.title || node.chatId}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
