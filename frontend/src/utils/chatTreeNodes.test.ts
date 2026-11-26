/**
 * What a collapsed tree node's working count covers: what the collapse hid,
 * by the same visibility rules the tree renders with.
 */
import { describe, expect, it } from "vitest";
import type { ChatTreeNode } from "../api";
import { attentionBelow, countRunningBelow, nodeIsRunning, nodeIsWaiting, subtreeWaiting, visibleChildren, type TreeVisibility } from "./chatTreeNodes";

function makeNode(chatId: string, overrides: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return { chatId, title: chatId, provider: "claude-code", status: "stopped", folder: "/f", createdAt: "", updatedAt: "", children: [], ...overrides };
}
const OPTS: TreeVisibility = { showArchived: false, foldAsides: true };
const live =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

describe("nodeIsRunning", () => {
  it("is running when the live registry says so, even on a stale stopped snapshot", () => {
    expect(nodeIsRunning(makeNode("a", { status: "stopped" }), live("a"))).toBe(true);
  });

  it("is running when the snapshot says ongoing, though the registry does not know it (a native sub-agent)", () => {
    expect(nodeIsRunning(makeNode("a", { status: "ongoing" }), live())).toBe(true);
    expect(nodeIsRunning(makeNode("a", { status: "stopped" }), live())).toBe(false);
  });

  it("falls back to the snapshot without a registry", () => {
    expect(nodeIsRunning(makeNode("a", { status: "ongoing" }))).toBe(true);
    expect(nodeIsRunning(makeNode("a", { status: "waiting" }))).toBe(false);
  });
});

describe("countRunningBelow", () => {
  const tree = makeNode("n", {
    children: [
      makeNode("ownAside", { role: "aside" }),
      makeNode("c", { children: [makeNode("gc"), makeNode("gcAside", { role: "aside" })] }),
      makeNode("arch", { childArchived: true, children: [makeNode("underArch")] }),
    ],
  });
  const all = live("n", "ownAside", "c", "gc", "gcAside", "arch", "underArch");

  it("counts descendants and their folded asides, not the node or its own asides, nor hidden archived subtrees", () => {
    // c, gc, gcAside.
    expect(countRunningBelow(tree, false, OPTS, all)).toBe(3);
  });

  it("counts archived subtrees once they are shown", () => {
    expect(countRunningBelow(tree, false, { ...OPTS, showArchived: true }, all)).toBe(5);
  });

  it("counts an unfolded aside as a row of its own while searching", () => {
    // ownAside is now a row, and so is gcAside.
    expect(countRunningBelow(tree, false, { ...OPTS, foldAsides: false }, all)).toBe(4);
  });

  it("is zero when nothing below is working", () => {
    expect(countRunningBelow(tree, false, OPTS, live("n", "ownAside"))).toBe(0);
  });
});

describe("attentionBelow", () => {
  it("sums what the fold hides — unread, summons, waiting — not the node's own asides", () => {
    const tree = makeNode("n", {
      children: [
        makeNode("ownAside", { role: "aside", updatedAt: "2026-01-02", lastReadAt: "2026-01-01" }),
        makeNode("c", {
          status: "waiting",
          children: [
            makeNode("gc", { updatedAt: "2026-01-02", lastReadAt: "2026-01-01" }),
            makeNode("gc2", { summon: { urgency: "normal", createdAt: "2026-01-01" } }),
          ],
        }),
      ],
    });
    expect(attentionBelow(tree, false, OPTS, live())).toEqual({ running: 0, waiting: 1, unread: 1, summoned: 1 });
  });
});

describe("visibleChildren", () => {
  it("keeps a hidden archived child that holds the open chat", () => {
    const node = makeNode("n", { children: [makeNode("arch", { childArchived: true, children: [makeNode("open")] })] });
    expect(visibleChildren(node, false, OPTS)).toHaveLength(0);
    expect(visibleChildren(node, false, { ...OPTS, activeChatId: "open" }).map((c) => c.chatId)).toEqual(["arch"]);
  });
});

describe("nodeIsWaiting / subtreeWaiting", () => {
  const tree = makeNode("root", {
    children: [
      makeNode("a", { children: [makeNode("a1", { children: [makeNode("a1x")] }), makeNode("a2")] }),
      makeNode("b", { children: [makeNode("bAside", { role: "aside" })] }),
      makeNode("arch", { childArchived: true, children: [makeNode("underArch")] }),
    ],
  });
  const find = (id: string, n: ChatTreeNode = tree): ChatTreeNode | undefined => (n.chatId === id ? n : n.children.map((c) => find(id, c)).find(Boolean));

  it("reads the live poll or the snapshot for the node itself", () => {
    expect(nodeIsWaiting(makeNode("x"), live("x"))).toBe(true);
    expect(nodeIsWaiting(makeNode("x", { status: "waiting" }))).toBe(true);
    expect(nodeIsWaiting(makeNode("x", { status: "ongoing" }))).toBe(false);
  });

  it("is true on every ancestor of a waiting chat, several levels up, and on none of its siblings", () => {
    const waiting = live("a1x");
    for (const id of ["root", "a", "a1"]) expect(subtreeWaiting(find(id)!, waiting)).toBe(true);
    for (const id of ["a2", "b", "a1x"]) expect(subtreeWaiting(find(id)!, waiting)).toBe(false);
  });

  it("does not count the node itself — only what is below it", () => {
    expect(subtreeWaiting(find("a1x")!, live("a1x"))).toBe(false);
  });

  it("counts folded asides and archived children, hidden or not", () => {
    expect(subtreeWaiting(find("b")!, live("bAside"))).toBe(true);
    expect(subtreeWaiting(tree, live("underArch"))).toBe(true);
  });

  it("reads the snapshot's waiting status deep in the tree without a live poll", () => {
    const t = makeNode("r", { children: [makeNode("c", { children: [makeNode("g", { status: "waiting" })] })] });
    expect(subtreeWaiting(t)).toBe(true);
  });
});
