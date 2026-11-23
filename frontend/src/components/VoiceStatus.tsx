import { MAX_VOICE_RECORDING_MS } from "shared/types/voice.js";
import type { VoiceDictationState } from "../hooks/useVoiceDictation";

/** Past this, the readout turns to the warning colour: the auto-stop is close. */
const WARN_AT_MS = MAX_VOICE_RECORDING_MS - 30_000;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

interface Props {
  state: VoiceDictationState;
  /** Show the "Esc to cancel" hint — keyboards only. */
  showEscapeHint: boolean;
}

/**
 * The dictation status line above the input row. Always mounted while the mic
 * is, so the live region exists before it has anything to say (a region
 * inserted together with its text is often not announced); empty and
 * zero-height when idle.
 *
 * The ticking time is `aria-hidden`: a screen reader hears "Recording" once,
 * not a new announcement four times a second.
 */
export default function VoiceStatus({ state, showEscapeHint }: Props) {
  let content: React.ReactNode = null;
  if (state.status === "requesting") {
    content = <span>Waiting for microphone…</span>;
  } else if (state.status === "recording") {
    const warn = state.elapsedMs >= WARN_AT_MS;
    content = (
      <>
        <span aria-hidden className="voice-recording" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)", flexShrink: 0 }} />
        <span>Recording</span>
        <span aria-hidden style={{ fontVariantNumeric: "tabular-nums", color: warn ? "var(--warning)" : undefined }}>
          {formatElapsed(state.elapsedMs)} / {formatElapsed(MAX_VOICE_RECORDING_MS)}
        </span>
        {showEscapeHint && <span aria-hidden>· Esc to cancel</span>}
      </>
    );
  } else if (state.status === "transcribing") {
    content = <span>Transcribing…</span>;
  } else if (state.status === "error") {
    content = <span style={{ color: state.tone === "error" ? "var(--error)" : undefined }}>{state.message}</span>;
  }
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: content ? "flex" : "block",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text-muted)",
        padding: content ? "0 4px 6px" : 0,
        minHeight: 0,
      }}
    >
      {content}
    </div>
  );
}
