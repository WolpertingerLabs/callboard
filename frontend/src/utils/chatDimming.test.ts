/**
 * The archived-chat dim.
 *
 * The case worth a test file is the first paint: `cards` is `[]` for as long as
 * the card fetch takes, and a dim that reads only "no card record" fades the
 * entire sidebar until it lands. Every case here carries a row that must NOT be
 * dimmed — an assertion that matched everything would pass a fixture where
 * everything is dimmed, which is precisely the bug.
 */
import { describe, expect, it } from "vitest";
import type { Chat, CardSummary } from "../api";
import { chatCardId, isChatDimmed, type DimContext } from "./chatDimming";

type Cards = ReadonlyMap<string, Pick<CardSummary, "lifecycle">>;

const chat = (metadata: Record<string, unknown>, id = "chat-1"): Pick<Chat, "id" | "metadata"> => ({ id, metadata: JSON.stringify(metadata) });

/**
 * Annotated, not inferred, and that is the assertion: `cardsLoaded` is the
 * dim's sole gate, so a second *required* one — another toggle sneaking back
 * in — stops these being assignable and fails `tsc`, which the frontend
 * tsconfig runs over `src`, tests included. A runtime check could not do this;
 * `Object.keys` over a literal this file wrote only ever agrees with itself.
 */
const LOADED: DimContext = { cardsLoaded: true };
const LOADING: DimContext = { cardsLoaded: false };

const CARDS: Cards = new Map([
  ["open-card", { lifecycle: "open" as const }],
  ["closed-card", { lifecycle: "closed" as const }],
  // Callers also index CardSummary.memberChats by chat id, which is the
  // authoritative answer for legacy multi-level trees.
  ["legacy-leaf", { lifecycle: "open" as const }],
]);

describe("chatCardId", () => {
  it("resolves a chat's card as its lineage root", () => {
    // Children are stamped with the root at creation.
    expect(chatCardId(chat({ rootChatId: "open-card" }))).toBe("open-card");
    // Pre-stamp records fall back to the parent pointer.
    expect(chatCardId(chat({ parentChatId: "open-card" }))).toBe("open-card");
    expect(chatCardId(chat({ forkedFrom: "open-card" }))).toBe("open-card");
    // A top-level chat is its own root — and therefore its own card.
    expect(chatCardId(chat({}, "own-root"))).toBe("own-root");
    expect(chatCardId({ id: "bad", metadata: "{not json" })).toBeUndefined();
  });
});

describe("isChatDimmed", () => {
  it("dims nothing before the first listCards returns", () => {
    // Both of these dim once loaded — see the next test. Before then an empty
    // card map is indistinguishable from "nobody has a card", so the whole list
    // would flash faded on every mount.
    expect(isChatDimmed(chat({}), new Map(), LOADING)).toBe(false);
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), new Map(), LOADING)).toBe(false);
    // Control: a chat on an open card is undimmed in this state too, so the
    // assertion above is not just reporting "everything is false".
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, LOADED)).toBe(false);
  });

  it("dims a card-less chat and a closed-card chat, but not an open-card one", () => {
    // Card-less here means a root the cards map does not know — e.g. a
    // triggered chat, which is not a card at all.
    expect(isChatDimmed(chat({ triggered: true }, "triggered-root"), CARDS, LOADED)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), CARDS, LOADED)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, LOADED)).toBe(false);
    expect(isChatDimmed(chat({ forkedFrom: "intermediate" }, "legacy-leaf"), CARDS, LOADED)).toBe(false);
  });

  it("dims a chat whose root was deleted (dangling lineage)", () => {
    expect(isChatDimmed(chat({ rootChatId: "deleted-card" }), CARDS, LOADED)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, LOADED)).toBe(false);
  });

  /**
   * There is no view option in front of the dim any more, so a stale
   * `dimCardless: false` — the shape a bundle predating the removal passed —
   * cannot switch it back off. The gate count itself is pinned at compile time
   * where `LOADED` is declared, not here.
   */
  it("dims with no toggle in front of it", () => {
    const legacy = { dimCardless: false, cardsLoaded: true } as unknown as DimContext;
    expect(isChatDimmed(chat({}), CARDS, legacy)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), CARDS, legacy)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, legacy)).toBe(false);
  });
});
