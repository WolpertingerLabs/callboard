/**
 * Route-level tests for PATCH /api/chats/:id/read.
 *
 * Card rollup computes `unread` as `updated_at > lastReadAt`, so marking read
 * must not bump `updated_at` — otherwise the card shows an unread dot again the
 * moment it is marked read. Same write path (and same fake store) as
 * chats.set-title.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-mark-read-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

let chat: any;
let record: any = null;

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

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => (chat ? { ...chat, ...(record ?? {}) } : null),
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
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));
vi.mock("../services/quick-completion.js", () => ({ generateChatTitleFromTranscript: () => Promise.resolve(null) }));

const { chatsRouter } = await import("./chats.js");

const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/read" && layer.route.methods.patch).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function markRead(id = "chat-1"): Promise<{ code: number; body: any }> {
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
    handler({ params: { id } } as unknown as Request, res as unknown as Response);
  });
}

const BORN = "2026-06-01T09:00:00.000Z";
const LAST_SAID = "2026-08-20T11:00:00.000Z";

function setChat(opts: { stored?: boolean; metadata?: string } = {}) {
  const blob = JSON.stringify({ session_ids: ["session-1"], title: "Kept" });
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
  setChat();
});

describe("PATCH /api/chats/:id/read", () => {
  it("stamps lastReadAt without bumping updated_at, so the chat reads as read", async () => {
    const res = await markRead();

    expect(res.code).toBe(200);
    expect(updateChatMetadata).toHaveBeenCalledWith("chat-1", expect.objectContaining({ lastReadAt: expect.any(String) }), { touch: false });
    expect(record.updated_at).toBe(LAST_SAID);
    const meta = JSON.parse(record.metadata);
    expect(meta.title).toBe("Kept");
    // The rollup's unread test.
    expect(record.updated_at > meta.lastReadAt).toBe(false);
  });

  it("creates a record for a filesystem-only chat with the session's own timestamps", async () => {
    setChat({ stored: false });
    const res = await markRead();

    expect(res.code).toBe(200);
    expect(upsertChat).toHaveBeenCalledTimes(1);
    expect(record.created_at).toBe(BORN);
    expect(record.updated_at).toBe(LAST_SAID);
    expect(JSON.parse(record.metadata).lastReadAt).toEqual(expect.any(String));
  });

  it("refuses rather than replacing a record whose metadata does not parse", async () => {
    setChat({ metadata: '{"session_ids": ["sess' });
    const res = await markRead();

    expect(res.code).toBe(500);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(record.metadata).toBe('{"session_ids": ["sess');
  });

  it("404s for an unknown chat", async () => {
    chat = null;
    record = null;
    expect((await markRead()).code).toBe(404);
  });
});
