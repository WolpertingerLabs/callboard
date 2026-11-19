/**
 * The chat header's list of this chat's asides: a "N asides" button opening a
 * menu, one row per aside, each opening it in the side panel. Hovering or
 * focusing a row emphasises that aside's highlighted passages. The button
 * and each row carry a dot for what an aside needs — a summon, a prompt
 * waiting, an unread reply, a live run (utils/asideAttention.ts); the chat's
 * own status in the header stays the chat's.
 *
 * Rendered only when the chat has asides. Keyboard: the menu
 * takes focus on open, arrows move, Escape returns focus here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareQuote } from "lucide-react";
import ProviderBadge from "./ProviderBadge";
import { STATUS_DOT } from "./ChatTreeList";
import { AsideAttentionDot, asideCountLabel } from "./ChatRoleBadge";
import { useIsSessionActive } from "../contexts/SessionContext";
import type { AsideEntry } from "../utils/asideHighlights";
import { attentionSuffix, nodeSignals, sumAttention, type AsideSignals } from "../utils/asideAttention";

/**
 * Reports whether one aside has a live session. One per aside, because the
 * session registry is read per chat (`useIsSessionActive`) and hooks cannot
 * be called in a loop.
 */
function RunningProbe({ chatId, onChange }: { chatId: string; onChange: (chatId: string, running: boolean) => void }) {
  const running = !!useIsSessionActive(chatId);
  useEffect(() => {
    onChange(chatId, running);
    return () => onChange(chatId, false);
  }, [chatId, running, onChange]);
  return null;
}

/** One aside's row: a dot and name for what it needs beyond its status dot (which already says running). */
function RowAttention({ signals }: { signals: AsideSignals }) {
  const words = [signals.summoned && "calling for you", signals.waiting && "waiting for an answer", signals.unread && "unread"].filter(Boolean).join(", ");
  if (!words) return null;
  return (
    <span role="img" aria-label={words} title={words} style={{ display: "inline-flex" }}>
      <AsideAttentionDot attention={sumAttention([signals])} />
    </span>
  );
}

export default function AsideListButton({
  asides,
  openId,
  onOpen,
  onEmphasize,
}: {
  asides: readonly AsideEntry[];
  /** The aside open in the panel, marked in the list. */
  openId: string | null;
  /** Called with the button, for focus to come back to when the panel closes (the row clicked goes with the menu). */
  onOpen: (chatId: string, returnFocus: HTMLElement | null) => void;
  onEmphasize: (chatIds: readonly string[] | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const onRunningChange = useCallback((chatId: string, on: boolean) => {
    setRunning((prev) => {
      if (prev.has(chatId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }, []);
  const label = asideCountLabel(asides.length);
  const signalsOf = (aside: AsideEntry) => nodeSignals(aside, running.has(aside.chatId));
  const attention = sumAttention(asides.map(signalsOf));
  const attentionLabel = attentionSuffix(attention);

  const close = (refocus = false) => {
    setOpen(false);
    onEmphasize(null);
    if (refocus) triggerRef.current?.focus();
  };

  // Not PopupMenu: that one closes on any scroll, and the transcript under
  // this header scrolls on every streamed frame. In place, like the
  // fork-point marker's menu, closed by a press outside.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        onEmphasize(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onEmphasize]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
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
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} in this chat${attentionLabel}`}
        title={`This chat's asides: ${label}${attentionLabel}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "var(--bg-secondary)",
          color: "var(--text)",
          padding: "7px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        <MessageSquareQuote size={16} aria-hidden />
        <span>{label}</span>
        <AsideAttentionDot attention={attention} />
      </button>
      {asides.map((aside) => (
        <RunningProbe key={aside.chatId} chatId={aside.chatId} onChange={onRunningChange} />
      ))}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Asides of this chat"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 50,
            minWidth: 260,
            maxWidth: "min(360px, 90vw)",
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md)",
            padding: "4px 0",
          }}
        >
          {asides.map((aside) => (
            <button
              key={aside.chatId}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="fork-point-menu-item"
              aria-current={aside.chatId === openId ? "true" : undefined}
              onClick={() => {
                close();
                onOpen(aside.chatId, triggerRef.current);
              }}
              onMouseEnter={() => onEmphasize([aside.chatId])}
              onMouseLeave={() => onEmphasize(null)}
              onFocus={() => onEmphasize([aside.chatId])}
              title={aside.title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                padding: "6px 12px",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                minWidth: 0,
                fontWeight: aside.chatId === openId ? 600 : undefined,
              }}
            >
              <span
                title={`Status: ${running.has(aside.chatId) ? "running" : aside.status}`}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: running.has(aside.chatId) ? "var(--status-active)" : STATUS_DOT[aside.status] || "var(--text-muted)",
                }}
              />
              <RowAttention signals={{ ...signalsOf(aside), running: false }} />
              <ProviderBadge provider={aside.provider === "claude-code" ? undefined : aside.provider} compact />
              <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {aside.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
