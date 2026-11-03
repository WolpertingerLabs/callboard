// @vitest-environment jsdom
/**
 * "Split off as standalone chat" — removing a child chat's parent link.
 *
 * Offered where a child is the thing on screen: the right-click / long-press
 * menu on an expanded tree's child nodes, and the kebab of a group row fronted
 * by a child (its root not loaded). Never on a root, and never on a native
 * Codex subagent, whose parent is re-read from its rollout. Success refetches
 * the list; a refusal lands in the sidebar's failure banner in the server's
 * words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse, ChatTreeNode } from "../api";
import { detachChat, getChatTree, listChats, listCards, getDrafts } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  getChatTree: vi.fn(),
  detachChat: vi.fn(),
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
const mockDetach = vi.mocked(detachChat);
const mockGetChatTree = vi.mocked(getChatTree);

const FOLDER = "/home/cybil/projects/callboard";
const SPLIT = "Split off as standalone chat";

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

function makeNode(chatId: string, title: string, overrides: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return {
    chatId,
    title,
    provider: "claude-code",
    status: "stopped",
    folder: FOLDER,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T11:00:00.000Z",
    children: [],
    ...overrides,
  };
}

function listResponse(chats: Chat[]): ChatListResponse {
  return { chats, hasMore: false, total: chats.length, windowRows: chats.length, stale: false };
}

const ROOT = makeChat("root", { title: "Root thread" });
const CHILD = makeChat("child", { title: "Helper", parentChatId: "root", rootChatId: "root", chatRole: "subagent" });

async function renderAndExpand(children: ChatTreeNode[] = [makeNode("child", "Helper", { role: "subagent" })]) {
  mockGetChatTree.mockResolvedValue({ targetChatId: "root", rootChatId: "root", ancestors: [], tree: makeNode("root", "Root thread", { children }) });
  render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTitle("Expand chat tree"));
  await screen.findByText(children[0].title!);
}

/** The tree node row for a title — the element carrying `title={label}`. */
const nodeRow = (title: string) => screen.getAllByTitle(title).find((el) => el.textContent?.includes(title) && el.style.paddingLeft !== "")!;

beforeEach(() => {
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([ROOT, CHILD]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatList split off — tree node context menu", () => {
  it("offers the action on a child node and calls the API, then refetches the list", async () => {
    mockDetach.mockResolvedValue({ ...CHILD, metadata: JSON.stringify({ title: "Helper" }) });
    await renderAndExpand();
    const callsBefore = mockListChats.mock.calls.length;

    fireEvent.contextMenu(nodeRow("Helper"), { clientX: 40, clientY: 60 });
    const entry = await screen.findByText(SPLIT);
    await act(async () => {
      fireEvent.click(entry);
    });

    expect(mockDetach).toHaveBeenCalledWith("child");
    expect(screen.queryByText(SPLIT)).toBeNull();
    await waitFor(() => expect(mockListChats.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not offer it on the tree's root node", async () => {
    await renderAndExpand();
    const root = nodeRow("Root thread");
    const event = fireEvent.contextMenu(root);
    expect(screen.queryByText(SPLIT)).toBeNull();
    // Unhandled, so the browser's own menu is left alone.
    expect(event).toBe(true);
  });

  it("does not offer it on a native Codex subagent", async () => {
    await renderAndExpand([
      makeNode("child", "Helper", {
        provider: "codex",
        nativeAgent: { parentThreadId: "t", lifecycle: "complete", management: "read-only", controlNote: "read-only" },
      }),
    ]);
    fireEvent.contextMenu(nodeRow("Helper"));
    expect(screen.queryByText(SPLIT)).toBeNull();
  });

  it("closes on Escape without calling the API", async () => {
    await renderAndExpand();
    fireEvent.contextMenu(nodeRow("Helper"));
    await screen.findByText(SPLIT);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(SPLIT)).toBeNull();
    expect(mockDetach).not.toHaveBeenCalled();
  });

  it("says why when the server refuses", async () => {
    mockDetach.mockRejectedValue(new Error("This chat has no parent — it is already a standalone chat"));
    await renderAndExpand();
    fireEvent.contextMenu(nodeRow("Helper"));
    await act(async () => {
      fireEvent.click(await screen.findByText(SPLIT));
    });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain('"Helper" could not be split off');
    expect(banner.textContent).toContain("already a standalone chat");
  });
});

describe("ChatList split off — row kebab", () => {
  /** The row element ChatListItem renders as its root — see ChatList.editTitle.test.tsx. */
  const rowOf = (title: string) => screen.getByText(title).parentElement!.parentElement!.parentElement!;
  const openKebab = (title: string) => {
    fireEvent.mouseEnter(rowOf(title));
    fireEvent.click(screen.getByTitle("Chat actions"));
  };

  it("offers it on a row fronted by a child whose root is not loaded", async () => {
    mockDetach.mockResolvedValue(CHILD);
    mockListChats.mockResolvedValue(listResponse([CHILD]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("Helper");
    openKebab("Helper");
    await act(async () => {
      fireEvent.click(screen.getByText(SPLIT));
    });
    expect(mockDetach).toHaveBeenCalledWith("child");
  });

  it("does not offer it on a standalone chat", async () => {
    mockListChats.mockResolvedValue(listResponse([makeChat("solo", { title: "Solo" })]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("Solo");
    openKebab("Solo");
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(screen.queryByText(SPLIT)).toBeNull();
  });

  it("does not offer it on a group row fronted by its root", async () => {
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("Root thread");
    openKebab("Root thread");
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(screen.queryByText(SPLIT)).toBeNull();
  });
});
