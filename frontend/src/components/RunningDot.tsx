import type { CSSProperties } from "react";

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
