/**
 * The "Dim inactive chats" decision.
 *
 * The case worth a test file is the first paint: `cards` is `[]` for as long as
 * the card fetch takes, and a dim that reads only "no card record" fades the
 * entire sidebar until it lands. Every case here carries a row that must NOT be
 * dimmed — an assertion that matched everything would pass a fixture where
 * everything is dimmed, which is precisely the bug.
 */
import { describe, expect, it } from "vitest";
import type { Chat, CardSummary } from "../api";
import { chatCardId, isChatDimmed } from "./chatDimming";

type Cards = ReadonlyMap<string, Pick<CardSummary, "lifecycle">>;

const chat = (metadata: Record<string, unknown>): Pick<Chat, "metadata"> => ({ metadata: JSON.stringify(metadata) });

const ON = { dimCardless: true, cardsLoaded: true };
const LOADING = { dimCardless: true, cardsLoaded: false };

const CARDS: Cards = new Map([
  ["open-card", { lifecycle: "open" as const }],
  ["closed-card", { lifecycle: "closed" as const }],
]);

describe("chatCardId", () => {
  it("reads a filed chat's card, and treats unassigned and malformed alike", () => {
    expect(chatCardId(chat({ cardId: "open-card" }))).toBe("open-card");
    // Unassign merges `cardId: null` rather than deleting the key.
    expect(chatCardId(chat({ cardId: null }))).toBeUndefined();
    expect(chatCardId(chat({}))).toBeUndefined();
    expect(chatCardId({ metadata: "{not json" })).toBeUndefined();
  });
});

describe("isChatDimmed", () => {
  it("dims nothing before the first listCards returns", () => {
    // Both of these dim once loaded — see the next test. Before then an empty
    // card map is indistinguishable from "nobody has a card", so the whole list
    // would flash faded on every mount.
    expect(isChatDimmed(chat({}), new Map(), LOADING)).toBe(false);
    expect(isChatDimmed(chat({ cardId: "closed-card" }), new Map(), LOADING)).toBe(false);
    // Control: a chat on an open card is undimmed in this state too, so the
    // assertion above is not just reporting "everything is false".
    expect(isChatDimmed(chat({ cardId: "open-card" }), CARDS, ON)).toBe(false);
  });

  it("dims a card-less chat and a closed-card chat, but not an open-card one", () => {
    expect(isChatDimmed(chat({}), CARDS, ON)).toBe(true);
    expect(isChatDimmed(chat({ cardId: "closed-card" }), CARDS, ON)).toBe(true);
    expect(isChatDimmed(chat({ cardId: "open-card" }), CARDS, ON)).toBe(false);
  });

  it("dims a chat whose card id dangles past a deleted card", () => {
    expect(isChatDimmed(chat({ cardId: "deleted-card" }), CARDS, ON)).toBe(true);
    expect(isChatDimmed(chat({ cardId: "open-card" }), CARDS, ON)).toBe(false);
  });

  it("dims nothing while the option is off", () => {
    const off = { dimCardless: false, cardsLoaded: true };
    expect(isChatDimmed(chat({}), CARDS, off)).toBe(false);
    expect(isChatDimmed(chat({ cardId: "closed-card" }), CARDS, off)).toBe(false);
  });
});
