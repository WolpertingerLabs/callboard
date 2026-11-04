/**
 * `PATCH /api/chats/:id/star` — starring one message at a time.
 *
 * The route is a delta on `metadata.starredMessages`, and what this suite
 * mostly guards is that it stays one: two tabs starring different messages
 * must both land, a repeated request must not duplicate, and nothing else in
 * the metadata may move.
 *
 * Same no-supertest style as chats.pinned.test.ts — the handler is pulled off
 * the router stack and driven with a fake req/res, and chats live in memory.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-star-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Chat records the stubbed file service hands back, set per test. */
let fileChats: any[] = [];
/** Records written through `upsertChat` — the path for a chat with no stored record yet. */
let upserts: { id: string; metadata: string }[] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
    updateChatMetadata: (id: string, fields: Record<string, unknown>) => {
      const chat = fileChats.find((c) => c.id === id);
      if (!chat) return false;
      chat.metadata = JSON.stringify({ ...JSON.parse(chat.metadata || "{}"), ...fields });
      return true;
    },
    upsertChat: (id: string, _folder: string, _sessionId: string, fields: { metadata: string }) => {
      upserts.push({ id, metadata: fields.metadata });
    },
  },
}));
// A fresh copy per lookup, as the real findChat reads the record from disk —
// so a request sees whatever the previous one wrote and nothing cached.
vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: (id: string) => {
    if (id === "filesystem-only") {
      return { id, folder: "/tmp/proj", session_id: id, metadata: "{}", _from_filesystem: true, created_at: "x", updated_at: "x" };
    }
    const chat = fileChats.find((c) => c.id === id);
    return chat ? { ...chat, displayFolder: chat.folder, session_log_path: null } : null;
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));

const { chatsRouter } = await import("./chats.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const starHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/star" && layer.route.methods.patch).route.stack[0]
  .handle as (req: Request, res: Response) => void;

function star(id: string, body: unknown): Promise<{ status: number; body: any }> {
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
    starHandler({ params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

const metaOf = (id: string) => JSON.parse(fileChats.find((c) => c.id === id)!.metadata);

const A = "assistant@2026-11-04T10:00:00.000Z#0";
const B = "user@2026-11-04T10:01:00.000Z#0";

beforeEach(() => {
  upserts = [];
  fileChats = [
    {
      id: "chat-1",
      folder: "/tmp/proj",
      session_id: "chat-1",
      metadata: JSON.stringify({ title: "Kept", pinned: true }),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];
});

describe("PATCH /api/chats/:id/star", () => {
  it("stars and unstars a message, round-tripping through the stored record", async () => {
    const set = await star("chat-1", { messageKey: A, starred: true });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ starredMessages: [A], starredMessagesRev: 1 });
    expect(metaOf("chat-1").starredMessages).toEqual([A]);

    const unset = await star("chat-1", { messageKey: A, starred: false });
    expect(unset.body).toEqual({ starredMessages: [], starredMessagesRev: 2 });
    expect(metaOf("chat-1").starredMessages).toEqual([]);
  });

  it("applies each request as a delta, so two tabs' stars both survive", async () => {
    // Tab 1 and tab 2 each loaded the chat with no stars, then starred a
    // different message. A list write would have the second erase the first.
    await star("chat-1", { messageKey: A, starred: true });
    const second = await star("chat-1", { messageKey: B, starred: true });
    expect(second.body.starredMessages).toEqual([A, B]);

    // And one tab unstarring leaves the other's star alone.
    await star("chat-1", { messageKey: A, starred: false });
    expect(metaOf("chat-1").starredMessages).toEqual([B]);
  });

  it("is idempotent — a repeated star does not duplicate, a repeated unstar is a no-op", async () => {
    await star("chat-1", { messageKey: A, starred: true });
    await star("chat-1", { messageKey: A, starred: true });
    expect(metaOf("chat-1").starredMessages).toEqual([A]);

    await star("chat-1", { messageKey: B, starred: false });
    expect(metaOf("chat-1").starredMessages).toEqual([A]);
  });

  it("leaves every other metadata key alone", async () => {
    await star("chat-1", { messageKey: A, starred: true });
    expect(metaOf("chat-1")).toEqual({ title: "Kept", pinned: true, starredMessages: [A], starredMessagesRev: 1 });
  });

  it("bumps the revision on every write, unstar and no-op included", async () => {
    // A client keeps whichever list carries the higher revision, so a chat
    // record fetched before a write must always read as older than its reply.
    const revs: number[] = [];
    for (const body of [
      { messageKey: A, starred: true },
      { messageKey: A, starred: true },
      { messageKey: B, starred: false },
      { messageKey: A, starred: false },
    ]) {
      revs.push((await star("chat-1", body)).body.starredMessagesRev);
    }
    expect(revs).toEqual([1, 2, 3, 4]);
    expect(metaOf("chat-1").starredMessagesRev).toBe(4);
  });

  it("keeps at most 500 stars, dropping the oldest", async () => {
    const existing = Array.from({ length: 500 }, (_, i) => `assistant@t${i}#0`);
    fileChats[0].metadata = JSON.stringify({ starredMessages: existing });
    const res = await star("chat-1", { messageKey: A, starred: true });
    expect(res.body.starredMessages).toHaveLength(500);
    expect(res.body.starredMessages[0]).toBe("assistant@t1#0");
    expect(res.body.starredMessages.at(-1)).toBe(A);
    // Re-starring one already kept moves it to the end without dropping another.
    const again = await star("chat-1", { messageKey: "assistant@t1#0", starred: true });
    expect(again.body.starredMessages).toHaveLength(500);
    expect(again.body.starredMessages.at(-1)).toBe("assistant@t1#0");
  });

  it("drops malformed stored entries rather than carrying them forward", async () => {
    fileChats[0].metadata = JSON.stringify({ starredMessages: [A, 42, "", null] });
    const res = await star("chat-1", { messageKey: B, starred: true });
    expect(res.body.starredMessages).toEqual([A, B]);
  });

  it("creates a record for a chat that only exists as a session log", async () => {
    const res = await star("filesystem-only", { messageKey: A, starred: true });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(JSON.parse(upserts[0].metadata).starredMessages).toEqual([A]);
  });

  it("rejects a malformed body without writing", async () => {
    for (const body of [{}, { messageKey: A }, { messageKey: A, starred: "true" }, { messageKey: "", starred: true }, { messageKey: 7, starred: true }, { messageKey: "x".repeat(201), starred: true }]) {
      expect((await star("chat-1", body)).status).toBe(400);
    }
    expect(metaOf("chat-1").starredMessages).toBeUndefined();
  });

  it("404s for a chat that does not exist", async () => {
    expect((await star("no-such-chat", { messageKey: A, starred: true })).status).toBe(404);
  });
});
