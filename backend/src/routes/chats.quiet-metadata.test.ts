/**
 * Route-level tests for the metadata PATCHes that are UI state, not activity:
 * bookmark, pin, permissions and summon-dismiss.
 *
 * All four write through `writeQuietMetadata`, the path PATCH /:id/read uses
 * (see chats.mark-read.test.ts, whose fake store this mirrors). Two properties
 * each, both of which the old `upsertChat` write got wrong:
 *
 *  - `updated_at` is left alone. Card rollup takes `lastActivityAt` from
 *    `max(member.updated_at)` and computes `unread` as `updated_at >
 *    lastReadAt`, so a bump sorts a quiet card to the top of the board wearing
 *    an unread dot for a conversation nobody added to.
 *  - A record whose metadata will not parse is refused, not replaced by a blob
 *    holding only the one field the route meant to set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-quiet-metadata-"));

let chat: any;
let record: any = null;
/** Fields findChat resolves on top of the stored blob — the native Codex lineage overlay's shape. */
let overlay: Record<string, unknown> | null = null;

/** Mirrors the real service closely enough to test the route's decisions. */
const updateChatMetadata = vi.fn((_id: string, fields: Record<string, unknown>, opts?: { touch?: boolean }) => {
  if (!record) return false;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(record.metadata);
  } catch {
    return false;
  }
  record.metadata = JSON.stringify({ ...meta, ...fields });
  if (opts?.touch !== false) record.updated_at = new Date(Date.now() + 1).toISOString();
  return true;
});
const upsertChat = vi.fn((id: string, folder: string, sessionId: string, updates: Record<string, unknown>) => {
  record = { id, folder, session_id: sessionId, ...updates };
  return record;
});

function resolved(): any {
  if (!chat) return null;
  const found = { ...chat, ...(record ?? {}) };
  if (!overlay) return found;
  try {
    return { ...found, metadata: JSON.stringify({ ...JSON.parse(found.metadata), ...overlay }) };
  } catch {
    return found;
  }
}

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => resolved(),
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    upsertChat: (...args: any[]) => (upsertChat as any)(...args),
    updateChatMetadata: (...args: any[]) => (updateChatMetadata as any)(...args),
    getChat: () => record,
  },
}));
vi.mock("../services/list-caches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/list-caches.js")>()),
  clearListCaches: () => {},
}));
const clearSummon = vi.fn();
vi.mock("../services/session-registry.js", () => ({
  sessionRegistry: { has: () => false, notifyMetadata: () => {}, clearSummon: (...args: any[]) => clearSummon(...args) },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));
vi.mock("../services/quick-completion.js", () => ({ generateChatTitleFromTranscript: () => Promise.resolve(null) }));

const { chatsRouter } = await import("./chats.js");

function handlerFor(path: string): (req: Request, res: Response) => void {
  return (chatsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.patch).route.stack[0].handle;
}

function call(path: string, body: unknown): Promise<{ code: number; body: any }> {
  const handler = handlerFor(path);
  return new Promise((resolve) => {
    const headers: Record<string, string> = { origin: "https://callboard.local", host: "callboard.local" };
    const req = { params: { id: "chat-1" }, body, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
    const res = {
      statusCode: 200,
      locals: { authMethod: "session" },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    handler(req, res as unknown as Response);
  });
}

const FOUR = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" };

/** Each route, the body it is sent, and what it should leave in metadata. */
const ROUTES: { name: string; path: string; body: unknown; check: (meta: any) => void }[] = [
  { name: "bookmark", path: "/:id/bookmark", body: { bookmarked: true }, check: (meta) => expect(meta.bookmarked).toBe(true) },
  { name: "pin", path: "/:id/pin", body: { pinned: true }, check: (meta) => expect(meta.pinned).toBe(true) },
  {
    name: "permissions",
    path: "/:id/permissions",
    body: { defaultPermissions: { ...FOUR, computerControl: "ask" } },
    check: (meta) => expect(meta.defaultPermissions).toMatchObject({ ...FOUR, computerControl: "ask" }),
  },
  { name: "summon", path: "/:id/summon", body: { dismiss: true }, check: (meta) => expect(meta.summon).toBeNull() },
];

const BORN = "2026-06-01T09:00:00.000Z";
const LAST_SAID = "2026-08-20T11:00:00.000Z";
const CORRUPT = '{"session_ids": ["sess';

function setChat(opts: { stored?: boolean; metadata?: string } = {}) {
  const blob = JSON.stringify({ session_ids: ["session-1"], title: "Kept", summon: { message: "look" } });
  chat = { id: "chat-1", folder: "/repo", session_id: "session-1", metadata: blob, created_at: BORN, updated_at: LAST_SAID };
  if (opts.stored === false) {
    chat._from_filesystem = true;
    record = null;
  } else {
    record = { ...chat, metadata: opts.metadata ?? blob };
  }
}

beforeEach(() => {
  upsertChat.mockClear();
  updateChatMetadata.mockClear();
  clearSummon.mockClear();
  overlay = null;
  setChat();
});

describe.each(ROUTES)("PATCH /api/chats/:id/$name", ({ path, body, check }) => {
  it("writes the field without bumping updated_at", async () => {
    const res = await call(path, body);

    expect(res.code).toBe(200);
    expect(updateChatMetadata).toHaveBeenCalledWith("chat-1", expect.any(Object), { touch: false });
    expect(upsertChat).not.toHaveBeenCalled();
    expect(record.updated_at).toBe(LAST_SAID);
    const meta = JSON.parse(record.metadata);
    check(meta);
    expect(meta.title).toBe("Kept");
    expect(res.body.updated_at).toBe(LAST_SAID);
  });

  it("persists the metadata findChat resolved, not only the one field", async () => {
    overlay = { nativeAgent: { parentThreadId: "thread-parent" } };
    expect((await call(path, body)).code).toBe(200);
    expect(JSON.parse(record.metadata).nativeAgent).toEqual({ parentThreadId: "thread-parent" });
  });

  it("creates a record for a filesystem-only chat with the session's own timestamps", async () => {
    setChat({ stored: false });
    const res = await call(path, body);

    expect(res.code).toBe(200);
    expect(upsertChat).toHaveBeenCalledTimes(1);
    expect(record.created_at).toBe(BORN);
    expect(record.updated_at).toBe(LAST_SAID);
    check(JSON.parse(record.metadata));
  });

  it("refuses rather than replacing a record whose metadata does not parse", async () => {
    setChat({ metadata: CORRUPT });
    const res = await call(path, body);

    expect(res.code).toBe(500);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(record.metadata).toBe(CORRUPT);
  });
});

describe("PATCH /api/chats/:id/summon", () => {
  it("does not clear the live summon when the record could not be written", async () => {
    setChat({ metadata: CORRUPT });
    await call("/:id/summon", {});
    expect(clearSummon).not.toHaveBeenCalled();
  });

  it("clears the live summon once the record is written", async () => {
    await call("/:id/summon", {});
    expect(clearSummon).toHaveBeenCalledWith("chat-1");
  });
});
