import { useCallback, useEffect, useRef, useState } from "react";
import { PackageCheck } from "lucide-react";
import type { SandboxDeliveriesResponse, SandboxDeliveredFile, SandboxKeptContainer, SandboxSessionDeliveries } from "shared/types/index.js";
import { sandboxDeliveriesClient } from "../api/sandboxDeliveries";
import MediaRenderer from "./MediaRenderer";
import { BYTES_UP_TO_GB, formatBytes } from "../utils/formatBytes";

/** How often the list is re-read while a sandbox session is live, and while one is kept. */
const LIVE_POLL_MS = 4_000;
const KEPT_POLL_MS = 30_000;

const REFUSAL_TEXT: Record<SandboxSessionDeliveries["refused"][number]["reason"], string> = {
  "too-large": "over the 64 MiB per-file limit",
  "session-total": "over the session's total-size limit",
  "file-count": "over the session's file-count limit",
  "storage-full": "over the disk limit for all deliverables (Settings → Sandbox desktop)",
};

/** "in 23 hours", "in 12 minutes". */
function untilText(at: number): string {
  const minutes = Math.max(1, Math.round((at - Date.now()) / 60_000));
  return minutes >= 90 ? `in ${Math.round(minutes / 60)} hours` : `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const buttonStyle = {
  padding: "3px 10px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
} as const;

/**
 * A kept container, with its two actions. The outcome is reported to the
 * group (`onOutcome`), not shown here: a successful retry or a discard
 * removes the container, and with it this notice.
 */
function KeptNotice({
  kept,
  chatId,
  onChanged,
  onOutcome,
}: {
  kept: SandboxKeptContainer;
  chatId: string;
  onChanged: () => void;
  onOutcome: (text: string) => void;
}) {
  const [busy, setBusy] = useState<"retry" | "discard" | null>(kept.retrying ? "retry" : null);
  const run = async (what: "retry" | "discard") => {
    if (what === "discard" && !window.confirm("Discard this sandbox desktop? Files it still holds that were not copied out are lost.")) return;
    setBusy(what);
    try {
      if (what === "retry") {
        const result = await sandboxDeliveriesClient.retryKept(chatId, kept.sessionId);
        onOutcome(
          result.outcome === "removed"
            ? "Retry export: every remaining file was copied, and the sandbox desktop was removed."
            : result.outcome === "gone"
              ? `Retry export: ${result.reason ?? "the container no longer exists."}`
              : `Retry export: still not complete (${result.reason ?? "the copy failed"}). It is still kept.`,
        );
      } else {
        await sandboxDeliveriesClient.discardKept(chatId, kept.sessionId);
        onOutcome("The kept sandbox desktop was discarded.");
      }
    } catch (error) {
      onOutcome(error instanceof Error ? error.message : "That did not work; try again.");
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  return (
    <div
      role="status"
      style={{
        border: "1px solid var(--warning)",
        background: "var(--warning-bg)",
        color: "var(--text)",
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span>
        <strong style={{ color: "var(--warning)" }}>Kept for recovery.</strong> Some files could not be copied out of this Sandbox desktop when its session
        ended ({kept.reason}), so instead of removing it, Callboard paused it; it still holds its memory. It is removed {untilText(kept.expiresAt)}.{" "}
        <strong>Retry export</strong> copies the remaining files and then removes the container; <strong>Discard</strong> removes it now.
      </span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => void run("retry")}>
          {busy === "retry" ? "Retrying…" : "Retry export"}
        </button>
        <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => void run("discard")}>
          {busy === "discard" ? "Discarding…" : "Discard"}
        </button>
      </span>
    </div>
  );
}

/** A delivered file as a #588 file card (images, audio, video and PDFs render inline, behind the untrusted gate). */
function DeliveredCard({ file, copied }: { file: SandboxDeliveredFile; copied: boolean }) {
  const inline = file.mediaType !== "file";
  const notes = [
    ...(file.storedName !== file.name ? [`A later version of ${file.name}`] : []),
    // Read-through: delivered in the chat this one's history was copied from (Continue from, Rerun, Compress, a fork or an aside).
    ...(copied ? ["From the chat this one's history was copied from"] : []),
  ];
  return (
    <MediaRenderer
      data={{
        type: "render_file",
        file_path: file.path,
        media_type: file.mediaType,
        mime_type: file.mimeType,
        display_mode: "inline",
        file_size: file.size,
        ...(notes.length ? { caption: notes.join(" · ") } : {}),
        ...(inline ? { untrusted: true, untrusted_reason: "Made inside the Sandbox desktop." } : {}),
      }}
    />
  );
}

/**
 * "Delivered from Sandbox desktop": the files this chat's Sandbox desktop
 * sessions copied out of `~/outbox`, as file cards, at the end of the
 * transcript. Also where a container kept for recovery is reported, with
 * Retry export and Discard. Renders nothing when there is nothing to say.
 */
export default function SandboxDeliveries({ chatId, sandboxLive }: { chatId: string; sandboxLive: boolean }) {
  // Keyed by chat, so another chat's list is never shown while this one loads.
  const [loaded, setLoaded] = useState<{ chatId: string; data: SandboxDeliveriesResponse } | null>(null);
  const generation = useRef(0);
  const load = useCallback(() => {
    const mine = ++generation.current;
    sandboxDeliveriesClient.list(chatId).then(
      (next) => {
        if (mine === generation.current) setLoaded({ chatId, data: next });
      },
      () => {
        /* Keep what is shown; the next poll retries. */
      },
    );
  }, [chatId]);
  const data = loaded?.chatId === chatId ? loaded.data : null;
  // The last Retry export / Discard outcome, kept here: the notice that ran it is gone once it succeeds.
  const [outcome, setOutcome] = useState<{ chatId: string; text: string } | null>(null);
  const outcomeText = outcome?.chatId === chatId ? outcome.text : "";

  // Re-read when a sandbox session starts or ends, and on a schedule while there is something to watch.
  useEffect(load, [load, sandboxLive]);
  const live = sandboxLive || !!data?.sessions.some((session) => session.state === "live");
  const kept = !!data?.kept.length;
  useEffect(() => {
    if (!live && !kept) return;
    const timer = window.setInterval(load, live ? LIVE_POLL_MS : KEPT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, kept, load]);

  if (!data) return null;
  const files = data.sessions.flatMap((session) => session.files.map((file) => ({ file, copied: !!session.fromChatId })));
  const refused = data.sessions.flatMap((session) => session.refused.map((refusal) => ({ ...refusal, sessionId: session.sessionId })));
  const keptIds = new Set(data.kept.map((k) => k.sessionId));
  // Another chat's problems are its own: only this chat's sessions report them here.
  const incomplete = data.sessions.filter((session) => session.state === "incomplete" && !session.fromChatId && !keptIds.has(session.sessionId));
  if (!files.length && !refused.length && !data.kept.length && !incomplete.length && !outcomeText) return null;

  return (
    <section aria-label="Delivered from Sandbox desktop" style={{ margin: "8px 0 12px", maxWidth: "92%" }}>
      <details open style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 10px", background: "var(--bg-secondary)" }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <PackageCheck size={14} aria-hidden="true" />
          Delivered from Sandbox desktop
          <span>
            · {files.length} file{files.length === 1 ? "" : "s"}
            {live ? " · syncing" : ""}
          </span>
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {data.kept.map((k) => (
            <KeptNotice key={k.sessionId} kept={k} chatId={chatId} onChanged={load} onOutcome={(text) => setOutcome({ chatId, text })} />
          ))}
          {outcomeText && (
            <div role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {outcomeText}
            </div>
          )}
          {incomplete.map((session) => (
            <div key={session.sessionId} role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {session.lost === "discarded"
                ? "A sandbox desktop was discarded before every file was copied out."
                : session.lost === "expired"
                  ? "A kept sandbox desktop reached the end of its retention before every file was copied out; it was removed."
                  : session.lost === "not-kept"
                    ? "Not every file was copied out of a sandbox desktop, and it could not be kept for recovery (the limit of kept sandboxes in Settings → Sandbox desktop was reached), so it was removed."
                    : session.lost === "gone"
                      ? "A kept sandbox desktop no longer exists, so the files it still held are gone."
                      : session.mode === "endpoint"
                        ? `Not every file was copied (${session.problem ?? "the copy failed"}); they are still in the sandbox's outbox.`
                        : `Not every file was copied (${session.problem ?? "the copy failed"}).`}
            </div>
          ))}
          {files.map(({ file, copied }) => (
            <DeliveredCard key={file.path} file={file} copied={copied} />
          ))}
          {refused.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }} aria-label="Not delivered">
              {refused.map((r) => (
                <li key={`${r.sessionId}:${r.name}`}>
                  Not delivered: {r.name} ({formatBytes(r.size, BYTES_UP_TO_GB)}), {REFUSAL_TEXT[r.reason] ?? "over a limit"}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}
