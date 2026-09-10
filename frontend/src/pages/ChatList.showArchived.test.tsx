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
import type { CardSummary, Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, searchChatContents } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  searchChatContents: vi.fn(),
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
const mockSearch = vi.mocked(searchChatContents);

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

  it("carries the scope into the stale-response refetch", async () => {
    // A cached response triggers an immediate second request for fresh data.
    // It builds its own argument list, so it is a third place the scope can be
    // dropped — and the one no other test covers, since every other fixture
    // here answers stale:false.
    mockListChats.mockResolvedValueOnce({ ...listResponse([makeChat("chat-1", { preview: "open chat" })]), stale: true });
    await renderList();
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "active"]);
    // The refetch is the fresh-data one, not a repeat of the cached request.
    expect(mockListChats.mock.calls[1][4]).toBe(false);
  });

  it("seeds itself from the three-way scope it replaced", async () => {
    // A user who was on the old "All" scope was seeing archived chats; the new
    // default would silently take them away.
    localStorage.setItem(KEY, JSON.stringify({ chatsCardLifecycle: "all" }));
    await renderList();
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["all"]);
  });
});

/**
 * Content search against a narrowed browse scope.
 *
 * Search is a server-side query over full history whose hits are applied as an
 * INTERSECTION against the loaded list. With the list scoped to open cards
 * that intersection does not narrow the results, it DELETES them — silently,
 * since a partial loss shows no empty state and no count. On the data dir this
 * was measured against, 4 of 133 rows are on open cards, so the default scope
 * would have thrown away most of every search.
 */
describe("content search widens the scope", () => {
  const OPEN = makeChat("chat-1", { preview: "open chat" });
  const ARCHIVED = makeChat("chat-2", { preview: "archived chat" });

  const card = (id: string, lifecycle: "open" | "closed"): CardSummary =>
    ({ id, lifecycle, memberChats: [{ chatId: id }], memberRuns: [], chatCount: 1 }) as unknown as CardSummary;

  beforeEach(() => {
    // The server, as far as this test is concerned: `active` withholds the
    // archived chat, `all` returns both.
    mockListChats.mockImplementation((...args: Parameters<typeof listChats>) =>
      Promise.resolve(listResponse(args[7] === "active" ? [OPEN] : [OPEN, ARCHIVED])),
    );
    // Both chats match the query — the question is which ones survive the scope.
    mockSearch.mockResolvedValue({ chatIds: ["chat-1", "chat-2"] } as Awaited<ReturnType<typeof searchChatContents>>);
    vi.mocked(listCards).mockResolvedValue({ cards: [card("chat-1", "open"), card("chat-2", "closed")] });
  });

  const submitSearch = (query: string) => {
    const input = screen.getByPlaceholderText(/Search chat contents/);
    fireEvent.change(input, { target: { value: query } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  /**
   * Asserted on the LAST scope rather than the whole sequence: a search
   * refetches twice by design — once when the query is submitted (this
   * widening) and once when its hits land and `anyFilterActive` flips — and
   * pinning the exact call count would break on a change to either.
   */
  const lastScope = () => scopeOf(mockListChats.mock.calls).at(-1);

  it("asks for everything while a search is active, with the toggle still off", async () => {
    await renderList();
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["active"]);

    submitSearch("deploy script");
    await waitFor(() => expect(lastScope()).toBe("all"));
    // The browse preference is untouched — only this request was widened.
    expect(JSON.parse(localStorage.getItem(KEY) || "{}").chatsShowArchived).toBeUndefined();
  });

  it("returns the archived hit, dimmed, rather than dropping it", async () => {
    await renderList();
    expect(screen.queryByText("archived chat")).toBeNull();

    submitSearch("deploy script");
    const hit = await screen.findByText("archived chat");
    // Present AND faded: the dim is what tells the user this result is on
    // archived work, which is why widening the scope does not lose the
    // distinction the toggle was drawing.
    await waitFor(() => expect(hit.closest(".chatlist-item-dimmed")).toBeTruthy());
    expect(screen.getByText("open chat").closest(".chatlist-item-dimmed")).toBeNull();
  });

  it("narrows back to open cards when the search is cleared", async () => {
    await renderList();
    submitSearch("deploy script");
    await waitFor(() => expect(lastScope()).toBe("all"));

    submitSearch("");
    await waitFor(() => expect(lastScope()).toBe("active"));
    // Not merely the scope: the archived row is gone from the list again, so
    // the widening really was scoped to the search and not left latched on.
    await waitFor(() => expect(screen.queryByText("archived chat")).toBeNull());
  });

  it("keeps the widening when the toggle is on, rather than fighting it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    await renderList();
    submitSearch("deploy script");
    await waitFor(() => expect(screen.getByText("archived chat")).toBeTruthy());
    expect(scopeOf(mockListChats.mock.calls).every((s) => s === "all")).toBe(true);
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
    // nothing at all, where before it showed a list of faded rows. Matched on
    // the sentence, not on "Show archived" alone — that string is also the
    // filter modal's switch label, so the loose match would pass on a page
    // that never rendered an empty state.
    expect(await screen.findByText(/^No chats on an open card\./)).toBeTruthy();
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
