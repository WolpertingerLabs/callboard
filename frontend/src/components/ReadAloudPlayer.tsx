import type { KeyboardEvent } from "react";
import { Loader2, Pause, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import { useReadAloud } from "../hooks/useReadAloud";
import { cycleRate, retry, seekBy, seekTo, stop, toggle } from "../utils/readAloudPlayer";

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
 * The inline player under the bubble being read aloud. Renders nothing for
 * any other bubble — and, through `useReadAloud`'s selector, does not even
 * re-render for them.
 *
 * Shortcuts are taken only from inside the player (`onKeyDown` on the group,
 * no global listener): Space/K play-pause, J/L or ←/→ skip 10 s, Escape stops.
 * Escape is claimed (`preventDefault` + `stopPropagation`) so an aside panel
 * around the chat, and the quote bar, leave it alone; the composer's dictation
 * Escape only acts on keys from inside the composer, so the two never meet.
 */
export default function ReadAloudPlayer({ ownerId }: { ownerId: string }) {
  const s = useReadAloud(ownerId);
  if (s.ownerId !== ownerId || s.status === "idle") return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }
    if (s.status !== "playing" && s.status !== "paused") return;
    // The slider handles its own arrow keys; a second, 10 s seek on top would double up.
    const onSlider = e.target instanceof HTMLInputElement && e.target.type === "range";
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === " " || key === "k") {
      // Claimed, so Space on a focused button does not also click it.
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
    <div className="read-aloud-player" role="group" aria-label="Read aloud player" onKeyDown={onKeyDown}>
      {s.status === "loading" && (
        <>
          <Loader2 size={14} className="voice-spinner" aria-hidden="true" />
          <span className="read-aloud-text" aria-live="polite">
            Preparing audio…
          </span>
          <button type="button" className="read-aloud-btn read-aloud-btn-text" aria-label="Cancel read aloud" onClick={stop}>
            Cancel
          </button>
        </>
      )}

      {s.status === "error" && (
        <>
          <span className="read-aloud-text read-aloud-error" role="alert">
            {s.error}
          </span>
          {s.retryable && (
            <button type="button" className="read-aloud-btn read-aloud-btn-text" onClick={retry}>
              Retry
            </button>
          )}
          <button type="button" className="read-aloud-btn read-aloud-btn-text" onClick={stop}>
            Dismiss
          </button>
        </>
      )}

      {(s.status === "playing" || s.status === "paused") && (
        <>
          <button type="button" className="read-aloud-btn" aria-label="Back 10 seconds" title="Back 10 seconds (J)" onClick={() => seekBy(-SKIP_SECONDS)}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button
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
          <button type="button" className="read-aloud-btn" aria-label="Stop" title="Stop (Esc)" onClick={stop}>
            <Square size={12} aria-hidden="true" />
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
          {s.hint && <span className="read-aloud-note">{s.hint}</span>}
          {s.truncated && <span className="read-aloud-note">Reading the first ~13 minutes of this long message.</span>}
        </>
      )}
    </div>
  );
}
