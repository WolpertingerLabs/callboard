// @vitest-environment jsdom
/**
 * Sidebar folders, end to end through the page: `includeFoldered` goes out on
 * every request path, the folder sections render between Pinned and Recent,
 * and the kebab's "Add to folder…" files the row without waiting for a
 * refetch — and "Remove from folder" takes the section away again.
 *
 * Same harness as ChatList.pinnedSections.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, setChatSidebarFolder, togglePin } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  searchChatContents: vi.fn(),
  setChatSidebarFolder: vi.fn(),
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

vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

const mockListChats = vi.mocked(listChats);
const mockSetFolder = vi.mocked(setChatSidebarFolder);

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

const headers = () =>
  screen
    .queryAllByRole("button")
    .map((el) => el.textContent ?? "")
    .filter((text) => /\(\d+\)$/.test(text));

function openRowMenu(text: string) {
  const row = screen.getByText(text).closest('div[style*="border-bottom"]')!;
  fireEvent.mouseEnter(row);
  fireEvent.click(row.querySelector('[title="Chat actions"]')!);
}

async function renderList(waitForText = "loose chat") {
  render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText(waitForText);
}

const LOOSE = makeChat("chat-loose", { preview: "loose chat" });
const FILED = makeChat("chat-filed", { preview: "filed chat", sidebarFolder: "Work" });

beforeEach(() => {
  localStorage.clear();
  resetChatSectionExpansion();
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([LOOSE]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetChatSectionExpansion();
});

describe("folder sections", () => {
  /** The trailing `includeFoldered` argument, after `space`. */
  const includeFolderedOf = () => mockListChats.mock.calls.map((args) => args[10]);

  it("asks for foldered chats on the initial load", async () => {
    await renderList();
    expect(includeFolderedOf()).toEqual([true]);
  });

  it("asks on the stale-response refetch and on every refresh, which all start at offset 0", async () => {
    let refresh: () => void = () => {};
    mockListChats.mockResolvedValueOnce({ ...listResponse([LOOSE]), stale: true });
    render(
      <MemoryRouter>
        <ChatList
          onRefresh={(fn) => {
            refresh = fn;
          }}
        />
      </MemoryRouter>,
    );
    await screen.findByText("loose chat");
    await waitFor(() => expect(includeFolderedOf()).toEqual([true, true]));
    refresh();
    await waitFor(() => expect(includeFolderedOf()).toEqual([true, true, true]));
  });

  it("does NOT ask on 'Load next page' — the first page already carried every filed tree", async () => {
    mockListChats.mockResolvedValue({ ...listResponse([LOOSE]), hasMore: true });
    await renderList();
    fireEvent.click(screen.getByText("Load next page"));
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));
    expect(includeFolderedOf()).toEqual([true, false]);
    // ...while the offset really was a later page.
    expect(mockListChats.mock.calls[1][1]).toBeGreaterThan(0);
  });

  it("renders the folder between Pinned and Recent", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, FILED, makeChat("p", { preview: "pinned chat", pinned: true })]));
    await renderList();
    expect(headers()).toEqual(["Pinned (1)", "Work (1)", "Recent (1)"]);
  });

  it("files a row from the kebab without a refetch, offering the existing folders", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, FILED]));
    mockSetFolder.mockResolvedValue(makeChat("chat-loose", { preview: "loose chat", sidebarFolder: "Work" }));
    await renderList();
    expect(headers()).toEqual(["Work (1)", "Recent (1)"]);

    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Add to folder…"));
    const dialog = screen.getByRole("dialog", { name: "Move to folder" });
    // The folder another chat names is offered.
    fireEvent.click(dialog.querySelector("button")!);

    await waitFor(() => expect(mockSetFolder).toHaveBeenCalledWith("chat-loose", "Work"));
    await waitFor(() => expect(headers()).toEqual(["Work (2)"]));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockListChats).toHaveBeenCalledTimes(1);
  });

  it("removes a row from its folder, and the last one takes the headers with it", async () => {
    mockListChats.mockResolvedValue(listResponse([LOOSE, FILED]));
    mockSetFolder.mockResolvedValue(makeChat("chat-filed", { preview: "filed chat", sidebarFolder: null }));
    await renderList();

    openRowMenu("filed chat");
    fireEvent.click(screen.getByText("Move to folder…"));
    fireEvent.click(screen.getByText("Remove from folder"));

    await waitFor(() => expect(mockSetFolder).toHaveBeenCalledWith("chat-filed", null));
    await waitFor(() => expect(headers()).toEqual([]));
  });

  it("leaves the row where it was when the server refuses", async () => {
    mockSetFolder.mockRejectedValue(new Error("Folder name cannot contain control or invisible characters"));
    await renderList();

    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Add to folder…"));
    fireEvent.change(screen.getByLabelText(/new folder/i), { target: { value: "Work" } });
    fireEvent.click(screen.getByText("Move"));

    expect((await screen.findByRole("alert")).textContent).toMatch(/control/);
    expect(headers()).toEqual([]);
  });
});

describe("pending overrides retire per field", () => {
  it("does not resurrect an older pending pin under a newer folder move's epoch", async () => {
    let refresh: () => void = () => {};
    vi.mocked(togglePin).mockResolvedValue({} as Chat);
    mockSetFolder.mockResolvedValue(makeChat("chat-loose", { preview: "loose chat", sidebarFolder: "Work" }));
    mockListChats.mockResolvedValue(listResponse([LOOSE]));
    render(
      <MemoryRouter>
        <ChatList
          onRefresh={(fn) => {
            refresh = fn;
          }}
        />
      </MemoryRouter>,
    );
    await screen.findByText("loose chat");

    // 1. Pin (epoch 1).
    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Pin"));
    await waitFor(() => expect(headers()).toEqual(["Pinned (1)"]));

    // 2. A refresh goes out AFTER the pin — so its response already reflects
    //    the pin's epoch — and is held.
    let land: (r: ChatListResponse) => void = () => {};
    mockListChats.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    refresh();
    await waitFor(() => expect(mockListChats).toHaveBeenCalledTimes(2));

    // 3. While it is out, file the chat (epoch 2).
    openRowMenu("loose chat");
    fireEvent.click(screen.getByText("Add to folder…"));
    fireEvent.change(screen.getByLabelText(/new folder/i), { target: { value: "Work" } });
    fireEvent.click(screen.getByText("Move"));
    await waitFor(() => expect(mockSetFolder).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // 4. The response: another tab unpinned the chat before it was built, and
    //    the folder move landed after. The pin override is as old as the
    //    request and must retire; only the folder move is newer.
    await act(async () => land(listResponse([makeChat("chat-loose", { preview: "loose chat", pinned: false })])));
    await waitFor(() => expect(headers()).toEqual(["Work (1)"]));
  });
});
