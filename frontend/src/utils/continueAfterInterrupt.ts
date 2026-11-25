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

// The page's notice for a run that ended aborted. Appended whenever the run's
// terminal event reports `aborted`, or the page settles a stop locally.
export const INTERRUPTED_MESSAGE = "Session was interrupted.";

/**
 * The page's local notice row for a run that ended aborted. Never persisted:
 * every tab watching the chat appends it after the refetched transcript, for
 * any abort — a user's Stop, but also a job cancel, a superseded job attempt,
 * a workspace teardown, a held message's Send now, or a newer message from
 * another tab or MCP. So it says nothing about who stopped the run, and the
 * Continue button does not read it (see {@link endsWithUserStop}). It carries
 * the parsers' `interrupted` subtype and renders as the same plain divider.
 */
export const INTERRUPTED_NOTICE: ParsedMessage = { role: "system", type: "system", subtype: "interrupted", content: INTERRUPTED_MESSAGE };

/**
 * Whether the user stopped the chat's last run, so there is work to Continue.
 *
 * Driven by `stoppedByUserAt` on the chat record alone. The daemon's Stop
 * route sets it — only when a human's Stop cancelled a live run — and the
 * chat's next run clears it, so it survives a reload, which no harness's
 * session log does for Callboard's own Stop. A user prompt timestamped after
 * it means a later turn happened whose clearing this page has not seen yet.
 *
 * The live case needs nothing else: the Stop route writes the flag in the
 * same tick as it aborts the run, before the run's terminal event can be
 * emitted, and every path that ends a run on the page (the terminal event's
 * refetch, the stop controller's settle and delayed resync) refetches the
 * chat record after that.
 *
 * What deliberately does not count:
 * - the page's {@link INTERRUPTED_NOTICE}, which every abort appends — a
 *   job cancel would otherwise offer to resume the cancelled step;
 * - the parsers' persisted `interrupted` markers: the Claude Code CLI writes
 *   "[Request interrupted by user for tool use]" when a permission is
 *   denied, and "that was not a request to stop… run it again" would undo
 *   the denial.
 */
export function endsWithUserStop(messages: readonly ParsedMessage[], stoppedByUserAt: string | undefined): boolean {
  if (!stoppedByUserAt) return false;
  const stoppedAt = Date.parse(stoppedByUserAt);
  if (Number.isNaN(stoppedAt)) return false;
  return !messages.some((m) => m.role === "user" && m.type === "text" && !!m.timestamp && Date.parse(m.timestamp) > stoppedAt);
}
