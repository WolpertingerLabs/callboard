import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";
import { getSlashCommandContent, type SlashCommandContent } from "../api";
import { getCommandDescription } from "../utils/commands";

interface Props {
  /** Full command name as the harness sees it, e.g. `callboard:my-skill`. */
  name: string;
  /** Chat the command belongs to. Absent on a chat that has no id yet. */
  chatId?: string;
  /** Description already known to the composer (plugin listings carry one). */
  description?: string;
  /** Drop the chip. Wired to the popover's X. */
  onRemove: () => void;
  /** Lets the composer know whether the popover is up (it steers Backspace). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The selected slash command, rendered as a chip inside the composer.
 *
 * The chip is the command: once one is picked it stops being text in the
 * textarea, so the prose the user types alongside it stays theirs. Clicking the
 * name opens a popover with the command's body — fetched lazily, because most
 * chips are never opened at all — and the popover's X is what removes the chip.
 * Click-away and Escape only close it; neither is a way to lose the command by
 * accident.
 */
export default function CommandChip({ name, chatId, description, onRemove, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SlashCommandContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // The body is fetched at most once per chip, so a command with no content
  // (a harness built-in) isn't re-requested every time the popover reopens.
  const requested = useRef(false);

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const toggle = useCallback(() => {
    const next = !open;
    setOpenState(next);
    if (!next || requested.current || !chatId) return;

    requested.current = true;
    setLoading(true);
    setError(false);
    getSlashCommandContent(chatId, name)
      .then(setDetail)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [open, setOpenState, chatId, name]);

  // Escape closes the popover without removing the chip.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenState(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setOpenState]);

  const subtitle = description || detail?.description || getCommandDescription(name) || null;

  return (
    <div style={{ position: "relative" }}>
      {open && (
        <>
          {/* Click-away overlay */}
          <div onClick={() => setOpenState(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              right: 0,
              maxWidth: 480,
              zIndex: 51,
              padding: 12,
              borderRadius: 8,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--accent-text)", wordBreak: "break-all" }}>/{name}</div>
                {subtitle && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{subtitle}</div>}
              </div>
              <button
                onClick={() => {
                  setOpenState(false);
                  onRemove();
                }}
                title="Remove"
                style={{
                  background: "transparent",
                  color: "var(--text-muted)",
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                <X size={13} />
              </button>
            </div>

            <div style={{ maxHeight: 280, overflowY: "auto", fontSize: 13 }}>
              {loading ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</div>
              ) : error ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Could not load command content.</div>
              ) : detail?.content ? (
                <MarkdownRenderer content={detail.content} />
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No content available.</div>
              )}
            </div>
          </div>
        </>
      )}

      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          maxWidth: "100%",
          background: "var(--accent-bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
      >
        <button
          onClick={toggle}
          title={subtitle ? `/${name} — ${subtitle}` : `/${name}`}
          style={{
            background: "transparent",
            border: "none",
            padding: "3px 8px",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--accent-text)",
            cursor: "pointer",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          /{name}
        </button>
      </span>
    </div>
  );
}
