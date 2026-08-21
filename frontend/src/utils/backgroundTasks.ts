/**
 * Which background tasks a transcript shows as still running.
 *
 * A Bash call made with `run_in_background` resolves immediately with a handle,
 * so the tool bubble would otherwise render as finished the instant the work
 * started — the call that takes longest is the one that looks fastest. The
 * outcome arrives later and separately, as a `background_task` system marker.
 *
 * Pairing them is the whole job: a launching `tool_result` whose task id no
 * marker ever claims is still going. Both ends carry `backgroundTaskId`, put
 * there by the session parser from the transcript's own fields, so this is an
 * id match and not a guess about ordering or adjacency.
 *
 * Pure and id-based rather than positional, because the two ends can be
 * arbitrarily far apart — a task started in one turn is reported in a later
 * one, with any amount of unrelated conversation in between.
 */
import type { ParsedMessage } from "../api";

/**
 * Ids of background tasks that were launched and never reported an outcome.
 *
 * Order-independent: ends are collected separately and subtracted, so a marker
 * appearing before its launch (a transcript stitched across a resume) still
 * cancels it rather than being ignored.
 *
 * Note what this does *not* know: whether the session is still alive. A task
 * only outlives its session if something keeps that session's subprocess
 * running, so callers gate the result on the chat actually streaming — see the
 * call site in `Chat.tsx`. Without that gate an orphaned task would read as
 * "running" forever, since a dead session never files the marker that would
 * clear it.
 */
export function pendingBackgroundTaskIds(messages: readonly ParsedMessage[]): ReadonlySet<string> {
  const launched = new Set<string>();
  const reported = new Set<string>();

  for (const message of messages) {
    if (message.type === "tool_result") {
      if (message.backgroundTaskId) launched.add(message.backgroundTaskId);
      continue;
    }
    if (message.subtype !== "background_task") continue;
    // Settle on `backgroundTaskIds`, not `backgroundTaskId`: a notice covering
    // several tasks — the resume-time orphan summary — deliberately declines to
    // attribute itself to any single one, but it still accounts for all of
    // them. Reading only the singular field left every task in a multi-task
    // notice pending for the rest of the chat.
    for (const id of message.backgroundTaskIds ?? []) reported.add(id);
    // Transcripts parsed before the plural field existed carry only this one.
    if (message.backgroundTaskId) reported.add(message.backgroundTaskId);
  }

  for (const id of reported) launched.delete(id);
  return launched;
}

/**
 * The terminal marker for tasks a run left running when it ended.
 *
 * The gate documented above has a corollary nobody wanted: at `done` the
 * spinner is dropped for *every* pending task at once, so one that was killed
 * — the hold gave up, the user stopped the run, the provider errored — renders
 * exactly like one that completed. The failure is drawn as a success.
 *
 * The engine's own `<task-notification status="stopped">` does eventually say
 * so, but it lands at the top of the *next* run: production has an 08:48 kill
 * reported at 14:10, by which point nothing on screen connects the two. This
 * closes that gap by synthesising the notice the session never got to file, in
 * the same shape the parser produces for a real one — so it settles the task
 * through {@link pendingBackgroundTaskIds} and renders through the existing
 * `background_task` bubble, with no second code path for a synthetic marker.
 *
 * Scoped to what the transcript still shows as pending, so a task the engine
 * did manage to report on is never accused of dying twice. Returns null when
 * that leaves nothing to say.
 *
 * The marker is not persisted — the transcript belongs to the engine, and
 * callboard only reads it. It is a client-side record of what this run ended
 * with, which is exactly as long as the ambiguity it exists to resolve lasts:
 * on a later load the engine's own notice is in the file.
 */
export function abandonedTaskMarker(abandonedIds: readonly string[], messages: readonly ParsedMessage[]): ParsedMessage | null {
  const stillPending = pendingBackgroundTaskIds(messages);
  const killed = abandonedIds.filter((id) => stillPending.has(id));
  if (killed.length === 0) return null;

  const plural = killed.length > 1;
  return {
    role: "system",
    type: "system",
    subtype: "background_task",
    // "stopped" is the engine's own word for a task that was cut short, and
    // the bubble already tones it as a warning rather than a success.
    backgroundTaskStatus: "stopped",
    backgroundTaskIds: [...killed],
    // Attribution needs exactly one id; stay silent when several are covered,
    // for the reason spelled out on `backgroundTaskIds` in shared/types.
    ...(killed.length === 1 && { backgroundTaskId: killed[0] }),
    content:
      `Background task${plural ? "s" : ""} ${killed.join(", ")} ${plural ? "were" : "was"} killed when the session ended` +
      ` — ${plural ? "they" : "it"} never reported a result.`,
  };
}
