import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitFork } from "lucide-react";
import type { ChatTreeNode } from "../api";
import ProviderBadge from "./ProviderBadge";
import { STATUS_DOT } from "./ChatTreeIndicator";

/**
 * Inline marker under a message that one or more forks branched off: a
 * "N forks" chip opening a menu of those forks, each navigating to its chat.
 *
 * Rows mirror ChatTreeIndicator's dropdown (status dot, provider badge,
 * title). Keyboard: Arrow keys move between rows, Escape closes and returns
 * focus to the chip.
 */
export default function ForkPointMarker({ forks, align }: { forks: ChatTreeNode[]; align: "left" | "right" }) {
  const navigate = useNavigate();
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

  const label = `${forks.length} fork${forks.length === 1 ? "" : "s"}`;

  return (
    <div ref={wrapRef} style={{ position: "relative", marginTop: 4 }}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${label} branched off here`}
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
          aria-label="Forks from this message"
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
              onClick={() => {
                setOpen(false);
                navigate(`/chat/${node.chatId}`);
              }}
              title={node.title || node.folder}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                padding: "5px 12px",
                border: "none",
                background: "transparent",
                textAlign: "left",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <span
                title={`Status: ${node.nativeAgent?.lifecycle ?? node.status}`}
                style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: STATUS_DOT[node.status] || "var(--text-muted)" }}
              />
              <ProviderBadge provider={node.provider === "claude-code" ? undefined : node.provider} acpProviderId={node.acpProviderId} compact />
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
