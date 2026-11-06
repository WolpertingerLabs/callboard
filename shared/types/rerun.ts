import type { ParsedMessage } from "./message.js";

/**
 * The first line of the user turn a callboard compression carries its summary
 * in (backend/src/agents/compression.ts), per direction. On harnesses whose
 * history is seeded as plain turns the line is all that marks the summary.
 */
export const COMPRESSION_SUMMARY_HEADINGS = {
  before: "[Summary of the earlier conversation, compressed by the user]",
  after: "[Summary of the later conversation, compressed by the user]",
} as const;

/** Whether `content` is a compression summary turn, by its heading. */
export function isCompressionSummaryText(content: string): boolean {
  const head = content.trimStart();
  return Object.values(COMPRESSION_SUMMARY_HEADINGS).some((h) => head.startsWith(h));
}

/** A compaction or compression summary carried as a user turn — never something to send again. */
export function isSummaryTurn(message: ParsedMessage): boolean {
  return message.role === "user" && message.type === "text" && (message.isCompactSummary === true || isCompressionSummaryText(message.content));
}

/**
 * A user turn a rerun can send again: one the user typed (not a team member's,
 * not a compaction summary), with text or images. Built-in slash commands are
 * excluded too — `/compact`, `/clear` and the like act on the session rather
 * than ask the model something, and rerunning one in a forked chat would act on
 * the wrong conversation.
 *
 * The frontend offers Rerun on a user bubble only when this holds, so the two
 * sides agree on what can be picked.
 */
export function isRerunPrompt(message: ParsedMessage): boolean {
  if (message.role !== "user" || message.type !== "text" || message.teamName || !message.timestamp) return false;
  if (message.isBuiltInCommand || isSummaryTurn(message)) return false;
  return message.content.trim().length > 0 || (message.imageIds?.length ?? 0) > 0;
}

const isBoundary = (m: ParsedMessage) => m.type === "system" && m.subtype === "compact_boundary";
/** A message of the user's own turn-taking: user-role text not from a team member. */
export const isUserTurn = (m: ParsedMessage) => m.role === "user" && m.type === "text" && !m.teamName;

/**
 * The prompt a reply at `index` answers: walking back, the first user turn —
 * which must itself be rerunnable — before any compact boundary or summary.
 * `{ index }` of that prompt, or why there is none. The server's rule; see
 * {@link rerunnableReplies} for the same answer for a whole transcript.
 */
export function findReplyPrompt(messages: readonly ParsedMessage[], index: number): { index: number } | { error: string } {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isBoundary(m) || isSummaryTurn(m)) return { error: "This reply follows a compaction, not a prompt that can be rerun" };
    if (!isUserTurn(m)) continue;
    if (!isRerunPrompt(m)) return { error: "The message this replies to cannot be rerun" };
    return { index: i };
  }
  return { error: "No user message before this one to rerun" };
}

/**
 * For every index, whether {@link findReplyPrompt} would find a prompt from
 * there — one pass, so the UI can decide per reply bubble without walking back
 * from each of them.
 */
export function rerunnableReplies(messages: readonly ParsedMessage[]): boolean[] {
  const out: boolean[] = new Array(messages.length);
  let reachable = false;
  for (let i = 0; i < messages.length; i++) {
    out[i] = reachable;
    const m = messages[i]!;
    if (isBoundary(m) || isSummaryTurn(m)) reachable = false;
    else if (isUserTurn(m)) reachable = isRerunPrompt(m);
  }
  return out;
}
