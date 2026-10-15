/**
 * Sidebar folders, on the two routes that carry them: `PATCH
 * /api/chats/:id/sidebar-folder` writes `metadata.sidebarFolder`, and `GET
 * /api/chats?includeFoldered=true` keeps a foldered root on the page when
 * recency would have left it off — the `includePinned` shape, applied to
 * folders, and re-guarded by every filter the request carries.
 *
 * Same harness as chats.pinned.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-sidebar-folder-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Chat records the stubbed file service hands back, set per test. */
let fileChats: any[] = [];
/** Session ids the stubbed provider discovers, newest first. */
let sessionIds: string[] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
    // The folder route's writer. Merges into the in-memory record the way the
    // file-backed service would, so a round-trip really is a round-trip.
    updateChatMetadata: (id: string, fields: Record<string, unknown>) => {
      const chat = fileChats.find((c) => c.id === id);
      if (!chat) return false;
      chat.metadata = JSON.stringify({ ...JSON.parse(chat.metadata || "{}"), ...fields });
      return true;
    },
  },
}));
// findChat is stubbed rather than driven, so the folder route's lookup is a
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

// These fixtures intentionally live under /tmp; opt them in explicitly now
// that shared discovery also enforces ignored-directory boundaries.
const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);
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
const folderHandler = routeHandler("/:id/sidebar-folder", "patch");

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

const setFolder = (id: string, body: Record<string, unknown>) => invoke(folderHandler, { params: { id }, body } as Partial<Request>);

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
    chat("in-window-foldered", { sidebarFolder: "Work" }),
    chat("recent-1", {}),
    chat("recent-2", {}),
    chat("recent-3", {}),
    // Foldered but stale — the case the param exists for.
    chat("stale-foldered", { sidebarFolder: "Work" }),
    // Its child, also off the page: the lineage pass must bring it along.
    chat("stale-child", { parentChatId: "stale-foldered", rootChatId: "stale-foldered" }),
    // A child naming a folder of its own: ignored, never appended for it.
    chat("orphan-root", {}),
    chat("child-with-folder", { parentChatId: "orphan-root", rootChatId: "orphan-root", sidebarFolder: "Nope" }),
    // Foldered and archived / triggered: the folder buys neither back in.
    chat("archived-foldered", { sidebarFolder: "Work", card: { lifecycle: "closed" } }),
    chat("triggered-foldered", { sidebarFolder: "Work", triggered: true }),
    // Cleared — stored as null, which is "no folder".
    chat("cleared", { sidebarFolder: null }),
  ];
  sessionIds = [
    "in-window-foldered",
    "recent-1",
    "recent-2",
    "recent-3",
    "cleared",
    "orphan-root",
    "child-with-folder",
    "triggered-foldered",
    "archived-foldered",
    "stale-child",
    "stale-foldered",
  ];
});

describe("PATCH /api/chats/:id/sidebar-folder", () => {
  it("sets, moves and clears the folder through the stored record", async () => {
    const set = await setFolder("recent-1", { sidebarFolder: "Work" });
    expect(set.status).toBe(200);
    expect(JSON.parse(set.body.metadata).sidebarFolder).toBe("Work");
    expect(metaOf("recent-1").sidebarFolder).toBe("Work");

    await setFolder("recent-1", { sidebarFolder: "Personal" });
    expect(metaOf("recent-1").sidebarFolder).toBe("Personal");

    // null clears; written as null because metadata writers merge and cannot delete.
    const cleared = await setFolder("recent-1", { sidebarFolder: null });
    expect(cleared.status).toBe(200);
    expect(metaOf("recent-1").sidebarFolder).toBeNull();
  });

  it("trims the name, and treats empty or whitespace-only as clear", async () => {
    await setFolder("recent-1", { sidebarFolder: "  Work  " });
    expect(metaOf("recent-1").sidebarFolder).toBe("Work");
    await setFolder("recent-1", { sidebarFolder: "   " });
    expect(metaOf("recent-1").sidebarFolder).toBeNull();
    await setFolder("recent-1", { sidebarFolder: "Work" });
    await setFolder("recent-1", { sidebarFolder: "" });
    expect(metaOf("recent-1").sidebarFolder).toBeNull();
  });

  it("leaves every other metadata key alone, the pin included, and does not use `folder`", async () => {
    fileChats.push(chat("pinned", { pinned: true, title: "T" }));
    await setFolder("pinned", { sidebarFolder: "Work" });
    expect(metaOf("pinned")).toEqual({ pinned: true, title: "T", sidebarFolder: "Work" });
    // `folder` is the working directory, untouched.
    expect(fileChats.find((c) => c.id === "pinned")!.folder).toBe("/tmp/proj");
  });

  it("rejects bad names without writing anything", async () => {
    const bad = [{ sidebarFolder: 3 }, { sidebarFolder: true }, { sidebarFolder: "x".repeat(65) }, { sidebarFolder: "a\u0007b" }, { sidebarFolder: "tab\there" }, { sidebarFolder: "rtl\u202Eoverride" }, {}];
    for (const body of bad) {
      const res = await setFolder("recent-1", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(metaOf("recent-1").sidebarFolder).toBeUndefined();
    // The boundary is inclusive.
    expect((await setFolder("recent-1", { sidebarFolder: "x".repeat(64) })).status).toBe(200);
  });

  it("refuses to file a child chat, but lets a stray child folder be cleared", async () => {
    const res = await setFolder("stale-child", { sidebarFolder: "Work" });
    expect(res.status).toBe(400);
    expect(metaOf("stale-child").sidebarFolder).toBeUndefined();

    expect((await setFolder("child-with-folder", { sidebarFolder: null })).status).toBe(200);
    expect(metaOf("child-with-folder").sidebarFolder).toBeNull();
  });

  it("404s for a chat that does not exist", async () => {
    expect((await setFolder("no-such-chat", { sidebarFolder: "Work" })).status).toBe(404);
  });
});

describe("GET /api/chats?includeFoldered=true", () => {
  const PAGE = { limit: "3", includeLineage: "true", cardLifecycle: "unarchived", excludeTriggered: "true" };

  it("appends a foldered root from outside the window, with its tree", async () => {
    const without = await listChats(PAGE);
    expect(idsOf(without)).not.toContain("stale-foldered");

    const withFoldered = await listChats({ ...PAGE, includeFoldered: "true" });
    expect(rowFor(withFoldered, "stale-foldered")._folder_appended).toBe(true);
    // Appended before the lineage pass, so the root's child rides along.
    expect(rowFor(withFoldered, "stale-child")._lineage_appended).toBe(true);
    // An append, not a re-sort.
    expect(idsOf(withFoldered).slice(0, without.chats.length)).toEqual(idsOf(without));
  });

  it("does not append a foldered chat already on the page, nor a child for its own folder, nor a cleared one", async () => {
    const body = await listChats({ ...PAGE, includeFoldered: "true" });
    expect(idsOf(body).filter((id: string) => id === "in-window-foldered")).toEqual(["in-window-foldered"]);
    expect(rowFor(body, "in-window-foldered")._folder_appended).toBeUndefined();
    expect(idsOf(body)).not.toContain("child-with-folder");
    expect(idsOf(body)).not.toContain("cleared");
  });

  it("leaves foldered chats the lifecycle and triggered filters exclude excluded", async () => {
    const scoped = await listChats({ ...PAGE, includeFoldered: "true", limit: "50" });
    expect(idsOf(scoped)).not.toContain("archived-foldered");
    expect(idsOf(scoped)).not.toContain("triggered-foldered");

    const wide = await listChats({ ...PAGE, includeFoldered: "true", limit: "50", cardLifecycle: "all", excludeTriggered: "false" });
    expect(idsOf(wide)).toContain("archived-foldered");
    expect(idsOf(wide)).toContain("triggered-foldered");
  });

  it("does not move hasMore, total or windowRows", async () => {
    const without = await listChats(PAGE);
    const withFoldered = await listChats({ ...PAGE, includeFoldered: "true" });
    expect(withFoldered.total).toBe(without.total);
    expect(withFoldered.hasMore).toBe(without.hasMore);
    expect(withFoldered.windowRows).toBe(without.windowRows);
    expect(withFoldered.chats.length).toBeGreaterThan(withFoldered.windowRows);
  });

  it("still paginates when includeFoldered is the only reason the fetch widened", async () => {
    const body = await listChats({ limit: "2", includeFoldered: "true" });
    expect(body.windowRows).toBe(2);
    expect(idsOf(body).slice(0, 2)).toEqual(["in-window-foldered", "recent-1"]);
    expect(body.hasMore).toBe(true);
    expect(idsOf(body)).toContain("stale-foldered");
  });

  it("emits a chat that is both pinned and foldered once", async () => {
    fileChats = fileChats.map((c) => (c.id === "stale-foldered" ? chat(c.id, { sidebarFolder: "Work", pinned: true }) : c));
    const body = await listChats({ ...PAGE, includeFoldered: "true", includePinned: "true" });
    expect(idsOf(body).filter((id: string) => id === "stale-foldered")).toHaveLength(1);
  });

  it("keys the response cache on the param, in both directions", async () => {
    const base = { ...PAGE, cached: "true" };
    const warm = await listChats({ ...base, limit: "4", includeFoldered: "true" });
    expect(idsOf(warm)).toContain("stale-foldered");
    const plain = await listChats({ ...base, limit: "4" });
    expect(idsOf(plain)).not.toContain("stale-foldered");

    const plain2 = await listChats({ ...base, limit: "5" });
    expect(idsOf(plain2)).not.toContain("stale-foldered");
    const warm2 = await listChats({ ...base, limit: "5", includeFoldered: "true" });
    expect(idsOf(warm2)).toContain("stale-foldered");
  });
});
