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
  createCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
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
  await screen.findAllByTestId("section-header");
}

/**
 * Every status header, category header and tile on the board, in the order the
 * DOM holds them. Headers are prefixed so an assertion can't be satisfied by a
 * card that happens to be titled like a category.
 */
function outline(): string[] {
  return [...document.querySelectorAll('[data-testid="section-header"],[data-testid="group-header"],[role="checkbox"]')].map((el) => {
    if (el.getAttribute("role") === "checkbox") return el.getAttribute("aria-label")!.replace("Select ", "");
    return `${el.getAttribute("data-testid") === "section-header" ? "##" : "#"} ${el.textContent}`;
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
      "# Beta",
      "Blocked beta",
      "## Running",
      "# Alpha",
      "Running alpha",
      "## Idle",
      "# Alpha",
      "Idle alpha",
    ]);
  });

  it("orders a section's categories by the same activity extreme as the cards inside them", async () => {
    await mount([
      card("b1", "Beta recent", { category: "Beta", lastActivityAt: "2026-08-07T04:00:00.000Z" }),
      card("a1", "Alpha stalest", { category: "Alpha", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
      card("b2", "Beta stale", { category: "Beta", lastActivityAt: "2026-08-07T03:00:00.000Z" }),
      card("a2", "Alpha stale", { category: "Alpha", lastActivityAt: "2026-08-07T02:00:00.000Z" }),
    ]);

    // Idle sorts stalest-first, so the category holding the stalest card leads
    // — not the alphabetically-first one, which here happens to agree, and not
    // the freshest.
    expect(outline()).toEqual(["## Idle", "# Alpha", "Alpha stalest", "Alpha stale", "# Beta", "Beta stale", "Beta recent"]);
  });

  it("puts the freshest category first in a live section", async () => {
    await mount([
      card("a1", "Alpha older", { category: "Alpha", rollup: "active", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
      card("b1", "Beta newer", { category: "Beta", rollup: "active", lastActivityAt: "2026-08-07T05:00:00.000Z" }),
    ]);

    expect(outline()).toEqual(["## Running", "# Beta", "Beta newer", "# Alpha", "Alpha older"]);
  });

  it("sorts a category with a running job above one that is merely active", async () => {
    await mount([
      card("a1", "Alpha active", { category: "Alpha", rollup: "active", lastActivityAt: "2026-08-07T09:00:00.000Z" }),
      card("b1", "Beta job", { category: "Beta", rollup: "job_running", lastActivityAt: "2026-08-07T01:00:00.000Z" }),
    ]);

    // Peak urgency beats recency between groups, so the stale job still leads.
    expect(outline()).toEqual(["## Running", "# Beta", "Beta job", "# Alpha", "Alpha active"]);
  });

  it("labels the uncategorized group only where it shares a section", async () => {
    await mount([
      card("a1", "Idle alpha", { category: "Alpha" }),
      card("u1", "Idle loose"),
      card("u2", "Blocked loose", { rollup: "needs_you" }),
    ]);

    // Idle holds both, so both are named. Needs you holds only uncategorized
    // cards, where an "Uncategorized" heading would add nothing.
    expect(outline()).toEqual(["## Needs you", "Blocked loose", "## Idle", "# Alpha", "Idle alpha", "# Uncategorized", "Idle loose"]);
  });

  it("shows no sub-headings at all when nothing is categorized", async () => {
    await mount([card("u1", "Idle one"), card("u2", "Running one", { rollup: "active" })]);

    expect(screen.queryAllByTestId("group-header")).toEqual([]);
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
    expect(outline()).toEqual(["## Idle", "# Beta", "Beta stalest", "# Alpha", "Alpha pinned fresh", "Alpha stale"]);
  });
});
