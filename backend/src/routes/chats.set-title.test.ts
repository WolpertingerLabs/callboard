/**
 * Route-level tests for PATCH /api/chats/:id/title — the hand-written rename
 * behind the sidebar's "Edit title" dialog.
 *
 * The regeneration route next door decides *what* a title should say; this one
 * decides nothing and is therefore all edges:
 *
 *  - the typed value is trimmed, and an empty one CLEARS the title rather than
 *    storing a blank — the same reset `set_chat_title` offers, so a chat falls
 *    back to its opening message instead of rendering as an empty row;
 *  - the rest of the metadata blob survives, since the write replaces it whole;
 *  - the write goes through `upsertChat`, so a chat that only exists as a
 *    session log gets a record instead of a silently dropped rename; and
 *  - open tabs are notified, because a rename nobody sees is not one.
 *
 * Same no-supertest style as chats.regenerate-title.test.ts: the handler is
 * pulled off the router stack and driven with a fake req/res.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-set-title-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

/** The chat findChat resolves, or null for "no such chat". */
let chat: any;

const upsertChat = vi.fn((id: string, folder: string, sessionId: string, updates: Record<string, unknown>) => ({
  id,
  folder,
  session_id: sessionId,
  ...updates,
}));
const notifyMetadata = vi.fn();

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => chat,
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: { upsertChat: (...args: any[]) => (upsertChat as any)(...args), getChat: () => chat },
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: (...args: unknown[]) => notifyMetadata(...args) } }));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));
vi.mock("../services/quick-completion.js", () => ({ generateChatTitleFromTranscript: () => Promise.resolve(null) }));

/** The real record store, for the one test that is about the store itself. */
const { chatFileService: realChatFileService } = await vi.importActual<typeof import("../services/chat-file-service.js")>("../services/chat-file-service.js");

const { chatsRouter } = await import("./chats.js");

const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/title" && layer.route.methods.patch).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function setTitle(body: unknown, id = "chat-1"): Promise<{ code: number; body: any }> {
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
    handler({ params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

function setChat(meta: Record<string, unknown> = {}) {
  chat = {
    id: "chat-1",
    folder: "/repo",
    session_id: "session-2",
    session_log_path: "/tmp/session-2.jsonl",
    metadata: JSON.stringify({ session_ids: ["session-1", "session-2"], preview: "add a dark mode toggle", title: "Old Title", ...meta }),
  };
}

/** The metadata blob the route wrote, parsed. */
const writtenMeta = () => JSON.parse((upsertChat.mock.calls.at(-1)![3] as any).metadata);

beforeEach(() => {
  upsertChat.mockClear();
  notifyMetadata.mockClear();
  setChat();
});

describe("PATCH /api/chats/:id/title", () => {
  it("stores the title and notifies open clients", async () => {
    const res = await setTitle({ title: "Dark mode toggle" });

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ title: "Dark mode toggle" });

    expect(upsertChat).toHaveBeenCalledTimes(1);
    expect(upsertChat.mock.calls[0].slice(0, 3)).toEqual(["chat-1", "/repo", "session-2"]);
    expect(writtenMeta().title).toBe("Dark mode toggle");
    // The write replaces the whole blob, so everything else has to survive it.
    expect(writtenMeta().session_ids).toEqual(["session-1", "session-2"]);
    expect(writtenMeta().preview).toBe("add a dark mode toggle");

    // Without this every open tab keeps the old title until its next poll.
    expect(notifyMetadata).toHaveBeenCalledWith("chat-1", { title: "Dark mode toggle" });
  });

  it("trims what the user typed", async () => {
    const res = await setTitle({ title: "  Dark mode toggle \n" });

    expect(res.body).toEqual({ title: "Dark mode toggle" });
    expect(writtenMeta().title).toBe("Dark mode toggle");
  });

  it("clears the title when the field is emptied", async () => {
    // Not a blank title: the row would render as an empty line. Cleared means
    // the chat falls back to its preview, which is what it looked like before
    // anything was ever generated for it.
    const res = await setTitle({ title: "   " });

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ title: null });
    expect(writtenMeta().title).toBeNull();
    expect(writtenMeta().preview).toBe("add a dark mode toggle");
    expect(notifyMetadata).toHaveBeenCalledWith("chat-1", { title: null });
  });

  it("creates a record on disk for a chat that only exists on the filesystem", async () => {
    // `updateChatMetadata` returns false for a chat with no record and drops
    // the write on the floor — and a chat nobody has ever renamed is exactly
    // the chat being renamed here. The spy cannot tell an upsert that created
    // from one that updated, so this one call uses the real store and looks
    // for the file in a data dir where it provably was not before.
    upsertChat.mockImplementationOnce((...args: any[]) => (realChatFileService.upsertChat as any)(...args));

    const record = join(DATA_DIR, "chats", "session-2.json");
    expect(existsSync(record)).toBe(false);

    const res = await setTitle({ title: "Named by hand" });

    expect(res.code).toBe(200);
    const written = JSON.parse(readFileSync(record, "utf8"));
    expect(written.id).toBe("chat-1");
    expect(JSON.parse(written.metadata).title).toBe("Named by hand");
    // And reachable through the store's own lookup, not just as bytes.
    expect(JSON.parse(realChatFileService.getChat("chat-1")!.metadata).title).toBe("Named by hand");
  });

  it("rejects a title that is not a string", async () => {
    const res = await setTitle({ title: 42 });

    expect(res.code).toBe(400);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });

  it("rejects a title past the 240-character cap", async () => {
    // The same cap `set_chat_title` enforces, so a title an agent can set is
    // one a user can type back.
    expect((await setTitle({ title: "x".repeat(240) })).code).toBe(200);
    upsertChat.mockClear();

    const res = await setTitle({ title: "x".repeat(241) });

    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/240/);
    expect(upsertChat).not.toHaveBeenCalled();
  });

  it("404s for a chat that does not exist", async () => {
    chat = null;
    const res = await setTitle({ title: "Nowhere" }, "nope");

    expect(res.code).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });
});
