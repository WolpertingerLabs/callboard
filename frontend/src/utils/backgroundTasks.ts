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
