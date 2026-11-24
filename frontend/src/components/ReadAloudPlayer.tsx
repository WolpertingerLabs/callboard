import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { Loader2, Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useReadAloudPlayback } from "../hooks/useReadAloud";
import { isCoarsePointer } from "../utils/pointer";
import { cycleRate, getSpeaker, retry, seekBy, seekTo, stop, toggle } from "../utils/readAloudPlayer";

const SKIP_SECONDS = 10;

/** `m:ss`, or `h:mm:ss` from an hour up. Anything not a finite, positive time reads `0:00`. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function rateLabel(rate: number): string {
  return `${rate}×`;
}

/**
 * The read-aloud bar, docked above the chat's composer (pages/Chat.tsx), so
 * the controls stay on screen however far the message being read has
 * scrolled. One per chat view, showing the one page-wide playback when the
 * playing bubble is in its `scope`; nothing while idle. It is the only
 * subscriber that re-renders on `timeupdate` — the bubbles only ask "am I the
 * one playing" (hooks/useReadAloud.ts).
 *
 * Detached from its message, it names it: "Reading: <the start of its text>".
 *
 * The X closes the whole thing — the store's `stop`: the fetch aborted, the
 * audio paused, the blob URL revoked, the bar gone. It is the bar's one close
 * control in every state — named "Cancel read aloud" while preparing, "Close
 * audio player" otherwise — and Escape does the same. An error offers Retry
 * beside it when retrying can help.
 *
 * Shortcuts are taken only from inside the bar (`onKeyDown` on the group, no
 * global listener): Space/K play-pause, J/L or ←/→ skip 10 s, Escape closes.
 * Escape is claimed (`preventDefault` + `stopPropagation`) so an aside panel
 * around the chat, and the quote bar, leave it alone. The bar is a sibling of
 * the composer, not inside its root, and the composer's dictation Escape acts
 * only on keys from inside that root, so the two never meet. Space is
 * play/pause only on the play button, the slider or the group itself; on any
 * other button it is that button's own activation.
 *
 * Focus is kept, not dropped. When the controls swap and focus was on the
 * control that went away, it moves to the new state's main control: the X
 * while preparing, play/pause once the audio is ready, Retry on an error it
 * can help, the X on one it cannot. The X is one element throughout, so focus
 * on it simply stays.
 *
 * When the bar closes (X or Escape) with focus inside, focus goes back to the
 * playing bubble's speaker — but only if that speaker is in view in the
 * transcript, and always with `preventScroll`: the bar outlives its message's
 * scroll position, and focusing a far-off bubble would yank the transcript
 * there (and unlatch auto-scroll from the live tail). Otherwise, on desktop,
 * focus goes to the composer (`getComposer`, also without scrolling); on a
 * narrow or touch screen it is let go, since focusing the composer there
 * would pop the on-screen keyboard.
 */
export default function ReadAloudPlayer({ scope, getComposer }: { scope?: string; getComposer?: () => HTMLElement | null }) {
  const s = useReadAloudPlayback(scope);
  const isMobile = useIsMobile();
  const groupRef = useRef<HTMLDivElement>(null);
  /** The current state's main control: the X, play/pause, or Retry. */
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Whether focus is in the player. Cleared only when focus moves to something
   * else: a focused control that is removed fires no blur in some browsers, and
   * a null-target blur in others, and both mean "still ours".
   */
  const focusInside = useRef(false);
  const live = s.ownerId !== null && s.status !== "idle";
  const loading = s.status === "loading";
  const xIsPrimary = loading || (s.status === "error" && !s.retryable);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** Whether the X was the main control in the previous state. */
  const xWasPrimary = useRef(xIsPrimary);

  useEffect(() => {
    const wasPrimary = xWasPrimary.current;
    xWasPrimary.current = xIsPrimary;
    if (!live || !focusInside.current) return;
    const active = document.activeElement;
    // Focus lost with its control, or left on the X when it stopped being the
    // main control (the audio arrived; a load failed in a way Retry can help).
    const onDemotedX = active === closeRef.current && wasPrimary && !xIsPrimary;
    if (!active || active === document.body || onDemotedX) primaryRef.current?.focus();
  }, [s.status, live, xIsPrimary]);

  if (!live) return null;

  /** Close; if the bar had focus, hand it on (see the component's doc). */
  const end = () => {
    const hadFocus = !!groupRef.current?.contains(document.activeElement);
    const speaker = s.ownerId ? getSpeaker(s.ownerId) : null;
    focusInside.current = false;
    stop();
    if (!hadFocus) return;
    if (speaker?.isConnected && isInScrollView(speaker)) speaker.focus({ preventScroll: true });
    else if (!isMobile && !isCoarsePointer()) getComposer?.()?.focus({ preventScroll: true });
  };

  const onFocus = () => {
    focusInside.current = true;
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && !e.currentTarget.contains(next)) focusInside.current = false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      end();
      return;
    }
    if (s.status !== "playing" && s.status !== "paused") return;
    // The slider handles its own arrow keys; a second, 10 s seek on top would double up.
    const onSlider = e.target instanceof HTMLInputElement && e.target.type === "range";
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Space activates a focused button natively; only where that would do
    // nothing, or would itself be play/pause, is it ours.
    const spaceIsOurs = e.target === e.currentTarget || onSlider || e.target === primaryRef.current;
    if ((key === " " && spaceIsOurs) || key === "k") {
      // Claimed, so Space on the play button does not toggle twice.
      e.preventDefault();
      toggle();
    } else if (!onSlider && (key === "ArrowLeft" || key === "j")) {
      e.preventDefault();
      seekBy(-SKIP_SECONDS);
    } else if (!onSlider && (key === "ArrowRight" || key === "l")) {
      e.preventDefault();
      seekBy(SKIP_SECONDS);
    }
  };

  return (
    <div ref={groupRef} className="read-aloud-player" role="group" aria-label="Read aloud player" onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur}>
      {s.label && (
        <span className="read-aloud-label" title={s.label}>
          Reading: <span className="read-aloud-label-text">{s.label}</span>
        </span>
      )}

      {s.status === "loading" && (
        <>
          <Loader2 size={14} className="voice-spinner" aria-hidden="true" />
          <span className="read-aloud-text" aria-live="polite">
            Preparing audio…
          </span>
        </>
      )}

      {s.status === "error" && (
        <>
          <span className="read-aloud-text read-aloud-error" role="alert">
            {s.error}
          </span>
          {s.retryable && (
            <button ref={primaryRef} type="button" className="read-aloud-btn read-aloud-btn-text" onClick={retry}>
              Retry
            </button>
          )}
        </>
      )}

      {(s.status === "playing" || s.status === "paused") && (
        <>
          <button type="button" className="read-aloud-btn" aria-label="Back 10 seconds" title="Back 10 seconds (J)" onClick={() => seekBy(-SKIP_SECONDS)}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="read-aloud-btn read-aloud-btn-primary"
            aria-label={s.status === "playing" ? "Pause" : "Play"}
            title={s.status === "playing" ? "Pause (K)" : "Play (K)"}
            onClick={toggle}
          >
            {s.status === "playing" ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </button>
          <button type="button" className="read-aloud-btn" aria-label="Forward 10 seconds" title="Forward 10 seconds (L)" onClick={() => seekBy(SKIP_SECONDS)}>
            <RotateCw size={14} aria-hidden="true" />
          </button>
          <input
            type="range"
            className="read-aloud-progress"
            aria-label="Seek"
            min={0}
            max={s.duration > 0 ? s.duration : 0}
            step={1}
            value={Math.min(s.currentTime, s.duration > 0 ? s.duration : s.currentTime)}
            disabled={!(s.duration > 0)}
            aria-valuetext={`${formatClock(s.currentTime)} of ${formatClock(s.duration)}`}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          <span className="read-aloud-time">
            {formatClock(s.currentTime)} / {formatClock(s.duration)}
          </span>
          <button
            type="button"
            className="read-aloud-btn read-aloud-btn-text read-aloud-rate"
            aria-label={`Playback speed ${rateLabel(s.rate)}`}
            title="Playback speed"
            onClick={cycleRate}
          >
            {rateLabel(s.rate)}
          </button>
        </>
      )}

      {/* One element in every state (a fixed slot among the children), so
          focus on it survives a state change. */}
      <button
        ref={(el) => {
          closeRef.current = el;
          if (xIsPrimary) primaryRef.current = el;
        }}
        type="button"
        className="read-aloud-btn read-aloud-close"
        aria-label={loading ? "Cancel read aloud" : "Close audio player"}
        title={loading ? "Cancel (Esc)" : "Close (Esc)"}
        onClick={end}
      >
        <X size={16} aria-hidden="true" />
      </button>

      {(s.status === "playing" || s.status === "paused") && s.hint && <span className="read-aloud-note">{s.hint}</span>}
      {(s.status === "playing" || s.status === "paused") && s.truncated && <span className="read-aloud-note">Reading the start of this long message.</span>}
    </div>
  );
}

/**
 * Whether `el` is on screen: within every scrolling ancestor's visible box
 * and the viewport. Edges are inclusive, so an element with no layout box
 * (jsdom) counts as in view.
 */
function isInScrollView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return false;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = `${style.overflowY} ${style.overflow}`;
    if (!/auto|scroll|hidden/.test(overflow)) continue;
    const box = node.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) return false;
  }
  return true;
}
