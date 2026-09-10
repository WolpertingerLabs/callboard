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
/**
 * The stored record, or null for a chat that has only ever existed as a
 * session log — which is most of them, and the case the write path has to get
 * right. Separate from `chat` above on purpose: `findChat` answers for chats
 * with no record at all, so "found" and "stored" are genuinely different
 * states and the route treats them differently.
 */
let record: any = null;

/** Mirrors the real service closely enough to test the route's decisions. */
const updateChatMetadata = vi.fn((_id: string, fields: Record<string, unknown>, opts?: { touch?: boolean }) => {
  if (!record) return false;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(record.metadata);
  } catch {
    return false; // Fails closed on a record it cannot read — the real one does too.
  }
  record.metadata = JSON.stringify({ ...meta, ...fields });
  if (opts?.touch !== false) record.updated_at = "2026-09-10T00:00:00.000Z";
  return true;
});
const upsertChat = vi.fn((id: string, folder: string, sessionId: string, updates: Record<string, unknown>) => {
  record = { id, folder, session_id: sessionId, ...updates };
  return record;
});
const getChat = vi.fn(() => record);
const notifyMetadata = vi.fn();
const clearListCaches = vi.fn();

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => chat,
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    upsertChat: (...args: any[]) => (upsertChat as any)(...args),
    updateChatMetadata: (...args: any[]) => (updateChatMetadata as any)(...args),
    getChat: () => getChat(),
  },
}));
vi.mock("../services/list-caches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/list-caches.js")>()),
  clearListCaches: () => clearListCaches(),
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

/** Timestamps the session log gave the derived chat — nothing may rewrite them. */
const BORN = "2026-06-01T09:00:00.000Z";
const LAST_SAID = "2026-08-20T11:00:00.000Z";

/**
 * A chat that is both found and stored. `stored: false` leaves the record out,
 * for the filesystem-only case; `metadata` overrides the record's blob, for the
 * unreadable one.
 */
function setChat(meta: Record<string, unknown> = {}, opts: { stored?: boolean; metadata?: string } = {}) {
  const blob = JSON.stringify({ session_ids: ["session-1", "session-2"], preview: "add a dark mode toggle", title: "Old Title", ...meta });
  chat = {
    id: "chat-1",
    folder: "/repo",
    session_id: "session-2",
    session_log_path: "/tmp/session-2.jsonl",
    metadata: blob,
    created_at: BORN,
    updated_at: LAST_SAID,
  };
  // `findChat` stamps `_from_filesystem` in exactly the branch where the store
  // had no record, and the route now reads that instead of probing `getChat`
  // (two more uncached full-corpus scans). The fake has to carry it too, or
  // the record-less case is not the one the route actually sees.
  if (opts.stored === false) {
    chat._from_filesystem = true;
    record = null;
  } else {
    record = { ...chat, metadata: opts.metadata ?? blob };
  }
}

/** The metadata the route left behind, however it got there. */
const storedMeta = () => JSON.parse(record.metadata);

beforeEach(() => {
  upsertChat.mockClear();
  updateChatMetadata.mockClear();
  getChat.mockClear();
  notifyMetadata.mockClear();
  clearListCaches.mockClear();
  setChat();
});

describe("PATCH /api/chats/:id/title", () => {
  it("stores the title and notifies open clients", async () => {
    const res = await setTitle({ title: "Dark mode toggle" });

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ title: "Dark mode toggle" });

    expect(storedMeta().title).toBe("Dark mode toggle");
    // A read-merge-write in the store, not a blob replacement, so everything
    // else on the record survives untouched.
    expect(storedMeta().session_ids).toEqual(["session-1", "session-2"]);
    expect(storedMeta().preview).toBe("add a dark mode toggle");
    expect(upsertChat).not.toHaveBeenCalled();

    // Without this every open tab keeps the old title until its next poll.
    expect(notifyMetadata).toHaveBeenCalledWith("chat-1", { title: "Dark mode toggle" });
    // And without this a folder row keeps serving the old one out of cache
    // until the five-minute backstop expires. Invisible when omitted, so it
    // is asserted rather than trusted.
    expect(clearListCaches).toHaveBeenCalled();
  });

  it("renames without resurfacing the chat", async () => {
    // A title is a label, not activity. `updated_at` drives `lastActivityAt`
    // and `unread` in the card rollup, so a touch here sorts a card quiet for
    // weeks to the top of the board wearing an unread dot for a conversation
    // nobody added to. Same `touch: false` the card-title write already uses.
    await setTitle({ title: "Dark mode toggle" });

    expect(updateChatMetadata).toHaveBeenCalledWith("chat-1", { title: "Dark mode toggle" }, { touch: false });
    expect(record.updated_at).toBe(LAST_SAID);
  });

  it("trims what the user typed", async () => {
    const res = await setTitle({ title: "  Dark mode toggle \n" });

    expect(res.body).toEqual({ title: "Dark mode toggle" });
    expect(storedMeta().title).toBe("Dark mode toggle");
  });

  it("clears the title when the field is emptied", async () => {
    // Not a blank title: the row would render as an empty line. Cleared means
    // the chat falls back to its preview, which is what it looked like before
    // anything was ever generated for it.
    const res = await setTitle({ title: "   " });

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ title: null });
    expect(storedMeta().title).toBeNull();
    expect(storedMeta().preview).toBe("add a dark mode toggle");
    expect(notifyMetadata).toHaveBeenCalledWith("chat-1", { title: null });
  });

  it("refuses to write rather than reporting a success the store did not make", async () => {
    // `saveChat` is a plain writeFileSync, so a crash mid-write leaves a
    // truncated record. Merging into it is impossible, and a blob replacement
    // would take `session_ids` (the chat's whole history), `card`,
    // `parentChatId` and the rest down with it. `parseChatMetadata` cannot
    // report the difference — it answers {} for unreadable and empty alike —
    // so the store's own fail-closed read is what stands between the two.
    setChat({}, { metadata: '{"session_ids":["session-1"],"car' });

    const res = await setTitle({ title: "Named by hand" });

    expect(res.code).toBe(500);
    // The message does not name a cause: unreadable metadata, a full disk and
    // any other write failure are indistinguishable from the route, and
    // naming one would misdirect diagnosis on the others.
    expect(res.body.error).toMatch(/title is unchanged/i);
    // Untouched, not partially rewritten.
    expect(record.metadata).toBe('{"session_ids":["session-1"],"car');
    expect(upsertChat).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });

  it("creates a record on disk for a chat that only exists on the filesystem", async () => {
    // `updateChatMetadata` returns false for a chat with no record and drops
    // the write on the floor — and a chat nobody has ever renamed is exactly
    // the chat being renamed here. The spy cannot tell an upsert that created
    // from one that updated, so this one call uses the real store and looks
    // for the file in a data dir where it provably was not before.
    setChat({}, { stored: false });
    upsertChat.mockImplementationOnce((...args: any[]) => (realChatFileService.upsertChat as any)(...args));

    const path = join(DATA_DIR, "chats", "session-2.json");
    expect(existsSync(path)).toBe(false);

    const res = await setTitle({ title: "Named by hand" });

    expect(res.code).toBe(200);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.id).toBe("chat-1");
    expect(JSON.parse(written.metadata).title).toBe("Named by hand");
    // Dated from the session log, not from the rename. Left to default, the
    // create branch stamps `now` for both and the chat's real birthtime — the
    // only copy of it, since the record now shadows the log — is gone.
    expect(written.created_at).toBe(BORN);
    expect(written.updated_at).toBe(LAST_SAID);
    // And reachable through the store's own lookup, not just as bytes.
    expect(JSON.parse(realChatFileService.getChat("chat-1")!.metadata).title).toBe("Named by hand");
  });

  it("does not go looking for a record it already knows is absent", async () => {
    // `getChat` is uncached: a miss is a readdir + readFile + JSON.parse over
    // every record — ~44ms of blocked event loop on ~9k of them. Probing it to
    // find out whether a record exists would spend that twice over, on the
    // roughly one chat in three that has never had one. `findChat` already
    // answered the question via `_from_filesystem`, so nothing asks again.
    setChat({}, { stored: false });

    const res = await setTitle({ title: "Named by hand" });

    expect(res.code).toBe(200);
    expect(getChat).not.toHaveBeenCalled();
    expect(updateChatMetadata).not.toHaveBeenCalled();
    expect(upsertChat).toHaveBeenCalledTimes(1);
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
