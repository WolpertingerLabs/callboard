/**
 * Pinning, on the two routes that carry it: `PATCH /api/chats/:id/pin` writes
 * the flag, and `GET /api/chats?includePinned=true` makes sure a pinned chat is
 * on the page even when recency would have left it off.
 *
 * That second half is the whole reason the param exists. Sectioning the loaded
 * rows is a render-time partition, so a chat pinned and then left alone for a
 * week falls out of the pagination window and out of the Pinned section with
 * it. `includeLineage` already solved this shape of problem by appending
 * outside the window; this follows it.
 *
 * What the suite spends most of its assertions on is the other half of
 * "additive": every filter the request carries still applies to an appended
 * pinned chat. A pin is a position in the list, never an exemption from its
 * scope — a pinned chat on an archived card must stay out of an `unarchived`
 * response, because that scope is the exact complement of the sidebar's dim and
 * one smuggled row would put a faded chat in a view whose whole claim is that
 * it has none.
 *
 * Same no-supertest style as chats.cards-only.test.ts — the handler is pulled
 * off the router stack and driven with a fake req/res. Chats live in memory
 * (the file service is stubbed) and so does session discovery.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pinned-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Chat records the stubbed file service hands back, set per test. */
let fileChats: any[] = [];
/** Session ids the stubbed provider discovers, newest first. */
let sessionIds: string[] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
    // The pin route's writer. Mutates the in-memory record the way the
    // file-backed service would, so a round-trip really is a round-trip.
    upsertChat: (id: string, _folder: string, _sessionId: string, fields: Record<string, unknown>) => {
      const chat = fileChats.find((c) => c.id === id);
      if (!chat) throw new Error(`no such chat: ${id}`);
      Object.assign(chat, fields);
      return chat;
    },
  },
}));
// findChat is stubbed rather than driven, so the pin route's lookup is a
// property of the fixture and not of session-provenance resolution.
vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: (id: string) => {
    const chat = fileChats.find((c) => c.id === id);
    return chat ? { ...chat, displayFolder: chat.folder, session_log_path: null } : null;
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
// Real git calls would shell out once per distinct folder.
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const sessions = sessionIds.map((sessionId, i) => ({
          sessionId,
          folder: "/tmp/proj",
          displayFolder: "/tmp/proj",
          filePath: `/tmp/proj/${sessionId}.jsonl`,
          // Newest first, matching real discovery order.
          createdAt: new Date(2026, 0, 1, 0, sessionIds.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessionIds.length - i),
        }));
        return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { chatsRouter } = await import("./chats.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const routeHandler = (path: string, method: "get" | "patch") =>
  (chatsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;

const listHandler = routeHandler("/", "get");
const pinHandler = routeHandler("/:id/pin", "patch");

function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ status: number; body: any }> {
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
    handler(req as Request, res as unknown as Response);
  });
}

/**
 * GET / with the given query. `cached` defaults to false — the route caches by
 * query string and these tests rewrite the fixture set between assertions — so
 * the cache-key suite passes it explicitly.
 */
async function listChats(query: Record<string, string>): Promise<any> {
  const { body } = await invoke(listHandler, { query: { cached: "false", ...query } });
  return body;
}

const pin = (id: string, body: Record<string, unknown>) => invoke(pinHandler, { params: { id }, body } as Partial<Request>);

function chat(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    folder: "/tmp/proj",
    session_id: id,
    metadata: JSON.stringify(metadata),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const idsOf = (body: any) => body.chats.map((c: any) => c.id);
const metaOf = (id: string) => JSON.parse(fileChats.find((c) => c.id === id)!.metadata);
const rowFor = (body: any, id: string) => body.chats.find((c: any) => c.id === id);

beforeEach(() => {
  fileChats = [
    // Inside the window at limit=3, and pinned: the row the append pass must
    // NOT emit a second time.
    chat("in-window-pinned", { pinned: true }),
    chat("recent-1", {}),
    chat("recent-2", {}),
    chat("recent-3", {}),
    chat("recent-4", {}),
    // Pinned but stale — the case the whole param exists for.
    chat("stale-pinned", { pinned: true }),
    // Pinned AND on a closed card: excluded by cardLifecycle=unarchived, and
    // the pin must not buy it back in.
    chat("archived-pinned", { pinned: true, card: { lifecycle: "closed" } }),
    // Pinned automation: excluded by excludeTriggered, likewise.
    chat("triggered-pinned", { pinned: true, triggered: true }),
    // Bookmarked but not pinned, and pinned but not bookmarked: the two flags
    // are independent, and the "Bookmarked only" filter must still say so.
    chat("bookmarked-only", { bookmarked: true }),
  ];
  // Newest first. Everything pinned except `in-window-pinned` sits past the
  // first page at limit=3.
  sessionIds = [
    "in-window-pinned",
    "recent-1",
    "recent-2",
    "recent-3",
    "recent-4",
    "bookmarked-only",
    "triggered-pinned",
    "archived-pinned",
    "stale-pinned",
  ];
});

describe("PATCH /api/chats/:id/pin", () => {
  it("round-trips the flag through the stored record", async () => {
    expect(metaOf("recent-1").pinned).toBeUndefined();

    const set = await pin("recent-1", { pinned: true });
    expect(set.status).toBe(200);
    expect(JSON.parse(set.body.metadata).pinned).toBe(true);
    expect(metaOf("recent-1").pinned).toBe(true);

    const unset = await pin("recent-1", { pinned: false });
    expect(unset.status).toBe(200);
    expect(metaOf("recent-1").pinned).toBe(false);
  });

  it("leaves every other metadata key alone, the bookmark included", async () => {
    // The two flags are independent by decision: a bookmark is a filter, a pin
    // is a position, and a chat routinely wants one without the other. Writing
    // either through the other's key would make that impossible to express.
    await pin("bookmarked-only", { pinned: true });
    expect(metaOf("bookmarked-only")).toEqual({ bookmarked: true, pinned: true });

    await pin("bookmarked-only", { pinned: false });
    expect(metaOf("bookmarked-only").bookmarked).toBe(true);
  });

  it("rejects a non-boolean rather than storing whatever arrived", async () => {
    // The list route reads `pinned === true`, so a stored "true" would be a
    // pin the user cannot see and cannot clear.
    for (const body of [{ pinned: "true" }, { pinned: 1 }, {}]) {
      const res = await pin("recent-1", body);
      expect(res.status).toBe(400);
    }
    expect(metaOf("recent-1").pinned).toBeUndefined();
  });

  it("404s for a chat that does not exist", async () => {
    expect((await pin("no-such-chat", { pinned: true })).status).toBe(404);
  });
});

describe("GET /api/chats?includePinned=true", () => {
  const PAGE = { limit: "3", includeLineage: "true", cardLifecycle: "unarchived", excludeTriggered: "true" };

  it("appends a pinned chat from outside the pagination window", async () => {
    const without = await listChats(PAGE);
    // The control, and the reason the feature is needed at all: recency alone
    // leaves the stale pin off the page entirely.
    expect(idsOf(without)).not.toContain("stale-pinned");

    const withPinned = await listChats({ ...PAGE, includePinned: "true" });
    expect(idsOf(withPinned)).toContain("stale-pinned");
    expect(rowFor(withPinned, "stale-pinned")._pinned_appended).toBe(true);
    // Everything the page already had is still there, in the order it was in:
    // this is an append, not a re-sort.
    expect(idsOf(withPinned).slice(0, without.chats.length)).toEqual(idsOf(without));
  });

  it("does not append a pinned chat that is already in the window", async () => {
    const body = await listChats({ ...PAGE, includePinned: "true" });
    expect(idsOf(body).filter((id: string) => id === "in-window-pinned")).toEqual(["in-window-pinned"]);
    // ...and the row it kept is the paginated one, not an appended copy. A
    // duplicate would render in the sidebar as its own lineage group.
    expect(rowFor(body, "in-window-pinned")._pinned_appended).toBeUndefined();
  });

  it("leaves a pinned chat that the card-lifecycle scope excludes excluded", async () => {
    // The invariant three PRs went into: with "Archived" off, no fetched row is
    // dimmed. A pinned row is not allowed to be the exception that breaks it.
    const scoped = await listChats({ ...PAGE, includePinned: "true", limit: "50" });
    expect(idsOf(scoped)).not.toContain("archived-pinned");

    // Control: it is a real chat and the scope is what is withholding it, so
    // widening to `all` brings it back — dimmed, in the Pinned section.
    const unscoped = await listChats({ ...PAGE, includePinned: "true", limit: "50", cardLifecycle: "all" });
    expect(idsOf(unscoped)).toContain("archived-pinned");
  });

  it("leaves a pinned chat that the triggered filter excludes excluded", async () => {
    const filtered = await listChats({ ...PAGE, includePinned: "true", limit: "50" });
    expect(idsOf(filtered)).not.toContain("triggered-pinned");

    const shown = await listChats({ ...PAGE, includePinned: "true", limit: "50", excludeTriggered: "false" });
    expect(idsOf(shown)).toContain("triggered-pinned");
  });

  it("leaves a pinned chat that the bookmark filter excludes excluded", async () => {
    // "Bookmarked only" is a filter over the whole list; a pin is not a way
    // past it. The other direction is the point of the fixture pair: a
    // bookmarked chat is not pinned by being bookmarked.
    const body = await listChats({ ...PAGE, bookmarked: "true", includePinned: "true", limit: "50" });
    expect(idsOf(body)).toEqual(["bookmarked-only"]);
  });

  it("does not move hasMore or total — appended rows hang off the page", async () => {
    const without = await listChats(PAGE);
    const withPinned = await listChats({ ...PAGE, includePinned: "true" });

    expect(withPinned.total).toBe(without.total);
    expect(withPinned.hasMore).toBe(without.hasMore);
    expect(withPinned.windowRows).toBe(without.windowRows);
    // The claim that makes those numbers meaningful: the response really did
    // carry more rows than the window it reported.
    expect(withPinned.chats.length).toBeGreaterThan(withPinned.windowRows);
  });

  it("still paginates when includePinned is the only reason the fetch widened", async () => {
    // Deliberately WITHOUT includeLineage or a lifecycle scope, which every
    // case above happens to carry. `includePinned` sets `needsPostFilter`, so
    // the route over-fetches all 9999 sessions to find an out-of-window pin —
    // and a pagination branch chain that does not also name it falls through
    // to "sessions are already paginated" and hands that whole over-fetch back
    // as the page.
    const body = await listChats({ limit: "2", includePinned: "true" });
    expect(body.windowRows).toBe(2);
    expect(idsOf(body).slice(0, 2)).toEqual(["in-window-pinned", "recent-1"]);
    expect(body.hasMore).toBe(true);
    // ...while the append still happens on top of that page.
    expect(idsOf(body)).toContain("stale-pinned");
  });

  it("keeps the page itself intact when nothing is pinned at all", async () => {
    fileChats = fileChats.map((c) => chat(c.id, { ...JSON.parse(c.metadata), pinned: false }));
    const without = await listChats(PAGE);
    const withPinned = await listChats({ ...PAGE, includePinned: "true" });
    expect(idsOf(withPinned)).toEqual(idsOf(without));
  });
});

/**
 * The response cache is keyed by query string, and the param has to be in that
 * key. Left out, a request that asked for pinned chats would be answered from
 * an entry built for one that did not — and, worse, the other way round, which
 * puts rows in a caller's list that its own filters never admitted.
 *
 * These cases run WITH caching (a unique `limit` per case keeps them off each
 * other's entries) because a collision is the only thing they can catch, and
 * `cached=false` would hide it.
 */
describe("GET /api/chats includePinned cache key", () => {
  const base = { includeLineage: "true", cardLifecycle: "unarchived", excludeTriggered: "true" };

  it("does not serve a pinned-inclusive response to a request without the param", async () => {
    const warm = await listChats({ ...base, limit: "4", includePinned: "true", cached: "true" });
    expect(idsOf(warm)).toContain("stale-pinned");

    const plain = await listChats({ ...base, limit: "4", cached: "true" });
    expect(idsOf(plain)).not.toContain("stale-pinned");
  });

  it("does not serve a plain response to a request that asked for pinned chats", async () => {
    const plain = await listChats({ ...base, limit: "5", cached: "true" });
    expect(idsOf(plain)).not.toContain("stale-pinned");

    const warm = await listChats({ ...base, limit: "5", includePinned: "true", cached: "true" });
    expect(idsOf(warm)).toContain("stale-pinned");
  });
});
