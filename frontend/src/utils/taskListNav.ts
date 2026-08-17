/**
 * Finding the agent's current task list inside a transcript.
 *
 * Two features in `Chat.tsx` need this and they need the *same* answer: the
 * jump-to-list button only appears when there is a list, and pressing it must
 * scroll to the one the button was promising. Asking the question twice with two
 * inline scans is how those drift apart — and it is why the tool-name gate here
 * had no test at all until it was pulled out of the component.
 *
 * Newest wins. A task list is a complete snapshot, never a delta (see
 * `shared/types/taskList.ts`), so the last one in the transcript is the agent's
 * plan as of now and every earlier one is history.
 */
import { isTaskListTool } from "shared/types/index.js";
import type { ParsedMessage } from "../api";

/** A message list narrow enough to test without building a whole transcript. */
type TaskListCandidate = Pick<ParsedMessage, "type" | "toolName" | "content">;

/**
 * Index of the newest task list in `messages`, or -1 when there is none.
 *
 * Scanning from the end is not just about finding the latest — it is also what
 * keeps this cheap on the transcripts where it matters. A chat that is showing a
 * list finds it in the last handful of messages; one that has never had a list
 * pays a tool-name comparison per message, which is what the gate cost before
 * task lists went cross-engine and what it must not stop costing.
 */
export function findLatestTaskListIndex(messages: readonly TaskListCandidate[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "tool_use" && isTaskListTool(message.toolName, message.content)) return i;
  }
  return -1;
}
