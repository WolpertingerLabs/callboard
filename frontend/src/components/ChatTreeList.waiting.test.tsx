// @vitest-environment jsdom
/**
 * The yellow "waiting on you" dot in a chat tree: a chat blocked on the user
 * (a permission prompt, question or open approval) turns its own dot yellow,
 * and every ancestor's — node by node in an expanded tree, and the group row
 * that stands for the whole tree — so a question deep in a tree shows at the
 * root. Siblings stay as they were.
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

let mobile = false;
vi.mock("../hooks/useIsMobile", () => ({ useIsMobile: () => mobile }));

vi.mock("../api", () => ({
  getChatTree: vi.fn(),
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  mobile = false;
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

function renderList(running: string[] = [], chats: Chat[] = CHATS, activeChatId?: string, awaiting: string[] = []) {
  return render(
    <MemoryRouter>
      <ChatTreeList
        chats={chats}
        refreshToken={0}
        activeChatId={activeChatId}
        onChatClick={() => {}}
        onDelete={() => {}}
        onToggleBookmark={() => {}}
        onTogglePin={() => {}}
        cardMenuFor={() => ({})}
        sessionStatusFor={(id) => (running.includes(id) ? { active: true, type: "web" } : undefined)}
        isAwaiting={(id) => awaiting.includes(id)}
        onDetach={() => {}}
        onSetChildArchived={async () => true}
      />
    </MemoryRouter>,
  );
}

/**
 * Open the tree card — cards start closed — or, after a remount, find it
 * still open: an opened card is remembered.
 */
async function expand() {
  const card = await screen.findByRole("button", { name: /^(Expand|Collapse) "chat root"$/ });
  if (card.getAttribute("aria-expanded") === "false") fireEvent.click(card);
  await screen.findByText("Mid");
}

const node = (id: string) => screen.getAllByTestId("chat-tree-node").find((el) => el.getAttribute("data-chat-id") === id);
const waitingIn = (id: string) => !!within(node(id)!).queryByTestId("tree-node-waiting");
const groupDot = () => screen.getAllByTestId("chat-running")[0];

describe("waiting on the user", () => {
  it("turns the group row yellow when a loaded member is waiting, with no run behind it", async () => {
    mockTree();
    renderList([], CHATS, undefined, ["mid"]);
    const dot = await screen.findByTestId("chat-running");
    expect(dot.getAttribute("data-tone")).toBe("waiting");
    expect(dot.getAttribute("title")).toBe("Waiting for your answer");
    expect(within(dot).getByTestId("running-dot").style.background).toBe("var(--warning)");
  });

  it("turns the group row's working count yellow when one of the working chats is waiting", async () => {
    mockTree();
    renderList(["mid", "lonely"], CHATS, undefined, ["lonely"]);
    const dot = await screen.findByTestId("chat-running");
    expect(dot.getAttribute("data-tone")).toBe("waiting");
    expect(dot.getAttribute("title")).toBe("Waiting for your answer, 2 working in this tree");
    expect(dot.style.color).toBe("var(--warning)");
  });

  it("stays green when nothing in the tree is waiting", async () => {
    mockTree();
    renderList(["mid"]);
    expect((await screen.findByTestId("chat-running")).getAttribute("data-tone")).toBe("running");
  });

  it("paints every ancestor of a deep waiting chat yellow, and not its siblings", async () => {
    mockTree();
    // deepest is only in the fetched tree, not a row of the list.
    renderList(["leaf"], CHATS, undefined, ["deepest"]);
    await expand();
    for (const id of ["deepest", "deep", "mid", "root"]) expect(waitingIn(id)).toBe(true);
    for (const id of ["leaf", "lonely", "asideParent", "archParent"]) expect(waitingIn(id)).toBe(false);
    // A working sibling keeps its green dot.
    expect(within(node("leaf")!).getByTestId("running-dot").getAttribute("data-tone")).toBe("running");
    expect(node("deepest")!.getAttribute("aria-label")).toBe("Deepest — waiting for your answer");
    expect(node("mid")!.getAttribute("aria-label")).toBe("Mid — a chat below is waiting for your answer");
    // The group row reads the fetched tree, so it is yellow too.
    expect(groupDot().getAttribute("data-tone")).toBe("waiting");
  });

  it("reads the fetched tree's own waiting status as well as the live poll", async () => {
    mockTree(
      makeNode("root", "Root", {
        children: [makeNode("mid", "Mid", { children: [makeNode("leaf", "Leaf", { status: "waiting" })] }), makeNode("lonely", "Lonely")],
      }),
    );
    renderList();
    await expand();
    for (const id of ["leaf", "mid", "root"]) expect(waitingIn(id)).toBe(true);
    expect(waitingIn("lonely")).toBe(false);
  });

  it("carries a folded aside's question up to its parent and the root", async () => {
    mockTree();
    renderList([], CHATS, undefined, ["as1"]);
    await expand();
    expect(waitingIn("asideParent")).toBe(true);
    expect(waitingIn("root")).toBe(true);
    expect(waitingIn("mid")).toBe(false);
  });

  it("carries a hidden archived child's question up to its parent", async () => {
    mockTree();
    renderList([], CHATS, undefined, ["arch1"]);
    await expand();
    expect(waitingIn("archParent")).toBe(true);
    expect(waitingIn("root")).toBe(true);
  });
});
