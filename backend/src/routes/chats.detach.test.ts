/**
 * POST /api/chats/:id/detach — split a child chat off its parent so it becomes
 * a standalone root. Over a real (temp-dir) chat store, so the lineage reads
 * that decide "is this a root now" (walkToRootId, buildChatTree) run against
 * exactly what the route wrote.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-detach-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const clearListCaches = vi.fn();
vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => clearListCaches() }));
vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, hasPendingRequest: () => false, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { walkToRootId, buildChatTree } = await import("../services/chat-lineage.js");
const { createSpace } = await import("../services/space-store.js");
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
  clearListCaches.mockClear();
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
});
