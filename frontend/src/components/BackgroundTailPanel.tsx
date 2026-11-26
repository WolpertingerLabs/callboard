import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown } from "lucide-react";
import type { BackgroundTailStream } from "../api";
import { useBackgroundTail } from "../hooks/useBackgroundTail";
import { useRelativeTime } from "../hooks/useRelativeTime";
import { formatBytes } from "../utils/formatBytes";

interface Props {
  chatId: string;
  toolUseId: string;
  /** The task is still running: poll. When it turns false the panel fetches once more and stops. */
  live: boolean;
  /** Told the newest modification time across the streams (null when none exists) whenever it changes. */
  onLatestWrite?: (mtimeMs: number | null) => void;
}

/** Within this many pixels of the bottom counts as "following" the output. */
const STICK_SLACK_PX = 24;

function streamProblem(s: BackgroundTailStream, live: boolean): string | null {
  switch (s.error) {
    case "missing":
      return s.kind === "redirect" && live ? "File not created yet" : "File no longer exists (cleaned up)";
    case "not_regular":
      return "Not a regular file";
    case "refused":
      return "This file can't be shown";
    case "unreadable":
      return "File can't be read";
    default:
      return null;
  }
}

/**
 * The live output of a background Bash call: the engine's own output file
 * and any files the command redirects to, one tab each. Mounted only while
 * the row is open, so a collapsed bubble costs no requests.
 *
 * Follows new output while scrolled to the bottom; scrolling up stops
 * following and offers a "Latest" button instead.
 */
export default function BackgroundTailPanel({ chatId, toolUseId, live, onLatestWrite }: Props) {
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const { data, stream: fetching, error, loading, gone, refresh } = useBackgroundTail({ chatId, toolUseId, live, stream: picked });

  const streams = data?.streams ?? [];
  const latestWrite = data
    ? streams.reduce<number | null>((m, s) => (s.exists && s.mtimeMs !== undefined && (m === null || s.mtimeMs > m) ? s.mtimeMs : m), null)
    : undefined;
  useEffect(() => {
    if (latestWrite !== undefined) onLatestWrite?.(latestWrite);
  }, [latestWrite, onLatestWrite]);
  // The stream the hook is actually fetching wins over the server's current
  // default, so the highlighted tab and the content always agree.
  const selectedId = picked ?? fetching ?? data?.defaultStream ?? streams[0]?.id;
  const selected = streams.find((s) => s.id === selectedId) ?? null;
  const tail = data?.tail && data.tail.stream === selectedId ? data.tail : null;
  const lines = tail?.lines ?? null;

  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const updated = useRelativeTime(selected?.mtimeMs !== undefined ? new Date(selected.mtimeMs).toISOString() : undefined);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowLatest(false);
    } else {
      setShowLatest(true);
    }
  }, [lines, selectedId]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - STICK_SLACK_PX;
    stickRef.current = atBottom;
    if (atBottom) setShowLatest(false);
  };

  const jumpToLatest = () => {
    const el = preRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowLatest(false);
  };

  const pick = (id: string) => {
    stickRef.current = true;
    setPicked(id);
  };

  let empty: string | null = null;
  if (gone) empty = "No output available for this call";
  else if (!data) empty = error ? `Couldn't load output: ${error}` : loading ? "Loading…" : "No output yet";
  else if (!selected) empty = "No output yet";
  else if (streamProblem(selected, live)) empty = streamProblem(selected, live);
  // A stream with content whose tail has not arrived yet (just switched to it).
  else if (!tail) empty = loading || (selected.exists && !!selected.size) ? "Loading…" : "No output yet";
  else if (tail.binary) empty = "Binary output — not shown";
  else if (!lines || lines.length === 0) empty = "No output yet";

  const meta: string[] = [];
  if (selected?.exists && selected.size !== undefined) meta.push(formatBytes(selected.size));
  if (selected?.exists && updated) meta.push(`updated ${updated}`);
  if (tail?.truncated && lines) meta.push(`last ${lines.length} lines`);
  // Polls failing after a good load: say so rather than leave stale lines looking current.
  const reconnecting = !!error && !!data && !gone;
  const retryButton = (
    <button
      type="button"
      onClick={refresh}
      style={{
        minHeight: 32,
        padding: "0 12px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--text-muted)",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      Retry
    </button>
  );

  return (
    <div data-testid="background-tail-panel" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0 8px" }}>
      {streams.length > 1 && (
        <div
          role="group"
          aria-label="Output streams"
          style={{ display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 2 }}
        >
          {streams.map((s) => {
            const active = s.id === selectedId;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={active}
                title={s.displayPath || s.label}
                onClick={() => pick(s.id)}
                style={{
                  flexShrink: 0,
                  minHeight: 32,
                  padding: "0 12px",
                  borderRadius: 999,
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "var(--text-on-accent)" : "var(--text-muted)",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  opacity: s.exists ? 1 : 0.6,
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", fontSize: 11, color: "var(--text-muted)", minWidth: 0 }}>
          {selected.displayPath && (
            <span
              style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}
              title={selected.displayPath}
            >
              {selected.displayPath}
            </span>
          )}
          {meta.length > 0 && <span>{meta.join(" · ")}</span>}
        </div>
      )}

      {reconnecting && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
          <span>Reconnecting… ({error})</span>
          {retryButton}
        </div>
      )}

      {empty ? (
        <div
          style={{
            ...preStyle,
            color: "var(--text-muted)",
            fontStyle: "italic",
            fontFamily: "inherit",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>{empty}</span>
          {(gone || (error && !data)) && retryButton}
        </div>
      ) : (
        <div style={{ position: "relative" }}>
          <pre ref={preRef} onScroll={onScroll} data-testid="background-tail-lines" style={preStyle}>
            {lines?.join("\n")}
          </pre>
          {showLatest && (
            <button
              type="button"
              onClick={jumpToLatest}
              style={{
                position: "absolute",
                right: 10,
                bottom: 10,
                minHeight: 32,
                padding: "0 12px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                borderRadius: 999,
                border: "none",
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                boxShadow: "var(--shadow-md)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <ArrowDown size={12} /> Latest
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const preStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.45,
  background: "var(--code-bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: "min(50vh, 360px)",
  overflow: "auto",
  overscrollBehavior: "contain",
};
