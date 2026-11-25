import { AttachedFileChips, BUBBLE_BASE_STYLE } from "./MessageBubble";
import MarkdownRenderer from "./MarkdownRenderer";
import type { InFlightMessage } from "../utils/inFlightMessages";

/**
 * Optimistic user bubbles, styled like a sent message but dimmed and without
 * the copy/fork affordances a persisted message gets. Rendered in both the
 * empty-chat and populated-transcript branches of the chat page.
 *
 * The text goes through the same renderer a persisted user bubble uses
 * (MessageBubble), so the bubble keeps its formatting when the transcript
 * catches up and replaces it. `message.text` is only what the user typed:
 * attachment blocks and ride-along notices are added server-side, never here.
 *
 * Two deliberate differences from the persisted bubble:
 * - No `data-quote-content`: a message still being sent is not quotable.
 * - No built-in-command styling. `isBuiltInCommand` is set by the Claude
 *   session parser from the command envelope the CLI records, and the page
 *   cannot predict it: its command list is per-folder and provider-agnostic,
 *   so styling by it would misrender in other providers' chats.
 */
export default function InFlightBubbles({ messages }: { messages: InFlightMessage[] }) {
  return (
    <>
      {messages.map((message) => (
        <div key={message.key} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", margin: "6px 0" }}>
          <div
            style={{
              ...BUBBLE_BASE_STYLE,
              background: "var(--user-bg)",
              border: "1px solid transparent",
              opacity: 0.9,
            }}
          >
            {message.text && <MarkdownRenderer content={message.text} className="message-markdown" />}
            {message.fileNames && message.fileNames.length > 0 && <AttachedFileChips files={message.fileNames.map((name) => ({ name }))} />}
            {/* Carried across the new-chat redirect: the count came, the previews could not. */}
            {message.imageUrls.length === 0 && !!message.imageCount && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
                {message.imageCount} image{message.imageCount === 1 ? "" : "s"}
              </div>
            )}
            {/* Deliberately not in the chat image gallery: these are local
                previews of a message still being sent, and they are replaced
                by gallery-registered ImageThumbnails once it is persisted. */}
            {message.imageUrls.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {message.imageUrls.map((url) => (
                  <img
                    key={url}
                    src={url}
                    alt="Attached image"
                    style={{ maxHeight: 200, maxWidth: 300, borderRadius: 8, objectFit: "cover", border: "1px solid var(--border)" }}
                  />
                ))}
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, textAlign: "right" }}>Sent</div>
        </div>
      ))}
    </>
  );
}
