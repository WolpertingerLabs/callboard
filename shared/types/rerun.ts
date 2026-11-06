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
