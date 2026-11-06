import { useCallback } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { useCopy } from "../hooks/useCopy";

interface Props {
  /** Text placed on the clipboard when the button is pressed. */
  text: string;
  /**
   * When given, an HTML rendering written alongside `text` so rich targets
   * (Slack, Docs) paste formatting. A getter, not a string: rendering happens
   * on click rather than on every render of every bubble.
   */
  html?: () => string;
  /** Idle icon; defaults to the copy glyph. */
  icon?: LucideIcon;
  /** Tooltip and accessible name — "Copy message", "Copy code", … */
  title: string;
  /**
   * Class the hover-reveal CSS keys on (`.copy-btn`, `.code-copy-btn`). Those
   * selectors match a DIRECT child of the hovered container, so wrapping this
   * button in another element breaks them — see MessageBubble.fork.test.tsx.
   */
  className: string;
  /** Positioning, supplied by the caller; the chrome is owned here. */
  style?: React.CSSProperties;
  size?: number;
}

/**
 * A copy-to-clipboard button that flips to a checkmark for 1.5s on success.
 *
 * Shared by the per-message affordance in MessageBubble and the per-code-block
 * one in MarkdownRenderer, so both behave identically — including the fallback
 * for non-secure contexts in utils/clipboard.
 */
export default function CopyButton({ text, html, icon: Icon = Copy, title, className, style, size = 14 }: Props) {
  const [copied, copy] = useCopy();

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      // A code block sits inside a message bubble that has its own click
      // handlers; copying must not also select or fork the message.
      e.stopPropagation();
      await copy(text, html?.());
    },
    [text, html, copy],
  );

  return (
    <button
      className={className}
      onClick={handleCopy}
      title={title}
      aria-label={title}
      style={{
        padding: 4,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1,
        ...style,
      }}
    >
      {copied !== null ? <Check size={size} style={{ color: "var(--success)" }} /> : <Icon size={size} style={{ color: "var(--text-muted)" }} />}
    </button>
  );
}
