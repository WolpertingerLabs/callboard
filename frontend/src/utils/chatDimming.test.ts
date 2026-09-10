/**
 * The archived-chat dim.
 *
 * The rule under test: a row fades when its lineage root is an ARCHIVED card —
 * closed, or hidden from the board — and only then. A row on no card does not
 * fade. That is the narrow reading, and the narrowing is the point: nothing
 * triggered or job-stepped can be a card (`isCardEligible`), so the wide
 * reading faded every such chat and, worse, its server-side twin withheld them
 * from the list entirely — which is what made "Show triggered chats" look like
 * a dead switch.
 *
 * Every case here carries a row that must NOT be dimmed — an assertion that
 * matched everything would pass a fixture where everything is dimmed, which is
 * precisely the bug the wide rule was.
 */
import { describe, expect, it } from "vitest";
import type { Chat, CardSummary } from "../api";
import { chatCardId, isChatDimmed, type DimContext } from "./chatDimming";

type Cards = ReadonlyMap<string, Pick<CardSummary, "lifecycle" | "hidden">>;

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
  // A card opted out of the board. Archived for this purpose whatever its
  // lifecycle says — `cardLifecycle=unarchived` withholds its tree, so a dim
  // that read only `lifecycle` would leave those rows unfaded under a search.
  ["hidden-card", { lifecycle: "open" as const, hidden: true }],
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
    // An empty card map is indistinguishable from "nobody has a card", and
    // nobody having a card now means nobody is archived — so the pre-fetch
    // state renders undimmed by the rule as well as by the flag.
    expect(isChatDimmed(chat({}), new Map(), LOADING)).toBe(false);
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), new Map(), LOADING)).toBe(false);
    // Control: the same chat with its card present and closed DOES dim, so the
    // assertions above are about the state and not about the matcher.
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), CARDS, LOADED)).toBe(true);
  });

  /**
   * The rule, stated as the pair it has to be: a closed card fades, an open one
   * does not, and a chat on NO card is not archived and does not fade either.
   *
   * That last clause is the whole of this change. `isCardEligible` refuses to
   * make a card of a triggered or job-step chat, so under the old rule those
   * chats were permanently faded — and, since the server scope was the same
   * predicate, permanently absent from the default list. Turning on "Show
   * triggered chats" admitted them and the archived scope took them straight
   * back out.
   */
  it("dims a closed-card chat but not an open-card or card-less one", () => {
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), CARDS, LOADED)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, LOADED)).toBe(false);
    expect(isChatDimmed(chat({ forkedFrom: "intermediate" }, "legacy-leaf"), CARDS, LOADED)).toBe(false);
    // Card-less: a root the cards map does not know, which is what a triggered
    // chat, a job step and a never-recorded session all look like from here.
    expect(isChatDimmed(chat({ triggered: true }, "triggered-root"), CARDS, LOADED)).toBe(false);
    expect(isChatDimmed(chat({ jobRunId: "run-1" }, "job-step"), CARDS, LOADED)).toBe(false);
    expect(isChatDimmed(chat({}, "unfiled"), CARDS, LOADED)).toBe(false);
  });

  /**
   * Hidden is the second way to be archived, and it is in the predicate for
   * one reason: the server's `unarchived` scope withholds a hidden card's tree
   * exactly as it withholds a closed one's. A dim that read `lifecycle` alone
   * would disagree with it, and the sidebar's two halves are only safe while
   * they are exact complements.
   */
  it("dims a hidden card's chat even though its lifecycle is open", () => {
    expect(isChatDimmed(chat({ rootChatId: "hidden-card" }), CARDS, LOADED)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, LOADED)).toBe(false);
  });

  /**
   * A dangling root — the card was deleted — leaves a chat on no live card,
   * which is now the undimmed case. It reads as an ordinary unfiled chat
   * because that is what it has become; there is no archived card to point at.
   */
  it("does not dim a chat whose root was deleted (dangling lineage)", () => {
    expect(isChatDimmed(chat({ rootChatId: "deleted-card" }), CARDS, LOADED)).toBe(false);
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), CARDS, LOADED)).toBe(true);
  });

  /**
   * There is no view option in front of the dim any more, so a stale
   * `dimCardless: false` — the shape a bundle predating the removal passed —
   * cannot switch it back off. The gate count itself is pinned at compile time
   * where `LOADED` is declared, not here.
   */
  it("dims with no toggle in front of it", () => {
    const legacy = { dimCardless: false, cardsLoaded: true } as unknown as DimContext;
    expect(isChatDimmed(chat({ rootChatId: "closed-card" }), CARDS, legacy)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "hidden-card" }), CARDS, legacy)).toBe(true);
    expect(isChatDimmed(chat({ rootChatId: "open-card" }), CARDS, legacy)).toBe(false);
  });
});
