// @vitest-environment jsdom
/**
 * Collapsing subtrees inside an expanded chat tree. Every node below the root
 * that has rows to hide gets a chevron; each starts expanded, and a fold is
 * remembered across remounts (localStorage).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatTreeNode } from "../api";
import { getChatTree } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import { resetChatTreeCollapse } from "../hooks/useChatTreeCollapse";
import ChatTreeList from "./ChatTreeList";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => mockNavigate,
}));

vi.mock("../api", () => ({
  getChatTree: vi.fn(),
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  localStorage.clear();
  resetChatSectionExpansion();
  resetChatTreeCollapse();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FOLDER = "/home/cybil/projects/callboard";

function makeChat(id: string, meta: Record<string, unknown> = {}): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    created_at: "2026-07-28T10:00:00Z",
    updated_at: "2026-07-28T10:00:00Z",
    metadata: JSON.stringify({ preview: `chat ${id}`, ...meta }),
  } as Chat;
}
const child = (id: string, parent = "root") => makeChat(id, { parentChatId: parent, rootChatId: "root" });

function makeNode(chatId: string, title: string, overrides: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return {
    chatId,
    title,
    provider: "claude-code",
    status: "stopped",
    folder: FOLDER,
    createdAt: "",
    updatedAt: "2026-07-28T10:00:00Z",
    children: [],
    ...overrides,
  };
}

/**
 * root
 * ├─ mid           (has children → toggle)
 * │  ├─ leaf
 * │  └─ deep       (has a child → toggle)
 * │     └─ deepest
 * ├─ lonely        (leaf → no toggle)
 * ├─ asideParent   (only child is a folded aside → no toggle)
 * └─ archParent    (only child is a hidden archived child → no toggle)
 */
const TREE = makeNode("root", "Root", {
  children: [
    makeNode("mid", "Mid", {
      children: [makeNode("leaf", "Leaf"), makeNode("deep", "Deep", { children: [makeNode("deepest", "Deepest")] })],
    }),
    makeNode("lonely", "Lonely"),
    makeNode("asideParent", "Aside parent", { children: [makeNode("as1", "An aside", { role: "aside" })] }),
    makeNode("archParent", "Arch parent", { children: [makeNode("arch1", "Archived one", { childArchived: true })] }),
  ],
});
const CHATS = [makeChat("root"), child("mid"), child("lonely")];

function mockTree(tree: ChatTreeNode = TREE) {
  vi.mocked(getChatTree).mockResolvedValue({ targetChatId: "root", rootChatId: "root", ancestors: [], tree });
}

function renderList(running: string[] = [], chats: Chat[] = CHATS) {
  return render(
    <MemoryRouter>
      <ChatTreeList
        chats={chats}
        refreshToken={0}
        onChatClick={() => {}}
        onDelete={() => {}}
        onToggleBookmark={() => {}}
        onTogglePin={() => {}}
        cardMenuFor={() => ({})}
        sessionStatusFor={(id) => (running.includes(id) ? { active: true, type: "web" } : undefined)}
        onDetach={() => {}}
        onSetChildArchived={async () => true}
      />
    </MemoryRouter>,
  );
}

async function expand() {
  fireEvent.click(await screen.findByTitle("Expand chat tree"));
  await screen.findByText("Mid");
}

const node = (id: string) => screen.getAllByTestId("chat-tree-node").find((el) => el.getAttribute("data-chat-id") === id);
const toggleFor = (label: string) =>
  screen.queryByRole("button", { name: `Collapse "${label}"` }) ?? screen.queryByRole("button", { name: `Expand "${label}"` });

describe("collapsible subtrees", () => {
  it("puts an expanded toggle only on non-root nodes with rows to hide", async () => {
    mockTree();
    renderList();
    await expand();
    expect(toggleFor("Mid")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("Deep")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("Root")).toBeNull();
    expect(toggleFor("Lonely")).toBeNull();
    expect(toggleFor("Leaf")).toBeNull();
    expect(toggleFor("Aside parent")).toBeNull();
    expect(toggleFor("Arch parent")).toBeNull();
    expect(screen.getAllByTestId("tree-node-toggle")).toHaveLength(2);
  });

  it("is not inside the node's link", async () => {
    mockTree();
    renderList();
    await expand();
    expect(within(node("mid")!).queryByTestId("tree-node-toggle")).toBeNull();
  });

  it("hides a node's descendants without navigating, and remembers it across a remount", async () => {
    mockTree();
    renderList();
    await expand();
    fireEvent.click(toggleFor("Mid")!);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(node("mid")).toBeTruthy();
    expect(node("leaf")).toBeUndefined();
    expect(node("deep")).toBeUndefined();
    expect(node("deepest")).toBeUndefined();
    expect(node("lonely")).toBeTruthy();
    expect(toggleFor("Mid")?.getAttribute("aria-expanded")).toBe("false");

    cleanup();
    resetChatTreeCollapse(); // a fresh read from storage, as on a reload
    renderList();
    await expand();
    expect(node("leaf")).toBeUndefined();
    fireEvent.click(toggleFor("Mid")!);
    expect(node("leaf")).toBeTruthy();
    // The inner fold was never touched, so it is still open.
    expect(node("deepest")).toBeTruthy();
  });

  it("folds a nested node on its own", async () => {
    mockTree();
    renderList();
    await expand();
    fireEvent.click(toggleFor("Deep")!);
    expect(node("deepest")).toBeUndefined();
    expect(node("leaf")).toBeTruthy();
  });

  it("still navigates when the row itself is clicked", async () => {
    mockTree();
    renderList();
    await expand();
    fireEvent.click(node("mid")!);
    expect(mockNavigate).toHaveBeenCalledWith("/chat/mid");
  });
});

describe("working indicators", () => {
  it("gives a working child the glowing dot from the live registry, even on a stale snapshot", async () => {
    mockTree();
    renderList(["lonely"]);
    await expand();
    const lonely = node("lonely")!;
    expect(within(lonely).getByTestId("running-dot")).toBeTruthy();
    expect(lonely.getAttribute("aria-label")).toBe("Lonely — working");
    expect(within(node("mid")!).queryByTestId("running-dot")).toBeNull();
  });

  it("counts working descendants on a collapsed node, and drops the count once expanded", async () => {
    mockTree();
    // The group row's members are root/mid/lonely; deepest is only in the tree.
    renderList(["deepest", "leaf"]);
    await expand();
    expect(screen.queryByTestId("subtree-running")).toBeNull();

    fireEvent.click(toggleFor("Mid")!);
    const count = within(node("mid")!).getByTestId("subtree-running");
    expect(count.textContent).toBe("22 working below");
    expect(within(count).getByTestId("running-dot")).toBeTruthy();
    expect(node("mid")!.getAttribute("aria-label")).toBe("Mid, 2 working below");

    fireEvent.click(toggleFor("Mid")!);
    expect(screen.queryByTestId("subtree-running")).toBeNull();
  });

  it("shows the group row how many of its chats are working", async () => {
    mockTree();
    renderList(["mid", "lonely"]);
    const indicator = await screen.findByTestId("chat-running");
    expect(indicator.textContent).toContain("2");
    expect(indicator.getAttribute("title")).toBe("Active in web, 2 working in this tree");
  });
});
