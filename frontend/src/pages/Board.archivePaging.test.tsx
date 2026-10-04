/**
 * The archived strip pages: the board fetches the newest archived cards a page
 * at a time, while the strip's count reports the whole archive. Once a page is
 * loaded, refetches hold that window by cursor (`closedSince`), so cards
 * archived elsewhere add on top instead of pushing loaded ones off the bottom.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardPatch, CardSummary } from "../api";
import { listCards, updateCard } from "../api";
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

// Stubbed to the two things these tests need from it: which card it is
// showing, and a way to patch that card.
vi.mock("../components/board/CardDrawer", () => ({
  default: ({ card, onPatch }: { card: CardSummary; onPatch: (patch: CardPatch) => Promise<boolean> }) => (
    <div data-testid="drawer">
      {card.title}
      <button onClick={() => onPatch({ lifecycle: "open" })}>drawer-unarchive</button>
    </div>
  ),
}));

const BASE = Date.UTC(2026, 0, 1);

/** Card `i` is archived `i` minutes before card 0: a lower index is newer. */
function closedCard(i: number): CardSummary {
  return {
    id: `c${i}`,
    title: `Archived ${String(i).padStart(3, "0")}`,
    description: "",
    emoji: "🗂️",
    lifecycle: "closed",
    closedAt: new Date(BASE + (1000 - i) * 60_000).toISOString(),
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
/** The daemon's archive. Tests archive and unarchive "elsewhere" by editing it. */
let archive: CardSummary[];
const mockList = vi.mocked(listCards);

/** A daemon that honors closedLimit and closedSince, with the backend's either-admits union. Open cards are never windowed. */
async function daemon(_hidden?: boolean, { closedLimit, closedSince }: { closedLimit?: number; closedSince?: string } = {}) {
  const open = archive.filter((c) => c.lifecycle !== "closed");
  const closed = archive.filter((c) => c.lifecycle === "closed").sort((a, b) => b.closedAt!.localeCompare(a.closedAt!));
  const windowed = closedLimit !== undefined || closedSince !== undefined;
  const kept = closed.filter(
    (c, i) => !windowed || (closedLimit !== undefined && i < closedLimit) || (closedSince !== undefined && Date.parse(c.closedAt!) >= Date.parse(closedSince)),
  );
  return { cards: [...open, ...kept], closedTotal: closed.length, categories: [] };
}

beforeEach(() => {
  saveBoardClosedExpanded(true);
  archive = Array.from({ length: TOTAL }, (_, i) => closedCard(i));
  mockList.mockImplementation(daemon);
});

afterEach(() => {
  cleanup();
  mockList.mockReset();
  vi.mocked(updateCard).mockReset();
  metadataVersion = 0;
  localStorage.clear();
});

function mount() {
  render(
    <MemoryRouter>
      <Board />
    </MemoryRouter>,
  );
}

/** The poll's catch-up tick — the same loadCards a 15 s poll or a metadata event runs. */
function refetch() {
  document.dispatchEvent(new Event("visibilitychange"));
}

const lastWindow = () => mockList.mock.lastCall?.[1];
const header = () => screen.getByRole("button", { name: /^Archived\s*\d+$/ });

describe("Board archive paging", () => {
  it("asks for one page, renders it, and counts the whole archive", async () => {
    mount();
    expect(await screen.findByText("Archived 049")).toBeTruthy();
    expect(screen.queryByText("Archived 050")).toBeNull();
    expect(mockList).toHaveBeenCalledWith(false, { closedLimit: 50, closedSince: undefined });
    expect(header().textContent).toMatch(/120/);
  });

  it("refetches by cursor once a page is loaded, not by count", async () => {
    mount();
    await screen.findByText("Archived 049");
    refetch();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(lastWindow()).toEqual({ closedLimit: undefined, closedSince: closedCard(49).closedAt });
  });

  it("a card archived elsewhere adds on top and keeps the oldest loaded card, and its open drawer", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Archived 049/ }));
    expect(screen.getByTestId("drawer").textContent).toContain("Archived 049");

    archive.push({ ...closedCard(-1), title: "Just archived" });
    refetch();
    expect(await screen.findByText("Just archived")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Archived 049/ })).toBeTruthy();
    expect(screen.getByTestId("drawer").textContent).toContain("Archived 049");
    expect(header().textContent).toMatch(/121/);
  });

  it("unarchiving the oldest loaded card elsewhere moves the cursor to the next one", async () => {
    mount();
    await screen.findByText("Archived 049");
    archive = archive.filter((c) => c.id !== "c49");
    refetch();
    await waitFor(() => expect(screen.queryByText("Archived 049")).toBeNull());
    // The window shrank by that one card; it did not reach for card 50 or beyond.
    expect(screen.getByText("Archived 048")).toBeTruthy();
    expect(screen.queryByText("Archived 050")).toBeNull();

    const calls = mockList.mock.calls.length;
    refetch();
    await waitFor(() => expect(mockList.mock.calls.length).toBe(calls + 1));
    expect(lastWindow()).toEqual({ closedLimit: undefined, closedSince: closedCard(48).closedAt });
  });

  it("a window emptied elsewhere falls back to a fresh first page, not the whole archive", async () => {
    mount();
    await screen.findByText("Archived 049");
    archive = archive.filter((c) => Number(c.id.slice(1)) >= 50);
    refetch();
    await waitFor(() => expect(screen.queryByText("Archived 049")).toBeNull());
    refetch();
    expect(await screen.findByText("Archived 099")).toBeTruthy();
    expect(lastWindow()).toEqual({ closedLimit: 50, closedSince: undefined });
    expect(screen.queryByText("Archived 100")).toBeNull();
  });

  it("Show more fetches the next page, and the last page offers only what is left", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Show 50 more of 70" }));
    expect(await screen.findByText("Archived 099")).toBeTruthy();
    expect(lastWindow()).toEqual({ closedLimit: 100, closedSince: closedCard(49).closedAt });

    fireEvent.click(screen.getByRole("button", { name: "Show 20 more of 20" }));
    expect(await screen.findByText("Archived 119")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).toBeNull());
  });

  it("Show more costs exactly one request", { timeout: 15_000 }, async () => {
    // Non-zero arms the metadata-refetch effect, which re-runs if loadCards
    // changes identity — the double fetch this guards against.
    metadataVersion = 1;
    mount();
    // Mount = the initial fetch + the debounced metadata refetch. Wait for both
    // rather than sleeping, so a slow runner cannot leave one in flight.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    fireEvent.click(await screen.findByRole("button", { name: "Show 50 more of 70" }));
    expect(await screen.findByText("Archived 099")).toBeTruthy();
    // A re-armed debounce (300 ms) is scheduled before this timer, so it fires
    // first however slow the runner: timers run in deadline order.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(mockList).toHaveBeenCalledTimes(3);
  });

  it("drops a slow response that a newer request has superseded", async () => {
    let releaseFirst!: () => void;
    mockList.mockImplementationOnce(
      (hidden, window) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(daemon(hidden, window));
        }),
    );
    mount();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    refetch();
    expect(await screen.findByText("Archived 049")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more of 70" }));
    expect(await screen.findByText("Archived 099")).toBeTruthy();
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Archived 099")).toBeTruthy();
  });

  it("unarchiving a loaded card moves the count with it, before the next fetch", async () => {
    vi.mocked(updateCard).mockImplementation(async (id) => ({ card: { ...archive.find((c) => c.id === id)!, lifecycle: "open" } }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Archived 049/ }));
    const fetches = mockList.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "drawer-unarchive" }));
    await waitFor(() => expect(header().textContent).toMatch(/119/));
    expect(mockList.mock.calls.length).toBe(fetches);
  });

  it("a refetch that overtakes a slow Show more carries its page instead of discarding it", async () => {
    mount();
    await screen.findByText("Archived 049");
    let releaseShowMore!: () => void;
    mockList.mockImplementationOnce(
      (hidden, window) =>
        new Promise((resolve) => {
          releaseShowMore = () => resolve(daemon(hidden, window));
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more of 70" }));
    await waitFor(() => expect(lastWindow()).toEqual({ closedLimit: 100, closedSince: closedCard(49).closedAt }));
    // The poll takes a newer sequence number, so only it may land — and it
    // must ask for the click's page too.
    refetch();
    await waitFor(() => expect(mockList.mock.calls.at(-1)?.[1]).toEqual({ closedLimit: 100, closedSince: closedCard(49).closedAt }));
    expect(await screen.findByText("Archived 099")).toBeTruthy();
    releaseShowMore();
    expect(await screen.findByRole("button", { name: "Show 20 more of 20" })).toBeTruthy();
    // Landed, so the next poll is back to the cursor alone.
    refetch();
    await waitFor(() => expect(lastWindow()).toEqual({ closedLimit: undefined, closedSince: closedCard(99).closedAt }));
  });

  it("picks the cursor by time and skips a key that does not parse", async () => {
    archive = [closedCard(0), closedCard(1), { ...closedCard(2), closedAt: "0000-legacy" /* sorts first as a string */ }];
    mockList.mockResolvedValue({ cards: archive, closedTotal: 3, categories: [] });
    mount();
    await screen.findByText("Archived 001");
    refetch();
    await waitFor(() => expect(lastWindow()).toEqual({ closedLimit: undefined, closedSince: closedCard(1).closedAt }));
  });

  it("with no parseable key, refetches a fresh first page", async () => {
    archive = [{ ...closedCard(0), closedAt: "legacy" }];
    mockList.mockResolvedValue({ cards: archive, closedTotal: 1, categories: [] });
    mount();
    await screen.findByText("Archived 000");
    refetch();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(lastWindow()).toEqual({ closedLimit: 50, closedSince: undefined });
  });

  it("an unarchive a mid-request refetch already counted is not counted again", async () => {
    let releasePatch!: () => void;
    vi.mocked(updateCard).mockImplementation(
      (id) =>
        new Promise((resolve) => {
          releasePatch = () => resolve({ card: { ...closedCard(Number(id.slice(1))), lifecycle: "open" } });
        }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Archived 049/ }));
    fireEvent.click(screen.getByRole("button", { name: "drawer-unarchive" }));
    // The server applies it and a refetch lands before the PATCH resolves:
    // c49 comes back as an open card, already out of the archive count.
    archive = archive.map((c) => (c.id === "c49" ? { ...c, lifecycle: "open" } : c));
    refetch();
    await waitFor(() => expect(header().textContent).toMatch(/119/));
    expect(screen.getByTestId("drawer").textContent).toContain("Archived 049");
    releasePatch();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(header().textContent).toMatch(/119/);
  });

  it("falls back to the loaded cards when an older daemon sends no closedTotal", async () => {
    mockList.mockResolvedValue({ cards: archive.slice(0, 3) });
    mount();
    expect(await screen.findByRole("button", { name: /^Archived\s*3$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).toBeNull();
  });
});
