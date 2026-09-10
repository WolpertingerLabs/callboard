// @vitest-environment jsdom
/**
 * Pinned chats, end to end through the page: the sections the sidebar grows
 * when something is pinned, the way it loses them again, and the request param
 * that keeps a stale pin on the page at all.
 *
 * Worth testing from the page rather than from `sectionByPinned` alone, because
 * the partition is only half the feature. The other half is three things the
 * pure function cannot see: that `includePinned` actually goes out on every
 * request path, that the kebab's pin re-files the row without waiting for a
 * refetch, and that the fold survives a remount — which is the one thing a
 * user notices immediately if it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, togglePin } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  searchChatContents: vi.fn(),
  togglePin: vi.fn(),
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
const mockTogglePin = vi.mocked(togglePin);

const FOLDER = "/home/cybil/projects/callboard";

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

/** The `includePinned` argument of `listChats`, which is its last one. */
const includePinnedOf = (calls: Parameters<typeof listChats>[]) => calls.map((args) => args[8]);

/** Section headers as the sidebar renders them, in order. */
const headers = () =>
  screen
    .queryAllByRole("button")
    .map((el) => el.textContent ?? "")
    .filter((text) => /^(Pinned|Recent) \(\d+\)$/.test(text));

async function renderList(waitForText = "loose chat") {
  const view = render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText(waitForText);
  return view;
}

/**
 * Open the kebab menu on the row whose preview reads `text`. Lifted from
 * ChatList.showArchived.test.tsx: the row root is found by its inline
 * `border-bottom` rather than a class, and the kebab exists only while the row
 * is hovered.
 */
function openRowMenu(text: string) {
  const row = screen.getByText(text).closest('div[style*="border-bottom"]')!;
  fireEvent.mouseEnter(row);
  fireEvent.click(row.querySelector('[title="Chat actions"]')!);
}

const PINNED = makeChat("chat-pinned", { preview: "pinned chat", pinned: true });
const LOOSE = makeChat("chat-loose", { preview: "loose chat" });

beforeEach(() => {
  localStorage.clear();
  resetChatSectionExpansion();
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([LOOSE]));
  mockTogglePin.mockResolvedValue({} as Chat);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetChatSectionExpansion();
});

describe("sections appear only once something is pinned", () => {
  it("renders no headers at all with nothing pinned", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, makeChat("chat-2", { preview: "other chat" })]));
    await renderList();

    // Not "an empty Pinned header" and not "a lone Recent header" — nothing.
    // The overwhelmingly common sidebar must look exactly as it did before
    // this feature existed.
    expect(headers()).toEqual([]);
    expect(screen.getByText("loose chat")).toBeTruthy();
    expect(screen.getByText("other chat")).toBeTruthy();
  });

  it("grows both headers as soon as one chat is pinned", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, PINNED]));
    await renderList();

    expect(headers()).toEqual(["Pinned (1)", "Recent (1)"]);
    // Both rows are still on screen: sectioning files rows, it does not drop
    // them.
    expect(screen.getByText("pinned chat")).toBeTruthy();
    expect(screen.getByText("loose chat")).toBeTruthy();
  });

  it("puts Pinned first even when the response has it last", async () => {
    // Response order is recency, so a stale pin arrives at the BOTTOM. If the
    // partition were dropped the header order would still read right while the
    // rows underneath were in the wrong bands.
    mockListChats.mockResolvedValue(listResponse([LOOSE, PINNED]));
    await renderList();

    const rendered = screen.getAllByText(/pinned chat|loose chat|^(Pinned|Recent) \(\d+\)$/).map((el) => el.textContent);
    expect(rendered).toEqual(["Pinned (1)", "pinned chat", "Recent (1)", "loose chat"]);
  });

  it("shows Pinned alone, with no empty Recent band, when everything is pinned", async () => {
    mockListChats.mockResolvedValue(listResponse([PINNED, makeChat("chat-p2", { preview: "second pin", pinned: true })]));
    await renderList("pinned chat");

    expect(headers()).toEqual(["Pinned (2)"]);
  });
});

describe("pinning from the kebab", () => {
  it("moves the row into a Pinned section without waiting for a refetch", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE]));
    await renderList();
    expect(headers()).toEqual([]);

    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Pin"));

    await waitFor(() => expect(mockTogglePin).toHaveBeenCalledWith("chat-loose", true));
    // The local metadata write is what re-files the row: the sections are a
    // partition over the loaded chats, so nothing moves until `metadata.pinned`
    // does. It happens after the PATCH resolves, not before it — see
    // `handleTogglePin` on why this is deliberately not optimistic — so what
    // is pinned here is that the row moves without waiting for a REFETCH.
    await waitFor(() => expect(headers()).toEqual(["Pinned (1)"]));
    expect(mockListChats).toHaveBeenCalledTimes(1);
  });

  it("does not move the row until the server has taken the pin", async () => {
    // Not optimistic, deliberately: a failed PATCH must leave the sidebar
    // exactly as it was rather than show a section that will vanish at the
    // next poll. The doc-comment claimed the opposite for a while; this is the
    // assertion that stops it drifting back.
    mockListChats.mockResolvedValue(listResponse([LOOSE]));
    await renderList();

    let settle: (chat: Chat) => void = () => {};
    mockTogglePin.mockImplementationOnce(() => new Promise<Chat>((resolve) => (settle = resolve)));

    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Pin"));
    await waitFor(() => expect(mockTogglePin).toHaveBeenCalled());
    expect(headers()).toEqual([]);

    await act(async () => settle({} as Chat));
    expect(headers()).toEqual(["Pinned (1)"]);
  });

  it("takes the headers away entirely when the last pin is removed", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, PINNED]));
    await renderList();
    expect(headers()).toEqual(["Pinned (1)", "Recent (1)"]);

    openRowMenu("pinned chat");
    fireEvent.click(screen.getByText("Unpin"));

    await waitFor(() => expect(mockTogglePin).toHaveBeenCalledWith("chat-pinned", false));
    // Not "Recent (2)" — with nothing pinned there is no section at all.
    await waitFor(() => expect(headers()).toEqual([]));
    expect(screen.getByText("pinned chat")).toBeTruthy();
  });

  it("pins a chat that has lineage, which renders through the group branch", async () => {
    // Most chats that matter in this repo: anything forked, spawned or run as
    // a job step has lineage, so it renders as a group row rather than a lone
    // one. Every other fixture in this file is lineage-free, which is exactly
    // how the group branch shipped without a pin handler at all.
    const parent = makeChat("chat-parent", { preview: "parent chat" });
    const child = makeChat("chat-child", { preview: "child chat", parentChatId: "chat-parent", rootChatId: "chat-parent" });
    mockListChats.mockResolvedValue(listResponse([parent, child]));
    await renderList("parent chat");
    expect(headers()).toEqual([]);

    openRowMenu("parent chat");
    fireEvent.click(screen.getByText("Pin"));

    await waitFor(() => expect(mockTogglePin).toHaveBeenCalledWith("chat-parent", true));
    // (2), not (1): the group is filed whole, so the count is its chats.
    await waitFor(() => expect(headers()).toEqual(["Pinned (2)"]));
  });

  it("clears a group's pin from whichever member is holding it", async () => {
    // The pin was set while the chat was standalone; a subagent spawned off it
    // since, and it is no longer the row's header chat. The kebab still has to
    // reach it — see `ChatTreeList`'s `Row.pinnedMembers`.
    const parent = makeChat("chat-parent", { preview: "parent chat" });
    const child = makeChat("chat-child", { preview: "child chat", parentChatId: "chat-parent", rootChatId: "chat-parent", pinned: true });
    mockListChats.mockResolvedValue(listResponse([parent, child]));
    await renderList("parent chat");
    expect(headers()).toEqual(["Pinned (2)"]);

    openRowMenu("parent chat");
    fireEvent.click(screen.getByText("Unpin"));

    // The PATCH goes to the child, not to the row's own chat.
    await waitFor(() => expect(mockTogglePin).toHaveBeenCalledWith("chat-child", false));
    expect(mockTogglePin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(headers()).toEqual([]));
  });

  it("does not touch the bookmark, in either direction", async () => {
    // The kebab offers both, and they are independent flags: pinning a chat
    // must not star it, and the row's bookmark entry must still read as unset.
    mockListChats.mockResolvedValue(listResponse([LOOSE]));
    await renderList();

    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Pin"));
    await waitFor(() => expect(headers()).toEqual(["Pinned (1)"]));

    openRowMenu("loose chat");
    expect(screen.getByText("Bookmark")).toBeTruthy();
    expect(screen.queryByText("Remove bookmark")).toBeNull();
    // ...and the pin entry now offers the inverse.
    expect(screen.getByText("Unpin")).toBeTruthy();
  });
});

/**
 * A refresh in flight when the pin lands.
 *
 * `load` claims the list with `loadGenRef` and stands down if anything newer
 * has claimed it since. `handleTogglePin` writes to `chats` and so is one of
 * those newer things — without the bump, a `load` that went to the wire before
 * the PATCH commits its pre-pin response afterwards, and the pin reverts,
 * taking the whole Pinned section down with it until the next poll puts it
 * back. The sidebar polls every 15s while a session is active, so that is a
 * long time to watch a section you just created flicker out.
 */
describe("a stale refresh landing after the pin", () => {
  it("does not undo the pin", async () => {
    // A stable identity: the mount effect depends on `onRefresh`, so a fresh
    // arrow per render would re-run it every commit.
    let refresh = () => {};
    const captureRefresh = (fn: () => void) => {
      refresh = fn;
    };
    mockListChats.mockResolvedValue(listResponse([LOOSE]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={captureRefresh} />
      </MemoryRouter>,
    );
    await screen.findByText("loose chat");

    // A refresh goes to the wire and hangs there.
    let release: (response: ChatListResponse) => void = () => {};
    mockListChats.mockImplementationOnce(() => new Promise<ChatListResponse>((resolve) => (release = resolve)));
    act(() => refresh());
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));

    // ...and the user pins while it is still out.
    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Pin"));
    await waitFor(() => expect(headers()).toEqual(["Pinned (1)"]));

    // The response was assembled before the pin existed. Committing it now
    // would be the last response to LAND winning over the last write made.
    await act(async () => release(listResponse([LOOSE])));
    expect(headers()).toEqual(["Pinned (1)"]);
    expect(screen.getByText("loose chat")).toBeTruthy();
  });
});

describe("folding a section", () => {
  it("hides that section's rows and leaves the other one alone", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, PINNED]));
    await renderList();

    fireEvent.click(screen.getByText("Pinned (1)"));

    expect(screen.queryByText("pinned chat")).toBeNull();
    expect(screen.getByText("loose chat")).toBeTruthy();
    // The header stays — it is the only way back.
    expect(headers()).toEqual(["Pinned (1)", "Recent (1)"]);
  });

  it("persists the fold across a remount", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, PINNED]));
    await renderList();
    fireEvent.click(screen.getByText("Recent (1)"));
    expect(screen.queryByText("loose chat")).toBeNull();

    // A page reload: nothing cached in memory, everything read back from
    // localStorage.
    cleanup();
    resetChatSectionExpansion();
    await renderList("pinned chat");

    expect(screen.queryByText("loose chat")).toBeNull();
    expect(screen.getByText("pinned chat")).toBeTruthy();
  });
});

/**
 * The request side. Sectioning partitions the rows already loaded, so without
 * this the Pinned section quietly empties as its chats age out of the page —
 * which is the whole feature failing, silently, a week after it is used.
 */
describe("includePinned on the wire", () => {
  it("is set on the initial load", async () => {
    await renderList();
    expect(includePinnedOf(mockListChats.mock.calls)).toEqual([true]);
  });

  it("is set on the stale-response refetch, which builds its own argument list", async () => {
    mockListChats.mockResolvedValueOnce({ ...listResponse([LOOSE]), stale: true });
    await renderList();
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));
    expect(includePinnedOf(mockListChats.mock.calls)).toEqual([true, true]);
  });

  it("is set on 'Load next page', which builds a third", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE], true));
    await renderList();

    fireEvent.click(screen.getByText("Load next page"));
    await waitFor(() => expect(includePinnedOf(mockListChats.mock.calls)).toEqual([true, true]));
  });
});
