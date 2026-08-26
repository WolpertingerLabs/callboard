/**
 * Board multi-select: the wiring the tile and the hook cannot see.
 *
 * Three things live only here and are worth the cost of mounting the page —
 * the shift+click range order (which must be the order the board actually
 * rendered, not a re-derivation of it), the lifecycle scoping, and what
 * happens to a selection when the bulk call half-fails.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary } from "../api";
import { listCards, bulkSetCardLifecycle } from "../api";
import Board from "./Board";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  bulkSetCardLifecycle: vi.fn(),
  updateCard: vi.fn(),
}));

vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => 0 }));

// Stubbed so "a plain click opens the drawer" is an assertion about the board,
// not about whatever the real drawer fetches on mount.
vi.mock("../components/board/CardDrawer", () => ({
  default: ({ card }: { card: CardSummary }) => <div data-testid="drawer">{card.title}</div>,
}));

// The closed strip is collapsed by default; the closed-card tests need it open.
vi.mock("../utils/localStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/localStorage")>()),
  getBoardClosedExpanded: () => true,
  saveBoardClosedExpanded: vi.fn(),
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

/**
 * The board groups by status first and category second, so this fixture spans
 * BOTH kinds of boundary a range can cross. Rendered order is deterministically:
 *
 *   Needs you │ Alpha: Alpha one
 *   Idle      │ Alpha: Alpha two │ Beta: Beta one, Beta two
 *   (closed)  │ Closed one, Closed two, Closed three
 *
 * So Alpha one → Alpha two crosses a SECTION boundary, and Alpha two → Beta one
 * crosses a category GROUP boundary inside one section. Both matter: a flatten
 * that walked sections or groups in the wrong order would select cards the user
 * never saw, and with only one kind of boundary present, half of that flatten
 * is unguarded. Alpha leads Idle because it holds the stalest card (02:00).
 *
 * This array is DELIBERATELY not in rendered order — the open cards interleave
 * their categories and the closed ones are not in closedAt order. A range that
 * read `cards` directly instead of the arrays the board renders would pass
 * against a fixture that happened to agree with the screen; against this one
 * it selects a visibly different set.
 */
const CARDS: CardSummary[] = [
  card("a1", "Alpha one", { category: "Alpha", rollup: "needs_you", lastActivityAt: "2026-08-07T05:00:00.000Z" }),
  card("b1", "Beta one", { category: "Beta", lastActivityAt: "2026-08-07T03:00:00.000Z" }),
  card("a2", "Alpha two", { category: "Alpha", lastActivityAt: "2026-08-07T02:00:00.000Z" }),
  card("b2", "Beta two", { category: "Beta", lastActivityAt: "2026-08-07T04:00:00.000Z" }),
  card("c3", "Closed three", { lifecycle: "closed", closedAt: "2026-08-07T04:00:00.000Z" }),
  card("c1", "Closed one", { lifecycle: "closed", closedAt: "2026-08-07T06:00:00.000Z" }),
  card("c2", "Closed two", { lifecycle: "closed", closedAt: "2026-08-07T05:00:00.000Z" }),
];

/** Fixture lookup by id — the CARDS array order is deliberately not meaningful. */
function fixture(id: string, overrides: Partial<CardSummary> = {}): CardSummary {
  return { ...CARDS.find((c) => c.id === id)!, ...overrides };
}

const mockList = vi.mocked(listCards);
const mockBulk = vi.mocked(bulkSetCardLifecycle);

async function mount(cards: CardSummary[] = CARDS) {
  mockList.mockResolvedValue({ cards });
  render(
    <MemoryRouter>
      <Board />
    </MemoryRouter>,
  );
  await screen.findByText("Alpha one");
}

/** The tile's main surface, by card title. */
function tile(title: string) {
  return screen.getByRole("button", { name: new RegExp(title) });
}

function count() {
  return screen.queryByText(/\d+ selected/)?.textContent ?? null;
}

/** Titles of every currently-selected tile, in rendered order. */
function selectedTitles() {
  return screen
    .getAllByRole("checkbox")
    .filter((box) => box.getAttribute("aria-checked") === "true")
    .map((box) => box.getAttribute("aria-label")?.replace("Select ", ""));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(cleanup);

describe("entering selection mode from the desktop", () => {
  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("%s+click enters selection mode and selects that card", async (_name, init) => {
    await mount();
    fireEvent.click(tile("Alpha one"), init);

    expect(count()).toBe("1 selected");
    expect(selectedTitles()).toEqual(["Alpha one"]);
    expect(screen.getByRole("button", { name: "Close 1" })).toBeDefined();
  });

  it("a plain click still opens the drawer", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"));

    expect(screen.getByTestId("drawer").textContent).toBe("Alpha one");
    expect(count()).toBeNull();
  });

  it("right-click enters selection mode, and the click that may follow does not undo it", async () => {
    await mount();
    fireEvent.contextMenu(tile("Alpha one"));
    expect(count()).toBe("1 selected");

    // macOS turns Ctrl+click into a synthetic right-click and may deliver BOTH
    // contextmenu and a ctrl-click. jsdom cannot reproduce that pairing's
    // timing, but it can prove the suppression that makes it survivable.
    fireEvent.click(tile("Alpha one"), { ctrlKey: true });
    expect(count()).toBe("1 selected");
  });

  it("does not open the drawer while selecting", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Beta one"));

    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(count()).toBe("2 selected");
  });
});

describe("shift+click ranges", () => {
  it("selects the inclusive range in rendered order, across a status section boundary", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Beta one"), { shiftKey: true });

    // Alpha one is the whole of Needs you; the range runs from there into Idle
    // and stops partway through it. A flatten that walked the sections in any
    // other order would sweep a different set.
    expect(selectedTitles()).toEqual(["Alpha one", "Alpha two", "Beta one"]);
  });

  it("works backwards from the anchor, across a category group boundary", async () => {
    await mount();
    fireEvent.click(tile("Beta two"), { metaKey: true });
    fireEvent.click(tile("Alpha two"), { shiftKey: true });

    // Both ends sit inside Idle, on either side of the Alpha/Beta sub-heading.
    expect(selectedTitles()).toEqual(["Alpha two", "Beta one", "Beta two"]);
  });

  it("does not extend from an anchor the user has already deselected", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Alpha one")); // deselect the last card — mode ends
    expect(count()).toBeNull();

    fireEvent.click(tile("Beta two"), { shiftKey: true });
    // A stale anchor on Alpha one would have swept the whole open board.
    expect(selectedTitles()).toEqual(["Beta two"]);
  });

  it("with no anchor, behaves as a plain toggle", async () => {
    await mount();
    fireEvent.click(tile("Beta one"), { shiftKey: true });

    expect(selectedTitles()).toEqual(["Beta one"]);
  });

  it("inside the closed strip, follows the strip's own most-recently-closed-first order", async () => {
    await mount();
    fireEvent.click(tile("Closed one"), { metaKey: true });
    fireEvent.click(tile("Closed two"), { shiftKey: true });

    // Closed one (06:00) and Closed two (05:00) are adjacent on screen; Closed
    // three (04:00) sits after both. Any other ordering of the strip — by
    // title, say — would put Closed three between them and sweep it in.
    expect(selectedTitles()).toEqual(["Closed one", "Closed two"]);
  });

  it("cannot be aimed at a card outside the lifecycle scope", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Closed two"), { shiftKey: true });

    // The closed tile is inert while an open-scoped selection is live, so the
    // shift+click never lands. This is what keeps a range from spanning
    // lifecycles: not a filter over the slice, but an unreachable endpoint.
    expect(selectedTitles()).toEqual(["Alpha one"]);
  });
});

describe("lifecycle scoping", () => {
  it("offers Reopen, not Close, when the selection started on a closed card", async () => {
    await mount();
    fireEvent.click(tile("Closed one"), { metaKey: true });

    expect(screen.getByRole("button", { name: "Reopen 1" })).toBeDefined();
    // Not /^Close/ — that also matches the "Closed 2" strip disclosure.
    expect(screen.queryByRole("button", { name: /^Close \d+$/ })).toBeNull();
  });

  it("makes out-of-scope tiles inert", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });

    expect((tile("Closed one") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tile("Closed one"));
    expect(count()).toBe("1 selected");
  });
});

describe("leaving selection mode", () => {
  it("Escape exits", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(count()).toBeNull();
  });

  it("Cancel exits", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    expect(count()).toBeNull();
  });

  it("deselecting the last card exits", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Alpha one"));

    expect(count()).toBeNull();
  });
});

describe("Ctrl+A", () => {
  it("selects every in-scope card, and only those", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.keyDown(document, { key: "a", ctrlKey: true });

    expect(selectedTitles()).toEqual(["Alpha one", "Alpha two", "Beta one", "Beta two"]);
  });

  it("does nothing before selection mode is entered", async () => {
    await mount();
    fireEvent.keyDown(document, { key: "a", metaKey: true });

    expect(count()).toBeNull();
  });
});

describe("mobile Select all", () => {
  it("selects every card in the active lifecycle scope", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    await mount();
    fireEvent.contextMenu(tile("Alpha one"));

    const selectAll = screen.getByRole("button", { name: "Select all" }) as HTMLButtonElement;
    expect(selectAll.disabled).toBe(false);
    fireEvent.click(selectAll);

    expect(selectedTitles()).toEqual(["Alpha one", "Alpha two", "Beta one", "Beta two"]);
    expect(selectAll.disabled).toBe(true);
  });

  it("does not show the button on desktop, where Ctrl/Cmd+A is available", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });

    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  });
});

describe("the bulk action", () => {
  it("closes the selected cards and leaves selection mode", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Alpha two"));

    mockBulk.mockResolvedValue({
      updated: [fixture("a1", { lifecycle: "closed" }), fixture("a2", { lifecycle: "closed" })],
      failed: [],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close 2" }));
    });

    expect(mockBulk).toHaveBeenCalledWith(["a1", "a2"], "closed");
    await waitFor(() => expect(count()).toBeNull());
    // The returned cards are merged into state, so the two move into the
    // closed strip without waiting for the next poll: 3 closed becomes 5.
    expect(screen.getByRole("button", { name: "Closed 5" })).toBeDefined();
  });

  it("reopens from a closed selection", async () => {
    await mount();
    fireEvent.click(tile("Closed one"), { metaKey: true });

    mockBulk.mockResolvedValue({ updated: [fixture("c1", { lifecycle: "open" })], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reopen 1" }));
    });

    expect(mockBulk).toHaveBeenCalledWith(["c1"], "open");
  });

  it("on partial failure, reports the count and keeps exactly the failed cards selected", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });
    fireEvent.click(tile("Alpha two"));
    fireEvent.click(tile("Beta one"));

    mockBulk.mockResolvedValue({
      updated: [fixture("a1", { lifecycle: "closed" })],
      failed: [
        { id: "a2", error: "locked" },
        { id: "b1", error: "locked" },
      ],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close 3" }));
    });

    await screen.findByText("2 of 3 cards could not be updated");
    // Still selected, because retrying exactly these is the user's next move.
    expect(selectedTitles()).toEqual(["Alpha two", "Beta one"]);
    expect(screen.getByRole("button", { name: "Close 2" })).toBeDefined();
  });

  it("surfaces a total failure in the error banner", async () => {
    await mount();
    fireEvent.click(tile("Alpha one"), { metaKey: true });

    mockBulk.mockRejectedValue(new Error("network down"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close 1" }));
    });

    await screen.findByText("network down");
    expect(count()).toBe("1 selected");
  });
});

describe("reconciling against the 15s poll", () => {
  it("drops selected ids for cards that have vanished", async () => {
    vi.useFakeTimers();
    try {
      mockList.mockResolvedValue({ cards: CARDS });
      render(
        <MemoryRouter>
          <Board />
        </MemoryRouter>,
      );
      await act(async () => void (await Promise.resolve()));

      fireEvent.click(tile("Alpha one"), { metaKey: true });
      fireEvent.click(tile("Alpha two"));
      expect(count()).toBe("2 selected");

      // Another client deleted Alpha two; the next poll no longer returns it.
      mockList.mockResolvedValue({ cards: CARDS.filter((c) => c.id !== "a2") });
      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });

      expect(screen.queryByText("Alpha two")).toBeNull();
      // A count of 2 with only one tile on screen is a number the user cannot
      // reconcile with what they can see.
      expect(count()).toBe("1 selected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves selection mode when every selected card has vanished", async () => {
    vi.useFakeTimers();
    try {
      mockList.mockResolvedValue({ cards: CARDS });
      render(
        <MemoryRouter>
          <Board />
        </MemoryRouter>,
      );
      await act(async () => void (await Promise.resolve()));

      fireEvent.click(tile("Alpha one"), { metaKey: true });
      fireEvent.click(tile("Alpha two"));
      expect(count()).toBe("2 selected");

      mockList.mockResolvedValue({ cards: CARDS.filter((c) => c.id !== "a1" && c.id !== "a2") });
      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });

      // An action bar over a selection of nothing has nothing to act on.
      expect(count()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
