import type { CSSProperties } from "react";
import { visuallyHidden } from "../utils/visuallyHidden";

/**
 * `running`: green, something is working. `waiting`: yellow, something is
 * blocked on the user — a permission prompt, a question, an open approval.
 */
export type RunningTone = "running" | "waiting";

const TONE_COLOR: Record<RunningTone, string> = {
  running: "var(--status-active)",
  waiting: "var(--warning)",
};

/** What a waiting dot means, for the label every caller pairs it with. */
export const WAITING_LABEL = "Waiting for your answer";

/**
 * The green "something is running" dot — the sidebar's folder headers, chat
 * rows and the chat page header all paint the same one. With `tone="waiting"`
 * it is yellow instead: the chat (or something under it) has a question for
 * the user.
 *
 * Purely decorative: it is colour alone, so every caller pairs it with text
 * that names what it means (a visually hidden label, or a visible one).
 */
export default function RunningDot({ style, tone = "running" }: { style?: CSSProperties; tone?: RunningTone }) {
  const color = TONE_COLOR[tone];
  return (
    <span
      aria-hidden
      data-testid="running-dot"
      data-tone={tone}
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        flexShrink: 0,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 5px ${color}`,
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
  tone = "running",
}: {
  count: number;
  /** See {@link RunningTone}: a tree with someone waiting counts in yellow. */
  tone?: RunningTone;
  label: string;
  testId?: string;
  /** The tooltip; defaults to `label`. */
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      title={title ?? label}
      style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, color: TONE_COLOR[tone], ...style }}
    >
      <RunningDot tone={tone} />
      <span aria-hidden>{count}</span>
      <span style={visuallyHidden}>{label}</span>
    </span>
  );
}
