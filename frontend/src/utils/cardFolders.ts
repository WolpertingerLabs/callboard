/**
 * The folders a card's work actually lives in.
 *
 * Derived client-side from `memberChats`, deliberately: `CardSummary` carries
 * no folder of its own, but a card *is* its root chat and the rollup groups
 * every descendant chat under that root, so the folder set is already on the
 * wire. Keeping it here costs one pass over an array the tile has anyway and
 * avoids a backend field that would have to be kept in sync forever.
 *
 * The measured distribution is what shapes the API: 88.3% of cards span exactly
 * one folder and a further 8.8% span none — 97.1% between them have at most one
 * path to show — while the ones that span more span a *lot* (11, 12, 16, 20).
 * So consumers get an ordered list they can show the head of, not a count.
 */

import type { CardSummary } from "../api";

export interface CardFolder {
  path: string;
  chatCount: number;
  /** Most urgent live state among this folder's chats; undefined when all are stopped. */
  live?: "waiting" | "ongoing";
  lastActivityAt: string;
  isRoot: boolean;
}

/** waiting outranks ongoing outranks stopped — blocked-on-you is the state worth surfacing. */
const LIVE_RANK = { waiting: 2, ongoing: 1 } as const;

function rankOf(live: CardFolder["live"]): number {
  return live ? LIVE_RANK[live] : 0;
}

/**
 * One entry per distinct folder, ordered root-first, then live, then recent.
 *
 * The root pins to the top **even when it is quiet**. It is the card's origin
 * and the one row a user can build muscle memory against; sorting it by
 * activity would move it on every 15s poll.
 *
 * Returns `[]` rather than anything undefined when there is nothing to report.
 * That is the common case, not a defensive one: `isCardEligible` has no
 * provider check but the member-chat grouping skips retired providers, so a
 * root on a retired provider is a genuine card whose own member row is
 * missing — and `memberChats` can be empty outright. Measured, that is **72 of
 * 818 cards, 8.8%**, every one of them a lineage entirely on `openrouter`.
 * About one card in eleven; every consumer needs an answer for it.
 */
export function cardFolders(card: CardSummary): CardFolder[] {
  const rootFolder = card.memberChats.find((c) => c.chatId === card.id)?.folder;

  const byPath = new Map<string, CardFolder>();
  for (const chat of card.memberChats) {
    if (!chat.folder) continue;
    const live = chat.status === "stopped" ? undefined : chat.status;
    const existing = byPath.get(chat.folder);
    if (!existing) {
      byPath.set(chat.folder, {
        path: chat.folder,
        chatCount: 1,
        ...(live && { live }),
        lastActivityAt: chat.updatedAt,
        isRoot: chat.folder === rootFolder,
      });
      continue;
    }
    existing.chatCount++;
    if (rankOf(live) > rankOf(existing.live)) existing.live = live;
    // These are ISO-8601 UTC strings, so lexical order is chronological order
    // and there is no Date to allocate per member chat.
    if (chat.updatedAt > existing.lastActivityAt) existing.lastActivityAt = chat.updatedAt;
  }

  return [...byPath.values()].sort(
    (a, b) => Number(b.isRoot) - Number(a.isRoot) || rankOf(b.live) - rankOf(a.live) || b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
}
