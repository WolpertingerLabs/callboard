// @vitest-environment jsdom
/**
 * The sidebar's "Regenerate title" action, tested from the page because the
 * page is where the two interesting decisions live:
 *
 *  - picking the menu entry only OPENS a confirmation. The request re-derives
 *    a title with a model call and overwrites what the user is reading, so
 *    nothing may fire on the click itself; and
 *  - the in-flight lock is the LIST's state, not the row's. A row is remounted
 *    whenever a refresh changes its shape — folding into a lineage group,
 *    moving between the Active/Inactive sections — and a lock held inside it
 *    would be dropped mid-request and re-enable the entry, which is exactly the
 *    double-fire the lock exists to prevent. The last test drives that remount
 *    for real rather than asserting the lock's location.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, regenerateChatTitle } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  regenerateChatTitle: vi.fn(),
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
const mockRegenerate = vi.mocked(regenerateChatTitle);

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

function listResponse(chats: Chat[]): ChatListResponse {
  return { chats, hasMore: false, total: chats.length, windowRows: chats.length, stale: false };
}

/** A request whose resolution the test controls, so "in flight" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Hands the caller ChatList's own refresh callback, so a test can force a refetch. */
let refresh: () => void = () => {};

async function renderList() {
  const view = render(
    <MemoryRouter>
      <ChatList
        onRefresh={(fn) => {
          refresh = fn;
        }}
      />
    </MemoryRouter>,
  );
  await screen.findByText("Old Title");
  return view;
}

/**
 * The row element ChatListItem renders as its root — the one carrying the hover
 * handler that reveals the kebab. Walked up from the title rather than taken
 * from the container, because a row folded into a lineage group is nested one
 * level deeper than a lone one, and this test file renders both.
 */
function rowOf(title: string): HTMLElement {
  return screen.getByText(title).parentElement!.parentElement!.parentElement!;
}

function openRowMenu(title: string) {
  fireEvent.mouseEnter(rowOf(title));
  fireEvent.click(screen.getByTitle("Chat actions"));
}

beforeEach(() => {
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { title: "Old Title" })]));
  mockRegenerate.mockResolvedValue({ title: "A Much Better Title" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatList regenerate title", () => {
  it("asks for confirmation instead of regenerating on the click", async () => {
    await renderList();
    openRowMenu("Old Title");

    fireEvent.click(screen.getByText("Regenerate title"));

    expect(screen.getByText("Regenerate Title")).toBeTruthy();
    // The prompt names the title about to be replaced.
    expect(screen.getByText(/Replace the title of "Old Title"/)).toBeTruthy();
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it("regenerates on confirm and shows the new title without a refetch", async () => {
    await renderList();
    openRowMenu("Old Title");
    fireEvent.click(screen.getByText("Regenerate title"));

    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    expect(mockRegenerate).toHaveBeenCalledWith("chat-1");
    await screen.findByText("A Much Better Title");
    // One list fetch — the mount's. The new title is reflected locally.
    expect(mockListChats).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the confirmation is dismissed", async () => {
    await renderList();
    openRowMenu("Old Title");
    fireEvent.click(screen.getByText("Regenerate title"));

    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByText("Regenerate Title")).toBeNull();
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it("disables the entry while a regeneration is in flight", async () => {
    const pending = deferred<{ title: string }>();
    mockRegenerate.mockReturnValue(pending.promise);

    await renderList();
    openRowMenu("Old Title");
    fireEvent.click(screen.getByText("Regenerate title"));
    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    openRowMenu("Old Title");
    const entry = screen.getByText("Regenerating title…").closest("button")!;
    expect(entry.hasAttribute("disabled")).toBe(true);

    // A second click cannot start a second run — the point of the lock.
    fireEvent.click(entry);
    expect(screen.queryByText("Regenerate Title")).toBeNull();
    expect(mockRegenerate).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ title: "A Much Better Title" });
    });
    await screen.findByText("A Much Better Title");
  });

  it("holds the lock across a refresh that remounts the row", async () => {
    const pending = deferred<{ title: string }>();
    mockRegenerate.mockReturnValue(pending.promise);

    await renderList();
    openRowMenu("Old Title");
    fireEvent.click(screen.getByText("Regenerate title"));
    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    // The refresh discovers a child chat, so the row stops being a lone entry
    // and becomes the header of a lineage group — a different element tree, so
    // React remounts the row and any state it was holding is gone.
    mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { title: "Old Title" }), makeChat("chat-2", { parentChatId: "chat-1" })]));
    await act(async () => {
      refresh();
    });
    await screen.findByTitle("Expand chat tree");

    openRowMenu("Old Title");
    expect(screen.getByText("Regenerating title…").closest("button")!.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      pending.resolve({ title: "A Much Better Title" });
    });
    await screen.findByText("A Much Better Title");
  });

  it("releases the row when the request fails", async () => {
    const failed = new Error("boom");
    mockRegenerate.mockRejectedValue(failed);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderList();
    openRowMenu("Old Title");
    fireEvent.click(screen.getByText("Regenerate title"));
    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    await waitFor(() => expect(logged).toHaveBeenCalledWith("Failed to regenerate chat title:", failed));

    // Released, not wedged: the entry is offered again rather than staying
    // disabled for the life of the page.
    openRowMenu("Old Title");
    expect(screen.getByText("Regenerate title").closest("button")!.hasAttribute("disabled")).toBe(false);
    logged.mockRestore();
  });
});
