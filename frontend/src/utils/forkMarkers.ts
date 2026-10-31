/**
 * Where the inline fork-point markers go in a chat's transcript.
 *
 * Pure — tree and display items in, maps out — so Chat.tsx can memoize each
 * step and hand the memoized bubbles identity-stable arrays.
 */
import type { ChatTreeNode, ChatTreeResponse, ParsedMessage } from "../api";
import type { DisplayItem } from "./toolGrouping";

function findNode(node: ChatTreeNode, chatId: string): ChatTreeNode | null {
  if (node.chatId === chatId) return node;
  for (const child of node.children) {
    const hit = findNode(child, chatId);
    if (hit) return hit;
  }
  return null;
}

/**
 * The chat's DIRECT forks (role `fork` or `engine-switch`), grouped by the
 * message timestamp they branched off. Forks made before `forkedAt` was
 * recorded carry none and are left out — they just get no marker.
 */
export function forksByTimestamp(tree: ChatTreeResponse | null, chatId: string | undefined): Map<string, ChatTreeNode[]> {
  const map = new Map<string, ChatTreeNode[]>();
  if (!tree || !chatId) return map;
  for (const child of findNode(tree.tree, chatId)?.children ?? []) {
    if ((child.role !== "fork" && child.role !== "engine-switch") || !child.forkedAt) continue;
    const list = map.get(child.forkedAt);
    if (list) list.push(child);
    else map.set(child.forkedAt, [child]);
  }
  return map;
}

/** Messages whose bubble can carry a marker — the ones a fork can be made from. */
function hasMarkerSlot(message: ParsedMessage): boolean {
  return message.type === "text" && !message.teamName && !!message.timestamp;
}

/**
 * Which display item (by `originalIndex`) carries each timestamp's marker.
 * Several messages can share a timestamp — one engine turn split into blocks —
 * and the fork copied all of them, so the marker goes under the LAST.
 */
export function assignForkMarkers(items: readonly DisplayItem[], byTimestamp: Map<string, ChatTreeNode[]>): Map<number, ChatTreeNode[]> {
  const byIndex = new Map<number, ChatTreeNode[]>();
  if (byTimestamp.size === 0) return byIndex;
  const claimed = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "single" || !hasMarkerSlot(item.message)) continue;
    const ts = item.message.timestamp!;
    const forks = byTimestamp.get(ts);
    if (!forks || claimed.has(ts)) continue;
    claimed.add(ts);
    byIndex.set(item.originalIndex, forks);
  }
  return byIndex;
}
