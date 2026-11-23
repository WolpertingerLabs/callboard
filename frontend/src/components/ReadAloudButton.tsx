import { useContext, useEffect, useRef } from "react";
import { Loader2, Volume2 } from "lucide-react";
import { ReadAloudScope, useReadAloudStatus } from "../hooks/useReadAloud";
import { registerSpeaker, release, start, stop } from "../utils/readAloudPlayer";

/**
 * The speaker in a bubble's hover row (beside copy, fork and star). Reads that
 * one message aloud; a second click — while preparing or playing — stops it.
 *
 * Revealed on `.msg-bubble:hover` like its neighbours, plus on keyboard focus
 * and while its message is the one playing (`.is-active`), so the control that
 * stops playback never fades out from under it.
 *
 * Unavailable (no OpenRouter key) it stays focusable but `aria-disabled`, its
 * tooltip naming the fix — the composer mic's pattern.
 *
 * The controls are in the bar docked above the composer (ReadAloudPlayer),
 * under the chat view's `ReadAloudScope`; this button registers itself with
 * the store so the bar can hand focus back to it when it closes.
 *
 * The bubble owning this button owns the playback: unmounting it (navigating
 * away, the bubble's key changing) stops whatever it was reading.
 */
export default function ReadAloudButton({
  ownerId,
  markdown,
  available,
  reason,
  right,
}: {
  ownerId: string;
  /** The message's markdown — converted to speech only when clicked. */
  markdown: string;
  available: boolean;
  reason?: string;
  right: number;
}) {
  const status = useReadAloudStatus(ownerId);
  const scope = useContext(ReadAloudScope);
  const active = status !== "idle";
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => release(ownerId), [ownerId]);
  useEffect(() => (buttonRef.current ? registerSpeaker(ownerId, buttonRef.current) : undefined), [ownerId]);

  const stoppable = available && status !== "idle" && status !== "error";
  const label = stoppable ? "Stop reading aloud" : "Read aloud";

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`read-aloud-affordance${active ? " is-active" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!available) return;
        // Synchronous, inside the click: the store unlocks iOS audio here.
        if (stoppable) stop();
        else start(ownerId, markdown, scope);
      }}
      title={available ? label : reason}
      aria-label={label}
      aria-disabled={available ? undefined : true}
      style={{
        position: "absolute",
        top: 6,
        right,
        zIndex: 2,
        padding: 4,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        cursor: available ? "pointer" : "not-allowed",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {status === "loading" ? (
        <Loader2 size={14} className="voice-spinner" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
      ) : (
        // Dimmed on the icon, not the button: the button's opacity is the hover reveal's.
        <Volume2 size={14} style={{ color: stoppable ? "var(--accent-text)" : "var(--text-muted)", opacity: available ? undefined : 0.5 }} aria-hidden="true" />
      )}
    </button>
  );
}
