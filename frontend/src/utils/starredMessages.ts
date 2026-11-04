/**
 * Which messages can be starred, and the key a star is stored under.
 *
 * Pure — messages in, keys out — so Chat.tsx can memoize it and hand the
 * memoized bubbles identity-stable props.
 *
 * ## Why the key is derived, not read
 *
 * `ParsedMessage` carries no id that every engine fills. Claude Code has a
 * JSONL `uuid` and pi an entry id, but the parsers drop both, and ACP and Cline
 * transcripts have nothing per message at all. What every engine does carry is
 * the `timestamp` — the same identity a fork is made from — and the transcript
 * is always re-read from disk (live updates refetch it rather than assembling
 * it from stream frames), so a timestamp is the same after a reload, a
 * reconnect or a switch of tab.
 *
 * A timestamp alone is not unique: one engine turn split into several text
 * blocks gives them all the same one. So the key is the role, the timestamp,
 * and the message's ordinal among the starrable messages sharing both:
 * `assistant@2026-11-04T10:00:00.000Z#1`.
 *
 * Deliberately NOT the array index. Claude Code splices subagent messages into
 * the parent timeline by timestamp, so every parent message after a running
 * subagent's shifts while it works. Subagent (`teamName`) messages are also
 * left out of the ordinal count, for the same reason. Nor a content hash: ACP
 * and Cline coalesce a streamed message's deltas, so a message starred while
 * still being written would change hash as it grew.
 */
import type { ParsedMessage } from "../api";

/** Conversational text on the main timeline, with a timestamp to key on. */
export function isStarrable(message: ParsedMessage): boolean {
  return message.type === "text" && (message.role === "user" || message.role === "assistant") && !message.teamName && !!message.timestamp;
}

/** Every starrable message's key, by its index in `messages`. */
export function starKeysByIndex(messages: readonly ParsedMessage[]): Map<number, string> {
  const keys = new Map<number, string>();
  const seen = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!isStarrable(message)) return;
    const base = `${message.role}@${message.timestamp}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    keys.set(index, `${base}#${ordinal}`);
  });
  return keys;
}

/** A starred message that is in the transcript: where it is, and its key. */
export interface StarredMessage {
  index: number;
  key: string;
}

/**
 * The starred messages present in the transcript, oldest first. A stored key
 * that matches nothing — its message is gone, e.g. the session it was in was
 * cleared — is skipped rather than counted, so the navigator never offers a
 * star it cannot scroll to.
 */
export function resolveStarred(keysByIndex: Map<number, string>, starred: ReadonlySet<string>): StarredMessage[] {
  if (starred.size === 0) return [];
  const out: StarredMessage[] = [];
  for (const [index, key] of keysByIndex) {
    if (starred.has(key)) out.push({ index, key });
  }
  return out.sort((a, b) => a.index - b.index);
}
