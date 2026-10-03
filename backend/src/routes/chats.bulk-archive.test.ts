/**
 * POST /api/chats/bulk-archive — the sidebar's archive, for card and card-less
 * trees alike.
 *
 * Drives the real chat file service over a temp data dir, so the assertions
 * are about what lands on disk: which representation a root gets (card
 * lifecycle vs. the chat-level `archived` flag), that a member id archives its
 * root, that the write is quiet, and that every requested id is reported once.
 *
 * Same no-supertest style as cards.patch-unpin.test.ts.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chats-bulk-archive-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Sessions the stubbed lookup reports as on disk with no stored record. */
const filesystemOnly = new Map<string, any>();

vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
// The real findChat would go looking through every provider's session store on
// this machine for the ids the tests invent.
vi.mock("../utils/chat-lookup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/chat-lookup.js")>();
  const { chatFileService } = await import("../services/chat-file-service.js");
  return {
    ...actual,
    findChat: (id: string) => chatFileService.getChat(id) ?? filesystemOnly.get(id) ?? null,
  };
});

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { patchCardFields } = await import("../services/card-fields.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const bulkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/bulk-archive" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => void;

function bulkArchive(body: unknown): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    bulkHandler({ body } as unknown as Request, res as unknown as Response);
  });
}

let seq = 0;
const make = (meta: Record<string, unknown>) => chatFileService.createChat("/tmp/proj", `bulk-archive-${seq++}`, JSON.stringify(meta)).id;
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");

describe("POST /api/chats/bulk-archive", () => {
  it("rejects a malformed body", async () => {
    expect((await bulkArchive({ ids: [], archived: true })).code).toBe(400);
    expect((await bulkArchive({ ids: ["x"], archived: "yes" })).code).toBe(400);
  });

  it("closes a card root's card and leaves no chat-level flag on it", async () => {
    const root = make({});
    const res = await bulkArchive({ ids: [root], archived: true });

    expect(res.code).toBe(200);
    expect(res.body.updated).toEqual([{ id: root, rootChatId: root, archived: true, isCard: true }]);
    expect(metaOf(root).card.lifecycle).toBe("closed");
    expect(metaOf(root).archived).toBeUndefined();
  });

  it("flags a card-less (triggered) root and writes no metadata.card onto it", async () => {
    const root = make({ triggered: true });
    const res = await bulkArchive({ ids: [root], archived: true });

    expect(res.body.updated).toEqual([{ id: root, rootChatId: root, archived: true, isCard: false }]);
    const meta = metaOf(root);
    expect(meta.archived).toBe(true);
    expect(typeof meta.archivedAt).toBe("string");
    expect(meta.card).toBeUndefined();

    await bulkArchive({ ids: [root], archived: false });
    expect(metaOf(root).archived).toBeUndefined();
    expect(metaOf(root).archivedAt).toBeUndefined();
  });

  it("treats a job-step root as card-less too", async () => {
    const root = make({ jobRunId: "run-x" });
    await bulkArchive({ ids: [root], archived: true });
    expect(metaOf(root).archived).toBe(true);
    expect(metaOf(root).card).toBeUndefined();
  });

  it("resolves a child id to its root and archives the root, not the child", async () => {
    const root = make({ triggered: true });
    const child = make({ parentChatId: root, rootChatId: root, triggered: true });

    const res = await bulkArchive({ ids: [child], archived: true });

    expect(res.body.updated).toEqual([{ id: child, rootChatId: root, archived: true, isCard: false }]);
    expect(metaOf(root).archived).toBe(true);
    expect(metaOf(child).archived).toBeUndefined();
  });

  it("flips a shared root once and still reports every requested id", async () => {
    const root = make({ triggered: true });
    const a = make({ parentChatId: root, rootChatId: root });
    const b = make({ parentChatId: root, rootChatId: root });

    const res = await bulkArchive({ ids: [a, b, root], archived: true });
    const archivedAt = metaOf(root).archivedAt;

    expect(res.body.updated.map((u: any) => u.id)).toEqual([a, b, root]);
    expect(res.body.failed).toEqual([]);
    // Re-archiving is not a transition: archivedAt describes when it happened.
    await bulkArchive({ ids: [a], archived: true });
    expect(metaOf(root).archivedAt).toBe(archivedAt);
  });

  it("reports a missing id as failed without stranding the rest of the batch", async () => {
    const root = make({ triggered: true });
    const res = await bulkArchive({ ids: ["no-such-chat", root], archived: true });

    expect(res.code).toBe(200);
    expect(res.body.failed).toEqual([{ id: "no-such-chat", error: "Chat not found" }]);
    expect(res.body.updated.map((u: any) => u.id)).toEqual([root]);
    expect(metaOf(root).archived).toBe(true);
  });

  it("does not bump updated_at on either kind of root", async () => {
    const cardRoot = make({});
    const flagRoot = make({ triggered: true });
    const before = [chatFileService.getChat(cardRoot)!.updated_at, chatFileService.getChat(flagRoot)!.updated_at];
    await new Promise((r) => setTimeout(r, 5));

    await bulkArchive({ ids: [cardRoot, flagRoot], archived: true });
    await bulkArchive({ ids: [cardRoot, flagRoot], archived: false });

    expect([chatFileService.getChat(cardRoot)!.updated_at, chatFileService.getChat(flagRoot)!.updated_at]).toEqual(before);
  });

  it("unpins the chats of a card-less tree on archive, as a card archive does", async () => {
    const root = make({ triggered: true, pinned: true });
    const child = make({ parentChatId: root, rootChatId: root, pinned: true });

    await bulkArchive({ ids: [root], archived: true });

    expect(metaOf(root).pinned).toBe(false);
    expect(metaOf(child).pinned).toBe(false);
  });

  it("unarchiving a hidden card clears hidden too, so the row stops reading as archived", async () => {
    const root = make({});
    patchCardFields(root, { hidden: true });

    await bulkArchive({ ids: [root], archived: false });

    expect(metaOf(root).card.hidden).toBeUndefined();
    expect(metaOf(root).card.lifecycle).not.toBe("closed");
  });

  it("materialises a record-less session and closes it as the card it becomes", async () => {
    filesystemOnly.set("fs-only-session", {
      id: "fs-only-session",
      folder: "/tmp/proj",
      session_id: "fs-only-session",
      metadata: JSON.stringify({}),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      _from_filesystem: true,
    });

    const res = await bulkArchive({ ids: ["fs-only-session"], archived: true });

    expect(res.body.updated).toEqual([{ id: "fs-only-session", rootChatId: "fs-only-session", archived: true, isCard: true }]);
    expect(metaOf("fs-only-session").card.lifecycle).toBe("closed");
    expect(chatFileService.getChat("fs-only-session")!.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });
});
