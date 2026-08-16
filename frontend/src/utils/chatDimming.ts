import type { Chat, CardSummary } from "../api";

/**
 * The "Dim inactive chats" decision, as a function rather than an expression
 * inline in the list, for one reason: its whole difficulty is a state the list
 * passes through for a few hundred milliseconds on every mount and which no
 * render of the finished page reproduces.
 */

/** A chat's filed card id, or undefined. Unassign merges `cardId: null`. */
export function chatCardId(chat: Pick<Chat, "metadata">): string | undefined {
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    return typeof meta.cardId === "string" && meta.cardId ? meta.cardId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the chat is filed under a card that is currently open.
 *
 * The shared question behind two features: the dim fades the rows this returns
 * false for, and "Active cards first" files them under the Inactive header.
 * A dangling id — the card was deleted — is a chat with no live card, same as
 * never having had one, so it answers false like an unfiled chat.
 *
 * Says nothing about whether the cards have loaded: callers hold that flag
 * (see {@link DimContext.cardsLoaded}) because they differ in what to do with
 * it — the dim suppresses itself, the sectioning renders as if it were off.
 */
export function isChatCardActive(
  chat: Pick<Chat, "metadata">,
  cardsById: ReadonlyMap<string, Pick<CardSummary, "lifecycle">>,
): boolean {
  const id = chatCardId(chat);
  if (!id) return false;
  return cardsById.get(id)?.lifecycle === "open";
}

export interface DimContext {
  /** The view option. */
  dimCardless: boolean;
  /**
   * Whether the first `listCards` has returned.
   *
   * Load-bearing, and the reason this is not simply `!card`. A missing card
   * record means three different things — the chat has no card, the cards have
   * not been fetched yet, or the id dangles past a deleted card — and on first
   * paint `cards` is `[]`, so every one of them looks identical to "no card".
   * Without this flag the entire list flashes dimmed on every mount and then
   * un-dims when the fetch lands.
   */
  cardsLoaded: boolean;
}

/**
 * Whether a row is a candidate for dimming.
 *
 * Candidate, not verdict: `ChatListItem` still exempts rows that need the user
 * (active, summoning, unread), because it is the component that already parses
 * those out of the chat's metadata.
 */
export function isChatDimmed(
  chat: Pick<Chat, "metadata">,
  // Lifecycle is the only field the dim reads; asking for less than a
  // CardSummary is what lets a test state a card as `{ lifecycle: "closed" }`.
  cardsById: ReadonlyMap<string, Pick<CardSummary, "lifecycle">>,
  { dimCardless, cardsLoaded }: DimContext,
): boolean {
  if (!dimCardless || !cardsLoaded) return false;
  return !isChatCardActive(chat, cardsById);
}
