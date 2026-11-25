/**
 * The Continue button shown under a transcript whose last turn the user
 * stopped: what counts as "ended in an interruption", and the prompt that
 * picks the work back up.
 *
 * The prompt is an ordinary user message — every harness accepts one, and the
 * model needs it in its context — and the transcript recognises it by its
 * exact text to render a compact "Continued" divider instead of a bubble. No
 * wire field is involved, so an older bundle just shows the prompt as the
 * user message it is.
 */
import type { ParsedMessage } from "../api";
import { withoutRideAlongBlock } from "shared/types/rideAlong.js";

/**
 * Sent by the Continue button. Says outright that the stop was not a request
 * to stop — otherwise the model tends to treat the interruption as the user's
 * answer and ask what to do next — and covers the tool call the stop cut off,
 * whose result is an "interrupted" error rather than its output.
 *
 * Never reword this in place: transcripts recognise it by exact text (see
 * {@link isContinuePrompt}). Add the new wording to {@link CONTINUE_PROMPTS}
 * and keep the old one there.
 */
export const CONTINUE_PROMPT =
  "Your previous turn was interrupted, but that was not a request to stop. Resume the task you were working on from exactly where you left off. If a tool call was cut off before it finished, run it again.";

/** Every wording {@link CONTINUE_PROMPT} has had, so older transcripts still render compactly. */
const CONTINUE_PROMPTS: ReadonlySet<string> = new Set([CONTINUE_PROMPT]);

/** True when a user message is the Continue button's prompt (ride-along notices aside). */
export function isContinuePrompt(message: Pick<ParsedMessage, "role" | "type" | "content" | "imageIds">): boolean {
  if (message.role !== "user" || message.type !== "text" || message.imageIds?.length) return false;
  return CONTINUE_PROMPTS.has(withoutRideAlongBlock(message.content ?? "").trim());
}

/**
 * True when the transcript's last turn was stopped by the user, so there is
 * work to continue. Two shapes count:
 *
 * - a trailing `interrupted` system marker — the Claude Code and Codex
 *   parsers' projection of the harness's own record (persisted, so it
 *   survives a reload), or the page's local notice when the harness wrote none;
 * - a last real message carrying `stopReason: "aborted"`, which is how pi
 *   records a stopped turn.
 *
 * Other trailing system rows (an abandoned-task marker, a compaction divider)
 * are skipped; any other real message means the interruption, if there was
 * one, belongs to an earlier turn.
 */
export function endsWithInterruption(messages: readonly ParsedMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.subtype === "interrupted") return true;
    if (m.role === "system") continue;
    return m.role === "assistant" && m.stopReason === "aborted";
  }
  return false;
}
