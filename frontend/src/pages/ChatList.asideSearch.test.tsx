// @vitest-environment jsdom
/**
 * A content search's hits are shown, asides included. Folded (the usual
 * view), an aside that matched would vanish into its parent's count — exactly
 * when both it and its parent matched. While a search is up an aside is a
 * child like any other: its parent's row is a group, and its tree shows it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  useSessionContext: () => ({
    activeSessions: new Map(),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
    awaitingChatIds: new Set<string>(),
  }),
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
const CHATS = [
  makeChat("main", "chat main"),
  makeChat("aside", "chat aside", { chatRole: "aside", parentChatId: "main", rootChatId: "main" }),
  makeChat("other", "chat other"),
];
const listResponse = (chats: Chat[]): ChatListResponse => ({ chats, hasMore: false, total: chats.length, windowRows: chats.length, stale: false });

it("shows a matching aside while a search is up, instead of folding it into its parent's count", async () => {
  vi.mocked(listChats).mockResolvedValue(listResponse(CHATS));
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(searchChatContents).mockResolvedValue({ chatIds: ["main", "aside"] } as never);
  render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText("chat main");
  // Folded: the aside is its parent's count, not a row.
  expect(screen.queryByText("chat aside")).toBeNull();
  expect(screen.getByRole("img", { name: "1 aside" })).toBeTruthy();

  const search = screen.getByPlaceholderText("Search chat contents...");
  fireEvent.change(search, { target: { value: "cache" } });
  fireEvent.keyDown(search, { key: "Enter" });
  // Both matched. Unfolded, the aside is a member of its parent's group, as a
  // matching fork would be — and the group's tree shows it.
  fireEvent.click(await screen.findByTitle("Expand chat tree"));
  const node = await screen.findByText("chat aside");
  expect(node.closest('[data-testid="chat-tree-node"]')?.getAttribute("data-chat-id")).toBe("aside");
  expect(screen.queryByText("chat other")).toBeNull();
  expect(within(document.body).queryByRole("img", { name: /^1 aside/ })).toBeNull();
});
