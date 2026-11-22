import type { HeldMessage } from "shared/types/index.js";
import { AttachedFileChips } from "./MessageBubble";

/**
 * The messages this chat holds until its turn ends ("Enqueue Send"), shown
 * at the end of the transcript, after the turn they wait on. Each one looks
 * like the user bubble it will become, dashed and muted because it has not
 * been sent, with a line saying where it stands and what can be done with it.
 *
 * Presentation only: the list is the daemon's (`/activity`'s
 * `heldMessages`), and every action is the page's.
 */
export interface HeldMessageListProps {
  items: readonly HeldMessage[];
  /** Items with an action out right now: their buttons are greyed until it settles. */
  busyIds?: ReadonlySet<string>;
  /** A Resume queue request is out. */
  resuming?: boolean;
  onSendNow: (item: HeldMessage) => void;
  onEdit: (item: HeldMessage) => void;
  onRemove: (item: HeldMessage) => void;
  /** Re-queue the paused and failed items. */
  onResume: () => void;
}

/**
 * Where an item stands. `queuePosition` is its 1-based place among the
 * queued items, given only when more than one is queued.
 */
export function heldStateLine(item: HeldMessage, queuePosition?: number): string {
  switch (item.state) {
    case "queued":
      return queuePosition ? `Queued · #${queuePosition} in queue` : "Queued · sends when this turn ends";
    case "delivering":
      return "Sending…";
    case "paused":
      return item.reason ? `Paused · ${item.reason}` : "Paused";
    case "failed":
      return item.reason ? `Couldn't send · ${item.reason}` : "Couldn't send";
    default:
      // A state a newer daemon added: the type promises it is "not sending yet".
      return "Waiting";
  }
}

const actionStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  color: "var(--text)",
  cursor: "pointer",
};

export default function HeldMessageList({ items, busyIds, resuming = false, onSendNow, onEdit, onRemove, onResume }: HeldMessageListProps) {
  if (items.length === 0) return null;
  const queued = items.filter((item) => item.state === "queued");
  const canResume = items.some((item) => item.state === "paused" || item.state === "failed");
  return (
    <section aria-label="Held messages" style={{ display: "flex", flexDirection: "column", gap: 4, margin: "6px 0" }}>
      {items.map((item) => {
        const position = queued.length > 1 ? queued.indexOf(item) + 1 : 0;
        const busy = busyIds?.has(item.id) ?? false;
        // Being sent right now: the daemon refuses to give it back.
        const locked = busy || item.state === "delivering";
        const failed = item.state === "failed";
        return (
          <article
            key={item.id}
            aria-label="Held message"
            data-held-state={item.state}
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", margin: "4px 0" }}
          >
            <div
              style={{
                maxWidth: "92%",
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                border: "1px dashed var(--border)",
                color: "var(--text-muted)",
                fontSize: 14,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {item.text}
              {item.images && item.images.length > 0 && <AttachedFileChips files={item.images.map((image) => ({ name: image.originalName }))} />}
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 6,
                marginTop: 4,
                fontSize: 11,
                color: failed ? "var(--error)" : "var(--text-muted)",
              }}
            >
              <span role="status">{heldStateLine(item, position || undefined)}</span>
              <button type="button" style={actionStyle} disabled={locked} onClick={() => onSendNow(item)} title="Send it now, interrupting the current turn">
                Send now
              </button>
              <button type="button" style={actionStyle} disabled={locked} onClick={() => onEdit(item)} title="Take it back into the composer">
                Edit
              </button>
              <button type="button" style={actionStyle} disabled={locked} onClick={() => onRemove(item)} title="Remove without sending">
                Remove
              </button>
            </div>
          </article>
        );
      })}
      {canResume && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={actionStyle} disabled={resuming} onClick={onResume} title="Queue the paused messages again">
            Resume queue
          </button>
        </div>
      )}
    </section>
  );
}
