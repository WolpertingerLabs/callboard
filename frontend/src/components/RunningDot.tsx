import type { CSSProperties } from "react";
import { visuallyHidden } from "../utils/visuallyHidden";

/**
 * The green "something is running" dot — the sidebar's folder headers, chat
 * rows and the chat page header all paint the same one.
 *
 * Purely decorative: it is colour alone, so every caller pairs it with text
 * that names what it means (a visually hidden label, or a visible one).
 */
export default function RunningDot({ style }: { style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      data-testid="running-dot"
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        flexShrink: 0,
        borderRadius: "50%",
        background: "var(--status-active)",
        boxShadow: "0 0 5px var(--status-active)",
        ...style,
      }}
    />
  );
}

/**
 * What a live session's dot means. Web and CLI sessions share the one dot;
 * which side the agent is running on is only in the words.
 */
export function activeSessionLabel(type: string): string {
  return type === "web" ? "Active in web" : "Active in CLI";
}

/**
 * The dot with a number beside it, in the dot's colour — "this many working".
 * The sidebar section headers, a collapsed tree node and a group row all use
 * it, so a count of running chats reads the same wherever it appears.
 *
 * The number is `aria-hidden` and `label` says it in words, because a bare
 * "2" next to a colour means nothing to a screen reader.
 */
export function RunningCount({
  count,
  label,
  testId,
  title,
  style,
}: {
  count: number;
  label: string;
  testId?: string;
  /** The tooltip; defaults to `label`. */
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      data-testid={testId}
      title={title ?? label}
      style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, color: "var(--status-active)", ...style }}
    >
      <RunningDot />
      <span aria-hidden>{count}</span>
      <span style={visuallyHidden}>{label}</span>
    </span>
  );
}
