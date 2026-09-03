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
  default: ({ card }: { card: CardSummary }) => <div data-testid="drawer">{card.title}</div>,
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

/** A card's main surface, by title — a tile in one mode, a row in the other. */
function face(title: string) {
  return screen.getByRole("button", { name: new RegExp(title) });
}

function selectedTitles() {
  return screen
    .getAllByRole("checkbox")
    .filter((box) => box.getAttribute("aria-checked") === "true")
    .map((box) => box.getAttribute("aria-label")?.replace("Select ", ""));
}

/** The width-capped page body — the header's grandparent. */
const page = () => screen.getByRole("heading", { level: 1 }).parentElement!.parentElement as HTMLElement;

const layoutRadio = (name: "Cards view" | "List view") => screen.getByRole("radio", { name });
const foldersToggle = () => screen.getByRole("button", { name: "Show folders" });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(cleanup);

describe("the layout control", () => {
  it("starts on cards, which is the board that already existed", async () => {
    await mount();
    expect(layoutRadio("Cards view").getAttribute("aria-checked")).toBe("true");
    expect(layoutRadio("List view").getAttribute("aria-checked")).toBe("false");
  });

  it("moves aria-checked with the mode, and actually swaps the face", async () => {
    await mount();
    // A tile stacks its lines; a row lays them out on the shared column
    // template. Asserted so the rest of this file cannot pass against a mode
    // that flipped a flag and rendered tiles anyway.
    expect(face("Alpha one").style.display).toBe("flex");

    fireEvent.click(layoutRadio("List view"));
    expect(layoutRadio("List view").getAttribute("aria-checked")).toBe("true");
    expect(layoutRadio("Cards view").getAttribute("aria-checked")).toBe("false");
    expect(face("Alpha one").style.display).toBe("grid");
  });

  it("widens the page for a list, which has a column the grid does not", async () => {
    await mount();
    expect(page().style.maxWidth).toBe("1100px");

    fireEvent.click(layoutRadio("List view"));
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

    fireEvent.click(layoutRadio("List view"));
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
    fireEvent.click(layoutRadio("List view"));
    fireEvent.click(face("Alpha one"), { metaKey: true });
    fireEvent.click(face("Beta one"), { shiftKey: true });
    expect(selectedTitles()).toEqual(asCards);
  });

  it("still opens the drawer on a plain click", async () => {
    await mount();
    fireEvent.click(layoutRadio("List view"));
    fireEvent.click(face("Alpha two"));

    expect(screen.getByTestId("drawer").textContent).toBe("Alpha two");
  });
});

describe("the folder summary in list mode", () => {
  it("shows one path and no +N for a card that lives in one folder", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(layoutRadio("List view"));
    fireEvent.click(foldersToggle());

    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
    // The 97% case: a "+0" here would be noise on 794 of 818 cards.
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("counts the other folders on a card that fanned out", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(layoutRadio("List view"));
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
    fireEvent.click(layoutRadio("List view"));
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();

    fireEvent.click(foldersToggle());
    expect(screen.queryByTitle("/home/cybil/callboard")).toBeNull();
  });
});

describe("persistence", () => {
  it("restores both preferences on a remount", async () => {
    await mount(FOLDER_CARDS);
    fireEvent.click(layoutRadio("List view"));
    fireEvent.click(foldersToggle());

    cleanup();
    await mount(FOLDER_CARDS);

    expect(layoutRadio("List view").getAttribute("aria-checked")).toBe("true");
    expect(foldersToggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle("/home/cybil/countinghouse")).toBeDefined();
  });

  it("falls back to the default rather than throwing on a mode it has never heard of", async () => {
    // A store written by a bundle this one predates — or by hand. Rendering a
    // container that does not exist is the outcome the reader exists to avoid.
    localStorage.setItem("claude-code-settings", JSON.stringify({ boardViewMode: "gantt", boardShowPaths: "yes" }));
    await mount();

    expect(layoutRadio("Cards view").getAttribute("aria-checked")).toBe("true");
    expect(foldersToggle().getAttribute("aria-pressed")).toBe("false");
  });
});
