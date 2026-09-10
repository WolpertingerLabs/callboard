/**
 * Route-level tests for POST /api/chats/bulk-delete — the sidebar's
 * multi-select delete.
 *
 * Written against `POST /api/cards/bulk-lifecycle` as the reference (see
 * cards.bulk-lifecycle.test.ts): same partial-success contract, same tolerance
 * of ids that no longer exist, same one-notification-per-batch, and the same
 * routing test at the bottom — a bulk path that a `/:id` route can swallow is
 * a routing bug wearing a data bug's clothes.
 *
 * The one thing this suite has to pin that the cards one does not is that a
 * bulk delete is exactly N single deletes and not a cascade: `DELETE
 * /api/chats/:id` has never deleted the chats forked from its target, and both
 * routes now run the same `deleteOneChat`, so the tests at the bottom hold the
 * single route to its old answers as well.
 *
 * Same no-supertest style as chats.set-title.test.ts: the handler is pulled off
 * the router stack and driven with a fake req/res. The handler is resolved by
 * path alone, not path+method, so the routing test stays the only thing that
 * fails if the verb or the position of the route regresses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-bulk-delete-"));

/** The chat corpus `findChat` answers from, keyed by id. */
const corpus = new Map<string, any>();
/** Chats whose native agent refuses to be controlled — read-only children. */
const readOnly = new Set<string>();

const deleteSessionFiles = vi.fn();
const deleteChat = vi.fn((sessionId: string) => {
  for (const [id, chat] of corpus) if (chat.session_id === sessionId) corpus.delete(id);
});
const notifyMetadata = vi.fn();
const clearListCaches = vi.fn();
/**
 * The two store lookups, spied separately, because which one the route uses is
 * the difference between a bounded batch and a stalled daemon: `getChat`'s miss
 * path is a readdir + parse of every record (~45 ms across 9.2k on a real data
 * dir) and `getAllChats` is one stat-gated pass for the whole batch.
 */
const getChat = vi.fn((id: string) => corpus.get(id) ?? null);
const getAllChats = vi.fn(() => [...corpus.values()]);
/** The `storedRecord` hint each `findChat` call received — undefined means "look it up yourself". */
const storedRecordArgs: unknown[] = [];

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  // Mirrors the real signature's contract: a passed hint (record or null) is
  // used as-is, an omitted one is looked up. chat-lookup.storedRecord.test.ts
  // holds the real implementation to the same rule.
  findChat: (id: string, _includeGitInfo?: boolean, storedRecord?: unknown) => {
    storedRecordArgs.push(storedRecord);
    if (storedRecord !== undefined) return storedRecord;
    return getChat(id);
  },
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getChat: (...args: any[]) => (getChat as any)(...args),
    getAllChats: (...args: any[]) => (getAllChats as any)(...args),
    deleteChat: (...args: any[]) => (deleteChat as any)(...args),
  },
}));
vi.mock("../services/list-caches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/list-caches.js")>()),
  clearListCaches: () => clearListCaches(),
}));
vi.mock("../services/session-registry.js", () => ({
  sessionRegistry: { has: () => false, notifyMetadata: (...args: unknown[]) => notifyMetadata(...args) },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [{ kind: "claude-code", deleteSessionFiles: (...args: any[]) => (deleteSessionFiles as any)(...args) }],
}));
vi.mock("../services/codex-native-agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/codex-native-agents.js")>()),
  assertNativeAgentControllable: (id: string) => {
    if (readOnly.has(id)) throw new Error(`Chat ${id} is a read-only native agent child`);
  },
}));
vi.mock("../services/quick-completion.js", () => ({ generateChatTitleFromTranscript: () => Promise.resolve(null) }));

const { chatsRouter } = await import("./chats.js");

const layerFor = (path: string, method: string) =>
  (chatsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;

const bulkHandler = layerFor("/bulk-delete", "post");
const singleHandler = layerFor("/:id", "delete");

/** Drive a handler directly and resolve with the status code and JSON body. */
function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ code: number; body: any }> {
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
    handler(req as Request, res as unknown as Response);
  });
}

const bulkDelete = (body: unknown) => invoke(bulkHandler, { body } as Partial<Request>);
const deleteOne = (id: string) => invoke(singleHandler, { params: { id } } as unknown as Partial<Request>);

/**
 * Drive a request through the real router so Express's own matching decides
 * which handler runs — the only way to observe path shadowing.
 * `matched` is false when the router fell through to next().
 */
function dispatch(method: string, url: string, body: unknown): Promise<{ matched: boolean; code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ matched: true, code: this.statusCode, body: payload });
        return this;
      },
    };
    (chatsRouter as any)({ method, url, body, headers: {}, query: {} } as unknown as Request, res as unknown as Response, () =>
      resolve({ matched: false, code: 404, body: undefined }),
    );
  });
}

/** Put a chat in the corpus. `parentChatId` makes it a fork of another. */
function makeChat(id: string, meta: Record<string, unknown> = {}, sessionId = `session-${id}`) {
  corpus.set(id, {
    id,
    folder: "/repo",
    session_id: sessionId,
    session_log_path: `/tmp/${sessionId}.jsonl`,
    metadata: JSON.stringify(meta),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
  });
  return id;
}

beforeEach(() => {
  corpus.clear();
  readOnly.clear();
  deleteSessionFiles.mockClear();
  deleteChat.mockClear();
  notifyMetadata.mockClear();
  clearListCaches.mockClear();
  getChat.mockClear();
  getAllChats.mockClear();
  storedRecordArgs.length = 0;
});

describe("POST /api/chats/bulk-delete", () => {
  it("deletes a batch, naming exactly the ids it deleted", async () => {
    const ids = [makeChat("a"), makeChat("b"), makeChat("c")];

    const res = await bulkDelete({ ids });

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ deleted: ids, failed: [] });
    // Both halves of a delete, per chat: the provider's session log first, the
    // stored record second.
    expect(deleteSessionFiles).toHaveBeenCalledTimes(3);
    expect(deleteChat.mock.calls.map((c) => c[0])).toEqual(["session-a", "session-b", "session-c"]);
    expect(corpus.size).toBe(0);
  });

  it("does not cascade to a deleted chat's children", async () => {
    const parent = makeChat("parent");
    makeChat("child", { parentChatId: parent, rootChatId: parent });

    const res = await bulkDelete({ ids: [parent] });

    expect(res.body.deleted).toEqual([parent]);
    // The fork survives with a dangling parent pointer, which is exactly what
    // `DELETE /:id` has always left behind. A bulk path that quietly took the
    // tree with it would delete work the user never selected.
    expect(deleteChat.mock.calls.map((c) => c[0])).toEqual(["session-parent"]);
    expect(corpus.has("child")).toBe(true);
  });

  it("returns 200 with BOTH arrays populated when the batch mixes real and missing ids", async () => {
    const good = makeChat("real-1");
    const alsoGood = makeChat("real-2");

    // Two missing ids — a well-formed chat id with no record, and junk. Both
    // are "not found" to the caller, and neither may strand the ids after them.
    const res = await bulkDelete({ ids: [good, "chat-nope", "not-an-id", alsoGood] });

    expect(res.code).toBe(200);
    expect(res.body.deleted).toEqual([good, alsoGood]);
    expect(res.body.failed).toEqual([
      { id: "chat-nope", error: "Chat not found" },
      { id: "not-an-id", error: "Chat not found" },
    ]);
    // The failures sat between the two real ids: the trailing one still went.
    expect(corpus.has(alsoGood)).toBe(false);
  });

  it("reports a chat that refuses to be deleted, and deletes the rest", async () => {
    const good = makeChat("deletable");
    const child = makeChat("native-child");
    readOnly.add(child);

    const res = await bulkDelete({ ids: [child, good] });

    expect(res.code).toBe(200);
    expect(res.body.deleted).toEqual([good]);
    expect(res.body.failed).toEqual([{ id: child, error: `Chat ${child} is a read-only native agent child` }]);
    // Nothing was deleted for the refusing chat — not its session files either.
    expect(deleteSessionFiles).toHaveBeenCalledTimes(1);
    expect(corpus.has(child)).toBe(true);
  });

  it("reports a chat whose provider cannot be resolved", async () => {
    makeChat("broken");
    corpus.get("broken")._provider_resolution_error = "Unknown provider 'ghost'";

    const res = await bulkDelete({ ids: ["broken"] });

    expect(res.body).toEqual({ deleted: [], failed: [{ id: "broken", error: "Unknown provider 'ghost'" }] });
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("dedupes a repeated id — one delete, one report", async () => {
    const id = makeChat("twice");

    const res = await bulkDelete({ ids: [id, id] });

    // Without the dedupe the second pass would find no record and report a
    // spurious "Chat not found" beside its own success.
    expect(res.body).toEqual({ deleted: [id], failed: [] });
    expect(deleteChat).toHaveBeenCalledTimes(1);
  });

  it("400s when ids is not an array, is empty, or holds a non-string", async () => {
    for (const ids of [undefined, "chat-1", 42, {}, [], ["chat-1", 7], [null]]) {
      const res = await bulkDelete({ ids });
      expect(res.code, `ids=${JSON.stringify(ids)}`).toBe(400);
      expect(res.body.error).toMatch(/non-empty array of strings/);
    }
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("accepts batches larger than the cards route's former 200-id cap", async () => {
    // #394 removed that cap when "Select all" over 804 cards made batches this
    // size routine; the sidebar has the same "Select all".
    const ids = Array.from({ length: 201 }, (_, i) => `chat-bulk-${i}`);

    const res = await bulkDelete({ ids });

    expect(res.code).toBe(200);
    expect(res.body.deleted).toEqual([]);
    expect(res.body.failed).toHaveLength(ids.length);
  });

  it("notifies metadata exactly ONCE for an N-chat batch, not once per chat", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => makeChat(`batch-${i}`));

    await bulkDelete({ ids });

    expect(notifyMetadata).toHaveBeenCalledTimes(1);
    expect(clearListCaches).toHaveBeenCalledTimes(1);
    // The one notification carries an id from the batch so the refetch it
    // triggers is attributable, and says `cardEvent` because deleting a
    // lineage root removes a card.
    expect(ids).toContain(notifyMetadata.mock.calls[0][0]);
    expect(notifyMetadata.mock.calls[0][1]).toEqual({ cardEvent: "updated" });
  });

  it("does not notify or clear caches when nothing in the batch existed", async () => {
    const res = await bulkDelete({ ids: ["ghost-1", "ghost-2"] });

    expect(res.body.deleted).toEqual([]);
    expect(res.body.failed).toHaveLength(2);
    expect(notifyMetadata).not.toHaveBeenCalled();
    expect(clearListCaches).not.toHaveBeenCalled();
  });

  it("notifies with the RESOLVED record id, as the single route does", async () => {
    // An id can arrive as a session id — the sidebar sends whatever it holds —
    // and the notification names the chat that changed, not the key it was
    // asked about.
    makeChat("record-id", {}, "session-alias");

    const res = await bulkDelete({ ids: ["session-alias"] });

    // `deleted` is keyed by what the client asked for, so it can filter its own
    // rows; the notification is keyed by the record.
    expect(res.body.deleted).toEqual(["session-alias"]);
    expect(notifyMetadata).toHaveBeenCalledWith("record-id", { cardEvent: "updated" });
  });

  it("resolves POST /bulk-delete to the bulk handler — never a 404 from a /:id route", async () => {
    const id = makeChat("routed");

    const res = await dispatch("POST", "/bulk-delete", { ids: [id] });

    // The failure modes this pins: falling through to next() (no such route),
    // or being swallowed by a `/:id`-shaped route and answering "Chat not
    // found" for a chat called "bulk-delete".
    expect(res.matched).toBe(true);
    expect(res.code).toBe(200);
    expect(res.body?.error).toBeUndefined();
    expect(res.body.deleted).toEqual([id]);
  });
});

/**
 * The single-chat route, held to the answers it gave before it was folded onto
 * the shared `deleteOneChat`.
 *
 * The refactor is the risk: three different refusals used to be written inline
 * in the handler, each with its own status and body, and the bulk route needed
 * them as one-line reasons instead. Both shapes now come off the same error, so
 * these are what prove the single route's responses did not quietly change.
 */
describe("DELETE /api/chats/:id after the shared-helper refactor", () => {
  it("still deletes both halves and answers ok", async () => {
    const id = makeChat("solo");

    const res = await deleteOne(id);

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteSessionFiles).toHaveBeenCalledTimes(1);
    expect(deleteChat).toHaveBeenCalledWith("session-solo");
    expect(notifyMetadata).toHaveBeenCalledWith(id, { cardEvent: "updated" });
  });

  it("still 404s for a chat that does not exist", async () => {
    const res = await deleteOne("nope");
    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: "Chat not found" });
  });

  it("still 409s a read-only native child, with its own error code and message", async () => {
    const id = makeChat("native");
    readOnly.add(id);

    const res = await deleteOne(id);

    expect(res.code).toBe(409);
    expect(res.body.error).toBe("native_child_read_only");
    expect(res.body.message).toMatch(/read-only native agent child/);
    // And the refusal comes BEFORE any deletion is attempted.
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it("still 409s a chat whose provider cannot be resolved", async () => {
    makeChat("broken");
    corpus.get("broken")._provider_resolution_error = "Unknown provider 'ghost'";

    const res = await deleteOne("broken");

    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "Unknown provider 'ghost'" });
  });
});

/**
 * The cost of a batch, which is the reason this route can be uncapped.
 *
 * `POST /api/cards/bulk-lifecycle` gets away with an uncapped batch because it
 * builds `createCardContext()` once and resolves every id off a Map. This route
 * had no such context: each id went through `findChat` → `chatFileService.getChat`,
 * whose miss path is a readdir + parse of the whole records directory (~45 ms
 * across 9.2k records, measured) — ~9 s of blocked event loop for 200 ids, and
 * the ids most likely to miss are the ones the client retries, since it keeps
 * failed ids selected and the dominant failure is "not found".
 */
describe("the batch's cost", () => {
  it("takes ONE record snapshot for the whole batch and never scans per id", async () => {
    const ids = [makeChat("real-a"), makeChat("real-b"), "ghost-1", "ghost-2", "ghost-3"];

    await bulkDelete({ ids });

    // One stat-gated pass, not one per id...
    expect(getAllChats).toHaveBeenCalledTimes(1);
    // ...and the whole-directory scan is never reached, for a hit OR a miss.
    // This is the assertion that fails if the snapshot is removed or if a
    // second lookup creeps back into `deleteOneChat`.
    expect(getChat).not.toHaveBeenCalled();
  });

  it("tells findChat there is no record, rather than letting it look again", async () => {
    const present = makeChat("present");

    await bulkDelete({ ids: [present, "absent"] });

    // `null`, not `undefined`: the snapshot is authoritative over the records
    // directory, so "absent from it" is "there is no record" and findChat can
    // go straight to its filesystem fallback. `undefined` would mean "look it
    // up yourself" and buy back the scan this exists to remove.
    expect(storedRecordArgs).toHaveLength(2);
    expect(storedRecordArgs[0]).toMatchObject({ id: present });
    expect(storedRecordArgs[1]).toBeNull();
  });

  it("yields the event loop mid-batch instead of blocking it for the whole run", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => makeChat(`many-${i}`));

    /** How many deletes had happened when a task queued from OUTSIDE the batch got to run. */
    let deletesAtInterleave = -1;
    const pending = bulkDelete({ ids });
    setImmediate(() => {
      deletesAtInterleave = deleteChat.mock.calls.length;
    });
    const res = await pending;

    expect(res.body.deleted).toHaveLength(60);
    // A handler that never yielded would finish all 60 before anything else in
    // the daemon ran, and this would be 60. Some SSE frame, some poll, some
    // other request gets a turn instead — which is the whole property, since
    // the remaining per-id cost is the provider's own file lookups (Codex
    // re-walks its rollout tree after each unlink invalidates the memo).
    expect(deletesAtInterleave).toBeGreaterThan(0);
    expect(deletesAtInterleave).toBeLessThan(60);
  });
});
