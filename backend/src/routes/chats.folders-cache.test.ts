/**
 * The folder-list response cache, and the one thing it must never do.
 *
 * `GET /api/chats/folders` is polled by the sidebar and everything on its path
 * is synchronous, so the response is cached. The risk that buys is not a stale
 * number — it is a stale *state*: a row carries
 * `status: "ongoing" | "waiting" | "stopped"` derived from the in-memory
 * session registry and the pending-permission map, and a cached "stopped" for a
 * session that just went live is a visible lie about what the daemon is doing.
 *
 * The cache guards that with a fingerprint of exactly those two inputs rather
 * than with invalidation hooks, because a session starts and stops without any
 * request reaching this route. So the tests that matter here are the last three
 * in the file: they move each status input and assert the response moves with
 * it, TTL notwithstanding.
 *
 * The registry and pending map are stubbed through mutable locals so a test can
 * flip them mid-flight the way a real session would.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

/** In-memory session state the route reads. Mutated per test. */
const registryState = vi.hoisted(() => ({ ongoing: new Set<string>(), version: 0, metadataVersion: 0 }));
const pendingState = vi.hoisted(() => ({ waiting: new Set<string>() }));
/** Session ids the stubbed provider discovers, newest first. */
const discovered = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("../services/claude.js", () => ({
  hasPendingRequest: (id: string) => pendingState.waiting.has(id),
  getPendingRequest: () => null,
  getActiveSession: () => null,
  // Mirrors the real implementation: derived from the map's keys, so a test
  // that adds a waiting chat moves the fingerprint without a second knob.
  pendingRequestFingerprint: () => [...pendingState.waiting].sort().join(","),
}));
vi.mock("../services/session-registry.js", () => ({
  sessionRegistry: {
    has: (id: string) => registryState.ongoing.has(id),
    notifyMetadata: () => {},
    get version() {
      return registryState.version;
    },
    get metadataVersion() {
      return registryState.metadataVersion;
    },
  },
}));
vi.mock("../utils/git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveBranch: () => ({ ok: true, folder: "" }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder, isWorktree: false }),
}));
// Discovery is stubbed for the same reason as in
// chat-file-service.call-sites.test.ts: the real one shells out to `find` over
// a directory derived from homedir() at module load. What is under test here is
// what the route does with the sessions, not how it finds them.
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const sessions = discovered.ids.map((id, i) => ({
          sessionId: id,
          folder: projectFolder,
          displayFolder: projectFolder,
          filePath: join(projectsDir, encodedDir, `${id}.jsonl`),
          // Now-relative: the route applies a day-based cutoff, so fixed dates
          // would silently empty the listing as the calendar moves.
          createdAt: new Date(Date.now() - i * 60_000),
          updatedAt: new Date(Date.now() - i * 60_000),
        }));
        return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-folders-cache-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.HOME = tmpRoot;

const projectFolder = join(tmpRoot, "proj");
mkdirSync(projectFolder, { recursive: true });
const projectsDir = join(tmpRoot, ".claude", "projects");
const encodedDir = projectFolder.replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(projectsDir, encodedDir), { recursive: true });

const { chatsRouter } = await import("./chats.js");
const { folderListCache, clearFolderListCache, FOLDER_LIST_CACHE_TTL } = await import("../services/folder-list-cache.js");
const { clearProjectDirFolderCache } = await import("../utils/paths.js");
const { chatFileService } = await import("../services/chat-file-service.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const foldersHandler = (chatsRouter as any).stack.find((l: any) => l.route?.path === "/folders" && l.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function listFolders(query: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve(payload);
        return this;
      },
    };
    foldersHandler({ query } as unknown as Request, res as unknown as Response);
  });
}

let sessionId: string;

beforeEach(() => {
  clearFolderListCache();
  clearProjectDirFolderCache();
  registryState.ongoing.clear();
  pendingState.waiting.clear();
  registryState.version = 0;
  registryState.metadataVersion = 0;

  sessionId = randomUUID();
  discovered.ids = [sessionId];
  writeFileSync(join(projectsDir, encodedDir, `${sessionId}.jsonl`), `{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}\n`);
  chatFileService.createChat(projectFolder, sessionId, JSON.stringify({ title: "first" }));
});

describe("hit and miss", () => {
  it("serves the second request from cache", async () => {
    const first = await listFolders();
    expect(first.folders).toHaveLength(1);
    expect(first.stale).toBe(false);
    expect(folderListCache.size).toBe(1);

    // Rewrite the record under the handler. A cache hit is the only way the
    // response can still say "first".
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });
    const second = await listFolders();
    expect(second.folders[0].chatTitle).toBe("first");
  });

  it("recomputes when the entry is explicitly invalidated", async () => {
    await listFolders();
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });

    clearFolderListCache();
    expect(folderListCache.size).toBe(0);

    const fresh = await listFolders();
    expect(fresh.folders[0].chatTitle).toBe("second");
  });

  it("recomputes when cached=false, and refills the entry", async () => {
    await listFolders();
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });

    const bypassed = await listFolders({ cached: "false" });
    expect(bypassed.folders[0].chatTitle).toBe("second");
    // The bypass is a read-through, not a poison: the next normal request must
    // get the value this one computed.
    expect((await listFolders()).folders[0].chatTitle).toBe("second");
  });

  it("marks a response served past the freshness window as stale", async () => {
    await listFolders();
    const entry = [...folderListCache.values()][0];
    entry.createdAt -= FOLDER_LIST_CACHE_TTL + 1_000;

    const served = await listFolders();
    expect(served.stale).toBe(true);
    expect(served.folders).toHaveLength(1);
  });
});

describe("key separation", () => {
  it("keys on maxAgeDays", async () => {
    await listFolders({ maxAgeDays: "5" });
    expect(folderListCache.size).toBe(1);

    await listFolders({ maxAgeDays: "30" });
    expect(folderListCache.size).toBe(2);
    expect([...folderListCache.keys()].sort()).toEqual(["30:false", "5:false"]);
  });

  it("keys on includeDiskUsage", async () => {
    await listFolders({ maxAgeDays: "5" });
    await listFolders({ maxAgeDays: "5", includeDiskUsage: "true" });

    expect(folderListCache.size).toBe(2);
    expect([...folderListCache.keys()].sort()).toEqual(["5:false", "5:true"]);
  });

  it("does not serve a sizeless response to a request that asked for sizes", async () => {
    const without = await listFolders({ maxAgeDays: "5" });
    expect(without.folders[0].diskUsage).toBeUndefined();

    // Would silently return the cached sizeless row if the key ignored the flag.
    const withSizes = await listFolders({ maxAgeDays: "5", includeDiskUsage: "true" });
    expect(withSizes.folders[0].diskUsage).toBeDefined();
  });

  it("treats an absent maxAgeDays as the default rather than a separate key", async () => {
    await listFolders();
    await listFolders({ maxAgeDays: "5" });
    expect(folderListCache.size).toBe(1);
  });
});

describe("a live session's status is never masked by the cache", () => {
  it("reports a session that goes ongoing after the response was cached", async () => {
    expect((await listFolders()).folders[0].status).toBe("stopped");

    // Exactly what services/claude.ts does when a run starts: register, bump.
    registryState.ongoing.add(sessionId);
    registryState.version++;

    const after = await listFolders();
    expect(after.folders[0].status).toBe("ongoing");
    // ...and it is a genuine recompute, not a stale read that happened to be right.
    expect(after.stale).toBe(false);
  });

  it("reports a session that parks a permission prompt after the response was cached", async () => {
    expect((await listFolders()).folders[0].status).toBe("stopped");

    // A permission request adds to pendingRequests and bumps nothing else —
    // the registry version is deliberately left alone here, because that is
    // the real shape of this transition and the case a registry-only
    // fingerprint would miss.
    pendingState.waiting.add(sessionId);

    expect((await listFolders()).folders[0].status).toBe("waiting");
  });

  it("reports a session that stops after the response was cached", async () => {
    registryState.ongoing.add(sessionId);
    registryState.version++;
    expect((await listFolders()).folders[0].status).toBe("ongoing");

    registryState.ongoing.delete(sessionId);
    registryState.version++;

    expect((await listFolders()).folders[0].status).toBe("stopped");
  });

  it("beats the stale window too, not just the freshness window", async () => {
    await listFolders();
    // Old enough that a TTL-only cache would serve it without recomputing.
    const entry = [...folderListCache.values()][0];
    entry.createdAt -= FOLDER_LIST_CACHE_TTL + 60_000;

    registryState.ongoing.add(sessionId);
    registryState.version++;

    const after = await listFolders();
    expect(after.folders[0].status).toBe("ongoing");
    expect(after.stale).toBe(false);
  });

  it("does not recompute when nothing about the session state moved", async () => {
    await listFolders();
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });

    // No registry or pending-map movement — the fingerprint must not be
    // spuriously unstable, or the cache never hits and buys nothing.
    expect((await listFolders()).folders[0].chatTitle).toBe("first");
  });
});
