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
 *
 * ## Two things this module costs, said plainly
 *
 * **It puts card-fields.ts inside an import cycle.** `card-fields` now imports
 * this, which imports `chat-lineage`, which imports `claude.js`, which imports
 * `card-fields`. It resolves: nothing here runs at module scope, so the partial
 * namespace claude.js sees while the cycle is being evaluated is never read.
 * But no test proves that, because every test in this area stubs `claude.js`
 * (the pre-existing `callboard-tools ↔ claude` cycle forced that long before
 * this change). The evidence is an out-of-band probe — importing `card-fields`
 * on its own in a bare node process — not the suite. A side effect of the same
 * edge: that bare import now boots the agent stack, which is a real widening of
 * what this file's header calls its "purity split". The *read* half of
 * card-fields is still pure over a record; only `patchCardFields`, already the
 * write half, reaches anything.
 *
 * **Discovery-only native Codex lineage is not consulted.** Membership comes
 * from `buildLineageIndex` over the stored snapshot, not from
 * `createCardContext`'s corpus, which additionally infers parents for native
 * Codex sessions found on disk. Pinning a chat materialises a stored record
 * (the pin route upserts one), so the common case is covered. What is not: a
 * pinned native child whose *parent* has no stored record at all — its inferred
 * edge exists only in the context, so `existingRootIdOf` degrades it to its own
 * root and archiving the real card leaves its pin. Using the context would be
 * exact and would cost the native-discovery pass on every archive; the case is
 * narrow enough to leave, and narrower since #448 hid native children by
 * default.
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

/**
 * Pinned chats grouped by the lineage root — i.e. by the card they are on.
 *
 * The values are **session ids, not chat ids**, and that is a performance
 * decision rather than a stylistic one. Records are filed as
 * `<session_id>.json` (`chat-file-service.ts`'s `saveChat`), so a write keyed
 * by session id is a single stat + read, while one keyed by `chat.id` misses
 * `getChatBySessionId`'s direct read and falls through to a readdir + parse of
 * every record in the directory. The two are equal for most records, but
 * `createChat` assigns a fresh `randomUUID()` as `chat.id`, so exactly the
 * chats a user creates from the UI are the ones that pay. Measured on an 8k
 * corpus: 20 writes keyed by `chat.id` cost 147 ms, the same 20 keyed by
 * `session_id` cost 1.5 ms. Both spellings reach the same file.
 */
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
    // than stranding the chat on a card that no longer exists. Note this walks
    // by `chat.id`: lineage pointers name chat ids, only the write key is a
    // session id.
    const rootId = index.existingRootIdOf(chat.id);
    const group = byRoot.get(rootId);
    if (group) group.push(chat.session_id);
    else byRoot.set(rootId, [chat.session_id]);
  }
  return byRoot;
}

/**
 * Resolves the pinned chats on a card, given its root chat id. Returns the
 * session ids to write to — see {@link indexPinnedByRoot}.
 */
export type PinnedMemberLookup = (rootChatId: string) => string[];

/**
 * A lookup that answers "which chats on this card are pinned" without reading
 * the chat corpus more than once.
 *
 * Pass `stored` when the caller already has a snapshot — both card routes take
 * one to build their `CardContext`, so handing it over makes this free. Omit it
 * and the snapshot is read on first use, which keeps the cost off every card
 * write that is not an archive: a rename, a status edit, or a re-archive of an
 * already-closed card never asks, so never pays. Note the laziness is about
 * *archiving*, not about *unpinning* — the first archived card in a batch pays
 * for the index even if nothing on it turns out to be pinned.
 *
 * The membership is then cached for the life of the lookup, which is what makes
 * a bulk archive of N cards cost one pass instead of N ("Select all" over 800
 * cards is a routine gesture, and `listChatsSnapshot()` is ~65-130 ms of blocked
 * event loop even warm). Both routes run start to finish without an `await`, so
 * nothing of Callboard's can interleave and invalidate it; a concurrent external
 * writer could, and both outcomes are benign — a chat pinned during the batch
 * keeps a pin the archive never promised to take, and one unpinned by hand is
 * written `pinned: false` a second time.
 */
export function createPinnedMemberLookup(stored?: Chat[]): PinnedMemberLookup {
  let byRoot: Map<string, string[]> | null = null;
  return (rootChatId: string) => {
    byRoot ??= indexPinnedByRoot(stored ?? listChatsSnapshot());
    return byRoot.get(rootChatId) ?? [];
  };
}

/**
 * Clear `metadata.pinned` on every pinned chat belonging to `rootChatId`'s card.
 * Returns the session ids actually unpinned (empty when the setting is off, or
 * when the card had no pinned chats).
 *
 * Writes are view-only (`touch: false`), for the reason card writes are: a pin
 * is a label on a conversation, not activity in it, so clearing one must not
 * bump `updated_at` and resurface a three-week-old chat at the top of the board
 * wearing an unread dot — least of all as a side effect of archiving it.
 *
 * **Best-effort, and never throws.** The caller has already persisted the
 * archive by the time this runs, so an exception escaping here would report a
 * card that is closed on disk as a failed request: `PATCH /api/cards/:id` would
 * answer 500, and `bulk-lifecycle` would push the id into `failed[]` and skip
 * `replaceRoot`, repainting the board tile as open. `updateChatMetadata` catches
 * its own write errors, but the `getChat` it opens with does not, and it touches
 * the filesystem — EMFILE and friends are real. Same shape, and the same
 * reasoning, as `clearRedirectedMemberCard` in routes/cards.ts. The per-chat
 * catch is separate so one unreadable record does not strand the pins after it.
 */
export function unpinArchivedCardChats(rootChatId: string, lookup: PinnedMemberLookup = createPinnedMemberLookup()): string[] {
  const unpinned: string[] = [];
  try {
    if (!unpinOnArchiveEnabled()) return unpinned;
    const candidates = lookup(rootChatId);
    if (candidates.length === 0) return unpinned;

    for (const sessionId of candidates) {
      try {
        // `pinned: false` rather than deleting the key, matching what the unpin
        // half of `PATCH /api/chats/:id/pin` writes — every reader tests
        // `=== true`, and one spelling keeps hand-inspection of a record honest.
        if (chatFileService.updateChatMetadata(sessionId, { pinned: false }, { touch: false })) unpinned.push(sessionId);
        else log.warn(`Could not clear the pin on chat ${sessionId} while archiving card ${rootChatId}`);
      } catch (err: any) {
        log.error(`Error clearing the pin on chat ${sessionId} while archiving card ${rootChatId}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    log.error(`Could not unpin the chats on archived card ${rootChatId}: ${err?.message ?? err}`);
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
