/**
 * The board in list mode is the SAME board.
 *
 * View mode swaps the container and the face and nothing else — and the reason
 * that matters is `orderedIds`, which is flattened out of the very arrays the
 * JSX renders and is what shift+click ranges are read from. A list mode that
 * re-derived its own order would keep looking right while selecting cards the
 * user never saw, so the assertions below compare the two modes against each
 * other rather than against a hand-written expectation: the outline they
 * produce, and the set a range across a section boundary sweeps.
 *
 * localStorage is deliberately NOT mocked here — the round-trip of both new
 * preferences across a remount is one of the things under test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardMemberChat, CardSummary } from "../api";
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
  default: ({ card, initialFolderFilter }: { card: CardSummary; initialFolderFilter?: string }) => (
    <div data-testid="drawer">
      {card.title}
      {initialFolderFilter && <span data-testid="drawer-folder">{initialFolderFilter}</span>}
    </div>
  ),
}));

function member(overrides: Partial<CardMemberChat> & Pick<CardMemberChat, "chatId" | "folder">): CardMemberChat {
  return {
    title: null,
    status: "stopped",
    hasSummon: false,
    unread: false,
    isTriggered: false,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

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
 * Spans both kinds of boundary a range can cross — the Needs you / Idle status
 * split and the Alpha / Beta category split inside Idle — and is deliberately
 * not in rendered order, so a mode that read this array instead of the arrays
 * the board renders would sweep a visibly different set.
 */
const CARDS: CardSummary[] = [
  card("a1", "Alpha one", { category: "Alpha", rollup: "needs_you", lastActivityAt: "2026-08-07T05:00:00.000Z" }),
  card("b1", "Beta one", { category: "Beta", lastActivityAt: "2026-08-07T03:00:00.000Z" }),
  card("a2", "Alpha two", { category: "Alpha", lastActivityAt: "2026-08-07T02:00:00.000Z" }),
  card("b2", "Beta two", { category: "Beta", lastActivityAt: "2026-08-07T04:00:00.000Z" }),
];

/** One card in one folder — the 97% case — and one fanned out across three. */
const FOLDER_CARDS: CardSummary[] = [
  card("s1", "Single folder", {
    memberChats: [member({ chatId: "s1", folder: "/home/cybil/callboard" })],
  }),
  card("m1", "Many folders", {
    memberChats: [
      member({ chatId: "m1", folder: "/home/cybil/countinghouse" }),
      member({ chatId: "m2", folder: "/home/cybil/countinghouse.feat-a" }),
      member({ chatId: "m3", folder: "/home/cybil/countinghouse.feat-b" }),
    ],
  }),
];

/**
 * The same four cards, with one of them — Alpha two, which sits INSIDE the
 * range the selection tests sweep — fanned out across three folders. That is
 * the card whose expansion must not reach `orderedIds`.
 */
const CARDS_WITH_FANOUT: CardSummary[] = CARDS.map((c) =>
  c.id === "a2"
    ? {
        ...c,
        memberChats: [
          member({ chatId: "a2", folder: "/home/cybil/callboard" }),
          member({ chatId: "x", folder: "/home/cybil/callboard.feat-x" }),
          member({ chatId: "y", folder: "/home/cybil/callboard.feat-y" }),
        ],
      }
    : c,
);

/** One card spanning 20 folders — the widest fan-out in the measured data. */
const WIDE_CARD: CardSummary[] = [
  card("w1", "Wide fan-out", {
    memberChats: Array.from({ length: 20 }, (_, i) =>
      member({ chatId: i === 0 ? "w1" : `w-${i}`, folder: i === 0 ? "/home/cybil/callboard" : `/home/cybil/callboard.feat-${i}` }),
    ),
  }),
];

const mockList = vi.mocked(listCards);

async function mount(cards: CardSummary[] = CARDS) {
  mockList.mockResolvedValue({ cards });
  render(
    <MemoryRouter>
      <Board />
    </MemoryRouter>,
  );
  await screen.findAllByRole("heading", { level: 2 });
}

/** Every heading and every card, in the order the DOM holds them — the same handle the grouping tests read. */
function outline(): string[] {
  return [...document.querySelectorAll('[role="heading"],[role="checkbox"]')].map((el) => {
    if (el.getAttribute("role") === "checkbox") return el.getAttribute("aria-label")!.replace("Select ", "");
    return `${"#".repeat(Number(el.getAttribute("aria-level")))} ${el.textContent}`;
  });
}

/**
 * A card's main surface, by title — a tile in one mode, a row in the other.
 *
 * Filtered past the expansion: a row's folder entries name the card they
 * belong to, so several buttons on an expanded board match one title.
 */
function face(title: string) {
  const matches = screen.getAllByRole("button", { name: new RegExp(title) });
  return matches.find((el) => el.closest('[role="group"]') === null)!;
}

function selectedTitles() {
  return screen
    .getAllByRole("checkbox")
    .filter((box) => box.getAttribute("aria-checked") === "true")
    .map((box) => box.getAttribute("aria-label")?.replace("Select ", ""));
}

/** The width-capped page body — the header's grandparent. */
const page = () => screen.getByRole("heading", { level: 1 }).parentElement!.parentElement as HTMLElement;

const layoutToggle = (name: "Cards view" | "List view") => screen.getByRole("button", { name });
const foldersToggle = () => screen.getByRole("button", { name: "Show folders" });
const expandToggle = () => screen.getByRole("button", { name: "Expand rows" });

/** List mode with paths on — the only configuration where an expansion means anything. */
function listWithPaths() {
  fireEvent.click(layoutToggle("List view"));
  fireEvent.click(foldersToggle());
}

/** The chevron on one row, addressed by the card it belongs to. */
function rowChevron(title: string) {
  return face(title).parentElement!.querySelector<HTMLElement>('[title^="Show all"],[title^="Hide"]')!;
}

/**
 * Whether a card's row is expanded, probed by a folder that is NOT its root —
 * the collapsed row shows the root path and nothing else, so a non-root path
 * on screen can only have come from the expansion.
 */
const isExpanded = (nonRootFolder: string) => screen.queryAllByTitle(nonRootFolder).length > 0;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(cleanup);

describe("the layout control", () => {
  it("starts on cards, which is the board that already existed", async () => {
    await mount();
    expect(layoutToggle("Cards view").getAttribute("aria-pressed")).toBe("true");
    expect(layoutToggle("List view").getAttribute("aria-pressed")).toBe("false");
  });

  it("moves aria-pressed with the mode, and actually swaps the face", async () => {
    await mount();
    // A tile stacks its lines; a row lays them out on the shared column
    // template. Asserted so the rest of this file cannot pass against a mode
    // that flipped a flag and rendered tiles anyway.
    expect(face("Alpha one").style.display).toBe("flex");

    fireEvent.click(layoutToggle("List view"));
    expect(layoutToggle("List view").getAttribute("aria-pressed")).toBe("true");
    expect(layoutToggle("Cards view").getAttribute("aria-pressed")).toBe("false");
    expect(face("Alpha one").style.display).toBe("grid");
  });

  it("is a group of pressed toggles, not radios it cannot drive from the keyboard", async () => {
    await mount();
    // ARIA radios owe the user roving tabindex and Arrow navigation between
    // them. These are two plain buttons in the tab order, and the two controls
    // beside them were already aria-pressed — a role promising a keyboard
    // contract the widget does not implement is worse than no role.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Board layout" })).toBeDefined();
    expect(layoutToggle("Cards view").getAttribute("aria-pressed")).toBe("true");
  });

  it("widens the page for a list, which has a column the grid does not", async () => {
    await mount();
    expect(page().style.maxWidth).toBe("1100px");

    fireEvent.click(layoutToggle("List view"));
    expect(page().style.maxWidth).toBe("1400px");
  });
});

describe("list mode renders the same board", () => {
  it("puts the same cards under the same headings in the same order", async () => {
    await mount();
    const asCards = outline();
    // Not a hand-written expectation: the point is that the two modes agree,
    // and Board.grouping.test.tsx already pins what that order should be.
    expect(asCards).toEqual(["## Needs you", "### Alpha", "Alpha one", "## Idle", "### Alpha", "Alpha two", "### Beta", "Beta one", "Beta two"]);

    fireEvent.click(layoutToggle("List view"));
    expect(outline()).toEqual(asCards);
  });

  it("sweeps the same range on a shift+click across a section boundary", async () => {
    await mount();
    fireEvent.click(face("Alpha one"), { metaKey: true });
    fireEvent.click(face("Beta one"), { shiftKey: true });
    const asCards = selectedTitles();
    expect(asCards).toEqual(["Alpha one", "Alpha two", "Beta one"]);

    // Same gesture in list mode. `orderedIds` is derived from the rendered
    // arrays, so this is the assertion that catches a container swap that
    // reordered anything on its way through.
    cleanup();
    await mount();
    fireEvent.click(layoutToggle("List view"));
    fireEvent.click(face("Alpha one"), { metaKey: true });
    fireEvent.click(face("Beta one"), { shiftKey: true });
    expect(selectedTitles()).toEqual(asCards);
  });

  it("still opens the drawer on a plain click", async () => {
    await mount();
    fireEvent.click(layoutToggle("List view"));
    fireEvent.click(face("Alpha two"));

    expect(screen.getByTestId("drawer").textContent).toBe("Alpha two");
  });
});

describe("the folder summary in list mode", () => {
  it("shows one path and no +N for a card that lives in one folder", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(layoutToggle("List view"));
    fireEvent.click(foldersToggle());

    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
    // The 97% case: a "+0" here would be noise on 794 of 818 cards.
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("counts the other folders on a card that fanned out", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(layoutToggle("List view"));
    fireEvent.click(foldersToggle());

    expect(screen.getByTitle("/home/cybil/countinghouse")).toBeDefined();
    expect(screen.getByText("+2")).toBeDefined();
  });
});

describe("the folders toggle", () => {
  it("is off by default, which is today's board", async () => {
    await mount(FOLDER_CARDS);
    expect(foldersToggle().getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTitle("/home/cybil/callboard")).toBeNull();
  });

  it("reaches both faces, not just the one it was flipped on", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(foldersToggle());
    // Card mode first.
    expect(foldersToggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();

    // The preference is the board's, not the face's, so it survives the swap.
    fireEvent.click(layoutToggle("List view"));
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();

    fireEvent.click(foldersToggle());
    expect(screen.queryByTitle("/home/cybil/callboard")).toBeNull();
  });
});

describe("row expansion", () => {
  it("offers the expand toggle only where it controls something", async () => {
    await mount(FOLDER_CARDS);
    // Card mode: tiles do not expand, so the control would be a lie.
    expect(screen.queryByRole("button", { name: "Expand rows" })).toBeNull();

    fireEvent.click(layoutToggle("List view"));
    // List mode with paths still off: nothing to expand into.
    expect(screen.queryByRole("button", { name: "Expand rows" })).toBeNull();

    fireEvent.click(foldersToggle());
    expect(expandToggle()).toBeDefined();

    fireEvent.click(layoutToggle("Cards view"));
    expect(screen.queryByRole("button", { name: "Expand rows" })).toBeNull();
  });

  it("sets the resting state of every row", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(false);

    fireEvent.click(expandToggle());
    expect(expandToggle().getAttribute("aria-pressed")).toBe("true");
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(true);
  });

  it("lets one row override that resting state in either direction", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();

    // Collapsed at rest, opened by its own chevron.
    fireEvent.click(rowChevron("Many folders"));
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(true);

    // And the other way: expanded at rest, closed by its own chevron. The
    // override is a DIFFERENCE from the resting state, not a state of its own.
    fireEvent.click(rowChevron("Many folders"));
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(false);
    fireEvent.click(expandToggle());
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(true);
    fireEvent.click(rowChevron("Many folders"));
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(false);
  });

  it("expands every row on 'expand all', including the one already open by hand", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();

    // The difference is a difference from the last HEADER press, not a
    // standing per-row state. Carried across, the row the user had just opened
    // would be the only row on the board that "expand all" closed — the exact
    // row they had shown most interest in.
    fireEvent.click(rowChevron("Many folders"));
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(true);

    fireEvent.click(expandToggle());
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(true);

    // And it is still a toggle afterwards, not a one-way latch.
    fireEvent.click(expandToggle());
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(false);
  });

  it("leaves the 97.1% of cards with at most one path without a chevron", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();
    fireEvent.click(expandToggle());

    // Nothing to open onto, so nothing to open — even with the board's
    // resting state set to expanded.
    const single = screen.getByRole("button", { name: /Single folder/ }).parentElement!;
    expect(single.querySelector('[title^="Show all"],[title^="Hide"]')).toBeNull();
    // The selection checkbox and the row itself, and no expansion under them.
    expect(single.querySelectorAll("button")).toHaveLength(2);
  });

  it("caps a wide fan-out at eight entries and offers the rest to the drawer", async () => {
    await mount(WIDE_CARD);
    listWithPaths();
    fireEvent.click(expandToggle());

    // 20 folders on the board would push every other card off the screen.
    expect(screen.getByTitle("/home/cybil/callboard.feat-7")).toBeDefined();
    expect(screen.queryByTitle("/home/cybil/callboard.feat-8")).toBeNull();
    expect(screen.getByText("… 12 more")).toBeDefined();
  });

  it("sweeps the same range with a row expanded as with every row collapsed", async () => {
    // The regression guard for `orderedIds`. A folder entry is not a card, and
    // a range that stepped through one would select cards the user never saw.
    await mount(CARDS_WITH_FANOUT);
    fireEvent.click(face("Alpha one"), { metaKey: true });
    fireEvent.click(face("Beta one"), { shiftKey: true });
    const collapsed = selectedTitles();
    expect(collapsed).toEqual(["Alpha one", "Alpha two", "Beta one"]);

    cleanup();
    await mount(CARDS_WITH_FANOUT);
    listWithPaths();
    // Alpha two sits mid-range and is the fanned-out card, so its expansion
    // lands between the two ends of the sweep.
    fireEvent.click(rowChevron("Alpha two"));
    expect(isExpanded("/home/cybil/callboard.feat-x")).toBe(true);

    fireEvent.click(face("Alpha one"), { metaKey: true });
    fireEvent.click(face("Beta one"), { shiftKey: true });
    expect(selectedTitles()).toEqual(collapsed);
  });
});

describe("drilling into a folder", () => {
  it("opens the drawer filtered to the folder that was clicked", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();
    fireEvent.click(expandToggle());

    fireEvent.click(screen.getByTitle("/home/cybil/countinghouse.feat-a"));
    expect(screen.getByTestId("drawer").textContent).toContain("Many folders");
    expect(screen.getByTestId("drawer-folder").textContent).toBe("/home/cybil/countinghouse.feat-a");
  });

  it("opens it unfiltered from the row itself", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();
    fireEvent.click(expandToggle());

    fireEvent.click(face("Many folders"));
    expect(screen.getByTestId("drawer").textContent).toBe("Many folders");
    expect(screen.queryByTestId("drawer-folder")).toBeNull();
  });
});

describe("persistence", () => {
  it("restores both preferences on a remount", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(layoutToggle("List view"));
    fireEvent.click(foldersToggle());

    cleanup();
    await mount(FOLDER_CARDS);

    expect(layoutToggle("List view").getAttribute("aria-pressed")).toBe("true");
    expect(foldersToggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle("/home/cybil/countinghouse")).toBeDefined();
  });

  it("restores the resting expansion too, but never a per-row override", async () => {
    await mount(FOLDER_CARDS);
    listWithPaths();
    fireEvent.click(expandToggle());
    // A row pushed back against the resting state — the state that must NOT
    // come back. Restored, it would open a card that has since collapsed to
    // one folder onto nothing.
    fireEvent.click(rowChevron("Many folders"));
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(false);

    cleanup();
    await mount(FOLDER_CARDS);

    expect(expandToggle().getAttribute("aria-pressed")).toBe("true");
    expect(isExpanded("/home/cybil/countinghouse.feat-a")).toBe(true);
  });

  it("falls back to the default rather than throwing on a mode it has never heard of", async () => {
    // A store written by a bundle this one predates — or by hand. Rendering a
    // container that does not exist is the outcome the reader exists to avoid.
    localStorage.setItem("claude-code-settings", JSON.stringify({ boardViewMode: "gantt", boardShowPaths: "yes" }));
    await mount();

    expect(layoutToggle("Cards view").getAttribute("aria-pressed")).toBe("true");
    expect(foldersToggle().getAttribute("aria-pressed")).toBe("false");
  });
});
