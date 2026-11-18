/**
 * Pairing a `tool_use` with the `tool_result` it produced, for display.
 *
 * Lives here rather than inline in `Chat.tsx` because it is pure — messages in,
 * display items out — and because what it does is load-bearing beyond rendering:
 * a `tool_use` that captures the wrong result does not show a mismatch, it shows
 * nothing, since the bubble renders the call and the result together, so a
 * wrong pairing deletes a real tool's output from the transcript as far as the
 * user is concerned. (The retired ACP harness's synthetic `plan` snapshots, which
 * had no result of their own, were once excluded from pairing here; with the
 * harness gone a tool named `plan` pairs like any other.)
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

/**
 * Reserve globally unique ID pairs first, in either order and at any distance.
 * Reused/duplicate IDs are ambiguous: leave their results visible as orphans
 * rather than guessing (even if adjacent). Never use message.id as a call ID.
 * Then preserve forward adjacency for old histories missing one or both IDs,
 * without stealing a reserved result or a result with a known ID-bearing call.
 * Linear passes keep pairing O(n), including heavily duplicated histories.
 */
export function groupToolMessages(messages: readonly ParsedMessage[]): DisplayItem[] {
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  const record = (map: Map<string, number>, id: string, index: number) => {
    map.set(id, map.has(id) ? -1 : index);
  };
  messages.forEach((message, index) => {
    if (!message.toolUseId) return;
    if (message.type === "tool_use") record(uses, message.toolUseId, index);
    if (message.type === "tool_result") record(results, message.toolUseId, index);
  });

  const pairs = new Map<number, number>();
  const consumed = new Set<number>();
  for (const [id, useIndex] of uses) {
    const resultIndex = results.get(id);
    if (useIndex < 0 || resultIndex === undefined || resultIndex < 0) continue;
    pairs.set(useIndex, resultIndex);
    consumed.add(resultIndex);
  }

  messages.forEach((use, index) => {
    const result = messages[index + 1];
    if (use.type !== "tool_use" || pairs.has(index) || !result || result.type !== "tool_result" || consumed.has(index + 1)) return;
    // Both IDs present must have been resolved above, never by adjacency.
    if (use.toolUseId && result.toolUseId) return;
    if (use.toolUseId && (uses.get(use.toolUseId) === -1 || results.has(use.toolUseId))) return;
    if (result.toolUseId && (results.get(result.toolUseId) === -1 || uses.has(result.toolUseId))) return;
    pairs.set(index, index + 1);
    consumed.add(index + 1);
  });

  const items: DisplayItem[] = [];
  messages.forEach((message, index) => {
    if (consumed.has(index)) return;
    if (message.type === "tool_use") {
      const resultIndex = pairs.get(index) ?? null;
      items.push({
        kind: "tool_group",
        toolUse: message,
        toolResult: resultIndex === null ? null : messages[resultIndex],
        originalIndices: [index, resultIndex],
      });
    } else {
      items.push({ kind: "single", message, originalIndex: index });
    }
  });
  return items;
}
