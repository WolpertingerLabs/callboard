/**
 * Unpin a card's chats when that card is archived.
 *
 * ## Why this lives on the server, at the card seam
 *
 * A pin is per-chat (`metadata.pinned`), archiving is per-card
 * (`metadata.card.lifecycle`), and the two meet only in the sidebar: a pinned
 * chat is lifted out of the list into its own Pinned section, and an archived
 * chat is dimmed or hidden entirely. Leave the pin behind and the chat the user
 * archived keeps the most prominent seat in the list, wearing the archived dim —
 * the one row the archive gesture cannot get rid of.
 *
 * The enforcement therefore hangs off {@link patchCardFields}, the single write
 * that can flip a card's lifecycle, rather than off the web UI's archive button.
 * Everything that archives — `PATCH /api/cards/:id`, `POST
 * /api/cards/bulk-lifecycle`, the board, the sidebar's bulk bar, and any MCP
 * tool that later grows a lifecycle setter — funnels through there, so none of
 * them can archive a card and leave its pins standing.
 *
 * ## Archived means closed OR hidden
 *
 * `hidden` is counted as archiving here, deliberately. It reads like a
 * board-only concern ("opt this card out of the board"), but the sidebar — the
 * only place a pin has any effect at all — already treats the two as one state:
 * `GET /api/chats?cardLifecycle=unarchived` excludes the trees of closed *and*
 * hidden cards (see routes/chats.ts), which is exactly the set the sidebar dims
 * when its Archived toggle is off. A hidden card's pinned chat would therefore
 * sit in the Pinned section carrying the archived dim, which is the state this
 * setting exists to prevent. The alternative reading — "hidden is not archiving,
 * so keep the pin" — would make the setting's behaviour depend on which of two
 * indistinguishable-in-the-sidebar states the card is in.
 *
 * ## One direction only
 *
 * Unarchiving does NOT restore the pins. There is nothing to restore: the pin is
 * a single boolean that has been cleared, and remembering "these three chats
 * were pinned when the card closed in order to put them back later" would mean
 * inventing a second piece of per-chat state whose only job is to survive the
 * first. Archiving is the user's statement that they are done with this work;
 * re-pinning on reopen would put rows back at the top of the sidebar that the
 * user may well have unpinned by hand in between, with no way to tell the two
 * cases apart. A reopened chat can be re-pinned with the same one click that
 * pinned it originally.
 */
import type { Chat } from "shared";
import { getAgentSettings } from "./agent-settings.js";
import { chatFileService } from "./chat-file-service.js";
import { buildLineageIndex } from "./chat-lineage.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { clearListCaches } from "./list-caches.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("card-archive-unpin");

/**
 * Whether archiving a card should clear its chats' pins.
 *
 * Absent means ON — the setting is a way to turn the behaviour *off*, so an
 * instance that has never opened Settings gets it, and a stored `false` is the
 * only thing that disables it. Every read must spell this `!== false` rather
 * than `=== true`, or the default silently inverts.
 */
export function unpinOnArchiveEnabled(): boolean {
  return getAgentSettings().unpinChatsOnArchive !== false;
}

/** Whether a chat record carries the sidebar pin. */
function isPinned(chat: { metadata?: string | null }): boolean {
  try {
    const parsed: unknown = JSON.parse(chat.metadata || "{}");
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).pinned === true;
  } catch {
    // A record whose metadata will not parse is not pinned, matching the
    // sidebar's own pinned-append pass in routes/chats.ts.
    return false;
  }
}

/** Pinned chat ids grouped by the lineage root — i.e. by the card they are on. */
function indexPinnedByRoot(stored: Chat[]): Map<string, string[]> {
  const byRoot = new Map<string, string[]>();
  const pinned = stored.filter(isPinned);
  // The overwhelmingly common case: nobody has pinned anything, so the lineage
  // index (O(corpus)) is never built at all.
  if (pinned.length === 0) return byRoot;
  const index = buildLineageIndex(stored);
  for (const chat of pinned) {
    // `existingRootIdOf`, matching how card-context decides membership — a
    // dangling parent pointer promotes the highest surviving ancestor rather
    // than stranding the chat on a card that no longer exists.
    const rootId = index.existingRootIdOf(chat.id);
    const group = byRoot.get(rootId);
    if (group) group.push(chat.id);
    else byRoot.set(rootId, [chat.id]);
  }
  return byRoot;
}

/** Resolves the pinned chats on a card, given its root chat id. */
export type PinnedMemberLookup = (rootChatId: string) => string[];

/**
 * A lookup that reads the chat corpus at most once, on first use.
 *
 * Both halves matter. *At most once* is what makes a bulk archive of N cards
 * cost one corpus pass instead of N — `listChatsSnapshot()` is ~65-130 ms of
 * blocked event loop even warm, and "Select all" over 800 cards is a routine
 * gesture. *On first use* is what keeps that cost off every card write that
 * isn't an archive: a rename, a status edit or a re-archive of an already-closed
 * card never asks, so it never pays.
 *
 * Caching the membership across a batch is safe because the only write this
 * drives is `pinned: false` on a member, which changes no parent pointer and so
 * cannot move a chat to a different card mid-batch. Each root is also read
 * exactly once per batch (the routes flip a given card once), so a stale "still
 * pinned" entry for a card already processed is never consulted.
 */
export function createPinnedMemberLookup(): PinnedMemberLookup {
  let byRoot: Map<string, string[]> | null = null;
  return (rootChatId: string) => {
    byRoot ??= indexPinnedByRoot(listChatsSnapshot());
    return byRoot.get(rootChatId) ?? [];
  };
}

/**
 * Clear `metadata.pinned` on every pinned chat belonging to `rootChatId`'s card.
 * Returns the ids actually unpinned (empty when the setting is off, or when the
 * card had no pinned chats).
 *
 * Writes are view-only (`touch: false`), for the reason card writes are: a pin
 * is a label on a conversation, not activity in it, so clearing one must not
 * bump `updated_at` and resurface a three-week-old chat at the top of the board
 * wearing an unread dot — least of all as a side effect of archiving it.
 */
export function unpinArchivedCardChats(rootChatId: string, lookup: PinnedMemberLookup = createPinnedMemberLookup()): string[] {
  if (!unpinOnArchiveEnabled()) return [];
  const candidates = lookup(rootChatId);
  if (candidates.length === 0) return [];

  const unpinned: string[] = [];
  for (const chatId of candidates) {
    // `pinned: false` rather than deleting the key, matching what the unpin
    // half of `PATCH /api/chats/:id/pin` writes — every reader tests
    // `=== true`, and one spelling keeps hand-inspection of a record honest.
    if (chatFileService.updateChatMetadata(chatId, { pinned: false }, { touch: false })) unpinned.push(chatId);
    else log.warn(`Could not clear the pin on chat ${chatId} while archiving card ${rootChatId}`);
  }

  if (unpinned.length > 0) {
    // The pin decides which rows a list response carries, not just how one
    // renders (`includePinned` appends pinned chats from outside the pagination
    // window), so a page cached before this call is now wrong. The archive
    // routes clear the caches for the lifecycle flip itself; doing it here too
    // keeps the rule true for any caller that reaches patchCardFields without
    // going through them.
    clearListCaches();
    log.info(`Archiving card ${rootChatId} unpinned ${unpinned.length} chat(s): ${unpinned.join(", ")}`);
  }
  return unpinned;
}
