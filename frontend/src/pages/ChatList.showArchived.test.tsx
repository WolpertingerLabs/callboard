// @vitest-environment jsdom
/**
 * "Show archived", end to end through the page: the toggle's only job is to
 * decide the `cardLifecycle` scope the sidebar asks the server for, so what is
 * pinned here is that mapping and nothing else.
 *
 * Worth testing from the page rather than the pure function alone, because the
 * mapping has to survive four separate paths that each construct their own
 * request — the initial load, the stale-response refetch, the "Load next page"
 * pagination, and the refetch triggered by the filter bar's toggle. It is
 * also the reason the list needs no sections: while the user is BROWSING with
 * the toggle off the server sends no chat the dim would fade, so there is
 * nothing to separate out. Searching is the deliberate exception, and the
 * suite below pins it: a query widens the scope and the archived hits come
 * back faded.
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

/**
 * Click the filter bar's "Archived" toggle. One click, no modal and no Apply —
 * the button commits straight from the click, which is why every test below
 * goes from here to asserting on the request.
 */
function toggleShowArchived() {
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
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

  it("asks for everything on one click of the toggle", async () => {
    await renderList();

    toggleShowArchived();
    // "all", not "inactive": the archived rows join the open ones in place
    // rather than replacing them. And it arrives without an Apply — the whole
    // point of promoting this out of the modal.
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "all"]));
  });

  it("narrows back to open cards on a second click", async () => {
    await renderList();

    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "all"]));

    // The button reads the committed state back off `viewOptions`, so it
    // flips rather than latching on.
    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "all", "active"]));
  });

  it("carries the scope into pagination, so page 2 is not a different list", async () => {
    mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { preview: "open chat" })], true));
    await renderList();

    toggleShowArchived();
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText("Load next page"));
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["active", "all", "all"]));
  });

  it("persists the choice and reloads with it", async () => {
    await renderList();
    toggleShowArchived();
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

  /**
   * The case that actually pins `searching` as a dependency of `load`.
   *
   * Every other test here survives the dependency being deleted: their hits
   * land while `anyFilterActive` flips null → Set, which recreates the
   * callback anyway and picks `searching` out of that render's closure one
   * request later. With an advanced filter already on, `anyFilterActive` goes
   * true → true, nothing else changes, and a missing dependency means the list
   * is never refetched at all — the search runs against the open-card scope
   * and silently drops every archived hit, which is the entire bug this
   * widening exists to prevent.
   *
   * `react-hooks/exhaustive-deps` is a warning in this repo, among a thousand
   * others, so it is not the thing standing guard here. This is.
   */
  it("widens the scope even when an advanced filter is already active", async () => {
    await renderList();

    // A directory filter that matches both fixtures, so it narrows nothing
    // client-side and only its effect on `anyFilterActive` is under test.
    fireEvent.click(screen.getByTitle(/^Filters and view/));
    const regex = screen.getByPlaceholderText("e.g. my-project|other-repo");
    fireEvent.change(regex, { target: { value: "callboard" } });
    fireEvent.click(regex.parentElement!.querySelector("button")!);
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(lastScope()).toBe("active"));

    submitSearch("deploy script");
    await waitFor(() => expect(lastScope()).toBe("all"));
    expect(await screen.findByText("archived chat")).toBeTruthy();
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
    // the sentence, not on "Archived" alone — that string is also the filter
    // bar's toggle label, which this page always renders, so the loose match
    // would pass on a page that never showed an empty state.
    expect(await screen.findByText(/^No chats on an open card\./)).toBeTruthy();
  });

  /**
   * The window between submitting a query and its hits landing. `searching` is
   * already true (so the archived-hidden message is correctly suppressed) but
   * `matchingChatIds` is still null, so `isFiltered` is still false — and
   * without a guard the message falls through to the branch that tells a user
   * with thousands of chats they have none.
   */
  it("claims nothing at all while a search is in flight", async () => {
    // Both halves of a submitted search are held open, because the window
    // under test is the one where NEITHER has landed: the widened list request
    // is still out (so the rendered list is the old, empty, open-card one) and
    // the hits are still out (so `matchingChatIds` is null and `isFiltered` is
    // false). Without a guard the message falls through to the branch that
    // tells a user with thousands of chats that they have none.
    let releaseList: () => void = () => {};
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    mockListChats.mockImplementation(async (...args: Parameters<typeof listChats>) => {
      if (args[7] !== "active") await listGate;
      return listResponse(args[7] === "active" ? [] : [makeChat("chat-2", { preview: "archived chat" })]);
    });
    let land: (value: { chatIds: string[] }) => void = () => {};
    mockSearch.mockReturnValue(
      new Promise<{ chatIds: string[] }>((resolve) => {
        land = resolve;
      }) as ReturnType<typeof searchChatContents>,
    );

    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText(/^No chats on an open card\./);

    const input = screen.getByPlaceholderText(/Search chat contents/);
    fireEvent.change(input, { target: { value: "deploy script" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The archived-hidden message correctly goes: the scope has widened past it.
    await waitFor(() => expect(screen.queryByText(/^No chats on an open card/)).toBeNull());
    // And nothing replaces it. Not this message, not any message.
    expect(screen.queryByText(/No chats yet/)).toBeNull();
    expect(screen.queryByText(/No chats match/)).toBeNull();

    releaseList();
    land({ chatIds: ["chat-2"] });
    expect(await screen.findByText("archived chat")).toBeTruthy();
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
