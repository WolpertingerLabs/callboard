/**
 * What a collapsed tree node's working count covers: what the collapse hid,
 * by the same visibility rules the tree renders with.
 */
import { describe, expect, it } from "vitest";
import type { ChatTreeNode } from "../api";
import { attentionBelow, countRunningBelow, nodeIsRunning, visibleChildren, type TreeVisibility } from "./chatTreeNodes";

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
