/**
 * The Continue button shown under a transcript whose last run the user
 * stopped: when it is offered, and the prompt that picks the work back up.
 *
 * The prompt is an ordinary user message — every harness accepts one, and the
 * model needs it in its context — and the transcript recognises it by its
 * exact text to render a compact "Continued" divider instead of a bubble. No
 * wire field is involved in that, so an older bundle just shows the prompt as
 * the user message it is.
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

// Transcript marker for a run the user stopped. Shown both when the run's own
// terminal event reports the abort and when the page settles the stop locally.
export const INTERRUPTED_MESSAGE = "Session was interrupted.";

/**
 * The page's local notice row for a run the user stopped. Never persisted —
 * the page appends it after the refetched transcript — so it only ever stands
 * for a Stop pressed in this tab. Carries the parsers' `interrupted` subtype
 * and renders as the same plain divider.
 */
export const INTERRUPTED_NOTICE: ParsedMessage = { role: "system", type: "system", subtype: "interrupted", content: INTERRUPTED_MESSAGE };

function isLocalStopNotice(message: ParsedMessage): boolean {
  return message.role === "system" && message.subtype === "interrupted" && message.content === INTERRUPTED_MESSAGE;
}

/**
 * Whether the transcript's last run was stopped by the user, so there is work
 * to Continue. Only a user's Stop counts, from one of two sources:
 *
 * - `stoppedByUserAt` on the chat record, which the daemon's Stop route sets
 *   and the chat's next run clears. It is the one that survives a reload: no
 *   harness reliably records Callboard's own Stop in its session log. A user
 *   prompt timestamped after it means a later turn happened whose clearing
 *   this page has not seen yet.
 * - the page's own {@link INTERRUPTED_NOTICE} at the end of the transcript,
 *   for the live case (and a daemon older than the field).
 *
 * The parsers' persisted `interrupted` markers deliberately do not count. The
 * Claude Code CLI writes "[Request interrupted by user for tool use]" when a
 * permission is denied — by the user or by policy — and offering "that was
 * not a request to stop… run it again" there would undo the denial.
 */
export function endsWithUserStop(messages: readonly ParsedMessage[], stoppedByUserAt: string | undefined): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "system") break;
    if (isLocalStopNotice(m)) return true;
  }
  if (!stoppedByUserAt) return false;
  const stoppedAt = Date.parse(stoppedByUserAt);
  if (Number.isNaN(stoppedAt)) return false;
  return !messages.some((m) => m.role === "user" && m.type === "text" && !!m.timestamp && Date.parse(m.timestamp) > stoppedAt);
}
