import type { ParsedMessage } from "./message.js";

/**
 * A ride-along notice block: computer-control updates the daemon owed the
 * agent (a withdrawn request, say), carried at the very front of the next
 * turn's user prompt because no other channel reaches every engine without
 * system authority (backend/src/services/chat-notices.ts). The engines save
 * the prompt as the human's message, so everything that shows or reuses a
 * user turn — the transcript, the in-flight match, rerun, draft restore —
 * splits the block back off with {@link splitRideAlongBlock}.
 *
 * The format is fixed end to end, and the split is strict about it, so a human
 * who types something that merely looks like it keeps their text:
 *
 *     <RIDE_ALONG_HEADER>
 *     - 🖥️ Computer control update — …one line…
 *     - 🖥️ Computer control update — …one line…
 *     <RIDE_ALONG_FOOTER>
 *     <blank line, then the human's message — or nothing>
 */
export const RIDE_ALONG_HEADER = "[Callboard system notice — not typed by the human. Computer-control updates since your last turn:]";
export const RIDE_ALONG_FOOTER = "[End of Callboard notice. The human's message, if any, follows.]";
/** Every notice in a block is one line opening with this; the daemon's notice texts all start with its tail. */
export const RIDE_ALONG_NOTICE_PREFIX = "🖥️ Computer control update — ";
const LINE_PREFIX = `- ${RIDE_ALONG_NOTICE_PREFIX}`;

/** The `subtype` of the system row a split-off block renders as. */
export const CALLBOARD_NOTICE_SUBTYPE = "callboard_notice";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCK = new RegExp(`^${escape(RIDE_ALONG_HEADER)}\\n((?:${escape(LINE_PREFIX)}[^\\r\\n]+\\n)+)${escape(RIDE_ALONG_FOOTER)}(?:\\n\\n([\\s\\S]*))?$`, "u");

/** Build the block for `notices` (each flattened to one line, prefixed if it is not already). */
export function formatRideAlongBlock(notices: readonly string[]): string {
  const lines = notices.map((text) => {
    const flat = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
    return `- ${flat.startsWith(RIDE_ALONG_NOTICE_PREFIX) ? flat : `${RIDE_ALONG_NOTICE_PREFIX}${flat}`}`;
  });
  return [RIDE_ALONG_HEADER, ...lines, RIDE_ALONG_FOOTER].join("\n");
}

/**
 * Split a ride-along block off the start of a user message: the notices it
 * carried (one per line, prefix kept) and the human's own text after it ("" if
 * none). Null unless `content` opens with a block in exactly the fixed format
 * — at offset 0, not after whitespace; fixed header, ≥1 fixed-prefix lines,
 * fixed footer; then the end, or a blank line and the rest.
 */
export function splitRideAlongBlock(content: string): { notices: string[]; rest: string } | null {
  const match = BLOCK.exec(content);
  if (!match) return null;
  const notices = match[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(2));
  return { notices, rest: match[2] ?? "" };
}

/**
 * The transcript with every ride-along block taken out of the human's message
 * and shown as its own system row just before it, so the human sees what the
 * agent was told without it reading as their own words. A block that was the
 * whole message (a multimodal prompt carries it as its own text block) becomes
 * just the row.
 */
export function splitRideAlongMessages(messages: readonly ParsedMessage[]): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const message of messages) {
    const split = message.role === "user" && message.type === "text" ? splitRideAlongBlock(message.content ?? "") : null;
    if (!split) {
      out.push(message);
      continue;
    }
    out.push({
      role: "system",
      type: "system",
      subtype: CALLBOARD_NOTICE_SUBTYPE,
      content: split.notices.join("\n"),
      ...(message.timestamp !== undefined && { timestamp: message.timestamp }),
    });
    if (split.rest.trim() || message.imageIds?.length) out.push({ ...message, content: split.rest });
  }
  return out;
}

/** A user message's text with any leading ride-along block removed (unchanged when there is none). */
export function withoutRideAlongBlock(content: string): string {
  return splitRideAlongBlock(content)?.rest ?? content;
}
