import { Loader2, Mic, Square } from "lucide-react";
import type { VoiceDictation } from "../hooks/useVoiceDictation";

interface Props {
  dictation: VoiceDictation;
  /** The composer is disabled: the mic is too, like the paperclip beside it. */
  disabled: boolean;
}

/**
 * The composer's mic, 24×24 beside the paperclip inside the input field.
 *
 * Unavailable (no OpenRouter key, insecure context) is `aria-disabled` rather
 * than `disabled`, so it stays focusable and its `title` — the reason — can be
 * read. A press does nothing then. Enter/Space come from native button
 * semantics; Escape (cancel) is handled by the composer, scoped to its chat.
 */
export default function VoiceInputButton({ dictation, disabled }: Props) {
  const { state, unavailableReason, toggle } = dictation;
  const unavailable = !!unavailableReason;
  const recording = state.status === "recording";
  const busy = state.status === "transcribing";
  const requesting = state.status === "requesting";
  const inert = unavailable || disabled || busy || requesting;

  const label = recording ? "Stop recording and transcribe" : busy ? "Transcribing…" : requesting ? "Waiting for microphone…" : "Start voice input";
  const title = unavailableReason ?? (recording ? "Stop recording and transcribe (Esc cancels)" : busy ? "Transcribing…" : "Voice input");

  return (
    <button
      type="button"
      data-testid="voice-input-button"
      className={recording ? "voice-recording" : undefined}
      aria-label={label}
      aria-pressed={recording}
      aria-busy={busy || undefined}
      aria-disabled={unavailable || busy || requesting ? true : undefined}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (unavailable || disabled) return;
        toggle();
      }}
      style={{
        position: "absolute",
        right: 36,
        bottom: 8,
        width: 24,
        height: 24,
        borderRadius: 6,
        background: recording ? "var(--danger-bg)" : "var(--border)",
        color: recording ? "var(--danger)" : "var(--text-muted)",
        border: recording ? "1px solid var(--danger-border)" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: inert ? "default" : "pointer",
        opacity: unavailable || disabled ? 0.5 : 1,
        transition: "all 0.2s ease",
        zIndex: 6,
      }}
    >
      {recording ? (
        <Square size={11} fill="currentColor" aria-hidden />
      ) : busy || requesting ? (
        <Loader2 size={14} className="voice-spinner" aria-hidden />
      ) : (
        <Mic size={14} aria-hidden />
      )}
    </button>
  );
}
