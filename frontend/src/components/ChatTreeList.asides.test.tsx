// @vitest-environment jsdom
/**
 * Asides in the sidebar: not rows of their own (they open in their chat's
 * side panel), but a count on their parent's row and on its node in an
 * expanded tree. An aside makes no row a group and is no member of one; an
 * aside whose parent is not in the list is listed like any chat, so it can
 * still be reached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatTreeNode } from "../api";
import { getChatTree } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import ChatTreeList, { buildRows } from "./ChatTreeList";

vi.mock("../api", () => ({
  getChatTree: vi.fn(),
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetChatSectionExpansion();
});

const FOLDER = "/home/cybil/projects/callboard";

function makeChat(id: string, meta: Record<string, unknown> = {}, updatedAt = "2026-07-28T10:00:00Z"): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    created_at: "2026-07-28T10:00:00Z",
    updated_at: updatedAt,
    metadata: JSON.stringify({ preview: `chat ${id}`, ...meta }),
  } as Chat;
}
const aside = (id: string, parent: string, root = parent) => makeChat(id, { chatRole: "aside", parentChatId: parent, rootChatId: root });

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

function renderList(chats: Chat[], activeChatId?: string, running: string[] = []) {
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
      />
    </MemoryRouter>,
  );
}

describe("buildRows with asides", () => {
  it("folds a chat's asides into its row: one lone row, counting them, at the aside's recency", () => {
    // The aside is newest (first): the row sits where it would.
    const rows = buildRows([aside("a1", "main"), makeChat("other"), makeChat("main"), aside("a2", "main")]);
    expect(rows.map((r) => r.chat.id)).toEqual(["main", "other"]);
    expect(rows[0]).toMatchObject({ isGroup: false, asideCount: 2 });
    expect(rows[0]!.members.map((m) => m.id)).toEqual(["main"]);
    expect(rows[1]!.asideCount).toBe(0);
  });

  it("keeps a real tree a group, counting the asides of the chat that fronts it", () => {
    const rows = buildRows([
      makeChat("root"),
      makeChat("child", { parentChatId: "root", rootChatId: "root" }),
      aside("a1", "root"),
      aside("a2", "child", "root"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isGroup: true, asideCount: 1 });
    expect(rows[0]!.members.map((m) => m.id)).toEqual(["root", "child"]);
  });

  it("lists an aside whose parent is not loaded, as a row of its own", () => {
    const rows = buildRows([aside("a1", "elsewhere"), makeChat("main")]);
    expect(rows.map((r) => r.chat.id)).toEqual(["a1", "main"]);
  });
});

describe("ChatTreeList with asides", () => {
  it("shows the count on the parent's row and no row for the asides", () => {
    renderList([makeChat("main"), aside("a1", "main"), aside("a2", "main")]);
    expect(screen.getByRole("img", { name: "2 asides" })).toBeTruthy();
    expect(screen.queryByText("chat a1")).toBeNull();
    expect(screen.queryByTitle(/^(Expand|Collapse) chat tree$/)).toBeNull();
  });

  it("folds aside leaves of an expanded tree into a count on their parent's node", async () => {
    vi.mocked(getChatTree).mockResolvedValueOnce({
      targetChatId: "root",
      rootChatId: "root",
      ancestors: [],
      tree: makeNode("root", "Root chat", {
        children: [
          makeNode("child", "Child"),
          makeNode("a1", "Aside: one", { role: "aside" }),
          makeNode("a2", "Aside: parent of a fork", { role: "aside", children: [makeNode("f", "Fork of aside", { role: "fork" })] }),
          makeNode("a3", "Aside: archived", { role: "aside", childArchived: true }),
        ],
      }),
    });
    renderList([makeChat("root"), makeChat("child", { parentChatId: "root", rootChatId: "root" })]);
    await screen.findByTitle("Collapse chat tree"); // cards start expanded
    await screen.findByText("Child");
    const rootNode = screen.getAllByTestId("chat-tree-node").find((el) => el.getAttribute("data-chat-id") === "root")!;
    // a1 folded; a2 has a child so it stays; a3 is archived (hidden either way).
    expect(within(rootNode).getByRole("img", { name: "1 aside" })).toBeTruthy();
    expect(screen.queryByText("Aside: one")).toBeNull();
    expect(screen.getByText("Aside: parent of a fork")).toBeTruthy();
    expect(screen.queryByText("Aside: archived")).toBeNull();
  });

  it("keeps the node of an aside that is the open chat", async () => {
    vi.mocked(getChatTree).mockResolvedValueOnce({
      targetChatId: "root",
      rootChatId: "root",
      ancestors: [],
      tree: makeNode("root", "Root chat", { children: [makeNode("child", "Child"), makeNode("a1", "Aside: one", { role: "aside" })] }),
    });
    renderList([makeChat("root"), makeChat("child", { parentChatId: "root", rootChatId: "root" })], "a1");
    await screen.findByTitle("Collapse chat tree"); // cards start expanded
    expect(await screen.findByText("Aside: one")).toBeTruthy();
  });
});

describe("running asides", () => {
  it("puts the running dot on the row's aside count, not on the row", () => {
    renderList([makeChat("main"), aside("a1", "main"), aside("a2", "main")], undefined, ["a2"]);
    const count = screen.getByRole("img", { name: "2 asides, 1 running" });
    expect(within(count).getByTestId("running-dot")).toBeTruthy();
    // The row itself reports the parent chat, which is idle.
    expect(screen.getAllByTestId("running-dot")).toHaveLength(1);
  });

  it("puts it on a tree node's count too", async () => {
    vi.mocked(getChatTree).mockResolvedValueOnce({
      targetChatId: "root",
      rootChatId: "root",
      ancestors: [],
      tree: makeNode("root", "Root chat", { children: [makeNode("child", "Child"), makeNode("a1", "Aside: one", { role: "aside" })] }),
    });
    renderList([makeChat("root"), makeChat("child", { parentChatId: "root", rootChatId: "root" })], undefined, ["a1"]);
    await screen.findByTitle("Collapse chat tree"); // cards start expanded
    await screen.findByText("Child");
    const rootNode = screen.getAllByTestId("chat-tree-node").find((el) => el.getAttribute("data-chat-id") === "root")!;
    expect(within(rootNode).getByRole("img", { name: "1 aside, 1 running" })).toBeTruthy();
  });
});

describe("attention from folded asides (they are not members, but the row speaks for them)", () => {
  const T0 = "2026-07-28T10:00:00Z";
  const T1 = "2026-07-28T11:00:00Z";

  it("rolls an aside's unread reply, summon and recency into a lone parent row", () => {
    const parent = makeChat("main", { lastReadAt: T0 }, T0);
    const unread = makeChat("a1", { chatRole: "aside", parentChatId: "main", rootChatId: "main", lastReadAt: T0 }, T1);
    const called = makeChat(
      "a2",
      { chatRole: "aside", parentChatId: "main", rootChatId: "main", summon: { message: "look", urgency: "urgent", createdAt: T1 } },
      T0,
    );
    const [row] = buildRows([unread, parent, called]);
    expect(row!.members.map((m) => m.id)).toEqual(["main"]);
    expect(row!.activity).toMatchObject({ hasUnread: true, updatedAt: T1, summonChatId: "a2" });

    renderList([unread, parent, called]);
    expect(screen.getByTitle("Unread messages")).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 asides, 1 calling for you, 1 unread" })).toBeTruthy();
    // The row's time is the aside's — the recency that placed it.
    expect(screen.getByText(new RegExp(new Date(T1).toLocaleDateString(undefined, { month: "short", day: "numeric" })))).toBeTruthy();
  });

  it("counts running asides in their section's running total", () => {
    renderList([makeChat("main", { pinned: true }), aside("a1", "main")], undefined, ["a1"]);
    expect(screen.getByTestId("section-running").getAttribute("title")).toBe("1 running");
  });

  it("does not fold the aside that is the open chat: it is a member, in a group with its parent", () => {
    const rows = buildRows([makeChat("main"), aside("a1", "main")], "a1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isGroup: true, asideCount: 0 });
    expect(rows[0]!.members.map((m) => m.id).sort()).toEqual(["a1", "main"]);
  });

  it("does not fold an aside with chats of its own, as the tree does not", () => {
    const rows = buildRows([makeChat("main"), aside("a1", "main"), makeChat("f1", { chatRole: "fork", parentChatId: "a1", rootChatId: "main" })]);
    expect(rows[0]).toMatchObject({ isGroup: true, asideCount: 0 });
    expect(rows[0]!.members.map((m) => m.id).sort()).toEqual(["a1", "f1", "main"]);
  });
});

it("folds an aside whose only child is archived and hidden, in the tree as in the row", async () => {
  vi.mocked(getChatTree).mockResolvedValueOnce({
    targetChatId: "root",
    rootChatId: "root",
    ancestors: [],
    tree: makeNode("root", "Root chat", {
      children: [
        makeNode("child", "Child"),
        makeNode("a1", "Aside: with an archived fork", { role: "aside", children: [makeNode("f", "Archived fork", { role: "fork", childArchived: true })] }),
      ],
    }),
  });
  renderList([makeChat("root"), makeChat("child", { parentChatId: "root", rootChatId: "root" })]);
  await screen.findByTitle("Collapse chat tree"); // cards start expanded
  await screen.findByText("Child");
  const rootNode = screen.getAllByTestId("chat-tree-node").find((el) => el.getAttribute("data-chat-id") === "root")!;
  expect(within(rootNode).getByRole("img", { name: "1 aside" })).toBeTruthy();
  expect(screen.queryByText("Aside: with an archived fork")).toBeNull();
});
