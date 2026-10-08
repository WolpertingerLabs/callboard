// @vitest-environment jsdom
/**
 * The sidebar under a space: every list request carries the active space, a
 * search can widen to every space, the "All" view chips each row with its
 * space, and the switcher counts blocked cards in OTHER spaces so separation
 * never hides a chat that needs you.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary, Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, searchChatContents, moveToSpace } from "../api";
import type { SpaceListItem } from "shared/types/space.js";
import { SpaceContext, type SpaceContextValue } from "../contexts/SpaceContext";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  searchChatContents: vi.fn(),
  moveToSpace: vi.fn(),
}));
vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({ activeSessions: new Map(), connected: true, metadataVersion: 0, summonedChatIds: new Set<string>() }),
}));
vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

const space = (id: string, name: string, extra: Partial<SpaceListItem> = {}): SpaceListItem => ({
  id,
  name,
  order: 0,
  chatCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});
const SPACES = [space("default", "General"), space("sp_work", "Work", { emoji: "💼", color: "blue" })];

function makeChat(id: string, spaceId: string): Chat {
  return {
    id,
    folder: "/repo",
    displayFolder: "/repo",
    session_id: `s-${id}`,
    session_log_path: null,
    metadata: JSON.stringify({ title: id }),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
    spaceId,
  } as Chat;
}
const listResponse = (chats: Chat[]): ChatListResponse => ({ chats, hasMore: false, total: chats.length, windowRows: chats.length, stale: false });

function blockedCard(id: string, spaceId: string): CardSummary {
  return {
    id,
    spaceId,
    title: id,
    description: "",
    emoji: "🗂",
    lifecycle: "open",
    pinned: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    rollup: "needs_you",
    lastActivityAt: "2026-01-01T00:00:00Z",
    chatCount: 1,
    unread: false,
    memberChats: [],
    memberRuns: [],
  };
}

function renderWith(value: Partial<SpaceContextValue>) {
  const ctx: SpaceContextValue = {
    enabled: true,
    spaces: SPACES,
    activeSpaceId: "sp_work",
    activeSpace: SPACES[1],
    setActiveSpace: vi.fn(),
    refreshSpaces: async () => {},
    spaceById: (id) => SPACES.find((s) => s.id === id),
    notice: null,
    dismissNotice: () => {},
    ...value,
  };
  render(
    <MemoryRouter>
      <SpaceContext.Provider value={ctx}>
        <ChatList onRefresh={() => {}} />
      </SpaceContext.Provider>
    </MemoryRouter>,
  );
  return ctx;
}

/** `space` is listChats' last argument. */
const spacesRequested = () => vi.mocked(listChats).mock.calls.map((args) => args[9]);

beforeEach(() => {
  vi.mocked(listChats).mockResolvedValue(listResponse([makeChat("work chat", "sp_work")]));
  vi.mocked(listCards).mockResolvedValue({ cards: [blockedCard("blocked-general", "default"), blockedCard("blocked-work", "sp_work")] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  vi.mocked(searchChatContents).mockResolvedValue({ chatIds: ["work chat"] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatList in a space", () => {
  it("scopes every list request to the active space", async () => {
    renderWith({});
    await screen.findByText("work chat");
    expect(spacesRequested().every((s) => s === "sp_work")).toBe(true);
  });

  it("sends no space at all without a space provider (older daemons)", async () => {
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("work chat");
    expect(spacesRequested().every((s) => s === undefined)).toBe(true);
    expect(screen.queryByTestId("space-switcher")).toBeNull();
  });

  it("counts blocked cards in other spaces on the switcher, not the active one's", async () => {
    renderWith({});
    await screen.findByText("work chat");
    await waitFor(() => expect(screen.getByLabelText("1 card in other spaces need you")).toBeTruthy());
  });

  it("widens a search to every space when asked", async () => {
    renderWith({});
    await screen.findByText("work chat");
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "deploy" } });
    fireEvent.click(screen.getByLabelText("Search all spaces"));
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: "Enter" });
    await waitFor(() => expect(spacesRequested()).toContain("all"));
  });

  it("chips each row with its space in the All view", async () => {
    vi.mocked(listChats).mockResolvedValue(listResponse([makeChat("work chat", "sp_work"), makeChat("general chat", "default")]));
    renderWith({ activeSpaceId: "all", activeSpace: undefined });
    await screen.findByText("work chat");
    const chips = screen.getAllByTestId("space-chip").map((c) => c.textContent);
    expect(chips).toEqual(expect.arrayContaining(["💼 Work", "General"]));
  });

  it("offers Move to space… on a row and moves the tree", async () => {
    vi.mocked(moveToSpace).mockResolvedValue({ movedRoots: ["work chat"], chatCount: 1, failed: [] });
    renderWith({});
    const title = await screen.findByText("work chat");
    // The kebab shows on hover; hover the row the title sits in.
    let row: HTMLElement | null = title;
    while (row && !screen.queryByTitle("Chat actions")) {
      fireEvent.mouseEnter(row);
      row = row.parentElement;
    }
    fireEvent.click(screen.getByTitle("Chat actions"));
    fireEvent.click(await screen.findByText("Move to space…"));
    fireEvent.click(await screen.findByRole("button", { name: /General/ }));
    await waitFor(() => expect(moveToSpace).toHaveBeenCalledWith("default", { chatIds: ["work chat"] }));
  });
});
