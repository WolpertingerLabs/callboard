import { useState, useEffect } from "react";
import type { ChatActivity, ConditionWatch } from "../api";
import ConfirmModal from "./ConfirmModal";

/**
 * The live activity row above the composer.
 *
 * A chat sitting inside a 300-second `wait` used to render exactly like a
 * finished one. This is where "the agent is doing something that takes time,
 * here is what and for how long" lives — for all three ways a chat can
 * legitimately be busy with its turn over: a `wait`, an outstanding
 * `onComplete` callback, and a background-task hold.
 *
 * The countdown is computed locally from `expiresAt` rather than pushed from
 * the server — the client already knows the deadline, so ticking is arithmetic
 * and a reconnect re-derives the right number instead of resuming a stale
 * stream of ticks.
 */

/** `mm:ss`, floored at zero so an overdue timer reads "0:00" and not "-0:03". */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Verb for each activity kind, in the voice of the status line it sits in. */
const KIND_VERB: Record<ChatActivity["kind"], string> = {
  wait: "Waiting",
  await_chat: "Awaiting chat",
  await_agent: "Awaiting agent",
  generating: "Generating",
  scanning: "Scanning",
  holding: "Holding the session open",
};

/**
 * The verb, or a neutral one for a kind this bundle predates.
 *
 * Activities cross REST rather than the SSE wire, so `ActivityKind` carries no
 * capability gate and a tab running an older bundle can be handed a kind that
 * is not in the map above — the row would then render "· undefined". The
 * fallback is the whole mitigation, and it is why `shared/types/activity.ts`
 * puts the obligation on consumers: this lookup is the one that would break.
 */
function verbFor(kind: ChatActivity["kind"]): string {
  return KIND_VERB[kind] ?? "Busy";
}

interface ActivityDockProps {
  activities: ChatActivity[];
  conditionWatch: ConditionWatch | null;
  awaitingChildren: number;
  /** Resolves when the server has accepted the release. */
  onRelease: (activityId: string) => Promise<void>;
}

export default function ActivityDock({ activities, conditionWatch, awaitingChildren, onRelease }: ActivityDockProps) {
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<ChatActivity | null>(null);
  const [releasing, setReleasing] = useState(false);

  // One ticker, only while something is actually counting down.
  const hasDeadline = activities.some((a) => a.expiresAt !== undefined);
  useEffect(() => {
    if (!hasDeadline) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasDeadline]);

  // A turn is single-threaded, so at most one activity blocks it. Anything
  // else is a bug elsewhere; showing the first is the honest fallback.
  const primary = activities[0];

  if (!primary && awaitingChildren === 0) return null;

  const handleConfirm = async () => {
    if (!confirming) return;
    setReleasing(true);
    try {
      await onRelease(confirming.id);
    } finally {
      setReleasing(false);
      setConfirming(null);
    }
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          // 12px each side to sit inside the composer's own horizontal
          // padding: the dock is a bordered box directly above a bordered
          // box, and flush-to-the-edge made it read as the wider of the two.
          margin: "0 12px 8px",
          borderRadius: 8,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        {primary && (
          <>
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent)",
                flexShrink: 0,
                animation: "thinking-bounce 1.4s ease-in-out infinite",
              }}
            />
            <span style={{ color: "var(--text)", fontWeight: 500 }}>{primary.label}</span>

            {primary.expiresAt !== undefined && <span style={{ fontVariantNumeric: "tabular-nums" }}>— {formatRemaining(primary.expiresAt - now)} left</span>}

            {primary.detail && <span style={{ opacity: 0.8 }}>· {primary.detail}</span>}

            {primary.condition && (
              <span style={{ opacity: 0.9 }}>
                · waiting for: {primary.condition.text} (attempt {primary.condition.attempt}/{primary.condition.maxAttempts})
              </span>
            )}

            {!primary.condition && primary.kind !== "wait" && <span style={{ opacity: 0.8 }}>· {verbFor(primary.kind)}</span>}

            {primary.interruptible && (
              <button
                type="button"
                onClick={() => setConfirming(primary)}
                disabled={releasing}
                style={{
                  marginLeft: "auto",
                  padding: "3px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  cursor: releasing ? "default" : "pointer",
                  opacity: releasing ? 0.6 : 1,
                }}
              >
                End wait
              </button>
            )}
          </>
        )}

        {/* Shown with or without a live activity: a parent that spawned work
            and finished its own turn is precisely the case that used to look
            idle and done. */}
        {awaitingChildren > 0 && (
          <span style={{ ...(primary ? { flexBasis: "100%" } : {}), opacity: 0.9 }}>
            Awaiting {awaitingChildren} spawned chat{awaitingChildren === 1 ? "" : "s"}
          </span>
        )}

        {/* A watch with no live wait means the agent is between polls — doing
            its check right now. Without this the row would vanish and reappear
            every interval. */}
        {conditionWatch && !primary && (
          <span>
            Checking: {conditionWatch.text} (attempt {conditionWatch.attempts}/{conditionWatch.maxAttempts})
          </span>
        )}
      </div>

      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={handleConfirm}
        title="End this wait early?"
        message={
          confirming?.condition
            ? `The agent is waiting for: ${confirming.condition.text}. Ending the wait now tells it to check the condition immediately instead of sleeping out the remaining time.`
            : "The agent will resume immediately instead of sleeping out the remaining time. Use this when you can already see the thing it is waiting for has happened."
        }
        confirmText="End wait"
        confirmStyle="primary"
      />
    </>
  );
}
