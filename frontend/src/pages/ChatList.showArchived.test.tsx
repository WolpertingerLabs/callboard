// @vitest-environment jsdom
/**
 * "Show archived", end to end through the page: the toggle's only job is to
 * decide the `cardLifecycle` scope the sidebar asks the server for, and that
 * mapping is most of what is pinned here.
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
 *
 * It has since grown one neighbour it did not start with. All three of the bar's
 * scope toggles commit through the same `handleApplyFilters`, so persistence is
 * now a property of that one function rather than of this one toggle, and the
 * other two are pinned here for want of a better home — including the fact that
 * `bookmarked` persists nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 * Click the filter bar's archived toggle. One click, no modal and no Apply —
 * the button commits straight from the click, which is why every test below
 * goes from here to asserting on the request.
 *
 * By role and accessible name, not by text: the button is icon-only, so its
 * name comes from `aria-label` and there is no text node to match.
 */
function toggleShowArchived() {
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
}

/**
 * Open the kebab menu on the row whose preview reads `text`.
 *
 * The row root is located by its inline `border-bottom` rather than by a class:
 * `ChatListItem` sets a className only when the row is FADED, so keying on one
 * would find the dimmed row and miss the undimmed control it is being compared
 * against. The kebab button only exists while the row is hovered, which is why
 * the mouseEnter has to land on the root and not on the text node.
 */
function openRowMenu(text: string) {
  const row = screen.getByText(text).closest('div[style*="border-bottom"]')!;
  fireEvent.mouseEnter(row);
  fireEvent.click(row.querySelector('[title="Chat actions"]')!);
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
  it("asks for the unarchived scope by default", async () => {
    await renderList();
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived"]);
  });

  it("asks for everything on one click of the toggle", async () => {
    await renderList();

    toggleShowArchived();
    // "all", not "inactive": the archived rows join the open ones in place
    // rather than replacing them. And it arrives without an Apply — the whole
    // point of promoting this out of the modal.
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all"]));
  });

  it("narrows back to unarchived on a second click", async () => {
    await renderList();

    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all"]));

    // The button reads the committed state back off `viewOptions`, so it
    // flips rather than latching on.
    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all", "unarchived"]));
  });

  it("carries the scope into pagination, so page 2 is not a different list", async () => {
    mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { preview: "open chat" })], true));
    await renderList();

    toggleShowArchived();
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText("Load next page"));
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all", "all"]));
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
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "unarchived"]);
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
 * What each bar toggle persists, which is not the same answer for all three.
 *
 * All three now commit through `handleApplyFilters`, so persistence moved out of
 * the modal along with the controls — and that function writes exactly two keys.
 * Two of the toggles are remembered across reloads and one is deliberately not,
 * and the asymmetry is easy to miss now that the three sit side by side looking
 * identical.
 */
describe("what the toggles persist", () => {
  const stored = () => JSON.parse(localStorage.getItem(KEY) || "{}");

  it("remembers the Triggered toggle, and seeds the next mount from it", async () => {
    await renderList();
    expect(stored().showTriggeredChats).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Triggered" }));
    await waitFor(() => expect(stored().showTriggeredChats).toBe(true));

    // A fresh mount, as a page reload would be: the button comes back pressed
    // rather than merely the key being on disk.
    cleanup();
    await renderList();
    expect(screen.getByRole("button", { name: "Triggered" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("un-remembers it on the way back, rather than latching on", async () => {
    localStorage.setItem(KEY, JSON.stringify({ showTriggeredChats: true }));
    await renderList();

    fireEvent.click(screen.getByRole("button", { name: "Triggered" }));
    await waitFor(() => expect(stored().showTriggeredChats).toBe(false));
  });

  /**
   * Bookmarked is SESSION-ONLY, on purpose, and this pins the absence.
   *
   * It is the one scope that can empty the sidebar on its own (see the
   * `isFiltered` note in ChatList), so a persisted one greets a user with a
   * blank list on the next load and no memory of having asked for it. "Let's
   * persist all three for consistency" is the obvious tidy-up now that they are
   * three identical-looking buttons in a row, and it should have to argue with
   * a red test rather than sail through.
   */
  it("does not remember the Bookmarked toggle, in storage or across a mount", async () => {
    await renderList();

    fireEvent.click(screen.getByRole("button", { name: "Bookmarked" }));
    // Waited on a key that IS written by the same commit path, so this is not
    // just asserting before anything had a chance to be saved.
    await waitFor(() => expect(stored().chatsShowArchived).toBe(false));
    expect(Object.keys(stored())).not.toContain("bookmarked");
    expect(JSON.stringify(stored())).not.toMatch(/bookmark/i);

    cleanup();
    await renderList();
    expect(screen.getByRole("button", { name: "Bookmarked" }).getAttribute("aria-pressed")).toBe("false");
  });
});

/**
 * Two refreshes in flight at once.
 *
 * `load` wrote `setChats(response.chats)` unconditionally, so the last response
 * to LAND won rather than the last one REQUESTED. `loadGenRef` guarded
 * `loadMore` against `load`, and nothing guarded `load` against `load`.
 *
 * The old route to this control was open modal → switch → Apply → reopen →
 * switch → Apply, which made a double-toggle essentially impossible. One click
 * is now the whole gesture, so a double-click is the obvious way in — and it
 * is the bad direction: the two requests differ in scope, and `all` resolves
 * strictly more card trees server-side, so it is the likelier one to come back
 * late. The list would be left holding archived rows while the toggle that
 * fetched them read "off", until some unrelated refetch corrected it.
 */
describe("two refreshes in flight", () => {
  const OPEN = makeChat("chat-1", { preview: "open chat" });
  const ARCHIVED = makeChat("chat-2", { preview: "archived chat" });

  it("lets the last request REQUESTED win, not the last one to land", async () => {
    let releaseAll: () => void = () => {};
    const allGate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    // The widened request is the slow one. That is the ordering that inverts
    // the result, and it is also the realistic one.
    mockListChats.mockImplementation(async (...args: Parameters<typeof listChats>) => {
      if (args[7] === "all") {
        await allGate;
        return listResponse([OPEN, ARCHIVED]);
      }
      return listResponse([OPEN]);
    });

    await renderList();

    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all"]));
    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all", "unarchived"]));

    // Both clicks are committed and the scope is back to unarchived.
    const button = () => screen.getByRole("button", { name: "Archived" });
    expect(button().getAttribute("aria-pressed")).toBe("false");

    releaseAll();
    // Flush the superseded responses: if they were going to be written, this
    // is when it would happen.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The toggle is off, so the archived row those responses carried has no
    // business in the list — and the button must not be left contradicting it.
    expect(screen.queryByText("archived chat")).toBeNull();
    expect(screen.getByText("open chat")).toBeTruthy();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().getAttribute("title")).toMatch(/hidden/);
  });

  /**
   * The same guard from the other side: the in-flight response is the one that
   * should win, and it still has to be allowed to.
   */
  it("still writes a slow response when nothing supersedes it", async () => {
    let releaseAll: () => void = () => {};
    const allGate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    mockListChats.mockImplementation(async (...args: Parameters<typeof listChats>) => {
      if (args[7] === "all") {
        await allGate;
        return listResponse([OPEN, ARCHIVED]);
      }
      return listResponse([OPEN]);
    });

    await renderList();
    toggleShowArchived();
    await waitFor(() => expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived", "all"]));

    releaseAll();
    expect(await screen.findByText("archived chat")).toBeTruthy();
  });
});

/**
 * Content search against a narrowed browse scope.
 *
 * Search is a server-side query over full history whose hits are applied as an
 * INTERSECTION against the loaded list. With the list scoped at all, that
 * intersection does not narrow the results, it DELETES them — silently, since
 * a partial loss shows no empty state and no count. On the data dir this was
 * measured against, 4 of 133 rows were on open cards (the scope the default was
 * then), so it would have thrown away most of every search. `unarchived` is a
 * much wider default and the argument is unchanged: it still withholds every
 * archived tree, and archived work is exactly what an old search is for.
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
      Promise.resolve(listResponse(args[7] === "unarchived" ? [OPEN] : [OPEN, ARCHIVED])),
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
    expect(scopeOf(mockListChats.mock.calls)).toEqual(["unarchived"]);

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

  it("narrows back to unarchived when the search is cleared", async () => {
    await renderList();
    submitSearch("deploy script");
    await waitFor(() => expect(lastScope()).toBe("all"));

    submitSearch("");
    await waitFor(() => expect(lastScope()).toBe("unarchived"));
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
   * is never refetched at all — the search runs against the unarchived scope
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
    fireEvent.click(screen.getByTitle(/^Filters/));
    const regex = screen.getByPlaceholderText("e.g. my-project|other-repo");
    fireEvent.change(regex, { target: { value: "callboard" } });
    fireEvent.click(regex.parentElement!.querySelector("button")!);
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(lastScope()).toBe("unarchived"));

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

/**
 * Hidden cards — the second half of "archived", and the reason the sidebar's
 * card fetch differs from the board's.
 *
 * `metadata.card.hidden` opts a card out of the BOARD, and `GET /api/cards`
 * omits hidden cards by default for exactly that reason. The list route counts
 * one as archived all the same: `cardLifecycle=unarchived` withholds its tree
 * just as it withholds a closed card's. So the sidebar has to ask for them, or
 * its dim would call those rows "not archived" — no card, no verdict — while
 * the scope was withholding them, which is the disagreement #440 exists to
 * prevent.
 *
 * Asking for them creates the second obligation tested here. `cards` feeds the
 * row menu as well as the dim, and the menu's one entry is a lifecycle toggle
 * whose labels are written about the board ("moves to the board's Archived
 * strip", "returns to the board"). A hidden card is on the board under neither
 * lifecycle, and flipping it would not even clear the fade the user is looking
 * at, because `hidden` stays set and no sidebar control can unset it. So the
 * menu reads the BOARD cards and the dim reads all of them.
 */
describe("a hidden card", () => {
  const OPEN = makeChat("chat-1", { preview: "open chat", rootChatId: "chat-1" });
  const HIDDEN = makeChat("chat-2", { preview: "hidden chat", rootChatId: "chat-2" });

  const card = (id: string, extra: Partial<CardSummary> = {}): CardSummary =>
    ({ id, title: `card ${id}`, lifecycle: "open", chatCount: 1, memberChats: [{ chatId: id }], memberRuns: [], ...extra }) as unknown as CardSummary;

  beforeEach(() => {
    // "Archived" on, so the hidden card's tree is in scope and its row renders.
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    mockListChats.mockResolvedValue(listResponse([OPEN, HIDDEN]));
    vi.mocked(listCards).mockResolvedValue({ cards: [card("chat-1"), card("chat-2", { hidden: true })] });
  });

  /**
   * The single line that makes the route's hidden support and the dim's hidden
   * support meet. Both ends are covered — cards.hidden-listing.test.ts and
   * utils/chatDimming.test.ts — and nothing else pins the call between them, so
   * reverting `listCards(true)` to `listCards()` is a plausible edit that
   * regresses production with every other test still green.
   */
  it("asks the cards route for hidden cards, which the board never does", async () => {
    await renderList();
    expect(listCards).toHaveBeenCalledWith(true);
  });

  it("fades the hidden card's row, exactly as the scope withholds its tree", async () => {
    await renderList();
    const hidden = await screen.findByText("hidden chat");
    expect(hidden.closest(".chatlist-item-dimmed")).toBeTruthy();
    // Control: the open card's row is not faded, so this is the hidden flag and
    // not a list that fades everything.
    expect(screen.getByText("open chat").closest(".chatlist-item-dimmed")).toBeNull();
  });

  /**
   * The trap that asking for hidden cards opens, closed. Before they were
   * fetched, `cardOf` returned undefined for one and no entry rendered; the
   * split in `ChatList` keeps that true rather than teaching the tooltip a
   * fourth case for a card it could not act on anyway.
   */
  it("offers no lifecycle entry on its row, while an open card's row still does", async () => {
    await renderList();
    openRowMenu("hidden chat");
    expect(screen.queryByText("Archive chat")).toBeNull();
    expect(screen.queryByText("Unarchive chat")).toBeNull();
    // Deleting a chat is unaffected — the row keeps every entry that is not
    // about the card.
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("still offers it on a board card's row, so the absence above is the hidden flag", async () => {
    await renderList();
    openRowMenu("open chat");
    expect(screen.getByText("Archive chat")).toBeTruthy();
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
    //
    // Matched on the sentence rather than on "Archived" alone. The toggle is
    // icon-only, so that string is no longer rendered as text in the bar and
    // the loose match would no longer be ambiguous with it — but the sentence
    // is what the copy has to say, and the copy is the thing being pinned:
    // it has to point the user at the control that would fix this.
    const message = await screen.findByText(/^No unarchived chats\./);
    expect(message.textContent).toContain("Turn on “Archived” above");
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
    // is still out (so the rendered list is the old, empty, unarchived one) and
    // the hits are still out (so `matchingChatIds` is null and `isFiltered` is
    // false). Without a guard the message falls through to the branch that
    // tells a user with thousands of chats that they have none.
    let releaseList: () => void = () => {};
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    mockListChats.mockImplementation(async (...args: Parameters<typeof listChats>) => {
      if (args[7] !== "unarchived") await listGate;
      return listResponse(args[7] === "unarchived" ? [] : [makeChat("chat-2", { preview: "archived chat" })]);
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
    await screen.findByText(/^No unarchived chats\./);

    const input = screen.getByPlaceholderText(/Search chat contents/);
    fireEvent.change(input, { target: { value: "deploy script" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The archived-hidden message correctly goes: the scope has widened past it.
    await waitFor(() => expect(screen.queryByText(/^No unarchived chats/)).toBeNull());
    // And nothing replaces it. Not this message, not any message.
    expect(screen.queryByText(/No chats yet/)).toBeNull();
    expect(screen.queryByText(/No chats match/)).toBeNull();

    releaseList();
    land({ chatIds: ["chat-2"] });
    expect(await screen.findByText("archived chat")).toBeTruthy();
  });

  /**
   * The criterion `isFiltered` actually applies, stated as two tests because
   * the code that implements it looks like it could be replaced by the filter
   * badge's exemption set and cannot.
   *
   * All three scopes are toggle buttons in the bar now, so all three are exempt
   * from the badge — the badge counts what is inside the modal, and none of
   * them is. This asks a different question, "could this option have EMPTIED
   * the list?", and the answers no longer coincide at all: `bookmarked` alone
   * answers yes.
   */
  it("blames a view option that can empty the list all by itself", async () => {
    mockListChats.mockResolvedValue(listResponse([]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText(/^No unarchived chats\./);

    fireEvent.click(screen.getByRole("button", { name: "Bookmarked" }));

    expect(await screen.findByText(/^No chats match the current filters/)).toBeTruthy();
    // Not "No chats yet. Create one to get started." — a flat lie to anyone
    // who has chats but no bookmarks.
    expect(screen.queryByText(/No chats yet/)).toBeNull();
  });

  /**
   * The other side of the same criterion, and the one that would break if
   * `isFiltered` were re-pointed at the badge's exemption set: "Show triggered
   * chats" cannot empty a non-empty list — it only widens the request, which
   * still comes back with up to `limit` rows — so an empty list is never its
   * doing, and blaming it would send the user to switch off the one thing that
   * could only have helped.
   */
  it("does not blame a view option that can only add rows", async () => {
    mockListChats.mockResolvedValue(listResponse([]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText(/^No unarchived chats\./);

    fireEvent.click(screen.getByRole("button", { name: "Triggered" }));

    // Still the archived-hidden message: the scope is unchanged and that is
    // still the likeliest reason for an empty sidebar.
    expect(await screen.findByText(/^No unarchived chats\./)).toBeTruthy();
    expect(screen.queryByText(/No chats match/)).toBeNull();
  });

  it("does not blame it once archived chats are shown either", async () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true, showTriggeredChats: true }));
    mockListChats.mockResolvedValue(listResponse([]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    // Both of the add-only scopes on and nothing to show: the honest message is
    // that there are no chats, not that something is filtering them out.
    expect(await screen.findByText("No chats yet. Create one to get started.")).toBeTruthy();
  });

  it("falls back to the plain message once archived chats are shown", async () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    mockListChats.mockResolvedValue(listResponse([]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    // Showing archived chats only widens the request, so it cannot have emptied
    // a non-empty list: an empty list here is not the view options' doing and
    // must not be blamed on them.
    expect(await screen.findByText("No chats yet. Create one to get started.")).toBeTruthy();
  });
});
