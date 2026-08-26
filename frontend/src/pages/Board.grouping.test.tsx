/**
 * Board grouping: status is the outer split, category the inner one.
 *
 * The rule this file pins down is the one that is easy to invert by accident —
 * a category-first board scatters the cards that need you across every group
 * on screen, which is exactly the view the sections exist to prevent. These
 * assertions read the rendered outline (headers and tiles in document order)
 * rather than the arrays that produced it, so a change that reorders the JSX
 * without touching the grouping code is still caught.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary } from "../api";
import { listCards } from "../api";
import Board from "./Board";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  bulkSetCardLifecycle: vi.fn(),
  updateCard: vi.fn(),
}));

vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => 0 }));

vi.mock("../components/board/CardDrawer", () => ({
  default: ({ card }: { card: CardSummary }) => <div data-testid="drawer">{card.title}</div>,
}));

function card(id: string, title: string, overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    id,
    title,
    description: "",
    emoji: "🗂️",
    lifecycle: "open",
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-08-07T01:00:00.000Z",
    chatCount: 0,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

const mockList = vi.mocked(listCards);

async function mount(cards: CardSummary[]) {
  mockList.mockResolvedValue({ cards });
  render(
    <MemoryRouter>
      <Board />
    </MemoryRouter>,
  );
  await screen.findAllByRole("heading", { level: 2 });
}

/**
 * Every status heading, category heading and tile on the board, in the order
 * the DOM holds them. Read through the heading hierarchy the page actually
 * exposes, so these assertions cover the structure a screen reader walks and
 * not a set of test-only handles. Headings carry one markdown-style marker per
 * level — `## Status`, `### Category` — so an assertion can't be satisfied by a
 * card titled like a category, or by a heading at the wrong depth.
 */
function outline(): string[] {
  return [...document.querySelectorAll('[role="heading"],[role="checkbox"]')].map((el) => {
    if (el.getAttribute("role") === "checkbox") return el.getAttribute("aria-label")!.replace("Select ", "");
    return `${"#".repeat(Number(el.getAttribute("aria-level")))} ${el.textContent}`;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("status sections with category sub-groups", () => {
  it("keeps a categorized card in its status section rather than lifting the category to the top", async () => {
    await mount([
      card("i1", "Idle alpha", { category: "Alpha" }),
      card("n1", "Blocked beta", { category: "Beta", rollup: "needs_you" }),
      card("r1", "Running alpha", { category: "Alpha", rollup: "job_running" }),
    ]);

    // The needs-you card leads the board even though its category, Beta, sorts
    // last alphabetically and holds nothing else.
    expect(outline()).toEqual([
      "## Needs you",
      "### Beta",
      "Blocked beta",
      "## Running",
      "### Alpha",
      "Running alpha",
      "## Idle",
      "### Alpha",
      "Idle alpha",
    ]);
  });

  it("leads the Idle section with the category holding the stalest card", async () => {
    await mount([
      card("z1", "Zeta stalest", { category: "Zeta", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
      card("a1", "Alpha mid", { category: "Alpha", lastActivityAt: "2026-08-07T02:00:00.000Z" }),
      card("a2", "Alpha later", { category: "Alpha", lastActivityAt: "2026-08-07T03:00:00.000Z" }),
      card("z2", "Zeta fresh", { category: "Zeta", lastActivityAt: "2026-08-07T09:00:00.000Z" }),
    ]);

    // The ranges INTERLEAVE deliberately, so the three plausible keys disagree:
    // stalest-card puts Zeta first (01:00 < 02:00), freshest-card would put
    // Alpha first (03:00 < 09:00 ascending), and alphabetical would too. Only
    // the intended rule produces this order.
    expect(outline()).toEqual(["## Idle", "### Zeta", "Zeta stalest", "Zeta fresh", "### Alpha", "Alpha mid", "Alpha later"]);
  });

  it("reads a group's age from its stalest card, not from whatever a pin put first", async () => {
    await mount([
      card("a1", "Alpha pinned fresh", { category: "Alpha", pinned: true, lastActivityAt: "2026-08-07T09:00:00.000Z" }),
      card("a2", "Alpha stalest", { category: "Alpha", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
      card("b1", "Beta mid", { category: "Beta", lastActivityAt: "2026-08-07T05:00:00.000Z" }),
    ]);

    // Alpha leads on its 01:00 card even though the pin makes 09:00 the tile
    // rendered first. Keying the group on cards[0] would put Beta first.
    expect(outline()).toEqual(["## Idle", "### Alpha", "Alpha pinned fresh", "Alpha stalest", "### Beta", "Beta mid"]);
  });

  it("orders a live section's categories alphabetically, so a poll cannot reshuffle them", async () => {
    const live = (activity: string) => [
      card("a1", "Alpha work", { category: "Alpha", rollup: "active", lastActivityAt: activity }),
      card("b1", "Beta work", { category: "Beta", rollup: "active", lastActivityAt: "2026-08-07T05:00:00.000Z" }),
    ];

    await mount(live("2026-08-07T01:00:00.000Z"));
    const before = outline();
    // Freshest-first would lead with Beta here, so this assertion alone pins
    // the direction; the re-render below pins the stability.
    expect(before).toEqual(["## Running", "### Alpha", "Alpha work", "### Beta", "Beta work"]);

    // Alpha does some work, crossing Beta. That flips the comparison BOTH ways
    // — Alpha becomes the freshest and Beta the stalest — so any activity key
    // would swap these two BLOCKS of tiles on the next 15s poll, moving a
    // different card under a click already on its way. Only a static key holds.
    cleanup();
    await mount(live("2026-08-07T09:00:00.000Z"));
    expect(outline()).toEqual(before);
  });

  it("sorts a category with a running job above one that is merely active", async () => {
    await mount([
      card("a1", "Alpha active", { category: "Alpha", rollup: "active", lastActivityAt: "2026-08-07T09:00:00.000Z" }),
      card("b1", "Beta job", { category: "Beta", rollup: "job_running", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
    ]);

    // Peak urgency beats recency between groups, so the stale job still leads.
    expect(outline()).toEqual(["## Running", "### Beta", "Beta job", "### Alpha", "Alpha active"]);
  });

  it("labels the uncategorized group only where it shares a section", async () => {
    await mount([
      card("a1", "Idle alpha", { category: "Alpha" }),
      card("u1", "Idle loose"),
      card("u2", "Blocked loose", { rollup: "needs_you" }),
    ]);

    // Idle holds both, so both are named. Needs you holds only uncategorized
    // cards, where an "Uncategorized" heading would add nothing.
    expect(outline()).toEqual(["## Needs you", "Blocked loose", "## Idle", "### Alpha", "Idle alpha", "### Uncategorized", "Idle loose"]);
  });

  it("shows no sub-headings at all when nothing is categorized", async () => {
    await mount([card("u1", "Idle one"), card("u2", "Running one", { rollup: "active" })]);

    expect(screen.queryAllByRole("heading", { level: 3 })).toEqual([]);
    expect(outline()).toEqual(["## Running", "Running one", "## Idle", "Idle one"]);
  });

  it("keeps a pinned card at the head of its category without dragging the category up", async () => {
    await mount([
      card("a1", "Alpha pinned fresh", { category: "Alpha", pinned: true, lastActivityAt: "2026-08-07T09:00:00.000Z" }),
      card("a2", "Alpha stale", { category: "Alpha", lastActivityAt: "2026-08-07T08:00:00.000Z" }),
      card("b1", "Beta stalest", { category: "Beta", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
    ]);

    // Beta still leads: group order reads the stalest card in each group, which
    // a pin inside Alpha cannot change.
    expect(outline()).toEqual(["## Idle", "### Beta", "Beta stalest", "### Alpha", "Alpha pinned fresh", "Alpha stale"]);
  });

  it("lets uncategorized lead a section when it holds the stalest work", async () => {
    await mount([
      card("a1", "Alpha fresher", { category: "Alpha", lastActivityAt: "2026-08-07T05:00:00.000Z" }),
      card("u1", "Loose stalest", { lastActivityAt: "2026-08-07T01:00:00.000Z" }),
    ]);

    // Uncategorized loses only the ALPHABETICAL tie-break. It is not pinned to
    // the bottom, or the stalest thing on the board could hide under a heading
    // the eye reads as leftovers.
    expect(outline()).toEqual(["## Idle", "### Uncategorized", "Loose stalest", "### Alpha", "Alpha fresher"]);
  });

  it("files a rollup value this bundle predates under Idle, and orders it as idle", async () => {
    // An older tab against a newer daemon. Off the board entirely is the one
    // outcome worse than under the wrong heading — see BUCKETS in Board.tsx.
    //
    // Three cards, not one: with a single card `sort` never calls the
    // comparator, so a version of this test that only proved the card renders
    // would say nothing about how it sorts. The unknown rollup sits between
    // two real idle cards by age, which it can only do if the comparator gives
    // the same direction for (idle, unknown) as for (idle, idle). If it did
    // not, this order would depend on the order listCards returned them in.
    const cards = [
      card("i1", "Idle stalest", { lastActivityAt: "2026-08-07T01:00:00.000Z" }),
      card("x1", "From the future", { rollup: "hibernating" as CardSummary["rollup"], lastActivityAt: "2026-08-07T05:00:00.000Z" }),
      card("i2", "Idle freshest", { lastActivityAt: "2026-08-07T09:00:00.000Z" }),
    ];
    const expected = ["## Idle", "Idle stalest", "From the future", "Idle freshest"];

    await mount(cards);
    expect(outline()).toEqual(expected);

    // Same three cards, different server order. A non-transitive comparator
    // renders these two mounts differently.
    cleanup();
    await mount([cards[1], cards[2], cards[0]]);
    expect(outline()).toEqual(expected);
  });
});
