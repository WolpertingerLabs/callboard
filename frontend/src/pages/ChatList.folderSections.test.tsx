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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, setChatSidebarFolder } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  searchChatContents: vi.fn(),
  setChatSidebarFolder: vi.fn(),
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
  it("asks for foldered chats on the list request", async () => {
    await renderList();
    // The trailing `includeFoldered` argument, after `space`.
    expect(mockListChats.mock.calls.map((args) => args[10])).toEqual([true]);
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
