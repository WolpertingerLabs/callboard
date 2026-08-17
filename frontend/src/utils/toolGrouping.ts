/**
 * Pairing a `tool_use` with the `tool_result` it produced, for display.
 *
 * Lives here rather than inline in `Chat.tsx` because it is pure — messages in,
 * display items out — and because what it does is load-bearing beyond rendering:
 * a `tool_use` that captures the wrong result does not show a mismatch, it shows
 * nothing, since the bubble renders the call and the result together. The ACP
 * plan snapshots are the sharp case (see `acp/sessionParser.ts`): they are
 * `tool_use` messages for which no tool ran, and the checklist renderer returns
 * before it ever reads `toolResult`, so a plan that swallowed a real tool's
 * output would delete that output from the transcript as far as the user is
 * concerned.
 */
import type { ParsedMessage } from "../api";

/** A `tool_use` and the result it was matched with, if any. */
export interface ToolGroup {
  kind: "tool_group";
  toolUse: ParsedMessage;
  toolResult: ParsedMessage | null;
  originalIndices: [number, number | null];
}

/** Anything that is not half of a tool pair, including an orphaned result. */
export interface SingleMessage {
  kind: "single";
  message: ParsedMessage;
  originalIndex: number;
}

export type DisplayItem = ToolGroup | SingleMessage;

/** How far past a `tool_use` a matching result is still considered its own. */
const FORWARD_SCAN_LIMIT = 10;

/**
 * Group `tool_use` / `tool_result` pairs into combined display items.
 *
 * Ids win over adjacency wherever both are available: an adjacent result is
 * taken only if the two ids agree, or if either side has no id at all — which
 * is the compatibility path for transcripts written before callboard recorded
 * ids, not a general fallback. A result that is not adjacent is found by id
 * alone, within {@link FORWARD_SCAN_LIMIT} messages, and only if nothing else
 * has already claimed it.
 */
export function groupToolMessages(messages: readonly ParsedMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const consumedIndices = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (consumedIndices.has(i)) continue;
    const msg = messages[i];

    if (msg.type !== "tool_use") {
      // Includes an orphaned tool_result — one whose tool_use was not found, or
      // was already consumed by an earlier group.
      items.push({ kind: "single", message: msg, originalIndex: i });
      continue;
    }

    let matchedResultIndex: number | null = null;

    if (i + 1 < messages.length && messages[i + 1].type === "tool_result") {
      if (msg.toolUseId && messages[i + 1].toolUseId) {
        // Both sides identify themselves — believe them, not the ordering.
        if (messages[i + 1].toolUseId === msg.toolUseId) {
          matchedResultIndex = i + 1;
        }
      } else {
        // Old data without toolUseId: adjacency is all there is.
        matchedResultIndex = i + 1;
      }
    }

    if (matchedResultIndex === null && msg.toolUseId) {
      for (let j = i + 1; j < messages.length && j < i + FORWARD_SCAN_LIMIT; j++) {
        if (messages[j].type === "tool_result" && messages[j].toolUseId === msg.toolUseId && !consumedIndices.has(j)) {
          matchedResultIndex = j;
          break;
        }
      }
    }

    if (matchedResultIndex !== null) consumedIndices.add(matchedResultIndex);

    items.push({
      kind: "tool_group",
      toolUse: msg,
      toolResult: matchedResultIndex !== null ? messages[matchedResultIndex] : null,
      originalIndices: [i, matchedResultIndex],
    });
  }

  return items;
}
