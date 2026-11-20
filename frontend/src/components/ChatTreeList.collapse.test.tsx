// @vitest-environment jsdom
/**
 * Collapsing subtrees inside an expanded chat tree. Every node that has rows
 * to hide — the root's own row included — gets a chevron; each starts
 * expanded, and a fold is remembered across remounts (localStorage).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatTreeNode } from "../api";
import { getChatTree } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import { resetChatTreeCollapse } from "../hooks/useChatTreeCollapse";
import { getChatTreeCollapsedIds } from "../utils/localStorage";
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

function renderList(running: string[] = [], chats: Chat[] = CHATS, activeChatId?: string) {
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
        onDetach={() => {}}
        onSetChildArchived={async () => true}
      />
    </MemoryRouter>,
  );
}

/** Tree cards start expanded: wait for the tree to arrive. */
async function expand() {
  await screen.findByRole("button", { name: 'Collapse "chat root"' });
  await screen.findByText("Mid");
}

const node = (id: string) => screen.getAllByTestId("chat-tree-node").find((el) => el.getAttribute("data-chat-id") === id);
/** A node's toggle; the root's is named by what it hides ("Hide the 7 chats under …"). */
const toggleFor = (label: string) =>
  screen.queryByRole("button", { name: new RegExp(`^((Collapse|Expand) "${label}"|(Hide|Show) the \\d+ chats? under "${label}")$`) });

describe("collapsible subtrees", () => {
  it("puts an expanded toggle only on nodes with rows to hide, the root's included", async () => {
    mockTree();
    renderList();
    await expand();
    expect(toggleFor("Root")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("Mid")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("Deep")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("Lonely")).toBeNull();
    expect(toggleFor("Leaf")).toBeNull();
    expect(toggleFor("Aside parent")).toBeNull();
    expect(toggleFor("Arch parent")).toBeNull();
    expect(screen.getAllByTestId("tree-node-toggle")).toHaveLength(3);
  });

  it("folds the root's children from its own row, keeping the root and the card", async () => {
    mockTree();
    renderList();
    await expand();
    fireEvent.click(toggleFor("Root")!);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(node("root")).toBeTruthy();
    expect(screen.getAllByTestId("chat-tree-node")).toHaveLength(1);
    expect(toggleFor("Root")?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: 'Collapse "chat root"' }).getAttribute("aria-expanded")).toBe("true");
    expect([...getChatTreeCollapsedIds()]).toEqual(["root"]);

    cleanup();
    resetChatTreeCollapse();
    renderList();
    await screen.findByRole("button", { name: 'Show the 7 chats under "Root"' });
    expect(screen.getAllByTestId("chat-tree-node")).toHaveLength(1);
    // The children's own folds are untouched underneath.
    fireEvent.click(toggleFor("Root")!);
    expect(node("deepest")).toBeTruthy();
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
    expect(node("mid")!.getAttribute("aria-label")).toBe("Mid, 3 hidden, 2 working below");

    fireEvent.click(toggleFor("Mid")!);
    expect(screen.queryByTestId("subtree-running")).toBeNull();
  });

  it("counts everything a folded root row hides, at every depth", async () => {
    mockTree(
      makeNode("root", "Root", {
        children: [
          makeNode("mid", "Mid", {
            children: [makeNode("leaf", "Leaf", { summon: { urgency: "normal", createdAt: "2026-07-28T10:00:00Z" } }), makeNode("deep", "Deep")],
          }),
          makeNode("lonely", "Lonely"),
        ],
      }),
    );
    renderList(["deep", "lonely"]);
    await expand();
    fireEvent.click(toggleFor("Root")!);
    const root = node("root")!;
    expect(within(root).getByTestId("subtree-running").textContent).toBe("22 working below");
    expect(within(root).getByTestId("subtree-attention").getAttribute("title")).toBe("1 calling for you below");
    expect(root.getAttribute("aria-label")).toBe("Root, 4 hidden, 2 working below, 1 calling for you below");
    fireEvent.click(toggleFor("Root")!);
    expect(screen.queryByTestId("subtree-running")).toBeNull();
    expect(screen.queryByTestId("subtree-attention")).toBeNull();
  });

  it("shows the group row how many of its chats are working", async () => {
    mockTree();
    renderList(["mid", "lonely"]);
    const indicator = await screen.findByTestId("chat-running");
    expect(indicator.textContent).toContain("2");
    expect(indicator.getAttribute("title")).toBe("Active in web, 2 working in this tree");
  });
});

describe("review follow-ups", () => {
  it("keeps the open chat visible under a collapsed node, without changing the stored fold", async () => {
    mockTree();
    renderList();
    await expand();
    fireEvent.click(toggleFor("Mid")!);
    expect(node("leaf")).toBeUndefined();

    cleanup();
    renderList([], CHATS, "leaf");
    await expand();
    expect(node("leaf")).toBeTruthy();
    // The reason is in the accessible name, not only the tooltip.
    const toggle = screen.getByRole("button", { name: 'Collapse "Mid" (holds the open chat)' }) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.disabled).toBe(true);
    expect(getChatTreeCollapsedIds().has("mid")).toBe(true);
    // The open chat itself still folds what is under it.
    cleanup();
    renderList([], CHATS, "mid");
    await expand();
    expect(node("leaf")).toBeUndefined();
  });

  it("keeps the open chat visible under a folded root row, without changing the stored fold", async () => {
    mockTree();
    renderList();
    await expand();
    fireEvent.click(toggleFor("Root")!);
    expect(node("lonely")).toBeUndefined();

    cleanup();
    renderList([], CHATS, "lonely");
    await expand();
    expect(node("lonely")).toBeTruthy();
    expect(node("mid")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: 'Hide the 7 chats under "Root" (holds the open chat)' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(node("root")!).queryByTestId("subtree-running")).toBeNull();
    expect(getChatTreeCollapsedIds().has("root")).toBe(true);
    // With the root itself open, its fold applies.
    cleanup();
    renderList([], CHATS, "root");
    await screen.findByRole("button", { name: 'Show the 7 chats under "Root"' });
    expect(node("mid")).toBeUndefined();
  });

  it("counts a working aside folded under a non-front member on the group row", async () => {
    mockTree();
    const asideOfMid = makeChat("midAside", { chatRole: "aside", parentChatId: "mid", rootChatId: "root" });
    renderList(["midAside"], [...CHATS, asideOfMid]);
    const indicator = await screen.findByTestId("chat-running");
    expect(indicator.getAttribute("title")).toBe("Active in web, 1 working in this tree");
    expect(within(indicator).getByTestId("running-dot")).toBeTruthy();
  });

  it("surfaces unread and summoned chats a collapsed node hides, and not once expanded", async () => {
    mockTree(
      makeNode("root", "Root", {
        children: [
          makeNode("mid", "Mid", {
            children: [
              makeNode("leaf", "Leaf", { updatedAt: "2026-07-28T10:00:00Z", lastReadAt: "2026-07-27T10:00:00Z" }),
              makeNode("deep", "Deep", { summon: { urgency: "normal", createdAt: "2026-07-28T10:00:00Z" } }),
            ],
          }),
        ],
      }),
    );
    renderList();
    await expand();
    expect(screen.queryByTestId("subtree-attention")).toBeNull();
    fireEvent.click(toggleFor("Mid")!);
    const attention = within(node("mid")!).getByTestId("subtree-attention");
    expect(attention.getAttribute("title")).toBe("1 calling for you, 1 unread below");
    expect(within(attention).getByTestId("aside-attention-summoned")).toBeTruthy();
    expect(node("mid")!.getAttribute("aria-label")).toBe("Mid, 2 hidden, 1 calling for you, 1 unread below");
    fireEvent.click(toggleFor("Mid")!);
    expect(screen.queryByTestId("subtree-attention")).toBeNull();
  });

  it("puts a collapsed node's count after its title", async () => {
    mockTree();
    renderList(["leaf"]);
    await expand();
    fireEvent.click(toggleFor("Mid")!);
    const count = within(node("mid")!).getByTestId("subtree-running");
    const title = within(node("mid")!).getByText("Mid");
    expect(title.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names the top-level toggle and reports its state", async () => {
    mockTree();
    renderList();
    const toggle = await screen.findByRole("button", { name: 'Collapse "chat root"' });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await screen.findByText("Mid");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: 'Expand "chat root"' }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Mid")).toBeNull();
  });

  it("adds no height on touch, and keeps chevrons, connectors and titles in their columns", async () => {
    const measure = () => {
      const rowOf = (id: string) => node(id)!.parentElement!;
      const slotOf = (id: string) => node(id)!.previousElementSibling as HTMLElement;
      return { rowOf, slotOf };
    };
    /** Where the slot ends in layout: a toggle is wider, by the gap it reaches across, and gives it back in margin. */
    const layoutWidth = (slot: HTMLElement) => parseInt(slot.style.width) + (parseInt(slot.style.marginRight) || 0);
    mockTree();
    renderList();
    await expand();
    const desk = measure();
    const deskWidths = ["root", "mid", "lonely", "leaf", "deep"].map((id) => desk.slotOf(id).style.width);
    // The toggle's target reaches across the 6px gap before the status dot.
    expect(desk.slotOf("root").style.width).toBe("23px");
    expect(desk.slotOf("root").style.marginRight).toBe("-6px");
    expect(desk.rowOf("mid").style.minHeight).toBe("");
    cleanup();

    mobile = true;
    renderList();
    await expand();
    const { rowOf, slotOf } = measure();
    for (const id of ["root", "mid", "lonely", "leaf"]) {
      expect(rowOf(id).style.minHeight).toBe("");
      expect(rowOf(id).style.paddingLeft).toBe("");
      // The slot spans the row's height, so the target is the full row strip.
      expect(rowOf(id).style.alignItems).toBe("stretch");
    }
    // Same layout on touch as on desktop; only the root toggle's reach grows
    // there — across the status dot, to a 36px target — and gives it back.
    expect(["mid", "lonely", "leaf", "deep"].map((id) => slotOf(id).style.width)).toEqual(deskWidths.slice(1));
    expect(slotOf("root").style.width).toBe("36px");
    expect(slotOf("root").style.zIndex).toBe("1");
    // Siblings — a parent and a leaf — put their titles in the same place.
    expect(layoutWidth(slotOf("mid"))).toBe(layoutWidth(slotOf("lonely")));
    expect(layoutWidth(slotOf("leaf"))).toBe(layoutWidth(slotOf("deep")));
    // The root's chevron sits in the card chevron's column: 8px from the row
    // edge (3px border + a slot ending 12px later).
    expect(slotOf("root").getAttribute("data-testid")).toBe("tree-node-toggle");
    expect(layoutWidth(slotOf("root"))).toBe(17);
    expect(slotOf("root").style.paddingRight).toBe("19px"); // the chevron stays at the slot's right edge
    expect(screen.getByRole("button", { name: 'Collapse "chat root"' }).style.padding).toBe("0px 2px 0px 8px");
    // Chevrons and leaf connectors share one column: both at the slot's right edge.
    expect(slotOf("mid").style.justifyContent).toBe("flex-end");
    expect(slotOf("lonely").style.justifyContent).toBe("flex-end");
    expect(slotOf("lonely").getAttribute("data-testid")).toBe("tree-node-slot");
  });
});

describe("#564 review", () => {
  it("names the root toggle by what it hides, unlike the card toggle above it", async () => {
    mockTree();
    renderList();
    await expand();
    const toggle = screen.getByRole("button", { name: 'Hide the 7 chats under "Root"' });
    expect(toggle.getAttribute("title")).toBe('Hide the 7 chats under "Root"');
    fireEvent.click(toggle);
    const folded = screen.getByRole("button", { name: 'Show the 7 chats under "Root"' });
    expect(folded.getAttribute("title")).toBe('Show the 7 chats under "Root"');
    // The card's own toggle keeps its name; no two toggles share one.
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toContain('Collapse "chat root"');
    expect(new Set(names.filter(Boolean)).size).toBe(names.filter(Boolean).length);
  });

  it("shows a folded node how many rows it hides, idle or not — visible rows only", async () => {
    mockTree();
    renderList();
    await expand();
    expect(screen.queryByTestId("subtree-hidden-count")).toBeNull();
    fireEvent.click(toggleFor("Mid")!);
    // leaf, deep, deepest — nothing working, still counted.
    const count = within(node("mid")!).getByTestId("subtree-hidden-count");
    expect(count.textContent).toBe("+3");
    expect(count.style.color).toBe("var(--text-muted)");
    expect(within(node("mid")!).queryByTestId("subtree-running")).toBeNull();
    fireEvent.click(toggleFor("Root")!);
    // Not the folded aside or the hidden archived child: 7 rows, not 9.
    expect(within(node("root")!).getByTestId("subtree-hidden-count").textContent).toBe("+7");
    fireEvent.click(toggleFor("Root")!);
    fireEvent.click(toggleFor("Mid")!);
    expect(screen.queryByTestId("subtree-hidden-count")).toBeNull();
  });

  it("draws the trunk from the root down every row below it, meeting top-level connectors", async () => {
    mockTree();
    renderList();
    await expand();
    expect(within(node("root")!.parentElement!).queryByTestId("tree-trunk")).toBeNull();
    for (const id of ["mid", "lonely", "leaf", "deepest"]) expect(within(node(id)!.parentElement!).getByTestId("tree-trunk")).toBeTruthy();
    const trunk = within(node("lonely")!.parentElement!).getByTestId("tree-trunk");
    expect(trunk.style.left).toBe("11px"); // under the root chevron's centre (8 + 6 − 3px border)
    // lonely's connector: right end at its slot edge (31 − 1), left end at the trunk.
    const connector = (node("lonely")!.previousElementSibling as HTMLElement).firstElementChild as HTMLElement;
    expect(connector.style.width).toBe("19px");
    // Deeper connectors keep the short dash.
    const leafConnector = (node("leaf")!.previousElementSibling as HTMLElement).firstElementChild as HTMLElement;
    expect(leafConnector.style.width).toBe("10px");
  });
});
