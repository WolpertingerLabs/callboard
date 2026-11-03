/**
 * POST /api/chats/:id/detach — split a child chat off its parent so it becomes
 * a standalone root. Over a real (temp-dir) chat store, so the lineage reads
 * that decide "is this a root now" (walkToRootId, buildChatTree) run against
 * exactly what the route wrote — and over the real phone-home callback store
 * and pending-prompt map, which the split has to cut the old parent out of.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-detach-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
/** Where the Codex provider looks for rollouts — inside the temp root, never the real ~/.codex. */
const codexHome = join(tmpRoot, "codex");

const clearListCaches = vi.fn();
const notifyMetadata = vi.fn();
vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => clearListCaches() }));
vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, hasPendingRequest: () => false, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({
  sessionRegistry: { has: () => false, notifyMetadata: (...args: unknown[]) => notifyMetadata(...args) },
}));
vi.mock("../services/agent-settings.js", async (original) => ({
  ...(await original<typeof import("../services/agent-settings.js")>()),
  getAgentSettings: () => ({ codexHome }),
}));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { walkToRootId, buildChatTree } = await import("../services/chat-lineage.js");
const { createSpace } = await import("../services/space-store.js");
const { detachChatFromParent } = await import("../services/chat-detach.js");
const { registerCompletionCallback, listPendingForParent, removeCallbacks } = await import("../services/session-callbacks.js");
const { pendingRequests, hasPendingRequest } = await import("../services/pending-requests.js");
const { respondAsParent } = await import("../services/parent-answers.js");
const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const detachHandler = (chatsRouter as any).stack.find((l: any) => l.route?.path === "/:id/detach" && l.route.methods.post).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function detach(id: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    detachHandler({ query: {}, params: { id }, body: {} } as unknown as Request, res as unknown as Response);
  });
}

/** Session ids created by a test — deleteChat takes the session id, not the chat id. */
const created: string[] = [];
function makeChat(meta: Record<string, unknown> = {}) {
  const chat = chatFileService.createChat("/repos/detach", `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta));
  created.push(chat.session_id);
  return chat;
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata);

afterEach(() => {
  for (const sessionId of created.splice(0)) chatFileService.deleteChat(sessionId);
  pendingRequests.clear();
  rmSync(codexHome, { recursive: true, force: true });
  clearListCaches.mockClear();
  notifyMetadata.mockClear();
});

describe("POST /api/chats/:id/detach", () => {
  it("turns a child into a standalone root and takes it out of the old tree", async () => {
    const work = createSpace({ name: "Work" });
    const root = makeChat({ title: "root", spaceId: work.id });
    const child = makeChat({ title: "child", parentChatId: root.id, rootChatId: root.id, chatRole: "subagent", pinned: true });
    const sibling = makeChat({ title: "sibling", parentChatId: root.id, rootChatId: root.id });

    const res = await detach(child.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(child.id);

    const meta = metaOf(child.id);
    for (const key of ["parentChatId", "forkedFrom", "rootChatId", "chatRole", "forkedAt"]) expect(meta).not.toHaveProperty(key);
    // Unrelated metadata survives; the tree's space follows the new root.
    expect(meta).toMatchObject({ title: "child", pinned: true, spaceId: work.id, detachedFrom: { parentChatId: root.id } });
    expect(clearListCaches).toHaveBeenCalled();

    expect(walkToRootId(child.id)).toBe(child.id);
    const oldTree = buildChatTree(root.id)!;
    expect(oldTree.tree.children.map((n) => n.chatId)).toEqual([sibling.id]);
    const newTree = buildChatTree(child.id)!;
    expect(newTree.rootChatId).toBe(child.id);
    expect(newTree.ancestors).toEqual([]);
  });

  it("clears a fork's legacy forkedFrom pointer and its fork point", async () => {
    const original = makeChat({ title: "original" });
    const fork = makeChat({ forkedFrom: original.id, parentChatId: original.id, rootChatId: original.id, chatRole: "fork", forkedAt: "2026-01-01T00:00:00Z" });

    expect((await detach(fork.id)).status).toBe(200);
    const meta = metaOf(fork.id);
    expect(meta).not.toHaveProperty("forkedFrom");
    expect(meta).not.toHaveProperty("forkedAt");
    expect(walkToRootId(fork.id)).toBe(fork.id);
  });

  it("brings the detached chat's own descendants along, re-stamping their root", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const grandchild = makeChat({ parentChatId: child.id, rootChatId: root.id });
    const greatGrandchild = makeChat({ parentChatId: grandchild.id, rootChatId: root.id });

    expect((await detach(child.id)).status).toBe(200);
    expect(metaOf(grandchild.id)).toMatchObject({ parentChatId: child.id, rootChatId: child.id });
    expect(metaOf(greatGrandchild.id)).toMatchObject({ parentChatId: grandchild.id, rootChatId: child.id });
    expect(walkToRootId(greatGrandchild.id)).toBe(child.id);
    expect(buildChatTree(root.id)!.tree.children).toEqual([]);
  });

  it("does not bump updated_at — splitting is reorganisation, not activity", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const before = chatFileService.getChat(child.id)!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await detach(child.id);
    expect(chatFileService.getChat(child.id)!.updated_at).toBe(before);
  });

  it("refuses a chat that has no parent", async () => {
    const root = makeChat({ title: "root" });
    const res = await detach(root.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no parent/);
    expect(metaOf(root.id)).toEqual({ title: "root" });
  });

  it("answers 404 for an unknown chat", async () => {
    const res = await detach("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("refuses a native Codex subagent, whose parent is read from its rollout", async () => {
    const parent = makeChat({ provider: "codex" });
    const native = makeChat({
      provider: "codex",
      parentChatId: parent.id,
      nativeAgent: { parentThreadId: parent.session_id, inferredParentChatId: parent.id, lifecycle: "unknown", management: "read-only", controlNote: "" },
    });
    const res = await detach(native.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/native Codex subagent/);
    expect(metaOf(native.id).parentChatId).toBe(parent.id);
  });

  it("writes the default space as an absent key, as space-service's stamp() does", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    expect((await detach(child.id)).status).toBe(200);
    expect(metaOf(child.id)).not.toHaveProperty("spaceId");
  });

  it("drops stale card face fields so they do not become the new card's face", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id, card: { title: "Old card", lifecycle: "closed", emoji: "🧊" } });
    expect((await detach(child.id)).status).toBe(200);
    expect(metaOf(child.id)).not.toHaveProperty("card");
  });

  it("notifies the old root, the old parent and the split-off chat with a card event", async () => {
    const root = makeChat();
    const parent = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const child = makeChat({ parentChatId: parent.id, rootChatId: root.id });
    await detach(child.id);
    expect(notifyMetadata.mock.calls).toEqual([
      [root.id, { cardEvent: "updated" }],
      [parent.id, { cardEvent: "updated" }],
      [child.id, { cardEvent: "updated" }],
    ]);
  });

  it("is a no-op 200 when repeated on a chat already split off", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    expect((await detach(child.id)).status).toBe(200);
    const after = metaOf(child.id);
    clearListCaches.mockClear();
    notifyMetadata.mockClear();

    const again = await detach(child.id);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(child.id);
    expect(metaOf(child.id)).toEqual(after);
    expect(clearListCaches).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });

  it("re-stamps a descendant that never carried a rootChatId", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const legacy = makeChat({ forkedFrom: child.id });
    expect((await detach(child.id)).status).toBe(200);
    expect(metaOf(legacy.id)).toMatchObject({ forkedFrom: child.id, rootChatId: child.id });
    expect(walkToRootId(legacy.id)).toBe(child.id);
  });

  it("splits off a chat whose parent has been deleted", async () => {
    const parent = makeChat();
    const child = makeChat({ parentChatId: parent.id, rootChatId: parent.id });
    chatFileService.deleteChat(parent.session_id);
    const res = await detach(child.id);
    expect(res.status).toBe(200);
    expect(metaOf(child.id)).not.toHaveProperty("parentChatId");
    expect(metaOf(child.id).detachedFrom.parentChatId).toBe(parent.id);
    // The split-off chat is notified (it resolved as its own root already).
    expect(notifyMetadata.mock.calls.map(([id]) => id)).toContain(child.id);
  });

  it("removes completion callbacks waiting on the chat, so its stop no longer resumes the old parent", async () => {
    const parent = makeChat();
    const child = makeChat({ parentChatId: parent.id, rootChatId: parent.id });
    const other = makeChat({ parentChatId: parent.id, rootChatId: parent.id });
    expect(registerCompletionCallback({ childChatId: child.id, parentChatId: parent.id, kind: "spawned" }).registered).toBe(true);
    const kept = registerCompletionCallback({ childChatId: other.id, parentChatId: parent.id, kind: "spawned" });
    expect(listPendingForParent(parent.id)).toHaveLength(2);

    expect((await detach(child.id)).status).toBe(200);

    expect(listPendingForParent(parent.id).map((cb) => cb.childChatId)).toEqual([other.id]);
    removeCallbacks([kept.id!]);
  });

  it("also removes a callback registered under the chat's session id (continue_chat)", async () => {
    const parent = makeChat();
    const child = makeChat({ parentChatId: parent.id, rootChatId: parent.id });
    expect(child.session_id).not.toBe(child.id);
    expect(registerCompletionCallback({ childChatId: child.session_id, parentChatId: parent.id, kind: "continued" }).registered).toBe(true);
    expect(listPendingForParent(parent.id)).toHaveLength(1);

    expect((await detach(child.id)).status).toBe(200);

    expect(listPendingForParent(parent.id)).toEqual([]);
  });

  it("withdraws an open prompt offered to the old parent, leaving it for the user", async () => {
    const parent = makeChat();
    const child = makeChat({ parentChatId: parent.id, rootChatId: parent.id, parentAnswers: true });
    pendingRequests.set(child.id, {
      toolName: "Bash",
      input: { command: "ls" },
      eventType: "permission_request",
      eventData: {},
      resolve: () => {},
      requestId: "req-1",
      offeredToParent: parent.id,
    });

    expect((await detach(child.id)).status).toBe(200);

    expect(pendingRequests.get(child.id)?.offeredToParent).toBeUndefined();
    const answer = respondAsParent({ callerChatId: parent.id, callerPermissions: null, chatId: child.id, requestId: "req-1", allow: false, reason: "no" });
    expect(answer.ok).toBe(false);
    expect(hasPendingRequest(child.id)).toBe(true);
  });

  it("refuses a native Codex child detected only by read-time enrichment from its rollout", async () => {
    const parentThread = "01a0767f-671a-75f0-ab44-238e2fa5785c";
    const childThread = "01a07680-3128-7461-bc19-d727bd8dc379";
    const dir = join(codexHome, "sessions/2026/09/06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-09-06T11-35-07-${childThread}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: childThread,
          cwd: tmpRoot,
          source: { subagent: { thread_spawn: { parent_thread_id: parentThread } } },
          thread_source: "subagent",
          parent_thread_id: parentThread,
          subagent_history_start_ordinal: 1,
        },
      }) + "\n",
    );
    // The stored record says nothing about being native — only the rollout does.
    chatFileService.upsertChat(childThread, tmpRoot, childThread, { metadata: JSON.stringify({ provider: "codex" }) });
    created.push(childThread);

    const res = await detach(childThread);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/native Codex subagent/);
    expect(metaOf(childThread)).toEqual({ provider: "codex" });
  });
});

describe("detachChatFromParent", () => {
  it("refuses a record-less (filesystem-only) chat that is not native", () => {
    const result = detachChatFromParent({ id: "fs-only", metadata: JSON.stringify({ parentChatId: "p" }), _from_filesystem: true });
    expect(result).toEqual({ ok: false, status: 400, error: "This chat has no stored record to update" });
  });
});
