// @vitest-environment jsdom
/**
 * Multi-select in the sidebar chat list: the wiring no component can see.
 *
 * The gesture contract is shared with the board and tested where it lives
 * (`hooks/useSelectionActivation` via `board/cardFace.parity.test.tsx` and
 * `ChatListItem.selection.test.tsx`). What lives only here, and is worth the
 * cost of mounting the page:
 *
 *  - the shift+click range order, which must be the order the list actually
 *    rendered — one row per lineage GROUP, not one per chat;
 *  - the scope, which is a chat's CARD lifecycle and has a third value for a
 *    chat on no card at all;
 *  - the chats → cards mapping behind the archive verb, including two selected
 *    chats resolving to one card;
 *  - what happens to a selection when a bulk call half-fails, and when a
 *    refresh takes a selected row away underneath it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary, Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, bulkSetCardLifecycle, bulkDeleteChats, searchChatContents } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  bulkSetCardLifecycle: vi.fn(),
  bulkDeleteChats: vi.fn(),
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
const mockBulkLifecycle = vi.mocked(bulkSetCardLifecycle);
const mockBulkDelete = vi.mocked(bulkDeleteChats);

const FOLDER = "/home/cybil/projects/callboard";
const KEY = "claude-code-settings";

function makeChat(id: string, preview: string, meta: Record<string, unknown> = {}): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    session_log_path: null,
    metadata: JSON.stringify({ preview, ...meta }),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
  } as Chat;
}

function card(id: string, lifecycle: "open" | "closed", chatIds: string[], extra: Partial<CardSummary> = {}): CardSummary {
  return {
    id,
    title: `card ${id}`,
    lifecycle,
    chatCount: chatIds.length,
    memberChats: chatIds.map((chatId) => ({ chatId })),
    memberRuns: [],
    ...extra,
  } as unknown as CardSummary;
}

/**
 * The fixture, in rendered order — the server returns chats by recency and
 * `buildRows` keeps that order.
 *
 *   one     │ open card "c-one"
 *   two     │ open card "c-two"
 *   old     │ ARCHIVED card "c-old"          ← between two open rows, on purpose
 *   three   │ open card "c-shared"
 *   four    │ open card "c-shared"           ← same card as three, no lineage stamp
 *   robot   │ no card at all (triggered)
 *
 * The archived row sitting in the middle is what makes the range tests worth
 * running: the board can slice its ordered ids unfiltered because it lists
 * every open card before every closed one, and this list cannot — it is
 * ordered by recency and mixes the scopes freely.
 *
 * `three` and `four` share a card with NO parent pointers between them, which
 * is the legacy shape `indexByChat` exists for (root stamps postdate
 * forkedFrom). It is also the only way to get two selectable ROWS on one card:
 * stamped lineage would fold them into a single row.
 */
const CHATS: Chat[] = [
  makeChat("one", "chat one"),
  makeChat("two", "chat two"),
  makeChat("old", "chat old"),
  makeChat("three", "chat three"),
  makeChat("four", "chat four"),
  makeChat("robot", "chat robot", { triggered: true }),
];

const CARDS: CardSummary[] = [
  card("c-one", "open", ["one"]),
  card("c-two", "open", ["two"]),
  card("c-old", "closed", ["old"]),
  card("c-shared", "open", ["three", "four"]),
];

function listResponse(chats: Chat[], hasMore = false): ChatListResponse {
  return { chats, hasMore, total: chats.length, windowRows: chats.length, stale: false };
}

/** Refresh handle the page hands out, so a test can make the list reload. */
let refreshList: () => void = () => {};

async function mount(chats: Chat[] = CHATS, cards: CardSummary[] = CARDS) {
  mockListChats.mockResolvedValue(listResponse(chats));
  vi.mocked(listCards).mockResolvedValue({ cards });
  // "Archived" on, so the archived row is in scope and renders — the fixture
  // needs it on screen to be selectable at all.
  localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
  const view = render(
    <MemoryRouter>
      <ChatList
        onRefresh={(fn) => {
          refreshList = fn;
        }}
      />
    </MemoryRouter>,
  );
  const firstPreview = JSON.parse(chats[0].metadata ?? "{}").preview as string;
  await screen.findByText(firstPreview);
  // Wait for the CARDS, not just the chats. Selection is withheld until the
  // card index exists, because a row's scope is its card's lifecycle (see
  // `scopeOf`) — so "a hovered row offers a checkbox" is the observable proof
  // that the second request landed, and every test below would otherwise race
  // it.
  await waitFor(() => {
    fireEvent.mouseEnter(row(firstPreview));
    expect(screen.queryByRole("checkbox")).toBeTruthy();
  });
  fireEvent.mouseLeave(row(firstPreview));
  return view;
}

/**
 * One row's clickable surface, by its preview text.
 *
 * By the inline `border-bottom` the row root sets, as the sibling
 * ChatList.showArchived suite does — the row carries no role, deliberately
 * (see ChatListItem.selection.test.tsx), so there is nothing semantic to
 * anchor to.
 */
function row(preview: string) {
  return screen.getByText(preview).closest('div[style*="border-bottom"]') as HTMLElement;
}

function count() {
  return screen.queryByText(/\d+ chats? selected/)?.textContent ?? null;
}

/**
 * A key press aimed at the list.
 *
 * Dispatched on a row rather than on `document`, because the handler is bound
 * to the list root and not to the document — see the keydown effect in
 * ChatList, and the test at the bottom of "Ctrl+A" that pins the difference.
 */
function pressInList(init: Partial<KeyboardEventInit> & { key: string }) {
  fireEvent.keyDown(row("chat one"), init);
}

/** Previews of every currently-selected row, in rendered order. */
function selectedPreviews() {
  return screen
    .getAllByRole("checkbox")
    .filter((box) => box.getAttribute("aria-checked") === "true")
    .map((box) => box.getAttribute("aria-label")?.replace("Select ", ""));
}

/** The bar's action buttons, excluding Cancel and Select all. */
function actionLabels() {
  return screen
    .getAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((text) => /^(Archive|Unarchive|Delete) /.test(text));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getDrafts).mockResolvedValue([]);
  vi.mocked(searchChatContents).mockResolvedValue({ chatIds: [] } as Awaited<ReturnType<typeof searchChatContents>>);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("entering selection mode", () => {
  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("%s+click enters selection mode and selects that row", async (_name, init) => {
    await mount();
    fireEvent.click(row("chat one"), init);

    expect(count()).toBe("1 chat selected");
    expect(selectedPreviews()).toEqual(["chat one"]);
  });

  it("a plain click still opens the chat", async () => {
    await mount();
    fireEvent.click(row("chat one"));

    expect(count()).toBeNull();
  });

  it("right-click enters selection mode, and the click that may follow does not undo it", async () => {
    await mount();
    fireEvent.contextMenu(row("chat one"));
    expect(count()).toBe("1 chat selected");

    // macOS turns Ctrl+click into a synthetic right-click and may deliver BOTH
    // contextmenu and a ctrl-click.
    fireEvent.click(row("chat one"), { ctrlKey: true });
    expect(count()).toBe("1 chat selected");
  });

  it("does not open a chat while selecting", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"));

    expect(count()).toBe("2 chats selected");
  });
});

describe("shift+click ranges", () => {
  it("selects the inclusive range in rendered order", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"), { shiftKey: true });

    expect(selectedPreviews()).toEqual(["chat one", "chat two"]);
  });

  it("steps over a row that is out of the selection's scope", async () => {
    await mount();
    fireEvent.click(row("chat two"), { metaKey: true });
    fireEvent.click(row("chat three"), { shiftKey: true });

    // "chat old" lies between them and is on an ARCHIVED card. An unfiltered
    // slice would sweep it into an open-scoped selection, and the bar would
    // then offer to archive a card that is already archived.
    expect(selectedPreviews()).toEqual(["chat two", "chat three"]);
  });

  it("works backwards from the anchor", async () => {
    await mount();
    fireEvent.click(row("chat four"), { metaKey: true });
    fireEvent.click(row("chat two"), { shiftKey: true });

    expect(selectedPreviews()).toEqual(["chat two", "chat three", "chat four"]);
  });

  it("does not extend from an anchor the user has already deselected", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat one")); // deselect the last row — mode ends
    expect(count()).toBeNull();

    fireEvent.click(row("chat four"), { shiftKey: true });
    // A stale anchor on "chat one" would have swept the whole open list.
    expect(selectedPreviews()).toEqual(["chat four"]);
  });

  it("with no anchor, behaves as a plain toggle", async () => {
    await mount();
    fireEvent.click(row("chat two"), { shiftKey: true });

    expect(selectedPreviews()).toEqual(["chat two"]);
  });

  it("cannot be aimed at a row outside the scope", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat old"), { shiftKey: true });

    // The archived row is inert while an open-scoped selection is live, so the
    // shift+click never lands.
    expect(selectedPreviews()).toEqual(["chat one"]);
  });

  it("reads the range off the rows, not the chats — a lineage group is one entry", async () => {
    // `child` folds into `one`'s row, so the rendered list is one, two, three:
    // a range built from the chat array would step through the folded member
    // and select a chat with no row of its own on screen.
    const chats = [CHATS[0], makeChat("child", "chat child", { parentChatId: "one", rootChatId: "one" }), CHATS[1], CHATS[3]];
    await mount(chats, CARDS);

    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat three"), { shiftKey: true });

    expect(selectedPreviews()).toEqual(["chat one", "chat two", "chat three"]);
    expect(count()).toBe("3 chats selected");
  });
});

describe("the archive scope", () => {
  it("offers Archive over an open selection", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    expect(actionLabels()).toEqual(["Archive 1 card", "Delete 1 chat"]);
  });

  it("offers Unarchive when the selection started on an archived row", async () => {
    await mount();
    fireEvent.click(row("chat old"), { metaKey: true });

    expect(actionLabels()).toEqual(["Unarchive 1 card", "Delete 1 chat"]);
  });

  it("offers Delete alone for a chat on no card at all", async () => {
    await mount();
    fireEvent.click(row("chat robot"), { metaKey: true });

    // No card, so there is no lifecycle to flip and no honest verb to offer.
    // Delete is per chat and works regardless.
    expect(actionLabels()).toEqual(["Delete 1 chat"]);
  });

  it("makes rows in another scope inert", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    for (const preview of ["chat old", "chat robot"]) {
      // Inert, not merely dimmed: no checkbox to press, and the row's own
      // click does nothing at all — not even navigate.
      expect(row(preview).style.opacity).toBe("0.35");
      fireEvent.click(row(preview));
    }
    expect(count()).toBe("1 chat selected");
    expect(selectedPreviews()).toEqual(["chat one"]);
  });

  it("keeps a card-less chat out of an open selection even by Ctrl+A", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    pressInList({ key: "a", ctrlKey: true });

    expect(selectedPreviews()).toEqual(["chat one", "chat two", "chat three", "chat four"]);
  });
});

describe("leaving selection mode", () => {
  it("Escape exits", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    pressInList({ key: "Escape" });

    expect(count()).toBeNull();
  });

  it("Escape typed into the search box does not exit", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.keyDown(screen.getByPlaceholderText(/Search chat contents/), { key: "Escape" });

    expect(count()).toBe("1 chat selected");
  });

  it("Cancel exits", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    expect(count()).toBeNull();
  });

  it("deselecting the last row exits", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat one"));

    expect(count()).toBeNull();
  });
});

describe("Ctrl+A", () => {
  it("selects every row in scope, and only those", async () => {
    await mount();
    fireEvent.click(row("chat old"), { metaKey: true });
    pressInList({ key: "a", ctrlKey: true });

    expect(selectedPreviews()).toEqual(["chat old"]);
  });

  it("does nothing before selection mode is entered", async () => {
    await mount();
    pressInList({ key: "a", metaKey: true });

    expect(count()).toBeNull();
  });

  it("does not fire while the search box has focus", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.keyDown(screen.getByPlaceholderText(/Search chat contents/), { key: "a", ctrlKey: true });

    // Select-all inside a text field is select-all of the TEXT.
    expect(count()).toBe("1 chat selected");
  });
});

describe("mobile Select all", () => {
  it("selects every row in the active scope", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    await mount();
    fireEvent.contextMenu(row("chat one"));

    const selectAll = screen.getByRole("button", { name: "Select all" }) as HTMLButtonElement;
    expect(selectAll.disabled).toBe(false);
    fireEvent.click(selectAll);

    expect(selectedPreviews()).toEqual(["chat one", "chat two", "chat three", "chat four"]);
    expect(selectAll.disabled).toBe(true);
  });

  it("does not show the button on desktop, where Ctrl/Cmd+A is available", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  });
});

describe("bulk archive", () => {
  it("maps the selected chats to their card ids", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"));

    mockBulkLifecycle.mockResolvedValue({ updated: [card("c-one", "closed", ["one"]), card("c-two", "closed", ["two"])], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 2 cards" }));
    });

    expect(mockBulkLifecycle).toHaveBeenCalledWith(["c-one", "c-two"], "closed");
    await waitFor(() => expect(count()).toBeNull());
  });

  it("dedupes two chats on one card, and says so on the button", async () => {
    await mount();
    fireEvent.click(row("chat three"), { metaKey: true });
    fireEvent.click(row("chat four"));

    // Two rows selected, ONE card behind them. The count and the label carry
    // different nouns deliberately — the alternative is promising to archive
    // 2 and moving every chat on the card.
    expect(count()).toBe("2 chats selected");
    const button = screen.getByRole("button", { name: "Archive 1 card" });

    mockBulkLifecycle.mockResolvedValue({ updated: [card("c-shared", "closed", ["three", "four"])], failed: [] });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockBulkLifecycle).toHaveBeenCalledWith(["c-shared"], "closed");
  });

  it("unarchives from an archived selection", async () => {
    await mount();
    fireEvent.click(row("chat old"), { metaKey: true });

    mockBulkLifecycle.mockResolvedValue({ updated: [card("c-old", "open", ["old"])], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unarchive 1 card" }));
    });

    expect(mockBulkLifecycle).toHaveBeenCalledWith(["c-old"], "open");
  });

  it("fades the archived rows on the response, without waiting for a refetch", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    // The refetch this triggers returns the row still present — as it would
    // with "Archived" on. What must not wait for the server is the DIM.
    mockBulkLifecycle.mockResolvedValue({ updated: [card("c-one", "closed", ["one"])], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1 card" }));
    });

    await waitFor(() => expect(screen.getByText("chat one").closest(".chatlist-item-dimmed")).toBeTruthy());
  });

  it("on partial failure, reports the count and keeps exactly the failed card's chats selected", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat three"));
    fireEvent.click(row("chat four"));

    // c-shared failed, so BOTH its chats stay selected — the failure came back
    // keyed by card and has to be mapped back to the rows the user picked.
    mockBulkLifecycle.mockResolvedValue({
      updated: [card("c-one", "closed", ["one"])],
      failed: [{ id: "c-shared", error: "locked" }],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 2 cards" }));
    });

    await screen.findByText("1 of 2 cards could not be updated");
    expect(selectedPreviews()).toEqual(["chat three", "chat four"]);
    expect(screen.getByRole("button", { name: "Archive 1 card" })).toBeTruthy();
  });

  it("takes the failure message down with the selection it was about", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    mockBulkLifecycle.mockRejectedValue(new Error("network down"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1 card" }));
    });
    await screen.findByText("network down");

    pressInList({ key: "Escape" });
    expect(screen.queryByText("network down")).toBeNull();
  });

  it("surfaces a total failure and keeps the selection", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    mockBulkLifecycle.mockRejectedValue(new Error("network down"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1 card" }));
    });

    await screen.findByText("network down");
    expect(count()).toBe("1 chat selected");
  });
});

describe("bulk delete", () => {
  /** Enter selection, pick `extra` more rows, and press Delete. */
  function selectAndPressDelete(first: string, ...extra: string[]) {
    fireEvent.click(row(first), { metaKey: true });
    for (const preview of extra) fireEvent.click(row(preview));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Delete ${extra.length + 1} chats?$`) }));
  }

  it("asks first, stating the count, and does nothing until confirmed", async () => {
    await mount();
    selectAndPressDelete("chat one", "chat two");

    expect(screen.getByText("Delete Chats")).toBeTruthy();
    expect(screen.getByText(/delete these 2 chats\? This action cannot be undone\./)).toBeTruthy();
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it("says it in the singular for one chat, as the single-row confirmation does", async () => {
    await mount();
    selectAndPressDelete("chat one");

    expect(screen.getByText("Delete Chat")).toBeTruthy();
    expect(screen.getByText(/delete this chat\?/)).toBeTruthy();
  });

  it("says nothing about forks when no selected row fronts a group", async () => {
    await mount();
    selectAndPressDelete("chat one", "chat two");

    // Every row in this fixture is a lone chat, so the sentence would be noise
    // about something that cannot happen to this selection.
    expect(screen.queryByText(/not the chats forked from them/)).toBeNull();
  });

  it("names what it does NOT delete when a selected row fronts a lineage group", async () => {
    // `child` folds into `one`'s row, so that row fronts a group of two and
    // only its front chat is selectable.
    await mount([CHATS[0], makeChat("child", "chat child", { parentChatId: "one", rootChatId: "one" }), CHATS[1]], CARDS);
    selectAndPressDelete("chat one");

    // "Delete 1 chat" is true and is not the whole truth: the fork survives
    // and the group comes back fronted by it. Doing forty at once is what
    // makes that visible, so the dialog says it.
    expect(screen.getByText(/This deletes the selected chats, not the chats forked from them/)).toBeTruthy();
  });

  it("deletes the selected chats in rendered order and drops them from the list", async () => {
    await mount();
    selectAndPressDelete("chat two", "chat one");

    // The list mock still returns every chat, so a refetch would put these
    // rows straight back: they leave because the response said so, with no
    // round trip involved.
    mockBulkDelete.mockResolvedValue({ deleted: ["one", "two"], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    // Rendered order, not click order: a bulk request has to be deterministic.
    expect(mockBulkDelete).toHaveBeenCalledWith(["one", "two"]);
    await waitFor(() => expect(screen.queryByText("chat one")).toBeNull());
    expect(screen.queryByText("chat two")).toBeNull();
    expect(screen.getByText("chat three")).toBeTruthy();
    expect(count()).toBeNull();
  });

  it("on partial failure, keeps exactly the failed chats selected", async () => {
    await mount();
    selectAndPressDelete("chat one", "chat two", "chat three");

    mockBulkDelete.mockResolvedValue({ deleted: ["one"], failed: [{ id: "two", error: "native_child_read_only" }, { id: "three", error: "gone" }] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    await screen.findByText("2 of 3 chats could not be deleted");
    expect(selectedPreviews()).toEqual(["chat two", "chat three"]);
    // The one that succeeded is gone from the list all the same.
    expect(screen.queryByText("chat one")).toBeNull();
  });

  it("cancelling the dialog leaves the selection alone", async () => {
    await mount();
    selectAndPressDelete("chat one", "chat two");

    // Two "Cancel" buttons are on screen — the dialog's and the bar's. The
    // dialog's is the last one mounted.
    const cancels = screen.getAllByRole("button", { name: /Cancel/ });
    fireEvent.click(cancels[cancels.length - 1]);

    expect(mockBulkDelete).not.toHaveBeenCalled();
    expect(count()).toBe("2 chats selected");
  });
});

describe("reconciling against a refresh", () => {
  it("drops selected ids for chats that have vanished", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"));
    expect(count()).toBe("2 chats selected");

    // Another client deleted "chat two"; the next refresh no longer returns it.
    mockListChats.mockResolvedValue(listResponse(CHATS.filter((c) => c.id !== "two")));
    await act(async () => {
      refreshList();
    });

    await waitFor(() => expect(screen.queryByText("chat two")).toBeNull());
    // A count of 2 with one row on screen is a number the user cannot
    // reconcile with what they can see.
    expect(count()).toBe("1 chat selected");
  });

  it("leaves selection mode when every selected chat has vanished", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"));

    mockListChats.mockResolvedValue(listResponse(CHATS.filter((c) => c.id !== "one" && c.id !== "two")));
    await act(async () => {
      refreshList();
    });

    await waitFor(() => expect(count()).toBeNull());
  });

  it("drops a selected chat whose card was archived from under an open selection", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"));
    expect(count()).toBe("2 chats selected");

    // Someone archived c-two on the board. The row is still here (Archived is
    // on) but it is no longer in this selection's scope, and an archived card
    // must not be reachable by a button that reads "Archive".
    vi.mocked(listCards).mockResolvedValue({ cards: [CARDS[0], card("c-two", "closed", ["two"]), CARDS[2], CARDS[3]] });
    await act(async () => {
      refreshList();
    });

    await waitFor(() => expect(count()).toBe("1 chat selected"));
    expect(selectedPreviews()).toEqual(["chat one"]);
  });
});

describe("the list's own layout", () => {
  /**
   * Make every element in the document report `height` px tall.
   *
   * jsdom measures nothing — `offsetHeight` is 0 for everything — which is
   * exactly why the clearance used to be a constant asserted against itself.
   * Stubbing the geometry is what lets this file test the MECHANISM (the list
   * pads by what the bar reports) while the real numbers are guarded in a real
   * browser by scripts/test-selection-bar-clearance.mjs.
   */
  function stubOffsetHeight(height: number) {
    const proto = window.HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => height });
    return () => {
      if (original) Object.defineProperty(proto, "offsetHeight", original);
      else Reflect.deleteProperty(proto, "offsetHeight");
    };
  }

  const scroller = (container: HTMLElement) => container.querySelector('[style*="overflow: auto"]') as HTMLElement;

  it("pads by the height the bar REPORTS, not by a constant", async () => {
    // 111px is what the bar actually measures at 320px wide with a mobile
    // "Select all" — the case the old 76px constant was 35px short of.
    const restore = stubOffsetHeight(111);
    try {
      const { container } = await mount();
      expect(scroller(container).style.paddingBottom).toBe("");

      fireEvent.click(row("chat one"), { metaKey: true });
      await waitFor(() => expect(scroller(container).style.paddingBottom).toBe("111px"));
    } finally {
      restore();
    }
  });

  it("falls back to a clearance that covers the widest measured bar until one is reported", async () => {
    // No layout at all, so `onMeasure` never fires (it refuses to report 0 —
    // a 0 would read as "the bar needs no room"). The list has to pad by
    // something, and the fallback is sized from the browser harness's worst
    // case (111px at 320px mobile) rather than from the bar at rest.
    const { container } = await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    const padding = Number.parseInt(scroller(container).style.paddingBottom, 10);
    expect(padding).toBeGreaterThanOrEqual(111);
  });

  it("re-reports its height when the wording changes under it", async () => {
    let height = 84;
    const restore = stubOffsetHeight(0);
    try {
      const proto = window.HTMLElement.prototype;
      Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => height });
      const { container } = await mount();
      fireEvent.click(row("chat one"), { metaKey: true });
      await waitFor(() => expect(scroller(container).style.paddingBottom).toBe("84px"));

      // A second row selected changes every label on the bar, which is enough
      // to wrap it — and jsdom has no ResizeObserver, so the measurement has
      // to be re-taken on the wording rather than left to the observer.
      height = 98;
      fireEvent.click(row("chat two"));
      await waitFor(() => expect(scroller(container).style.paddingBottom).toBe("98px"));
    } finally {
      restore();
    }
  });

  it("confines the bar to the list column rather than the viewport", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    // `fixed` would stretch it across the chat pane beside the sidebar. What
    // confines it is the pair: `absolute` on the bar, `relative` on the list
    // root it is a child of. jsdom computes no layout, so the relationship is
    // asserted structurally rather than through offsetParent.
    const bar = screen.getByText("1 chat selected").parentElement as HTMLElement;
    expect(bar.style.position).toBe("absolute");
    expect((bar.parentElement as HTMLElement).style.position).toBe("relative");
  });
});

/**
 * The selection is DERIVED from the loaded rows, which hides it when they go —
 * and hiding is not forgetting. These are the tests for the difference.
 */
describe("a selection whose rows all go away", () => {
  const submitSearch = (query: string) => {
    const input = screen.getByPlaceholderText(/Search chat contents/);
    fireEvent.change(input, { target: { value: query } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("does not come back when the rows do", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    fireEvent.click(row("chat two"));
    expect(count()).toBe("2 chats selected");

    // A search that matches nothing empties the list. The bar goes with it,
    // which the user reads as "the selection is gone".
    submitSearch("nothing matches this");
    await waitFor(() => expect(count()).toBeNull());

    submitSearch("");
    await waitFor(() => expect(screen.getByText("chat one")).toBeTruthy());
    // Derivation alone would have kept both ids in the raw set and put the bar
    // straight back at "2 chats selected", over rows the user stopped thinking
    // about — with the action buttons live. The reaper is what forgets them.
    expect(count()).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("forgets its anchor too, so a later shift+click does not extend from it", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    submitSearch("nothing matches this");
    await waitFor(() => expect(count()).toBeNull());
    submitSearch("");
    await waitFor(() => expect(screen.getByText("chat four")).toBeTruthy());

    fireEvent.click(row("chat four"), { shiftKey: true });
    // A surviving anchor on "chat one" would have swept the whole open list.
    expect(selectedPreviews()).toEqual(["chat four"]);
  });
});

/**
 * The sidebar is a docked column with a transcript open beside it, so its
 * shortcuts are bound to the list root rather than to the document. The board
 * can bind to the document because the board IS the viewport.
 */
describe("the shortcuts stay inside the list", () => {
  it("leaves a Cmd+A aimed at the rest of the window alone", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    // Not prevented — `fireEvent` returns false when preventDefault was
    // called — so the browser's own select-all still happens wherever the user
    // was actually pointing.
    expect(fireEvent.keyDown(document.body, { key: "a", metaKey: true })).toBe(true);
    expect(selectedPreviews()).toEqual(["chat one"]);
  });

  it("still answers a Cmd+A inside the list", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });
    pressInList({ key: "a", metaKey: true });

    expect(selectedPreviews()).toEqual(["chat one", "chat two", "chat three", "chat four"]);
  });

  it("focuses the list when a selection starts, so the shortcuts have somewhere to arrive", async () => {
    const { container } = await mount();
    expect(container.firstElementChild).not.toBe(document.activeElement);

    fireEvent.click(row("chat one"), { metaKey: true });
    // Nothing in a row is focusable, so without this the focus stays on
    // <body> and a root-scoped handler could never fire.
    await waitFor(() => expect(document.activeElement).toBe(container.firstElementChild));
  });

  it("leaves an Escape aimed elsewhere alone, which is the cost of scoping them", async () => {
    await mount();
    fireEvent.click(row("chat one"), { metaKey: true });

    fireEvent.keyDown(document.body, { key: "Escape" });
    // Deliberate: the same rule that protects Cmd+A applies to Escape, so an
    // Escape the transcript is handling does not also drop the selection. The
    // bar's Cancel button is always available.
    expect(count()).toBe("1 chat selected");
  });
});

describe("before the cards land", () => {
  it("offers no selection at all, rather than one scoped from an empty card index", async () => {
    let releaseCards: (value: { cards: CardSummary[] }) => void = () => {};
    vi.mocked(listCards).mockReturnValue(new Promise((resolve) => (releaseCards = resolve)) as ReturnType<typeof listCards>);
    mockListChats.mockResolvedValue(listResponse(CHATS));
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("chat one");

    // The rows are here; the scope is not. A row's scope is its card's
    // lifecycle, and `/api/cards` is the slow uncached request of the two.
    fireEvent.mouseEnter(row("chat one"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(row("chat one"), { metaKey: true });
    expect(count()).toBeNull();

    await act(async () => {
      releaseCards({ cards: CARDS });
    });

    fireEvent.click(row("chat one"), { metaKey: true });
    expect(count()).toBe("1 chat selected");
  });
});
