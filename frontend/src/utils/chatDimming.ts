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
 * The same rows the server withholds under `cardLifecycle=active`, which is
 * what the "Show archived" toggle asks for when it is off. Two implementations
 * of one predicate, deliberately: with the toggle off nothing here has anything
 * to fade, and with it on the fade is the only thing marking what came back.
 *
 * Says nothing about whether the cards have loaded: the caller holds that flag
 * (see {@link DimContext.cardsLoaded}).
 */
export function isChatCardActive(
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
 * off this simply never has a row to fade.
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
