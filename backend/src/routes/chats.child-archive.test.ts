/**
 * PATCH /api/chats/:id/child-archive — archive ONE child chat, not its tree.
 * Over a real (temp-dir) chat store, so the tree read (`buildChatTree`) and the
 * split-off and reopen-on-message paths see exactly what the route wrote.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-child-archive-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const clearListCaches = vi.fn();
const notifyMetadata = vi.fn();
vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => clearListCaches() }));
vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, hasPendingRequest: () => false, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({
  sessionRegistry: { has: () => false, notifyMetadata: (...args: unknown[]) => notifyMetadata(...args), bumpVersion: () => {} },
}));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { buildChatTree } = await import("../services/chat-lineage.js");
const { detachChatFromParent } = await import("../services/chat-detach.js");
const { reopenArchivedChildChain } = await import("../services/child-archive.js");
const { buildCardSummaries } = await import("../services/card-rollup.js");
const { patchCardFields } = await import("../services/card-fields.js");
const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const handler = (chatsRouter as any).stack.find((l: any) => l.route?.path === "/:id/child-archive" && l.route.methods.patch).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function patch(id: string, body: unknown): Promise<{ status: number; body: any }> {
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
    handler({ query: {}, params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

/** Session ids created by a test — deleteChat takes the session id, not the chat id. */
const created: string[] = [];
function makeChat(meta: Record<string, unknown> = {}) {
  const chat = chatFileService.createChat("/repos/child-archive", `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta));
  created.push(chat.session_id);
  return chat;
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata);

afterEach(() => {
  for (const sessionId of created.splice(0)) chatFileService.deleteChat(sessionId);
  clearListCaches.mockClear();
  notifyMetadata.mockClear();
});

describe("PATCH /api/chats/:id/child-archive", () => {
  it("archives a child on its own record, leaving the root and its siblings alone", async () => {
    const root = makeChat({ title: "root" });
    const child = makeChat({ title: "child", parentChatId: root.id, rootChatId: root.id });
    const sibling = makeChat({ title: "sibling", parentChatId: root.id, rootChatId: root.id });

    const res = await patch(child.id, { archived: true });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(child.id);

    const meta = metaOf(child.id);
    expect(meta).toMatchObject({ title: "child", childArchived: true, parentChatId: root.id });
    expect(typeof meta.childArchivedAt).toBe("string");
    // Not the tree archive: neither the root nor a sibling is touched.
    expect(metaOf(root.id)).not.toHaveProperty("treeArchived");
    expect(metaOf(root.id)).not.toHaveProperty("childArchived");
    expect(metaOf(sibling.id)).not.toHaveProperty("childArchived");
    expect(clearListCaches).toHaveBeenCalled();
    // Other tabs refetch on it.
    expect(notifyMetadata).toHaveBeenCalledWith(child.id, { childArchived: true });
  });

  it("reports the flag on the child's tree node, and only there", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const sibling = makeChat({ parentChatId: root.id, rootChatId: root.id });
    await patch(child.id, { archived: true });

    const tree = buildChatTree(root.id)!;
    expect(tree.tree.childArchived).toBeUndefined();
    const byId = new Map(tree.tree.children.map((n) => [n.chatId, n]));
    expect(byId.get(child.id)!.childArchived).toBe(true);
    expect(byId.get(sibling.id)!.childArchived).toBeUndefined();
  });

  it("unarchives by removing both keys", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    await patch(child.id, { archived: true });

    const res = await patch(child.id, { archived: false });
    expect(res.status).toBe(200);
    expect(metaOf(child.id)).not.toHaveProperty("childArchived");
    expect(metaOf(child.id)).not.toHaveProperty("childArchivedAt");
    expect(buildChatTree(root.id)!.tree.children[0].childArchived).toBeUndefined();
  });

  it("keeps the original stamp when re-archived, and does not bump updated_at", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const before = chatFileService.getChat(child.id)!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await patch(child.id, { archived: true });
    const stamp = metaOf(child.id).childArchivedAt;
    await new Promise((r) => setTimeout(r, 5));
    clearListCaches.mockClear();
    notifyMetadata.mockClear();
    expect((await patch(child.id, { archived: true })).status).toBe(200);
    expect(metaOf(child.id).childArchivedAt).toBe(stamp);
    // Nothing changed, so nothing to invalidate or announce.
    expect(clearListCaches).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
    expect(chatFileService.getChat(child.id)!.updated_at).toBe(before);
  });

  it("refuses a root chat — its archive is its card's", async () => {
    const root = makeChat();
    const res = await patch(root.id, { archived: true });
    expect(res.status).toBe(400);
    expect(metaOf(root.id)).not.toHaveProperty("childArchived");
  });

  it("refuses a native Codex subagent", async () => {
    const root = makeChat({ provider: "codex" });
    const native = makeChat({
      provider: "codex",
      parentChatId: root.id,
      nativeAgent: { parentThreadId: "t", lifecycle: "unknown", management: "read-only", controlNote: "" },
    });
    expect((await patch(native.id, { archived: true })).status).toBe(409);
    expect(metaOf(native.id)).not.toHaveProperty("childArchived");
  });

  it("validates the body and the id", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id });
    expect((await patch(child.id, {})).status).toBe(400);
    expect((await patch(child.id, { archived: "yes" })).status).toBe(400);
    expect((await patch("no-such-chat", { archived: true })).status).toBe(404);
  });

  it("is cleared by a split-off, so a chat that becomes a root carries no stale flag", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    await patch(child.id, { archived: true });

    expect(detachChatFromParent(chatFileService.getChat(child.id)!).ok).toBe(true);
    expect(metaOf(child.id)).not.toHaveProperty("childArchived");
    expect(metaOf(child.id)).not.toHaveProperty("childArchivedAt");
  });
});

describe("reopenArchivedChildChain — a message brings an archived child back", () => {
  it("clears the flag on the messaged chat and on every archived ancestor up to the root", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const grandchild = makeChat({ parentChatId: child.id, rootChatId: root.id });
    await patch(child.id, { archived: true });
    await patch(grandchild.id, { archived: true });

    expect(new Set(reopenArchivedChildChain(grandchild.id))).toEqual(new Set([child.id, grandchild.id]));
    expect(metaOf(child.id)).not.toHaveProperty("childArchived");
    expect(metaOf(grandchild.id)).not.toHaveProperty("childArchived");
  });

  it("leaves archived siblings alone", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const sibling = makeChat({ parentChatId: root.id, rootChatId: root.id });
    await patch(sibling.id, { archived: true });

    expect(reopenArchivedChildChain(child.id)).toEqual([]);
    expect(metaOf(sibling.id).childArchived).toBe(true);
  });

  it("leaves an archive stamped after a job run started (the job-step exception)", async () => {
    const root = makeChat();
    const child = makeChat({ parentChatId: root.id, rootChatId: root.id });
    const runStartedAt = new Date(Date.now() - 60_000).toISOString();
    await patch(child.id, { archived: true });

    expect(reopenArchivedChildChain(child.id, { unlessArchivedAfter: runStartedAt })).toEqual([]);
    expect(metaOf(child.id).childArchived).toBe(true);
  });
});

/**
 * Deleting a chat never cascades, so deleting the parent of an archived child
 * leaves the child as the root of its own card — with the flag, and the
 * dangling parent pointer, still on it. The sidebar keeps hiding it and its
 * subtree, so its card must read as archived too.
 */
describe("an archived child whose parent is deleted", () => {
  const IDLE = {
    isSessionActive: () => false,
    pendingKindOf: () => undefined,
    activityOf: () => undefined,
    awaitingChildrenOf: () => 0,
    previewOf: () => null,
  };
  const cardsOf = () => buildCardSummaries(chatFileService.getAllChats(), [], IDLE);

  it("becomes a closed card, and reopening it clears the flag", async () => {
    const root = makeChat({ title: "root" });
    const child = makeChat({ title: "child", parentChatId: root.id, rootChatId: root.id });
    const grandchild = makeChat({ title: "grandchild", parentChatId: child.id, rootChatId: root.id });
    await patch(child.id, { archived: true });
    const archivedAt = metaOf(child.id).childArchivedAt;

    // While the parent exists the child is a member of the root's open card.
    expect(cardsOf().find((c) => c.id === root.id)?.lifecycle).toBe("open");
    expect(cardsOf().find((c) => c.id === child.id)).toBeUndefined();

    chatFileService.deleteChat(root.session_id);

    const card = cardsOf().find((c) => c.id === child.id);
    expect(card).toMatchObject({ lifecycle: "closed", closedAt: archivedAt });
    expect(card?.memberChats.map((m) => m.chatId).sort()).toEqual([child.id, grandchild.id].sort());

    patchCardFields(child.id, { lifecycle: "open" });
    expect(metaOf(child.id)).not.toHaveProperty("childArchived");
    expect(cardsOf().find((c) => c.id === child.id)?.lifecycle).toBe("open");
  });

  it("refuses to archive it through the child route, which would close the card without the card path", async () => {
    const root = makeChat({ title: "root" });
    const child = makeChat({ title: "child", parentChatId: root.id, rootChatId: root.id, pinned: true });
    chatFileService.deleteChat(root.session_id);

    const res = await patch(child.id, { archived: true });

    expect(res.status).toBe(400);
    expect(metaOf(child.id)).not.toHaveProperty("childArchived");
    expect(metaOf(child.id).pinned).toBe(true);
    expect(cardsOf().find((c) => c.id === child.id)?.lifecycle).toBe("open");
  });

  it("unarchives it through the child route by reopening its card", async () => {
    const root = makeChat({ title: "root" });
    const child = makeChat({ title: "child", parentChatId: root.id, rootChatId: root.id });
    await patch(child.id, { archived: true });
    chatFileService.deleteChat(root.session_id);
    notifyMetadata.mockClear();

    const res = await patch(child.id, { archived: false });

    expect(res.status).toBe(200);
    expect(metaOf(child.id)).not.toHaveProperty("childArchived");
    expect(metaOf(child.id)).not.toHaveProperty("childArchivedAt");
    expect(metaOf(child.id).card.lifecycle).toBe("open");
    expect(cardsOf().find((c) => c.id === child.id)?.lifecycle).toBe("open");
    expect(notifyMetadata).toHaveBeenCalledWith(child.id, { cardEvent: "updated" });
  });
});
