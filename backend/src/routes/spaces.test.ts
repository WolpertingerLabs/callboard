/**
 * The spaces API end to end over a real (temp-dir) chat store: CRUD, moving
 * whole trees (PATCH /api/cards/:id and POST /api/spaces/:id/move), the
 * delete-with-moveTo rule, and the board's space scope — including the one
 * exception to separation, cross-space "needs you".
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-spaces-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Chat ids the stubbed pending-request probe reports as blocked on the user. */
const waiting = new Set<string>();
vi.mock("../services/claude.js", () => ({
  getActiveSession: () => null,
  hasPendingRequest: (id: string) => waiting.has(id),
  getPendingRequest: (id: string) => (waiting.has(id) ? { eventType: "permission_request" } : null),
}));
vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => {} }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/git.js")>()),
  resolveWorktreeToMainRepoCached: (folder: string) =>
    folder.startsWith("/repos/app-wt") ? { mainRepoPath: "/repos/app", isWorktree: true } : { mainRepoPath: folder, isWorktree: false },
}));

const { spacesRouter } = await import("./spaces.js");
const { cardsRouter } = await import("./cards.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { _resetSpaceStoreCache } = await import("../services/space-store.js");
const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

type Method = "get" | "post" | "patch" | "delete";
const handler = (router: any, path: string, method: Method) =>
  router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle as (req: Request, res: Response) => void;

function call(router: any, method: Method, path: string, req: Partial<Request>): Promise<{ status: number; body: any }> {
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
    handler(router, path, method)({ query: {}, params: {}, body: {}, ...req } as Request, res as unknown as Response);
  });
}

const spaces = (method: Method, path: string, req: Partial<Request> = {}) => call(spacesRouter, method, path, req);
const cards = (method: Method, path: string, req: Partial<Request> = {}) => call(cardsRouter, method, path, req);

function makeChat(folder: string, meta: Record<string, unknown> = {}) {
  return chatFileService.createChat(folder, `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta));
}
const stampOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata).spaceId;

beforeEach(() => {
  rmSync(join(tmpRoot, "chats"), { recursive: true, force: true });
  mkdirSync(join(tmpRoot, "chats"), { recursive: true });
  rmSync(join(tmpRoot, "spaces"), { recursive: true, force: true });
  _resetSpaceStoreCache();
  waiting.clear();
});

describe("/api/spaces CRUD", () => {
  it("lists General first and creates, patches and counts", async () => {
    const created = await spaces("post", "/", { body: { name: "Work", emoji: "💼" } });
    expect(created.status).toBe(201);
    const id = created.body.space.id;
    makeChat("/repos/x", { spaceId: id });
    makeChat("/repos/y");

    const list = await spaces("get", "/", { query: { includeCounts: "true" } as any });
    expect(list.body.spaces.map((s: any) => [s.name, s.chatCount])).toEqual([
      ["General", 1],
      ["Work", 1],
    ]);

    const patched = await spaces("patch", "/:id", { params: { id }, body: { instructions: "Use British English." } });
    expect(patched.body.space).toMatchObject({ name: "Work", emoji: "💼", instructions: "Use British English." });
    expect((await spaces("patch", "/:id", { params: { id }, body: { name: "" } })).status).toBe(400);
    expect((await spaces("patch", "/:id", { params: { id: "sp_missing" }, body: { name: "x" } })).status).toBe(404);
  });

  it("refuses to delete a space that still holds chats, then moves them with moveTo", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const home = (await spaces("post", "/", { body: { name: "Home" } })).body.space;
    const chat = makeChat("/repos/x", { spaceId: work.id });

    const refused = await spaces("delete", "/:id", { params: { id: work.id } });
    expect(refused.status).toBe(409);
    expect(refused.body.chatCount).toBe(1);

    const ok = await spaces("delete", "/:id", { params: { id: work.id }, query: { moveTo: home.id } as any });
    expect(ok.status).toBe(200);
    expect(stampOf(chat.id)).toBe(home.id);
    expect((await spaces("get", "/")).body.spaces.some((s: any) => s.id === work.id)).toBe(false);
  });

  it("moving into the default clears the stamp instead of writing it", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const chat = makeChat("/repos/x", { spaceId: work.id });
    await spaces("delete", "/:id", { params: { id: work.id }, query: { moveTo: "default" } as any });
    expect(stampOf(chat.id)).toBeUndefined();
  });

  it("never deletes the default space", async () => {
    expect((await spaces("delete", "/:id", { params: { id: "default" } })).status).toBe(400);
  });
});

describe("moving trees", () => {
  it("PATCH /api/cards/:id { spaceId } moves the whole tree, from any member id", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const root = makeChat("/repos/x");
    const child = makeChat("/repos/x", { parentChatId: root.id, rootChatId: root.id });
    const res = await cards("patch", "/:id", { params: { id: child.id }, body: { spaceId: work.id } });
    expect(res.status).toBe(200);
    expect(res.body.card.spaceId).toBe(work.id);
    expect(stampOf(root.id)).toBe(work.id);
    expect(stampOf(child.id)).toBe(work.id);
    // A view-only write: moving must not resurface the chat as fresh activity.
    expect(chatFileService.getChat(root.id)!.updated_at).toBe(root.updated_at);
  });

  it("refuses an unknown or archived target", async () => {
    const root = makeChat("/repos/x");
    expect((await cards("patch", "/:id", { params: { id: root.id }, body: { spaceId: "sp_missing" } })).status).toBe(400);
    const old = (await spaces("post", "/", { body: { name: "Old" } })).body.space;
    await spaces("patch", "/:id", { params: { id: old.id }, body: { archived: true } });
    expect((await cards("patch", "/:id", { params: { id: root.id }, body: { spaceId: old.id } })).status).toBe(400);
  });

  it("POST /:id/move by folder takes every tree rooted there, worktrees included", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const a = makeChat("/repos/app");
    const b = makeChat("/repos/app-wt-feature");
    const c = makeChat("/repos/other");
    const res = await spaces("post", "/:id/move", { params: { id: work.id }, body: { folder: "/repos/app" } });
    expect(res.body.movedRoots.sort()).toEqual([a.id, b.id].sort());
    expect(stampOf(c.id)).toBeUndefined();

    const groups = await spaces("get", "/folder-groups", { query: { from: work.id } as any });
    expect(groups.body.groups).toEqual([expect.objectContaining({ displayFolder: "/repos/app", rootCount: 2, chatCount: 2 })]);
  });

  it("POST /:id/move by ids reports per-id failures", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const a = makeChat("/repos/app");
    const res = await spaces("post", "/:id/move", { params: { id: work.id }, body: { chatIds: [a.id, "missing-id"] } });
    expect(res.body.movedRoots).toEqual([a.id]);
    expect(res.body.failed).toEqual([{ id: "missing-id", error: "Chat not found" }]);
  });
});

describe("GET /api/cards?space=", () => {
  it("scopes the board and keeps other spaces' needs-you cards when asked", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const mine = makeChat("/repos/x", { spaceId: work.id });
    const otherQuiet = makeChat("/repos/y");
    const otherBlocked = makeChat("/repos/z");
    waiting.add(otherBlocked.id);

    const scoped = await cards("get", "/", { query: { space: work.id } as any });
    expect(scoped.body.cards.map((c: any) => c.id)).toEqual([mine.id]);

    const withNeedsYou = await cards("get", "/", { query: { space: work.id, crossSpaceNeedsYou: "true" } as any });
    const ids = withNeedsYou.body.cards.map((c: any) => c.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(otherBlocked.id);
    expect(ids).not.toContain(otherQuiet.id);
    expect(withNeedsYou.body.cards.find((c: any) => c.id === otherBlocked.id)).toMatchObject({ rollup: "needs_you", spaceId: "default" });

    const all = await cards("get", "/", { query: {} as any });
    expect(all.body.cards).toHaveLength(3);
  });
});

describe("DELETE /api/spaces/:id — one definition of empty", () => {
  const writeJob = (id: string, spaceId: string) => {
    const dir = join(tmpRoot, "jobs", "definitions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        version: 1,
        defaults: { spaceId },
        steps: [{ id: "s", type: "notify", message: "x" }],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
  };

  it("counts jobs: a space holding only a job is refused without moveTo, with both counts", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    writeJob("only-job", work.id);
    const refused = await spaces("delete", "/:id", { params: { id: work.id } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ chatCount: 0, jobCount: 1 });
    const listed = await spaces("get", "/", { query: { includeCounts: "true" } as any });
    expect(listed.body.spaces.find((s: any) => s.id === work.id)).toMatchObject({ chatCount: 0, jobCount: 1 });
    const ok = await spaces("delete", "/:id", { params: { id: work.id }, query: { moveTo: "default" } as any });
    expect(ok.status).toBe(200);
    expect(ok.body.movedJobs).toBe(1);
    rmSync(join(tmpRoot, "jobs", "definitions", "only-job.json"), { force: true });
  });

  it("a stale member stamp does not block — no view shows it there — and is cleaned up", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const root = makeChat("/repos/x");
    const child = makeChat("/repos/x", { parentChatId: root.id, rootChatId: root.id, spaceId: work.id });
    const res = await spaces("delete", "/:id", { params: { id: work.id } });
    expect(res.status).toBe(200);
    expect(stampOf(child.id)).toBeUndefined();
  });

  it("refuses an archived moveTo, as every other move does", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const old = (await spaces("post", "/", { body: { name: "Old" } })).body.space;
    await spaces("patch", "/:id", { params: { id: old.id }, body: { archived: true } });
    const chat = makeChat("/repos/x", { spaceId: work.id });
    const res = await spaces("delete", "/:id", { params: { id: work.id }, query: { moveTo: old.id } as any });
    expect(res.status).toBe(400);
    expect(stampOf(chat.id)).toBe(work.id);
  });
});

describe("spaces: counts are opt-in, order is one request, list edits are deltas", () => {
  it("PATCH and GET /:id compute no counts unless asked", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    makeChat("/repos/x", { spaceId: work.id });
    expect((await spaces("patch", "/:id", { params: { id: work.id }, body: { emoji: "💼" } })).body.space.chatCount).toBe(0);
    expect((await spaces("get", "/:id", { params: { id: work.id } })).body.space.chatCount).toBe(0);
    expect((await spaces("get", "/:id", { params: { id: work.id }, query: { includeCounts: "true" } as any })).body.space.chatCount).toBe(1);
  });

  it("POST /order rewrites the order in one request", async () => {
    const a = (await spaces("post", "/", { body: { name: "A" } })).body.space;
    const b = (await spaces("post", "/", { body: { name: "B" } })).body.space;
    await spaces("post", "/order", { body: { ids: ["default", b.id, a.id] } });
    const names = (await spaces("get", "/")).body.spaces.map((s: any) => s.name);
    expect(names).toEqual(["General", "B", "A"]);
  });

  it("removeRecentDirectory and agentScope deltas edit the server's current copy", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    await spaces("patch", "/:id", {
      params: { id: work.id },
      body: { defaults: { recentDirectories: [{ path: "/a" }, { path: "/b" }] }, agentScope: { plugins: ["p1", "p2"] } },
    });
    // Another writer added /c since this tab loaded the list.
    await spaces("patch", "/:id", { params: { id: work.id }, body: { defaults: { recentDirectories: [{ path: "/c" }, { path: "/a" }, { path: "/b" }] } } });
    await spaces("patch", "/:id", {
      params: { id: work.id },
      body: { removeRecentDirectory: "/a", agentScopeRemove: { plugins: ["p1"] }, agentScopeAdd: { plugins: ["p3"] } },
    });
    const space = (await spaces("get", "/:id", { params: { id: work.id } })).body.space;
    expect(space.defaults.recentDirectories.map((d: any) => d.path)).toEqual(["/c", "/b"]);
    expect(space.agentScope.plugins).toEqual(["p2", "p3"]);
  });

  it("GET /of/:chatId flags an archived space", async () => {
    const old = (await spaces("post", "/", { body: { name: "Old" } })).body.space;
    const chat = makeChat("/repos/x", { spaceId: old.id });
    await spaces("patch", "/:id", { params: { id: old.id }, body: { archived: true } });
    const res = await spaces("get", "/of/:chatId", { params: { chatId: chat.id } as any });
    expect(res.body).toMatchObject({ spaceId: old.id, archived: true });
  });
});

describe("PATCH /api/cards/:id with spaceId is all-or-nothing", () => {
  it("a field that fails validation leaves the tree where it was", async () => {
    const work = (await spaces("post", "/", { body: { name: "Work" } })).body.space;
    const root = makeChat("/repos/x");
    const res = await cards("patch", "/:id", { params: { id: root.id }, body: { spaceId: work.id, title: "   " } });
    expect(res.status).toBe(400);
    expect(stampOf(root.id)).toBeUndefined();
  });

  it("an unknown target space is a 400 before anything is written", async () => {
    const root = makeChat("/repos/x");
    const res = await cards("patch", "/:id", { params: { id: root.id }, body: { spaceId: "sp_nope", title: "New title" } });
    expect(res.status).toBe(400);
    expect(JSON.parse(chatFileService.getChat(root.id)!.metadata).card).toBeUndefined();
  });
});
