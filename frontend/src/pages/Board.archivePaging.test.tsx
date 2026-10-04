/**
 * The archived strip pages: the board fetches the newest archived cards a page
 * at a time, while the strip's count reports the whole archive.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary } from "../api";
import { listCards } from "../api";
import { saveBoardClosedExpanded } from "../utils/localStorage";
import Board from "./Board";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  bulkSetCardLifecycle: vi.fn(),
  updateCard: vi.fn(),
}));

let metadataVersion = 0;
vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => metadataVersion }));

vi.mock("../components/board/CardDrawer", () => ({
  default: ({ card }: { card: CardSummary }) => <div data-testid="drawer">{card.title}</div>,
}));

function closedCard(i: number): CardSummary {
  return {
    id: `c${i}`,
    title: `Archived ${i}`,
    description: "",
    emoji: "🗂️",
    lifecycle: "closed",
    closedAt: new Date(Date.UTC(2026, 0, 1) + (1000 - i) * 60_000).toISOString(),
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    chatCount: 0,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const TOTAL = 120;
const archive = Array.from({ length: TOTAL }, (_, i) => closedCard(i));
const mockList = vi.mocked(listCards);

beforeEach(() => {
  saveBoardClosedExpanded(true);
  // Behaves like a daemon that honors closedLimit.
  mockList.mockImplementation(async (_hidden, limit) => ({ cards: archive.slice(0, limit ?? TOTAL), closedTotal: TOTAL, categories: [] }));
});

afterEach(() => {
  cleanup();
  metadataVersion = 0;
  mockList.mockReset();
  localStorage.clear();
});

function mount() {
  render(
    <MemoryRouter>
      <Board />
    </MemoryRouter>,
  );
}

describe("Board archive paging", () => {
  it("asks for one page, renders it, and counts the whole archive", async () => {
    mount();
    expect(await screen.findByText("Archived 49")).toBeTruthy();
    expect(screen.queryByText("Archived 50")).toBeNull();
    expect(mockList).toHaveBeenCalledWith(false, 50);
    expect(screen.getByRole("button", { name: /Archived\s*120/ })).toBeTruthy();
  });

  it("Show more fetches the next page, and the last page offers only what is left", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Show 50 more of 70" }));
    expect(await screen.findByText("Archived 99")).toBeTruthy();
    expect(mockList).toHaveBeenLastCalledWith(false, 100);

    fireEvent.click(screen.getByRole("button", { name: "Show 20 more of 20" }));
    expect(await screen.findByText("Archived 119")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).toBeNull());
  });

  it("Show more costs exactly one request", async () => {
    // Non-zero arms the metadata-refetch effect, which re-runs if loadCards changes identity.
    metadataVersion = 1;
    mount();
    const button = await screen.findByRole("button", { name: "Show 50 more of 70" });
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the mount-time debounced refetch land
    const before = mockList.mock.calls.length;
    fireEvent.click(button);
    expect(await screen.findByText("Archived 99")).toBeTruthy();
    // Past the 300 ms metadata debounce a changed loadCards identity would re-arm.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockList.mock.calls.length - before).toBe(1);
  });

  it("drops a slow response that a newer request has superseded", async () => {
    let releaseFirst!: () => void;
    mockList.mockImplementationOnce(
      (_hidden, limit) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ cards: archive.slice(0, limit), closedTotal: TOTAL, categories: [] });
        }),
    );
    mount();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    // A visibility change is the poll's catch-up tick: a second request at the same limit.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("Archived 49")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more of 70" }));
    expect(await screen.findByText("Archived 99")).toBeTruthy();
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Archived 99")).toBeTruthy();
  });

  it("falls back to the loaded cards when an older daemon sends no closedTotal", async () => {
    mockList.mockResolvedValue({ cards: archive.slice(0, 3) });
    mount();
    expect(await screen.findByRole("button", { name: /Archived\s*3/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).toBeNull();
  });
});
