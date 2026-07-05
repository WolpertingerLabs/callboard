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

const { resolveParentage, getAncestors, buildChatTree, getParentChatId } = await import("./chat-lineage.js");
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
