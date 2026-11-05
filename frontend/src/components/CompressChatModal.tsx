import { useEffect, useState } from "react";
import ModalOverlay from "./ModalOverlay";
import { compressChat, previewChatCompression, StaleSummaryError, type CompressDirection, type SupersedePrecondition, type SupersedeResponse } from "../api";
import { errorMessage } from "../utils/errorMessage";

interface Props {
  chatId: string;
  timestamp: string;
  direction: CompressDirection;
  /** Sent with the commit so a chat moved by another tab is refused, not nested. */
  precondition?: SupersedePrecondition;
  onCancel: () => void;
  /** Called with the new chat once the compression is committed. */
  onDone: (result: SupersedeResponse) => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: string }
  /** The conversation changed since the summary was made; only a fresh one can be committed. */
  | { kind: "stale"; error: string }
  | { kind: "committing" };

/** How long a preview runs before the dialog explains why it is slow. */
export const SLOW_PREVIEW_MS = 20_000;

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
 *
 * The commit carries the preview's fingerprint of the summarised span. If the
 * conversation moved on in between (most often: more messages after a
 * compress-later preview), the server refuses and the dialog asks for a fresh
 * summary rather than drop the new messages.
 *
 * While the commit is in flight the dialog cannot be dismissed — Cancel,
 * Escape and the backdrop all wait — so the user cannot walk away from a
 * request that will still replace the chat.
 */
export default function CompressChatModal({ chatId, timestamp, direction, precondition, onCancel, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [summary, setSummary] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const committing = phase.kind === "committing";
  const dismiss = () => {
    if (!committing) onCancel();
  };

  useEffect(() => {
    // "loading" is the initial state, and Try again / Regenerate set it before
    // bumping `attempt`, so the effect itself only starts the request. Closing
    // the dialog aborts it, which the server turns into a cancelled model run.
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlow(true), SLOW_PREVIEW_MS);
    previewChatCompression(chatId, timestamp, direction, controller.signal)
      .then((res) => {
        setSummary(res.summary);
        setFingerprint(res.fingerprint);
        setPhase({ kind: "ready" });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: "failed", error: errorMessage(err, "Failed to generate a summary") });
      })
      .finally(() => clearTimeout(slowTimer));
    return () => {
      clearTimeout(slowTimer);
      controller.abort();
    };
  }, [chatId, timestamp, direction, attempt]);

  useEffect(() => {
    if (committing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, committing]);

  const regenerate = () => {
    setSummary("");
    setFingerprint("");
    setSlow(false);
    setPhase({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const commit = async () => {
    if (!summary.trim() || !fingerprint) return;
    setPhase({ kind: "committing" });
    try {
      onDone(await compressChat(chatId, timestamp, direction, summary, fingerprint, precondition));
    } catch (err) {
      if (err instanceof StaleSummaryError) setPhase({ kind: "stale", error: err.message });
      else setPhase({ kind: "failed", error: errorMessage(err, "Failed to compress chat") });
    }
  };

  const copy = COPY[direction];
  const busy = phase.kind === "loading" || committing;
  const canCommit = !busy && phase.kind !== "stale" && !!summary.trim() && !!fingerprint;

  return (
    <ModalOverlay onClose={dismiss}>
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
          <p role="status" style={{ margin: "0 0 16px 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Summarising on this chat&apos;s model… this can take a minute.
            {slow && (
              <>
                {" "}
                Long chats are summarised in parts and can take several minutes. Over remote access a proxy may give up on a request that long — if this fails,
                try compressing from a message closer to the end.
              </>
            )}
          </p>
        )}
        {(phase.kind === "failed" || phase.kind === "stale") && (
          <p role="alert" style={{ margin: "0 0 12px 0", fontSize: 13, color: "var(--danger)" }}>
            {phase.error}
            {phase.kind === "stale" && " Regenerating replaces the summary below, including any edits."}
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
              disabled={committing}
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
            onClick={dismiss}
            disabled={committing}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: committing ? "default" : "pointer",
              opacity: committing ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          {phase.kind === "stale" || (phase.kind === "failed" && !fingerprint) ? (
            <button type="button" onClick={regenerate} style={primaryButton(false)}>
              {phase.kind === "stale" ? "Regenerate summary" : "Try again"}
            </button>
          ) : (
            <button type="button" onClick={() => void commit()} disabled={!canCommit} style={primaryButton(!canCommit)}>
              {committing ? "Compressing…" : "Compress"}
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
