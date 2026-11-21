// @vitest-environment jsdom
/**
 * A submitted content search says so under the search box — the query, how
 * many chats it left, and a way out. Keyed on the submitted query, not the
 * draft in the box: typing alone narrows nothing, so it shows nothing.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resetChatTreeCollapse } from "../hooks/useChatTreeCollapse";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, searchChatContents } from "../api";
import ChatList from "./ChatList";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(async () => []),
  searchChatContents: vi.fn(),
  getChatTree: vi.fn(async () => ({
    targetChatId: "main",
    rootChatId: "main",
    ancestors: [],
    tree: {
      chatId: "main",
      title: "chat main",
      provider: "claude-code",
      status: "stopped",
      folder: "/f",
      createdAt: "",
      updatedAt: "2026-08-20T11:00:00.000Z",
      children: [
        {
          chatId: "aside",
          title: "chat aside",
          role: "aside",
          provider: "claude-code",
          status: "stopped",
          folder: "/f",
          createdAt: "",
          updatedAt: "2026-08-20T11:00:00.000Z",
          children: [],
        },
      ],
    },
  })),
}));
vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({ activeSessions: new Map(), connected: true, metadataVersion: 0, summonedChatIds: new Set<string>() }),
}));
vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

afterEach(() => {
  // Opened tree cards persist in a module-level store; start each test with every card closed.
  localStorage.removeItem("callboard-chat-tree-cards-expanded");
  resetChatTreeCollapse();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetChatSectionExpansion();
});

const FOLDER = "/home/cybil/projects/callboard";
function makeChat(id: string, preview: string): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    session_log_path: null,
    metadata: JSON.stringify({ preview }),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
  } as Chat;
}
const CHATS = [makeChat("one", "chat one"), makeChat("two", "chat two"), makeChat("three", "chat three")];
const listResponse = (chats: Chat[]): ChatListResponse => ({ chats, hasMore: false, total: chats.length, windowRows: chats.length, stale: false });

it("shows the submitted query and its count, and Clear search restores the full list", async () => {
  vi.mocked(listChats).mockResolvedValue(listResponse(CHATS));
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(searchChatContents).mockResolvedValue({ chatIds: ["two"] } as never);
  render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText("chat one");
  expect(screen.queryByText(/Searching for/)).toBeNull();

  const search = screen.getByPlaceholderText("Search chat contents...") as HTMLInputElement;
  // A draft alone is not a search.
  fireEvent.change(search, { target: { value: "cache" } });
  expect(screen.queryByText(/Searching for/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

  fireEvent.keyDown(search, { key: "Enter" });
  expect(await screen.findByText('Searching for "cache" · 1 chat')).toBeTruthy();
  expect(searchChatContents).toHaveBeenCalledWith("cache");
  expect(screen.getByText("chat two")).toBeTruthy();
  expect(screen.queryByText("chat one")).toBeNull();
  expect(screen.queryByText("chat three")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.queryByText(/Searching for/)).toBeNull();
  expect(search.value).toBe("");
  expect(await screen.findByText("chat one")).toBeTruthy();
  expect(screen.getByText("chat two")).toBeTruthy();
  expect(screen.getByText("chat three")).toBeTruthy();
});
