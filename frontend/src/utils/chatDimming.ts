import type { Chat, CardSummary } from "../api";

/**
 * The archived-chat dim, as a function rather than an expression inline in the
 * list, for one reason: its whole difficulty is a state the list passes
 * through for a few hundred milliseconds on every mount and which no render of
 * the finished page reproduces.
 */

/**
 * The card a chat belongs to: its lineage root. Cards are keyed by root chat
 * id, and membership is the tree — `metadata.rootChatId` is stamped on every
 * child at creation, `metadata.parentChatId` is the fallback for records that
 * predate the stamp, and a chat with neither is its own root (top-level
 * chats ARE cards). Legacy `forkedFrom` is the final pointer fallback.
 * Unreadable metadata resolves to no card.
 *
 * Stamp first; the server's `existingRootIdOf` walks the PARENT CHAIN first.
 * The two agree on every record `resolveParentage` writes, which keeps the two
 * consistent, and would diverge only on a record whose stamp and whose chain
 * name different roots — hand-edited or corrupt. Noted so a future reader knows
 * the asymmetry is deliberate rather than a missing case.
 */
export function chatCardId(chat: Pick<Chat, "id" | "metadata">): string | undefined {
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    if (typeof meta.rootChatId === "string" && meta.rootChatId) return meta.rootChatId;
    if (typeof meta.parentChatId === "string" && meta.parentChatId) return meta.parentChatId;
    if (typeof meta.forkedFrom === "string" && meta.forkedFrom) return meta.forkedFrom;
    return chat.id;
  } catch {
    return undefined;
  }
}

/**
 * The lifecycle fields the dim reads off a card. Asking for less than a
 * CardSummary is what lets a test state a card as `{ lifecycle: "closed" }`
 * (the wire value behind the UI's "Archived").
 */
export type DimCard = Pick<CardSummary, "lifecycle" | "hidden">;

/**
 * Whether the chat is filed under a card that is currently ARCHIVED — closed,
 * or hidden from the board.
 *
 * The question behind the dim: it fades the rows this returns true for. Note
 * which way round the missing-card case falls, because it is the whole of this
 * change and the reverse of what this predicate used to say: **no card is not
 * archived.** A triggered chat, a job-step chat, a session with no stored
 * record, and a dangling id whose root was deleted are all chats with no live
 * card, and none of them is on an archived one — they are ordinary chats and
 * they render undimmed.
 *
 * The complement of the rows the server withholds under
 * `cardLifecycle=unarchived`, the scope "Show archived" asks for when it is off
 * — but two implementations of one question, which can disagree at the edges.
 * {@link isChatDimmed} lists how. `hidden` is in here rather than left out as
 * an exotic case for that reason: the server counts a hidden card as archived,
 * so a dim that ignored the flag would fetch-and-not-fade exactly those rows.
 * It costs the caller a `listCards(true)` — see `api.listCards`.
 *
 * Says nothing about whether the cards have loaded: its one caller,
 * {@link isChatDimmed}, holds that flag (see {@link DimContext.cardsLoaded}).
 * Module-private since the sectioning that was the second caller went away —
 * it is a step of the dim now, not a shared predicate.
 */
function isChatOnArchivedCard(chat: Pick<Chat, "id" | "metadata">, cardsById: ReadonlyMap<string, DimCard>): boolean {
  // Callers can index CardSummary.memberChats into this map. Prefer that
  // authoritative membership: legacy multi-level trees may have neither a
  // rootChatId stamp nor a direct parent pointer to the actual root.
  const id = cardsById.has(chat.id) ? chat.id : chatCardId(chat);
  const card = id ? cardsById.get(id) : undefined;
  if (!card) return false;
  return card.lifecycle === "closed" || card.hidden === true;
}

export interface DimContext {
  /**
   * Whether the first `listCards` has returned.
   *
   * It used to be load-bearing and it no longer is, which is worth saying
   * plainly rather than leaving the reader to work out from a stale comment. A
   * missing card record still means three different things — the chat has no
   * card, the cards have not been fetched yet, or the id dangles past a deleted
   * card — and on first paint `cards` is `[]`, so all three look identical to
   * "no card". Under the old rule "no card" meant DIMMED, so the whole sidebar
   * flashed faded on every mount until the fetch landed, and this flag was the
   * only thing preventing it. Under the current rule "no card" means NOT
   * archived, so the pre-fetch state already renders as undimmed and the flash
   * cannot happen.
   *
   * Kept because it is the honest statement of what the dim knows, and because
   * it is exactly what makes the un-dimmed first paint deliberate instead of
   * incidental: reinstate any rule where an unknown card fades, and without
   * this flag the flash comes straight back. Not a toggle — the dim has none,
   * and a second *required* field here is what a returning one would look like.
   */
  cardsLoaded: boolean;
}

/**
 * Whether a row is a candidate for dimming.
 *
 * Candidate, not verdict: `ChatListItem` still exempts four kinds of row, and
 * it is the component that holds them — the open chat (`activeChatId`), plus
 * the summon, unread and job-awaiting-approval flags it already parses out of
 * the chat's metadata. Note what is NOT in that list: a *running* session. A
 * chat on an archived card fades while it is running, which is intended —
 * running is not the same question as "is this work still open" — but it is
 * now everyone's default rather than an opt-in, so do not describe the
 * exemptions as "rows that need the user" and leave it at that.
 *
 * Fades a chat whose card is archived — closed or hidden — and ONLY that. A
 * chat on no card is not archived and does not fade: it is a triggered chat, a
 * job step, a session nothing ever recorded, or a tree whose root was deleted,
 * and none of those is a piece of finished work. That is the narrowing this
 * predicate exists to carry; before it, "no card" faded too, and since
 * `isCardEligible` refuses to make a card of a triggered root, switching on
 * "Show triggered chats" produced a list of uniformly faded rows — when the
 * scope let them through at all.
 *
 * "Show archived" is not a toggle in front of this: it decides whether the
 * archived rows are fetched at all, so with it off this has almost nothing to
 * fade.
 *
 * Almost. Three ways a faded row reaches the toggle-off view — one of them on
 * purpose, and much the commonest:
 *
 *  - **a search is running.** Content search widens the request to `all`
 *    whatever the toggle says (see `cardLifecycleFor`), because hits are
 *    intersected against the list and a narrow scope would delete results
 *    rather than filter them. So archived rows arrive in bulk and the fade is
 *    what marks them as archived. The toggle scopes *browsing*; search covers
 *    everything.
 *  - **skew.** The scope is the server's verdict over stored records; the fade
 *    is the `/api/cards` rollup's, and they are separate requests. The 15s
 *    session poll calls `load()` without `loadCards()`, and archiving from a
 *    row's kebab menu patches `cards` locally without refetching the list, so
 *    one is briefly newer than the other.
 *  - **a card that only one side can see.** `services/card-context.ts` refuses
 *    to promote a native Codex record to a card (and stops early when
 *    `nativeDiscoveryIncomplete`), while the list route's root scan has no such
 *    term. Under the old "or absent" rule this faded such a root while the
 *    server called it open — the commonest skew of the three. It no longer
 *    does: both sides now answer "not archived", one because the record says
 *    open and the other because there is no card to be archived. What is left
 *    is the reverse and it is invisible while browsing — a root the rollup
 *    dropped whose stored card says CLOSED is withheld by the scope, so it can
 *    only appear under `all`, undimmed.
 *
 * So: faded rows with the toggle off and the search box empty are skew alone,
 * and rare. None of the three brings the sections back — what justified
 * deleting them is that the rows the dim exists for are the ones the toggle
 * already removed, not that the fade is provably unreachable.
 */
export function isChatDimmed(
  chat: Pick<Chat, "id" | "metadata">,
  // See {@link DimCard} for why this is not a full CardSummary. The map must
  // be built from a `listCards(true)` — hidden cards are part of the verdict.
  cardsById: ReadonlyMap<string, DimCard>,
  { cardsLoaded }: DimContext,
): boolean {
  if (!cardsLoaded) return false;
  return isChatOnArchivedCard(chat, cardsById);
}
