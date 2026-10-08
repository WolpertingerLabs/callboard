/**
 * `GET /api/chats?space=…` — the sidebar's space partition.
 *
 * A space is resolved at the lineage ROOT (space-membership.ts), so most of
 * these assertions are about the paths a chat could leak through rather than
 * the happy path: the response cache (keyed by query string), the pinned and
 * lineage append passes (which run corpus-wide before the scope), a member
 * whose own stamp disagrees with its root, and discovered sessions with no
 * record, which resolve through folder rules per response.
 *
 * Same no-supertest style as chats.pinned.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-space-scope-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

let fileChats: any[] = [];
/** [sessionId, folder] pairs the stubbed provider discovers, newest first. */
let sessions: [string, string][] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
    getChatBySessionId: (id: string) => fileChats.find((c) => c.session_id === id) ?? null,
    updateChatMetadata: (id: string, fields: Record<string, unknown>) => {
      const chat = fileChats.find((c) => c.id === id);
      if (!chat) return false;
      chat.metadata = JSON.stringify({ ...JSON.parse(chat.metadata || "{}"), ...fields });
      return true;
    },
  },
}));
vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: (id: string) => {
    const chat = fileChats.find((c) => c.id === id);
    return chat ? { ...chat, displayFolder: chat.folder, session_log_path: null } : null;
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveBranch: () => ({ ok: true, folder: "/tmp/work" }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder, isWorktree: false }),
}));
vi.mock("../services/app-plugins.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/app-plugins.js")>()),
  getAllAppPluginsData: () => ({
    scanRoots: [],
    plugins: [
      { id: "p-slack", enabled: true, manifest: { name: "slack" }, commands: [] },
      { id: "p-git", enabled: true, manifest: { name: "git" }, commands: [] },
    ],
  }),
  getEnabledAppPlugins: () => [
    { id: "p-slack", enabled: true, manifest: { name: "slack" }, commands: [] },
    { id: "p-git", enabled: true, manifest: { name: "git" }, commands: [] },
  ],
}));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const all = sessions.map(([sessionId, folder], i) => ({
          sessionId,
          folder,
          displayFolder: folder,
          filePath: `${folder}/${sessionId}.jsonl`,
          createdAt: new Date(2026, 0, 1, 0, sessions.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessions.length - i),
        }));
        return { sessions: all.slice(offset, offset + limit), total: all.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);
const { createSpace, _resetSpaceStoreCache } = await import("../services/space-store.js");
const { chatsRouter } = await import("./chats.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const routeHandler = (path: string, method: "get") =>
  (chatsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;
const listHandler = routeHandler("/", "get");
const treeHandler = routeHandler("/:id/tree", "get");
const newInfoHandler = routeHandler("/new/info", "get");

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

const listChats = async (query: Record<string, string>) => (await invoke(listHandler, { query: { cached: "false", ...query } })).body;
const idsOf = (body: any) => body.chats.map((c: any) => c.id).sort();

function chat(id: string, metadata: Record<string, unknown>, folder = "/tmp/work") {
  return { id, folder, session_id: id, metadata: JSON.stringify(metadata), created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
}

const work = createSpace({ name: "Work", folderRules: ["/tmp/rules/**"] });
const personal = createSpace({ name: "Personal" });

beforeEach(() => {
  _resetSpaceStoreCache();
  fileChats = [
    chat("w-root", { spaceId: work.id }),
    // A member whose own stamp disagrees with its root: the root wins.
    chat("w-child", { parentChatId: "w-root", rootChatId: "w-root", spaceId: personal.id }),
    chat("p-root", { spaceId: personal.id }),
    chat("g-root", {}),
    // Pinned in Personal — appended corpus-wide unless the scope re-guards it.
    chat("p-pinned", { spaceId: personal.id, pinned: true }),
    // A stamp naming a space that does not exist reads as the default.
    chat("ghost", { spaceId: "sp_deleted" }),
  ];
  sessions = [
    ["w-root", "/tmp/work"],
    ["w-child", "/tmp/work"],
    ["p-root", "/tmp/work"],
    ["g-root", "/tmp/work"],
    ["ghost", "/tmp/work"],
    // Discovered, no record: folder rules pick the space.
    ["disc-ruled", "/tmp/rules/repo"],
    ["disc-plain", "/tmp/elsewhere"],
    ["p-pinned", "/tmp/work"],
  ];
});

describe("GET /api/chats?space=", () => {
  it("returns only the chats whose tree resolves to the space", async () => {
    expect(idsOf(await listChats({ space: work.id }))).toEqual(["disc-ruled", "w-child", "w-root"]);
    expect(idsOf(await listChats({ space: personal.id }))).toEqual(["p-pinned", "p-root"]);
    expect(idsOf(await listChats({ space: "default" }))).toEqual(["disc-plain", "g-root", "ghost"]);
  });

  it("all admits everything and stamps each row with its space", async () => {
    const body = await listChats({ space: "all" });
    expect(body.chats).toHaveLength(8);
    const spaceOf = Object.fromEntries(body.chats.map((c: any) => [c.id, c.spaceId]));
    expect(spaceOf["w-child"]).toBe(work.id);
    expect(spaceOf["disc-ruled"]).toBe(work.id);
    expect(spaceOf.ghost).toBe("default");
  });

  it("is unscoped — and unstamped — when no space is sent (older bundles)", async () => {
    const body = await listChats({});
    expect(body.chats).toHaveLength(8);
    expect(body.chats.every((c: any) => c.spaceId === undefined)).toBe(true);
  });

  it("an unknown space matches nothing rather than everything", async () => {
    expect(idsOf(await listChats({ space: "sp_nope" }))).toEqual([]);
    expect(idsOf(await listChats({ space: "../etc" }))).toEqual([]);
  });

  it("paginates after filtering, so a page is filled from the space", async () => {
    const page = await listChats({ space: "default", limit: "2" });
    expect(page.chats).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it("does not append a pinned chat from another space", async () => {
    const body = await listChats({ space: work.id, limit: "1", includePinned: "true" });
    expect(idsOf(body)).not.toContain("p-pinned");
    const own = await listChats({ space: personal.id, limit: "1", includePinned: "true" });
    expect(idsOf(own)).toContain("p-pinned");
  });

  it("keeps lineage appends inside the tree's space", async () => {
    const body = await listChats({ space: work.id, includeLineage: "true", limit: "1" });
    expect(idsOf(body)).toEqual(expect.arrayContaining(["w-root", "w-child"]));
    expect(idsOf(body)).not.toContain("p-root");
  });
});

describe("chat list cache key", () => {
  it("never serves one space's cached page to another", async () => {
    const a = await invoke(listHandler, { query: { space: work.id } });
    const b = await invoke(listHandler, { query: { space: personal.id } });
    expect(idsOf(a.body)).not.toEqual(idsOf(b.body));
    expect(idsOf(b.body)).toEqual(["p-pinned", "p-root"]);
  });
});

describe("GET /api/chats/:id/tree?space=", () => {
  it("reports the root's space and refuses a tree from another space", async () => {
    const ok = await invoke(treeHandler, { params: { id: "w-child" }, query: { space: work.id } } as Partial<Request>);
    expect(ok.status).toBe(200);
    expect(ok.body.spaceId).toBe(work.id);
    const refused = await invoke(treeHandler, { params: { id: "w-child" }, query: { space: personal.id } } as Partial<Request>);
    expect(refused.status).toBe(404);
    const all = await invoke(treeHandler, { params: { id: "w-child" }, query: { space: "all" } } as Partial<Request>);
    expect(all.status).toBe(200);
  });
});

describe("GET /api/chats/new/info?space=", () => {
  it("lists only the app plugins and commands the space's agent scope admits", async () => {
    const { setSlashCommandsForDirectory } = await import("../services/slashCommands.js");
    const { updateSpace } = await import("../services/space-store.js");
    setSlashCommandsForDirectory(tmpRoot, ["slack:post", "git:commit", "compact"]);
    updateSpace(work.id, { agentScope: { plugins: ["p-git"] } });
    const scoped = await invoke(newInfoHandler, { query: { folder: tmpRoot, space: work.id } as any });
    expect(scoped.body.appPlugins.plugins.map((p: any) => p.id)).toEqual(["p-git"]);
    expect(scoped.body.slash_commands).toEqual(expect.arrayContaining(["git:commit", "compact"]));
    expect(scoped.body.slash_commands).not.toContain("slack:post");
    const unscoped = await invoke(newInfoHandler, { query: { folder: tmpRoot } as any });
    expect(unscoped.body.appPlugins.plugins).toHaveLength(2);
    expect(unscoped.body.slash_commands).toContain("slack:post");
  });
});

