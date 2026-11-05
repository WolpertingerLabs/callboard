import { useEffect, useState } from "react";
import ModalOverlay from "./ModalOverlay";
import { compressChat, previewChatCompression, type CompressDirection, type SupersedeResponse } from "../api";
import { errorMessage } from "../utils/errorMessage";

interface Props {
  chatId: string;
  timestamp: string;
  direction: CompressDirection;
  onCancel: () => void;
  /** Called with the new chat once the compression is committed. */
  onDone: (result: SupersedeResponse) => void;
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; error: string } | { kind: "committing" };

const COPY: Record<CompressDirection, { title: string; what: string }> = {
  before: { title: "Compress earlier messages", what: "everything before the message you picked" },
  after: { title: "Compress later messages", what: "everything after the message you picked" },
};

/**
 * Compress part of a chat: fetch a summary from the chat's own model, let the
 * user edit it, then commit. The summary is generated on open — that is the
 * slow part, often tens of seconds — and leaving the dialog cancels it.
 *
 * Commit makes a NEW chat that takes this one's place; the original stays as
 * its child, which is what makes this safe to offer without an undo button.
 */
export default function CompressChatModal({ chatId, timestamp, direction, onCancel, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [summary, setSummary] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // "loading" is the initial state, and Try again sets it before bumping
    // `attempt`, so the effect itself only starts the request.
    const controller = new AbortController();
    previewChatCompression(chatId, timestamp, direction, controller.signal)
      .then((res) => {
        setSummary(res.summary);
        setPhase({ kind: "ready" });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: "failed", error: errorMessage(err, "Failed to generate a summary") });
      });
    return () => controller.abort();
  }, [chatId, timestamp, direction, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const commit = async () => {
    if (!summary.trim()) return;
    setPhase({ kind: "committing" });
    try {
      onDone(await compressChat(chatId, timestamp, direction, summary));
    } catch (err) {
      setPhase({ kind: "failed", error: errorMessage(err, "Failed to compress chat") });
    }
  };

  const copy = COPY[direction];
  const busy = phase.kind === "loading" || phase.kind === "committing";

  return (
    <ModalOverlay onClose={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compress-chat-title"
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 640,
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "85vh",
        }}
      >
        <h2 id="compress-chat-title" style={{ margin: "0 0 12px 0", fontSize: 18 }}>
          {copy.title}
        </h2>
        <p style={{ margin: "0 0 12px 0", fontSize: 14, color: "var(--text)", lineHeight: 1.5 }}>
          Replaces {copy.what} with the summary below, in a new chat that takes this one&apos;s place. This chat is kept unchanged as its child, so you can go
          back to it.
        </p>

        {phase.kind === "loading" && (
          <p role="status" style={{ margin: "0 0 16px 0", fontSize: 13, color: "var(--text-muted)" }}>
            Summarising on this chat&apos;s model… this can take a minute.
          </p>
        )}
        {phase.kind === "failed" && (
          <p role="alert" style={{ margin: "0 0 12px 0", fontSize: 13, color: "var(--danger)" }}>
            {phase.error}
          </p>
        )}
        {phase.kind !== "loading" && (
          <>
            <label htmlFor="compress-chat-summary" style={{ display: "block", fontSize: 13, marginBottom: 6, color: "var(--text)" }}>
              Summary <span style={{ color: "var(--text-muted)" }}>— edit before compressing</span>
            </label>
            <textarea
              id="compress-chat-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={phase.kind === "committing"}
              rows={14}
              style={{
                width: "100%",
                flex: 1,
                minHeight: 160,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 13,
                lineHeight: 1.5,
                fontFamily: "inherit",
                boxSizing: "border-box",
                resize: "vertical",
                marginBottom: 20,
              }}
            />
          </>
        )}

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {phase.kind === "failed" && !summary.trim() ? (
            <button
              type="button"
              onClick={() => {
                setPhase({ kind: "loading" });
                setAttempt((n) => n + 1);
              }}
              style={primaryButton(false)}
            >
              Try again
            </button>
          ) : (
            <button type="button" onClick={() => void commit()} disabled={busy || !summary.trim()} style={primaryButton(busy || !summary.trim())}>
              {phase.kind === "committing" ? "Compressing…" : "Compress"}
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: 6,
    fontSize: 14,
    background: "var(--accent)",
    color: "var(--text-on-accent)",
    border: "none",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
