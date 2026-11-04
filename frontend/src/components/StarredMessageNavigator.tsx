import type { CSSProperties } from "react";
import { ChevronDown, ChevronUp, Star } from "lucide-react";

interface Props {
  count: number;
  /** 0-based position of the star last navigated to, or null before the first jump. */
  current: number | null;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  style?: CSSProperties;
}

/**
 * Up/down through the chat's starred messages, floating over the transcript.
 * Renders nothing when there are none, so the call site can include it
 * unconditionally.
 */
export default function StarredMessageNavigator({ count, current, canPrev, canNext, onPrev, onNext, style }: Props) {
  if (count === 0) return null;
  const label = `${current === null ? "–" : current + 1} / ${count}`;
  return (
    <div
      role="group"
      aria-label="Starred messages"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "var(--shadow-md)",
        overflow: "hidden",
        ...style,
      }}
    >
      <button onClick={onPrev} disabled={!canPrev} title="Previous starred message" aria-label="Previous starred message" style={arrowStyle(canPrev)}>
        <ChevronUp size={16} />
      </button>
      <div
        data-testid="starred-position"
        title={`${count} starred message${count === 1 ? "" : "s"}`}
        style={{ display: "flex", alignItems: "center", gap: 3, padding: "2px 6px", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}
      >
        <Star size={10} fill="currentColor" style={{ color: "var(--warning)" }} />
        {label}
      </div>
      <button onClick={onNext} disabled={!canNext} title="Next starred message" aria-label="Next starred message" style={arrowStyle(canNext)}>
        <ChevronDown size={16} />
      </button>
    </div>
  );
}

const arrowStyle = (enabled: boolean): CSSProperties => ({
  width: "100%",
  padding: "6px 8px",
  background: "transparent",
  border: "none",
  color: enabled ? "var(--text)" : "var(--text-muted)",
  opacity: enabled ? 1 : 0.4,
  cursor: enabled ? "pointer" : "default",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});
