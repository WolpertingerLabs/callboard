/**
 * Unit tests for the chat-lineage service — parentage resolution at chat
 * creation, forkedFrom aliasing, ancestor walks, tree assembly, orphaned
 * parents, and the visited-set guard against corrupt (cyclic) data.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is resolved from this env var when utils/paths.js first loads, so
// it must be set before the service modules are imported (hence dynamic import).
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-lineage-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

// chat-lineage imports hasPendingRequest from the (heavy) claude.js module —
// stub it so the tests don't pull in the agent SDK stack.
vi.mock("./claude.js", () => ({
  hasPendingRequest: () => false,
}));

const { resolveParentage, getAncestors, buildChatTree, getParentChatId, paginateTreeRows, buildLineageIndex } = await import("./chat-lineage.js");
type ChatTreeNode = import("shared/types/index.js").ChatTreeNode;

const chatsDir = join(tmpRoot, "chats");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
});

let counter = 0;

/** Write a chat file the way chat-file-service stores them (keyed by session_id). */
function writeChat(id: string, metadata: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  counter += 1;
  const sessionId = `session-${id}`;
  const createdAt = new Date(1700000000000 + counter * 60_000).toISOString();
  const chat = {
    id,
    folder: "/tmp/repo",
    session_id: sessionId,
    session_log_path: null,
    metadata: JSON.stringify(metadata),
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
  writeFileSync(join(chatsDir, `${sessionId}.json`), JSON.stringify(chat, null, 2));
  return chat;
}

describe("getParentChatId", () => {
  it("prefers parentChatId and aliases legacy forkedFrom", () => {
    expect(getParentChatId({ parentChatId: "a", forkedFrom: "b" })).toBe("a");
    expect(getParentChatId({ forkedFrom: "b" })).toBe("b");
    expect(getParentChatId({})).toBeUndefined();
    expect(getParentChatId({ parentChatId: "" })).toBeUndefined();
  });
});

describe("resolveParentage", () => {
  it("returns null when the parent chat has no record (temp tracking id)", () => {
    expect(resolveParentage("new-1234567890")).toBeNull();
  });

  it("roots a chain at the parent when the parent has no lineage", () => {
    writeChat("root");
    expect(resolveParentage("root")).toEqual({ parentChatId: "root", rootChatId: "root" });
  });

  it("propagates the parent's denormalized rootChatId", () => {
    writeChat("root");
    writeChat("mid", { parentChatId: "root", rootChatId: "root" });
    expect(resolveParentage("mid")).toEqual({ parentChatId: "mid", rootChatId: "root" });
  });

  it("walks legacy forkedFrom chains lacking rootChatId", () => {
    writeChat("root");
    writeChat("fork1", { forkedFrom: "root" });
    writeChat("fork2", { forkedFrom: "fork1" });
    expect(resolveParentage("fork2")).toEqual({ parentChatId: "fork2", rootChatId: "root" });
  });

  it("treats a dangling parent pointer as the root boundary", () => {
    writeChat("orphan", { parentChatId: "deleted-chat" });
    expect(resolveParentage("orphan")).toEqual({ parentChatId: "orphan", rootChatId: "orphan" });
  });
});

describe("getAncestors", () => {
  it("returns ancestors root-first with titles and roles", () => {
    writeChat("root", { title: "Root chat" });
    writeChat("mid", { parentChatId: "root", rootChatId: "root", chatRole: "subagent", title: "Mid" });
    writeChat("leaf", { parentChatId: "mid", rootChatId: "root", chatRole: "monitor" });

    expect(getAncestors("leaf")).toEqual([
      { chatId: "root", title: "Root chat" },
      { chatId: "mid", title: "Mid", role: "subagent" },
    ]);
    expect(getAncestors("root")).toEqual([]);
  });

  it("survives cyclic corrupt data via the visited set", () => {
    writeChat("a", { parentChatId: "b" });
    writeChat("b", { parentChatId: "a" });
    const ancestors = getAncestors("a");
    expect(ancestors.map((n: { chatId: string }) => n.chatId)).toEqual(["b"]);
  });
});

describe("buildChatTree", () => {
  it("returns null for unknown chats", () => {
    expect(buildChatTree("nope")).toBeNull();
  });

  it("assembles the full tree from any node, cross-provider, children in spawn order", () => {
    writeChat("root", { title: "Router" });
    writeChat("main", { parentChatId: "root", rootChatId: "root", chatRole: "main" });
    writeChat("codex-sub", { parentChatId: "main", rootChatId: "root", chatRole: "subagent", provider: "codex" });
    writeChat("or-monitor", { parentChatId: "main", rootChatId: "root", chatRole: "monitor", provider: "openrouter" });
    writeChat("unrelated");

    const result = buildChatTree("codex-sub");
    expect(result).not.toBeNull();
    expect(result!.targetChatId).toBe("codex-sub");
    expect(result!.rootChatId).toBe("root");
    expect(result!.ancestors.map((a: { chatId: string }) => a.chatId)).toEqual(["root", "main"]);

    expect(result!.tree.chatId).toBe("root");
    expect(result!.tree.provider).toBe("claude-code");
    expect(result!.tree.children).toHaveLength(1);

    const main = result!.tree.children[0];
    expect(main.chatId).toBe("main");
    expect(main.role).toBe("main");
    expect(main.children.map((c: { chatId: string }) => c.chatId)).toEqual(["codex-sub", "or-monitor"]);
    expect(main.children[0].provider).toBe("codex");
    expect(main.children[1].provider).toBe("openrouter");

    // Unrelated chats never leak into the tree.
    const flat: string[] = [];
    const walk = (n: ChatTreeNode) => {
      flat.push(n.chatId);
      n.children.forEach(walk);
    };
    walk(result!.tree);
    expect(flat).not.toContain("unrelated");
  });

  it("treats a child of a deleted parent as a root", () => {
    writeChat("child", { parentChatId: "deleted", rootChatId: "deleted", chatRole: "subagent" });
    writeChat("grandchild", { parentChatId: "child", rootChatId: "deleted" });

    const result = buildChatTree("grandchild");
    expect(result!.rootChatId).toBe("child");
    expect(result!.tree.chatId).toBe("child");
    expect(result!.tree.children.map((c) => c.chatId)).toEqual(["grandchild"]);
  });

  it("survives cyclic corrupt data via the visited set", () => {
    writeChat("a", { parentChatId: "b" });
    writeChat("b", { parentChatId: "a" });
    const result = buildChatTree("a");
    expect(result).not.toBeNull();
    // Whatever node wins as root, the walk must terminate and include both once.
    const flat: string[] = [];
    const walk = (n: ChatTreeNode) => {
      flat.push(n.chatId);
      n.children.forEach(walk);
    };
    walk(result!.tree);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("marks statuses stopped when no session registry entries exist", () => {
    writeChat("root");
    const result = buildChatTree("root");
    expect(result!.tree.status).toBe("stopped");
  });
});

describe("buildLineageIndex", () => {
  /** Snapshot record shorthand (no file storage involved — pure function). */
  const rec = (id: string, metadata: Record<string, unknown> = {}) => ({ id, metadata: JSON.stringify(metadata) });

  it("resolves chains to the existing root and memoizes the whole path", () => {
    const index = buildLineageIndex([
      rec("root"),
      rec("mid", { parentChatId: "root", rootChatId: "root" }),
      rec("leaf", { parentChatId: "mid", rootChatId: "root" }),
      rec("solo"),
    ]);
    expect(index.rootKeyOf("leaf")).toBe("root");
    expect(index.rootKeyOf("mid")).toBe("root");
    expect(index.rootKeyOf("root")).toBe("root");
    expect(index.rootKeyOf("solo")).toBe("solo");
    expect(index.parentIdOf("leaf")).toBe("mid");
    expect(index.parentIdOf("root")).toBeUndefined();
    expect(index.childrenByParent.get("root")?.map((c) => c.id)).toEqual(["mid"]);
  });

  it("folds orphaned siblings of a deleted parent under one key (matches the sidebar's client-side fallback)", () => {
    // Parent P was deleted; both children keep stamped pointers. The client
    // (ChatTreeList lineageOf) groups them under rootChatId || parentId —
    // the server row key must agree or pages render fewer rows than limit.
    const index = buildLineageIndex([rec("b", { parentChatId: "p", rootChatId: "p" }), rec("c", { parentChatId: "p", rootChatId: "p" })]);
    expect(index.rootKeyOf("b")).toBe("p");
    expect(index.rootKeyOf("c")).toBe("p");
    // Card identity cannot use the synthetic missing key: each highest
    // surviving descendant becomes an actual root that can hold card fields.
    expect(index.existingRootIdOf("b")).toBe("b");
    expect(index.existingRootIdOf("c")).toBe("c");
  });

  it("resolves the highest existing root for cards, including stamped job-step chats", () => {
    const index = buildLineageIndex([
      rec("root"),
      rec("child", { parentChatId: "root", rootChatId: "root" }),
      rec("step", { rootChatId: "root", jobRunId: "run-1" }),
      rec("orphan", { parentChatId: "gone", rootChatId: "gone" }),
      rec("orphan-child", { parentChatId: "orphan", rootChatId: "gone" }),
    ]);
    expect(index.existingRootIdOf("child")).toBe("root");
    expect(index.existingRootIdOf("step")).toBe("root");
    expect(index.existingRootIdOf("orphan")).toBe("orphan");
    expect(index.existingRootIdOf("orphan-child")).toBe("orphan");
  });

  it("keys legacy forkedFrom orphans (no rootChatId stamp) on the dangling parent id", () => {
    const index = buildLineageIndex([rec("f1", { forkedFrom: "gone" }), rec("f2", { forkedFrom: "gone" })]);
    expect(index.rootKeyOf("f1")).toBe("gone");
    expect(index.rootKeyOf("f2")).toBe("gone");
  });

  it("treats unknown ids (filesystem-only sessions) as their own root", () => {
    const index = buildLineageIndex([rec("a")]);
    expect(index.rootKeyOf("session-without-record")).toBe("session-without-record");
  });

  it("terminates on cyclic corrupt data with one shared key", () => {
    const index = buildLineageIndex([rec("a", { parentChatId: "b" }), rec("b", { parentChatId: "a" })]);
    expect(index.rootKeyOf("a")).toBe(index.rootKeyOf("b"));
  });

  it("ignores self-parent pointers and unparseable metadata", () => {
    const index = buildLineageIndex([rec("selfie", { parentChatId: "selfie" }), { id: "broken", metadata: "{not json" }]);
    expect(index.rootKeyOf("selfie")).toBe("selfie");
    expect(index.parentIdOf("selfie")).toBeUndefined();
    expect(index.rootKeyOf("broken")).toBe("broken");
  });

  it("paginates real lineage keys: folded trees and orphan groups each take one row", () => {
    // Recency order: leaf (tree A), orphan1, solo, orphan2 (folds into
    // orphan1's row), root (folds into tree A's row), other.
    const index = buildLineageIndex([
      rec("root"),
      rec("leaf", { parentChatId: "root", rootChatId: "root" }),
      rec("orphan1", { parentChatId: "gone", rootChatId: "gone" }),
      rec("orphan2", { parentChatId: "gone", rootChatId: "gone" }),
      rec("solo"),
      rec("other"),
    ]);
    const items = ["leaf", "orphan1", "solo", "orphan2", "root", "other"];
    const { page, total, windowRows } = paginateTreeRows(items, index.rootKeyOf, 3, 0);
    // Rows: [leaf,root], [orphan1,orphan2], [solo] — window of 3 rows
    expect(page).toEqual(["leaf", "orphan1", "solo", "orphan2", "root"]);
    expect(total).toBe(4);
    expect(windowRows).toBe(3);
  });
});

describe("paginateTreeRows", () => {
  /** Items keyed by their own id (standalone) unless mapped to a root. */
  const roots: Record<string, string> = { a1: "a", a2: "a", a3: "a", b1: "b" };
  const keyOf = (id: string) => roots[id] ?? id;

  it("folds same-root items into one row so a page still fills the limit", () => {
    // Rows in order: [a1,a2,a3] → a, [x] , [b1] → b, [y]
    const items = ["a1", "a2", "a3", "x", "b1", "y"];
    const page = paginateTreeRows(items, keyOf, 3, 0);
    expect(page.page).toEqual(["a1", "a2", "a3", "x", "b1"]);
    expect(page.total).toBe(4);
    expect(page.windowRows).toBe(3);
  });

  it("offsets by rows, not items", () => {
    const items = ["a1", "a2", "a3", "x", "b1", "y"];
    const page = paginateTreeRows(items, keyOf, 2, 2);
    expect(page.page).toEqual(["b1", "y"]);
    expect(page.total).toBe(4);
    expect(page.windowRows).toBe(2);
  });

  it("preserves the original recency order within a page", () => {
    // b1 (row b) appears between members of row a — order must survive
    const items = ["a1", "b1", "a2"];
    const page = paginateTreeRows(items, keyOf, 2, 0);
    expect(page.page).toEqual(["a1", "b1", "a2"]);
    expect(page.windowRows).toBe(2);
  });

  it("returns an empty short page past the end", () => {
    const items = ["a1", "x"];
    expect(paginateTreeRows(items, keyOf, 20, 2)).toEqual({ page: [], total: 2, windowRows: 0 });
    const short = paginateTreeRows(items, keyOf, 20, 1);
    expect(short.page).toEqual(["x"]);
    expect(short.windowRows).toBe(1);
  });

  it("degenerates to plain pagination when no items share a root", () => {
    const items = ["p", "q", "r"];
    const page = paginateTreeRows(items, (id) => id, 2, 1);
    expect(page.page).toEqual(["q", "r"]);
    expect(page.total).toBe(3);
    expect(page.windowRows).toBe(2);
  });
});
