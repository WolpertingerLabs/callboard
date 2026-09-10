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
 * Whether the chat is filed under a card that is currently open.
 *
 * The question behind the dim: it fades the rows this returns false for. A
 * dangling id — the root chat was deleted — is a chat with no live card, same
 * as never having had one, so it answers false like an unfiled chat.
 *
 * Very nearly the rows the server withholds under `cardLifecycle=active`, the
 * scope "Show archived" asks for when it is off — but two implementations of
 * one question, which can disagree at the edges. {@link isChatDimmed} lists
 * how.
 *
 * Says nothing about whether the cards have loaded: its one caller,
 * {@link isChatDimmed}, holds that flag (see {@link DimContext.cardsLoaded}).
 * Module-private since the sectioning that was the second caller went away —
 * it is a step of the dim now, not a shared predicate.
 */
function isChatCardActive(
  chat: Pick<Chat, "id" | "metadata">,
  cardsById: ReadonlyMap<string, Pick<CardSummary, "lifecycle">>,
): boolean {
  // Callers can index CardSummary.memberChats into this map. Prefer that
  // authoritative membership: legacy multi-level trees may have neither a
  // rootChatId stamp nor a direct parent pointer to the actual root.
  const direct = cardsById.get(chat.id);
  if (direct) return direct.lifecycle === "open";
  const id = chatCardId(chat);
  if (!id) return false;
  return cardsById.get(id)?.lifecycle === "open";
}

export interface DimContext {
  /**
   * Whether the first `listCards` has returned.
   *
   * Load-bearing, and the reason this is not simply `!card`. A missing card
   * record means three different things — the chat has no card, the cards have
   * not been fetched yet, or the id dangles past a deleted card — and on first
   * paint `cards` is `[]`, so every one of them looks identical to "no card".
   * Without this flag the entire list flashes dimmed on every mount and then
   * un-dims when the fetch lands.
   *
   * Now the *only* gate: the dim used to sit behind a view option a user had
   * to switch on, so the flash was rare and opt-in. It is unconditional, so
   * this flag is what stands between every user and a full-list dim on every
   * mount. Do not drop it.
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
 * chat on an archived or absent card fades while it is running, which is
 * intended — running is not the same question as "is this work still open" —
 * but it is now everyone's default rather than an opt-in, so do not describe
 * the exemptions as "rows that need the user" and leave it at that.
 *
 * Fades a chat whose card is archived *or* absent — the same predicate the dim
 * has always used, now with no toggle in front of it. "Show archived" is not
 * such a toggle: it decides whether these rows are fetched at all, so with it
 * off this has almost nothing to fade.
 *
 * Almost. The scope is the server's verdict over stored records
 * (`cardLifecycle=active`); the fade is the `/api/cards` rollup's. Two sources,
 * so a row CAN come back under the toggle-off view and still dim:
 *
 *  - **skew.** They are separate requests. The 15s session poll calls `load()`
 *    without `loadCards()`, and archiving from a row's kebab menu patches
 *    `cards` locally without refetching the list, so one is briefly newer.
 *  - **native Codex.** `services/card-context.ts` refuses to promote a native
 *    record to a card (and stops early when `nativeDiscoveryIncomplete`), while
 *    the list route's open-root scan has no such term. Such a root is in scope
 *    and in no card.
 *
 * A stray faded row with the toggle off is one of those two. Neither brings
 * the sections back: what justified deleting them is that the rows the dim
 * exists for are the ones the toggle already removed, not that the fade is
 * provably unreachable.
 */
export function isChatDimmed(
  chat: Pick<Chat, "id" | "metadata">,
  // Lifecycle is the only field the dim reads; asking for less than a
  // CardSummary is what lets a test state a card as `{ lifecycle: "closed" }`
  // (the wire value behind the UI's "Archived").
  cardsById: ReadonlyMap<string, Pick<CardSummary, "lifecycle">>,
  { cardsLoaded }: DimContext,
): boolean {
  if (!cardsLoaded) return false;
  return !isChatCardActive(chat, cardsById);
}
