// @vitest-environment jsdom
/**
 * "Show archived", end to end through the page: the toggle's only job is to
 * decide the `cardLifecycle` scope the sidebar asks the server for, so what is
 * pinned here is that mapping and nothing else.
 *
 * Worth testing from the page rather than the pure function alone, because the
 * mapping has to survive three separate paths that each construct their own
 * request — the initial load, the "Load next page" pagination, and the refetch
 * triggered by applying the filters modal. It is also the whole reason the list
 * needs no sections: with the toggle off the server never sends a chat the dim
 * would fade, so there is nothing left to separate out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
}));

vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({
    activeSessions: new Map(),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
  }),
}));

// Both fetch on mount; neither is what these tests are about.
vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

const mockListChats = vi.mocked(listChats);

const FOLDER = "/home/cybil/projects/callboard";
const KEY = "claude-code-settings";

function makeChat(id: string, meta: Record<string, unknown> = {}): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    session_log_path: null,
    metadata: JSON.stringify(meta),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
  } as Chat;
}

function listResponse(chats: Chat[], hasMore = false): ChatListResponse {
  return { chats, hasMore, total: chats.length, windowRows: chats.length, stale: false };
}

/** The `cardLifecycle` argument of `listChats`, which is its last one. */
const scopeOf = (call: Parameters<typeof listChats>[]) => call.map((args) => args[7]);

async function renderList() {
  const view = render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText("open chat");
  return view;
}

/** Open the filters modal and flip the switch, without applying. */
function toggleShowArchived() {
  fireEvent.click(screen.getByTitle(/^Filters and view/));
  fireEvent.click(screen.getByText("Show archived"));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { preview: "open chat" })]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("Show archived → cardLifecycle", () => {
  it("asks for open-card trees by default", async () => {
    await renderList();
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["active"]);
  });

  it("asks for everything once the toggle is applied", async () => {
    await renderList();

    toggleShowArchived();
    // Staged only — the list has not refetched yet.
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["active"]);

    fireEvent.click(screen.getByText("Apply"));
    // "all", not "inactive": the archived rows join the open ones in place
    // rather than replacing them.
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "all"]));
  });

  it("carries the scope into pagination, so page 2 is not a different list", async () => {
    mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { preview: "open chat" })], true));
    await renderList();

    toggleShowArchived();
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText("Load next page"));
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "all", "all"]));
  });

  it("persists the choice and reloads with it", async () => {
    await renderList();
    toggleShowArchived();
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).chatsShowArchived).toBe(true));

    // A fresh mount, as a page reload would be.
    cleanup();
    mockListChats.mockClear();
    await renderList();
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["all"]);
  });

  it("seeds itself from the three-way scope it replaced", async () => {
    // A user who was on the old "All" scope was seeing archived chats; the new
    // default would silently take them away.
    localStorage.setItem(KEY, JSON.stringify({ chatsCardLifecycle: "all" }));
    await renderList();
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["all"]);
  });
});

describe("the empty sidebar", () => {
  it("names the hidden archived chats, since that is now the likeliest reason", async () => {
    mockListChats.mockResolvedValue(listResponse([]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    // Not "No chats yet": a folder whose cards are all archived now shows
    // nothing at all, where before it showed a list of faded rows.
    expect(await screen.findByText(/Show archived/)).toBeTruthy();
  });

  it("falls back to the plain message once archived chats are shown", async () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    mockListChats.mockResolvedValue(listResponse([]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    // Showing archived chats only ever ADDS rows, so an empty list here is not
    // the view options' doing and must not be blamed on them.
    expect(await screen.findByText("No chats yet. Create one to get started.")).toBeTruthy();
  });
});
