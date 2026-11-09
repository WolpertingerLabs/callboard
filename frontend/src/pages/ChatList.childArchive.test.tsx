// @vitest-environment jsdom
/**
 * Per-child "Archive" — putting ONE child chat away from an expanded tree's
 * context menu, as opposed to the row kebab's tree archive.
 *
 * Offered on child nodes only (never the root, never a native Codex
 * subagent). Archiving hides the child and everything under it from both the
 * expanded tree and the loaded rows, unless "Show archived" is on — then it
 * renders faded and marked, and its menu offers "Unarchive". A refusal flips
 * the node back and lands in the failure banner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse, ChatTreeNode } from "../api";
import { getChatTree, listChats, listCards, getDrafts, setChildArchived } from "../api";
import { buildRows } from "../components/ChatTreeList";
import { withoutArchivedChildren } from "../utils/childArchive";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  getChatTree: vi.fn(),
  setChildArchived: vi.fn(),
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
const mockGetChatTree = vi.mocked(getChatTree);
const mockSetChildArchived = vi.mocked(setChildArchived);

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
const CHILD = makeChat("child", { title: "Helper", parentChatId: "root", rootChatId: "root" });
const SIBLING = makeChat("sibling", { title: "Sibling", parentChatId: "root", rootChatId: "root" });

async function renderAndExpand(tree: ChatTreeNode) {
  mockGetChatTree.mockResolvedValue({ targetChatId: "root", rootChatId: "root", ancestors: [], tree });
  render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTitle("Expand chat tree"));
  await screen.findByText("Root thread", { selector: "[data-testid='chat-tree-node'] *" });
}

const nodeRow = (chatId: string) => screen.queryAllByTestId("chat-tree-node").find((el) => el.dataset.chatId === chatId);

function treeWith(child: Partial<ChatTreeNode> = {}, grandchildren: ChatTreeNode[] = []): ChatTreeNode {
  return makeNode("root", "Root thread", {
    children: [makeNode("child", "Helper", { children: grandchildren, ...child }), makeNode("sibling", "Sibling")],
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([ROOT, CHILD, SIBLING]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ChatList child archive — tree node context menu", () => {
  it("offers Archive on a child node, and archiving removes it (and its subtree) from the tree", async () => {
    await renderAndExpand(treeWith({}, [makeNode("grandchild", "Grandchild")]));
    // The server's answer from here on — the refetch `load` triggers sees it.
    mockSetChildArchived.mockImplementation(async () => {
      mockGetChatTree.mockResolvedValue({
        targetChatId: "root",
        rootChatId: "root",
        ancestors: [],
        tree: treeWith({ childArchived: true }, [makeNode("grandchild", "Grandchild")]),
      });
      return { ...CHILD };
    });
    expect(nodeRow("grandchild")).toBeDefined();
    const callsBefore = mockListChats.mock.calls.length;

    fireEvent.contextMenu(nodeRow("child")!, { clientX: 40, clientY: 60 });
    const entry = await screen.findByRole("menuitem", { name: /^Archive/ });
    await act(async () => {
      fireEvent.click(entry);
    });

    expect(mockSetChildArchived).toHaveBeenCalledWith("child", true);
    expect(nodeRow("child")).toBeUndefined();
    expect(nodeRow("grandchild")).toBeUndefined();
    expect(nodeRow("sibling")).toBeDefined();
    await waitFor(() => expect(mockListChats.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not offer it on the tree's root node", async () => {
    await renderAndExpand(treeWith());
    fireEvent.contextMenu(nodeRow("root")!);
    expect(screen.queryByRole("menuitem", { name: /^Archive/ })).toBeNull();
  });

  it("does not offer it on a native Codex subagent", async () => {
    await renderAndExpand(
      treeWith({ provider: "codex", nativeAgent: { parentThreadId: "t", lifecycle: "complete", management: "read-only", controlNote: "read-only" } }),
    );
    fireEvent.contextMenu(nodeRow("child")!);
    expect(screen.queryByRole("menuitem", { name: /^Archive/ })).toBeNull();
  });

  it("hides an already-archived child while archived chats are hidden", async () => {
    await renderAndExpand(treeWith({ childArchived: true }));
    expect(nodeRow("child")).toBeUndefined();
    expect(nodeRow("sibling")).toBeDefined();
  });

  it("with Show archived on, shows the archived child marked and faded, and offers Unarchive", async () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    await renderAndExpand(treeWith({ childArchived: true }));
    mockSetChildArchived.mockImplementation(async () => {
      mockGetChatTree.mockResolvedValue({ targetChatId: "root", rootChatId: "root", ancestors: [], tree: treeWith() });
      return { ...CHILD };
    });

    const row = nodeRow("child")!;
    expect(row).toBeDefined();
    expect(row.dataset.childArchived).toBe("true");
    expect(row.className).toContain("chatlist-item-dimmed");
    expect(row.getAttribute("aria-label")).toBe("Helper — archived");
    expect(nodeRow("sibling")!.dataset.childArchived).toBeUndefined();

    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menuitem", { name: /^Archive/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Unarchive/ }));
    });
    expect(mockSetChildArchived).toHaveBeenCalledWith("child", false);
    expect(nodeRow("child")!.dataset.childArchived).toBeUndefined();
  });

  it("flips the node back and reports the error when the server refuses", async () => {
    mockSetChildArchived.mockRejectedValue(new Error("This chat has no parent"));
    await renderAndExpand(treeWith());

    fireEvent.contextMenu(nodeRow("child")!);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Archive/ }));
    });

    await waitFor(() => expect(nodeRow("child")).toBeDefined());
    expect((await screen.findByRole("alert")).textContent).toContain('"Helper" could not be archived: This chat has no parent');
  });
});

describe("ChatList child archive — the loaded rows", () => {
  const archivedOnly = makeChat("child", { title: "Helper", parentChatId: "root", rootChatId: "root", childArchived: true });

  it("renders a root whose only child is archived as a plain row with no tree to expand", async () => {
    mockListChats.mockResolvedValue(listResponse([ROOT, archivedOnly]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("Root thread");
    expect(screen.queryByTitle("Expand chat tree")).toBeNull();
  });

  it("keeps the tree expandable when archived chats are shown", async () => {
    localStorage.setItem(KEY, JSON.stringify({ chatsShowArchived: true }));
    mockListChats.mockResolvedValue(listResponse([ROOT, archivedOnly]));
    render(
      <MemoryRouter>
        <ChatList onRefresh={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByTitle("Expand chat tree")).toBeDefined();
  });
});

describe("withoutArchivedChildren — the loaded rows", () => {
  const archivedChild = makeChat("child", { title: "Helper", parentChatId: "root", rootChatId: "root", childArchived: true });
  const grandchild = makeChat("grandchild", { parentChatId: "child", rootChatId: "root" });

  it("drops an archived child and every loaded chat under it, keeping the root and siblings", () => {
    const kept = withoutArchivedChildren([ROOT, archivedChild, grandchild, SIBLING]);
    expect(kept.map((c) => c.id)).toEqual(["root", "sibling"]);
  });

  it("returns the same array when nothing is archived", () => {
    const chats = [ROOT, CHILD, SIBLING];
    expect(withoutArchivedChildren(chats)).toBe(chats);
  });

  it("ignores a stale flag on a root — a root is archived through its card", () => {
    const staleRoot = makeChat("root", { childArchived: true });
    expect(withoutArchivedChildren([staleRoot]).map((c) => c.id)).toEqual(["root"]);
  });

  it("leaves a root whose only children are archived as a plain, ungrouped row", () => {
    const rows = buildRows(withoutArchivedChildren([ROOT, archivedChild, grandchild]));
    expect(rows).toHaveLength(1);
    expect(rows[0].chat.id).toBe("root");
    expect(rows[0].isGroup).toBe(false);
  });
});
