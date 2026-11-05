/**
 * supersedeChat — a new chat takes the original's place in the tree and the
 * original becomes its child. Over a real (temp-dir) chat store, so the lineage
 * reads that decide the new shape (walkToRootId, buildChatTree) run against
 * exactly what the service wrote.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-supersede-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const running = vi.hoisted(() => new Set<string>());
vi.mock("./claude.js", () => ({ getActiveSession: () => null, hasPendingRequest: () => false, getPendingRequest: () => null }));
vi.mock("./session-registry.js", () => ({ sessionRegistry: { has: (id: string) => running.has(id), notifyMetadata: () => {} } }));

const { chatFileService } = await import("./chat-file-service.js");
const { walkToRootId, buildChatTree } = await import("./chat-lineage.js");
const { checkSupersedable, keptStars, supersedeChat, SupersedeRefusedError } = await import("./chat-supersede.js");
const { pendingRequests } = await import("./pending-requests.js");
const { registerCompletionCallback, listPendingForParent, removeCallbacks } = await import("./session-callbacks.js");

/** A minimal open prompt, as pending-requests stores one. */
function openPrompt(key: string, offeredToParent?: string) {
  pendingRequests.set(key, { eventType: "permission_request", toolName: "Bash", ...(offeredToParent && { offeredToParent }) } as any);
}

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const created: string[] = [];
function makeChat(meta: Record<string, unknown> = {}, workspaceId?: string) {
  const chat = chatFileService.createChat("/repos/supersede", `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta), workspaceId);
  created.push(chat.session_id);
  return chat;
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata);
const T = "2026-01-01T10:00:10.000Z";
const before = "2026-01-01T10:00:05.000Z";
const after = "2026-01-01T10:00:20.000Z";

function supersede(chat: ReturnType<typeof makeChat>, kind: "continue" | "compress-before" | "compress-after" = "continue") {
  const newSessionId = `n-${Math.random().toString(36).slice(2)}`;
  const result = supersedeChat({ chat, kind, timestamp: T, newSessionId, newChatMeta: { model: "opus", defaultPermissions: { fileRead: "allow" } } });
  created.push(result.chat.session_id);
  return result;
}

afterEach(() => {
  for (const sessionId of created.splice(0)) chatFileService.deleteChat(sessionId);
  running.clear();
  pendingRequests.clear();
});

describe("supersedeChat — root", () => {
  it("makes the new chat the root and the original its child, moving the root-only fields", () => {
    const card = { title: "Card face", lifecycle: "open" };
    const root = makeChat({ title: "Work", card, sidebarFolder: "Projects", spaceId: "space-1", pinned: true, bookmarked: true }, "ws-1");
    const { chat: n, original } = supersede(root);

    const nMeta = metaOf(n.id);
    expect(nMeta).toMatchObject({
      title: "Work",
      card,
      sidebarFolder: "Projects",
      spaceId: "space-1",
      pinned: true,
      model: "opus",
      supersedes: { chatId: root.id, kind: "continue" },
    });
    expect(nMeta).not.toHaveProperty("parentChatId");
    expect(n.workspaceId).toBe("ws-1");
    expect(n.folder).toBe(root.folder);

    const cMeta = metaOf(root.id);
    expect(cMeta).toMatchObject({
      parentChatId: n.id,
      forkedFrom: n.id,
      rootChatId: n.id,
      chatRole: "superseded",
      forkedAt: T,
      title: "Original: Work",
      bookmarked: true,
    });
    for (const key of ["card", "sidebarFolder", "spaceId", "pinned"]) expect(cMeta).not.toHaveProperty(key);
    expect(original?.id).toBe(root.id);

    expect(walkToRootId(root.id)).toBe(n.id);
    const tree = buildChatTree(n.id)!;
    expect(tree.rootChatId).toBe(n.id);
    expect(tree.tree.children.map((c) => [c.chatId, c.role, c.forkedAt])).toEqual([[root.id, "superseded", T]]);
  });

  it("moves children whose fork point is kept, leaves the rest and spawned children, and re-stamps the tree", () => {
    const root = makeChat({ title: "Root" });
    const earlyFork = makeChat({ parentChatId: root.id, forkedFrom: root.id, rootChatId: root.id, chatRole: "fork", forkedAt: before });
    const lateFork = makeChat({ parentChatId: root.id, rootChatId: root.id, chatRole: "fork", forkedAt: after });
    const spawned = makeChat({ parentChatId: root.id, rootChatId: root.id, chatRole: "subagent" });
    const grandchild = makeChat({ parentChatId: lateFork.id, rootChatId: root.id });
    const jobStep = makeChat({ rootChatId: root.id }); // tied by stamp alone
    const legacy = makeChat({ parentChatId: spawned.id }); // never stamped

    const { chat: n, movedChildren } = supersede(root);
    expect(movedChildren).toEqual([earlyFork.id]);
    expect(metaOf(earlyFork.id)).toMatchObject({ parentChatId: n.id, forkedFrom: n.id, rootChatId: n.id });
    expect(metaOf(lateFork.id)).toMatchObject({ parentChatId: root.id, rootChatId: n.id });
    expect(metaOf(spawned.id)).toMatchObject({ parentChatId: root.id, rootChatId: n.id });
    expect(metaOf(grandchild.id).rootChatId).toBe(n.id);
    expect(metaOf(jobStep.id).rootChatId).toBe(n.id);
    expect(metaOf(legacy.id).rootChatId).toBe(n.id);
  });

  it("compress-before keeps fork points and stars from the cutoff on; compress-after up to it", () => {
    const stars = [`user@${before}#0`, `assistant@${T}#0`, `user@${after}#1`];
    const rootA = makeChat({ starredMessages: stars });
    const earlyA = makeChat({ parentChatId: rootA.id, rootChatId: rootA.id, chatRole: "fork", forkedAt: before });
    const lateA = makeChat({ parentChatId: rootA.id, rootChatId: rootA.id, chatRole: "fork", forkedAt: after });
    const a = supersede(rootA, "compress-before");
    expect(a.movedChildren).toEqual([lateA.id]);
    expect(metaOf(earlyA.id).parentChatId).toBe(rootA.id);
    expect(metaOf(a.chat.id)).toMatchObject({ starredMessages: [`assistant@${T}#0`, `user@${after}#1`], starredMessagesRev: 1 });
    expect(metaOf(rootA.id)).toMatchObject({ chatRole: "pre-compression", title: "Before compression", starredMessages: stars });

    const rootB = makeChat({ title: "B", starredMessages: stars });
    const b = supersede(rootB, "compress-after");
    expect(metaOf(b.chat.id).starredMessages).toEqual([`user@${before}#0`, `assistant@${T}#0`]);
    expect(metaOf(rootB.id).title).toBe("Before compression: B");
  });
});

describe("supersedeChat — child", () => {
  it("puts the new chat in the child's slot under the same parent, with its role and fork point", () => {
    const root = makeChat({ title: "Root" });
    const child = makeChat({ title: "Child", parentChatId: root.id, forkedFrom: root.id, rootChatId: root.id, chatRole: "fork", forkedAt: before });
    const { chat: n } = supersede(child);

    expect(metaOf(n.id)).toMatchObject({ parentChatId: root.id, forkedFrom: root.id, rootChatId: root.id, chatRole: "fork", forkedAt: before, title: "Child" });
    expect(metaOf(child.id)).toMatchObject({ parentChatId: n.id, rootChatId: root.id, chatRole: "superseded", forkedAt: T });
    // The root keeps its own record untouched.
    expect(metaOf(root.id)).toEqual({ title: "Root" });

    const tree = buildChatTree(root.id)!;
    expect(tree.tree.children.map((c) => c.chatId)).toEqual([n.id]);
    expect(tree.tree.children[0]!.children.map((c) => c.chatId)).toEqual([child.id]);
  });

  it("does not stack title prefixes when superseded twice", () => {
    const root = makeChat({ title: "Work" });
    const first = supersede(root);
    const again = chatFileService.getChat(root.id)!;
    supersede(again);
    expect(metaOf(root.id).title).toBe("Original: Work");
    expect(metaOf(first.chat.id).title).toBe("Work");
    // A different action swaps the prefix rather than stacking it.
    supersede(chatFileService.getChat(root.id)!, "compress-after");
    expect(metaOf(root.id).title).toBe("Before compression: Work");
  });
});

describe("checkSupersedable", () => {
  it("refuses a running chat, one waiting on a prompt, an ACP chat and a native Codex subagent", () => {
    const chat = makeChat({});
    expect(checkSupersedable(chat)).toEqual({ ok: true });
    running.add(chat.id);
    expect(checkSupersedable(chat)).toMatchObject({ ok: false, status: 409 });
    running.clear();
    openPrompt(chat.session_id);
    expect(checkSupersedable(chat)).toMatchObject({ ok: false, status: 409 });
    expect(checkSupersedable(makeChat({ provider: "acp", acpProviderId: "opencode" }))).toMatchObject({ ok: false, status: 400 });
    expect(checkSupersedable(makeChat({ provider: "codex", nativeAgent: { parentThreadId: "x" } }))).toMatchObject({ ok: false, status: 409 });
  });
});

describe("supersedeChat — live linkage", () => {
  it("re-points callbacks waiting on the original as a parent, and prompts offered to it, to the new chat", () => {
    const root = makeChat({ title: "Parent" });
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id, chatRole: "subagent", parentAnswers: true });
    const unrelated = makeChat({});
    const cb = registerCompletionCallback({ childChatId: child.id, parentChatId: root.id, kind: "spawned" });
    const other = registerCompletionCallback({ childChatId: child.id, parentChatId: unrelated.id, kind: "spawned" });
    openPrompt(child.id, root.id);
    openPrompt(`${child.id}-2`, unrelated.id);
    try {
      const result = supersede(root);
      expect(result).toMatchObject({ repointedCallbacks: 1, repointedOffers: 1 });
      expect(listPendingForParent(root.id)).toEqual([]);
      expect(listPendingForParent(result.chat.id).map((c) => c.childChatId)).toEqual([child.id]);
      expect(listPendingForParent(unrelated.id)).toHaveLength(1);
      expect(pendingRequests.get(child.id)?.offeredToParent).toBe(result.chat.id);
      expect(pendingRequests.get(`${child.id}-2`)?.offeredToParent).toBe(unrelated.id);
    } finally {
      removeCallbacks([cb.id, other.id].filter(Boolean) as string[]);
    }
  });

  it("refuses at the late re-check, before writing anything, when a run started in between", () => {
    const chat = makeChat({ title: "Busy" });
    running.add(chat.session_id);
    expect(() => supersede(chat)).toThrow(SupersedeRefusedError);
    expect(chatFileService.getAllChats().filter((c) => c.folder === "/repos/supersede")).toHaveLength(1);
    expect(metaOf(chat.id)).toEqual({ title: "Busy" });
  });
});

describe("keptStars", () => {
  it("ignores malformed keys", () => {
    expect(keptStars("continue", ["nonsense", 3, `user@${before}#0`], new Date(T).getTime())).toEqual([`user@${before}#0`]);
  });
});
