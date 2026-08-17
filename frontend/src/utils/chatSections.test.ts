/**
 * The "Active cards first" split.
 *
 * Every fixture here is deliberately in the WRONG order to start with —
 * inactive first, or interleaved. A partition test whose input already happens
 * to be bucket-ordered passes with the partition deleted, which is exactly the
 * false green this module can produce.
 *
 * The `!cardsLoaded` case lives in the callers (they own that flag) and is
 * covered as "predicate absent" here: `enabled: false` must give back the
 * option-off rendering, not an all-Inactive list.
 */
import { describe, expect, it } from "vitest";
import type { CardSummary, Chat } from "../api";
import { isChatCardActive } from "./chatDimming";
import { activeSectionPredicate, sectionByActive } from "./chatSections";

const chat = (id: string, cardId?: string | null): Pick<Chat, "id" | "metadata"> => ({
  id,
  metadata: JSON.stringify(cardId === undefined ? {} : { cardId }),
});

const CARDS: ReadonlyMap<string, Pick<CardSummary, "lifecycle">> = new Map([
  ["open-card", { lifecycle: "open" }],
  ["closed-card", { lifecycle: "closed" }],
]);

const byCard = (c: Pick<Chat, "metadata">) => isChatCardActive(c, CARDS);
const ids = (sections: { items: Pick<Chat, "id">[] }[]) => sections.map((s) => s.items.map((i) => i.id));

describe("sectionByActive", () => {
  it("puts Active before Inactive even when the input is the other way round", () => {
    // Input order is inactive-first: if the partition were dropped and the
    // array returned as-is, this would come back reversed.
    const items = [chat("closed", "closed-card"), chat("none"), chat("open", "open-card")];
    const sections = sectionByActive(items, byCard, true)!;

    expect(sections.map((s) => s.key)).toEqual(["active", "inactive"]);
    expect(sections.map((s) => s.label)).toEqual(["Active", "Inactive"]);
    expect(ids(sections)).toEqual([["open"], ["closed", "none"]]);
  });

  it("preserves the incoming order within each section", () => {
    // Interleaved on the way in; each bucket must come out in the order the
    // list handed them over — which is recency order in the sidebar.
    const items = [chat("a", "open-card"), chat("b"), chat("c", "open-card"), chat("d", "closed-card"), chat("e", "open-card")];
    expect(ids(sectionByActive(items, byCard, true)!)).toEqual([
      ["a", "c", "e"],
      ["b", "d"],
    ]);
  });

  it("returns null when the option is off, however split the list is", () => {
    const items = [chat("closed", "closed-card"), chat("open", "open-card")];
    expect(sectionByActive(items, byCard, false)).toBeNull();
    // Control: the very same list does split when enabled, so the null above
    // is the option being off and not an unsplittable fixture.
    expect(sectionByActive(items, byCard, true)).not.toBeNull();
  });

  it("returns null when every item is active, and when every item is inactive", () => {
    // A lone "Active" header over an undivided list is noise.
    expect(sectionByActive([chat("a", "open-card"), chat("b", "open-card")], byCard, true)).toBeNull();
    expect(sectionByActive([chat("a", "closed-card"), chat("b")], byCard, true)).toBeNull();
    expect(sectionByActive([], byCard, true)).toBeNull();
  });

  it("counts one per item by default", () => {
    const sections = sectionByActive([chat("a", "open-card"), chat("b"), chat("c", "closed-card")], byCard, true)!;
    expect(sections.map((s) => s.count)).toEqual([1, 2]);
  });

  it("counts by countOf, so a tree row can speak for its whole group", () => {
    // The tree layout's rows stand for a lineage group each. Counting rows
    // would report 1 for a three-chat group — the header must count chats.
    const rows = [
      { chat: chat("closed", "closed-card"), size: 1 },
      { chat: chat("open", "open-card"), size: 3 },
      { chat: chat("none"), size: 2 },
    ];
    const sections = sectionByActive(
      rows,
      (row) => byCard(row.chat),
      true,
      (row) => row.size,
    )!;
    expect(sections.map((s) => [s.key, s.items.length, s.count])).toEqual([
      ["active", 1, 3],
      ["inactive", 2, 3],
    ]);
  });

  it("files a dangling card id — the card was deleted — as inactive", () => {
    const items = [chat("ghost", "deleted-card"), chat("open", "open-card")];
    expect(ids(sectionByActive(items, byCard, true)!)).toEqual([["open"], ["ghost"]]);
  });

  it("sections whatever the caller's item type is, not just chats", () => {
    // The tree layout sections ROWS, each wrapping the chat that fronts a
    // lineage group — so the generic is load-bearing, not decoration.
    const rows = [
      { rootKey: "r1", chat: chat("closed", "closed-card") },
      { rootKey: "r2", chat: chat("open", "open-card") },
    ];
    const sections = sectionByActive(rows, (row) => byCard(row.chat), true)!;
    expect(sections.map((s) => s.items.map((r) => r.rootKey))).toEqual([["r2"], ["r1"]]);
  });
});

/**
 * The gate, and the reason it is a function and not an inline expression: the
 * only case worth testing is one no finished render reproduces, so nothing
 * about a working sidebar would ever tell you it was wrong.
 */
describe("activeSectionPredicate", () => {
  const ON = { sortByCardActive: true, cardsLoaded: true };

  it("withholds the predicate until the first listCards returns", () => {
    // `cards` is empty for as long as the fetch takes, so every chat looks
    // card-less. Sectioning on that files the whole list under Inactive and
    // then MOVES the rows when the fetch lands — worse than the dim's flash,
    // which only changes a shade.
    expect(activeSectionPredicate(new Map(), { sortByCardActive: true, cardsLoaded: false })).toBeUndefined();
    // Control: the option is on in both, so it is `cardsLoaded` doing this and
    // not the option being read as off.
    expect(activeSectionPredicate(new Map(), ON)).toBeTypeOf("function");
  });

  it("withholds the predicate while the option is off", () => {
    expect(activeSectionPredicate(CARDS, { sortByCardActive: false, cardsLoaded: true })).toBeUndefined();
  });

  it("answers by the chat's card lifecycle once both hold", () => {
    const isActive = activeSectionPredicate(CARDS, ON)!;
    expect(isActive(chat("a", "open-card"))).toBe(true);
    expect(isActive(chat("b", "closed-card"))).toBe(false);
    expect(isActive(chat("c"))).toBe(false);
    // A deleted card leaves the id dangling; that is not an open card.
    expect(isActive(chat("d", "deleted-card"))).toBe(false);
  });
});
