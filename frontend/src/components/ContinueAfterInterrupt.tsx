import { Play } from "lucide-react";

/**
 * The button under a transcript whose last turn the user stopped. Sits where
 * the "thinking" row would be, left-aligned and quiet: it is an offer, not a
 * prompt the user has to dismiss.
 */
export function ContinueButton({ onContinue }: { onContinue: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" }}>
      <button
        type="button"
        data-testid="continue-after-interrupt"
        onClick={onContinue}
        title="Resume the interrupted work where it left off"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          padding: "4px 10px",
          borderRadius: 4,
          fontSize: 12,
          border: "none",
          cursor: "pointer",
        }}
      >
        <Play size={12} aria-hidden />
        Continue
      </button>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Pick up where it was interrupted</span>
    </div>
  );
}

/**
 * What the Continue button's prompt renders as in the transcript: a divider
 * like the interruption marker above it, not a user bubble of boilerplate.
 */
export function ContinuedDivider() {
  return (
    <div data-testid="continued-divider" style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0", padding: "0 8px" }}>
      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
      <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", whiteSpace: "nowrap", userSelect: "none" }}>Continued</div>
      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}
