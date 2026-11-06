/**
 * The Branches layout on the Board: a third mode beside Cards and List that
 * persists like them, hides the header controls that only mean something for
 * card faces, and can never be in selection mode.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary } from "../api";
import { getGitOverview, listCards } from "../api";
import Board from "./Board";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  bulkSetCardLifecycle: vi.fn(),
  updateCard: vi.fn(),
  getGitOverview: vi.fn(),
}));

vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => 0 }));

vi.mock("../components/board/CardDrawer", () => ({
  default: ({ card }: { card: CardSummary }) => <div data-testid="drawer">{card.title}</div>,
}));

function card(id: string, title: string): CardSummary {
  return {
    id,
    title,
    description: "",
    emoji: "🗂️",
    lifecycle: "open",
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-11-06T01:00:00.000Z",
    chatCount: 1,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

const CARDS = [card("c1", "PR tracking"), card("c2", "Other work")];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.mocked(listCards).mockResolvedValue({ cards: CARDS });
  vi.mocked(getGitOverview).mockResolvedValue({
    generatedAt: new Date().toISOString(),
    repos: [{ repoPath: "/src/app", name: "app", rows: [{ cwd: "/src/app", branch: "main", isMain: true, cardIds: ["c1"] }] }],
  });
});
afterEach(cleanup);

async function mount() {
  render(
    <MemoryRouter>
      <Board />
    </MemoryRouter>,
  );
  await screen.findAllByRole("heading", { level: 2 });
}

const toggle = (name: string) => screen.getByRole("button", { name });

describe("the Branches layout", () => {
  it("is offered beside Cards and List", async () => {
    await mount();
    expect(toggle("Branches view").getAttribute("aria-pressed")).toBe("false");
    expect(getGitOverview).not.toHaveBeenCalled();
  });

  it("shows worktrees instead of card sections, and opens the drawer from a chip", async () => {
    await mount();
    fireEvent.click(toggle("Branches view"));
    expect(toggle("Branches view").getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("heading", { level: 2, name: "app" })).toBeDefined();
    expect(screen.queryByText("Idle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "PR tracking" }));
    expect(screen.getByTestId("drawer").textContent).toBe("PR tracking");
  });

  it("hides the Folders and Expand toggles, which control nothing there", async () => {
    await mount();
    fireEvent.click(toggle("List view"));
    fireEvent.click(toggle("Show folders"));
    expect(screen.queryByRole("button", { name: "Expand rows" })).not.toBeNull();

    fireEvent.click(toggle("Branches view"));
    expect(screen.queryByRole("button", { name: "Show folders" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand rows" })).toBeNull();
  });

  it("persists across a remount", async () => {
    await mount();
    fireEvent.click(toggle("Branches view"));
    cleanup();
    await mount();
    expect(toggle("Branches view").getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("heading", { level: 2, name: "app" })).toBeDefined();
  });

  it("leaves selection mode on the way in, and offers no way back into it", async () => {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: /PR tracking/ })[0], { metaKey: true });
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeNull();

    fireEvent.click(toggle("Branches view"));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    // Back on the cards, the old selection is gone rather than resurrected.
    fireEvent.click(toggle("Cards view"));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
