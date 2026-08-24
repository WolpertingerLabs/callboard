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
 * The same is true of the workspace fields — `displayName`, `workspaceId`,
 * `workspaces[]`, `directoryState` — which come from the workspace registry.
 * `renameWorkspace` writes a record and returns; it is not one of the writers
 * that invalidate a listing, and neither would the next one be.
 *
 * The cache guards both with a fingerprint of those inputs rather than with
 * invalidation hooks, because none of them needs a request to change. So the
 * tests that matter here are the last two blocks: they move each input and
 * assert the response moves with it.
 *
 * The registry, pending map and workspace version are stubbed through mutable
 * locals so a test can flip them mid-flight the way a real session would.
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
/**
 * Sessions the stubbed provider discovers, newest first. `ageDays` and `folder`
 * default per-index so the common case stays a bare id; the key-separation
 * cases set them to build a row set that `maxAgeDays` actually partitions.
 */
const discovered = vi.hoisted(() => ({
  ids: [] as string[],
  ageDaysById: {} as Record<string, number>,
  folderById: {} as Record<string, string>,
  /** How many times the route has built a listing. One build = one discovery. */
  builds: 0,
}));

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
        discovered.builds++;
        const sessions = discovered.ids.map((id, i) => {
          // Now-relative: the route applies a day-based cutoff, so fixed dates
          // would silently empty the listing as the calendar moves.
          const ageMs = discovered.ageDaysById[id] !== undefined ? discovered.ageDaysById[id] * 86_400_000 : i * 60_000;
          const folder = discovered.folderById[id] ?? projectFolder;
          return {
            sessionId: id,
            folder,
            displayFolder: folder,
            filePath: join(projectsDir, encodedDir, `${id}.jsonl`),
            createdAt: new Date(Date.now() - ageMs),
            updatedAt: new Date(Date.now() - ageMs),
          };
        });
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
// `du -sk` charges an empty directory 0 blocks on APFS and one 4 KiB block on
// ext4, so "this row has a size" is only a portable assertion about a directory
// with something in it. Content, not the directory itself, is what the
// disk-usage assertion below reads.
writeFileSync(join(projectFolder, "occupies-a-block.txt"), "x".repeat(4096));
// A second real directory, so a row can exist for it. `buildFolderSummaries`
// drops rows whose directory is gone unless a workspace record claims them.
const olderFolder = join(tmpRoot, "older-proj");
mkdirSync(olderFolder, { recursive: true });
const projectsDir = join(tmpRoot, ".claude", "projects");
const encodedDir = projectFolder.replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(projectsDir, encodedDir), { recursive: true });

const { chatsRouter } = await import("./chats.js");
const { folderListCache, clearFolderListCache, FOLDER_LIST_CACHE_TTL } = await import("../services/folder-list-cache.js");
const { clearProjectDirFolderCache } = await import("../utils/paths.js");
const { chatFileService } = await import("../services/chat-file-service.js");
// Not stubbed: the workspace registry's version counter is what the fingerprint
// reads, and driving the real store is what proves the counter is wired to the
// writers rather than merely present. `buildWorkspaceIndex` reads the same
// store, so a record created here also reaches the row.
const { createWorkspace, renameWorkspace, archiveWorkspace } = await import("../services/workspace-store.js");

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
  // Records accumulate on one cwd otherwise, and two records on a directory
  // deliberately suppress the workspace name in favour of the basename.
  rmSync(join(tmpRoot, "workspaces"), { recursive: true, force: true });
  mkdirSync(join(tmpRoot, "workspaces"), { recursive: true });
  registryState.ongoing.clear();
  pendingState.waiting.clear();
  registryState.version = 0;
  registryState.metadataVersion = 0;

  sessionId = randomUUID();
  discovered.ids = [sessionId];
  discovered.ageDaysById = {};
  discovered.folderById = {};
  discovered.builds = 0;
  writeFileSync(join(projectsDir, encodedDir, `${sessionId}.jsonl`), `{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}\n`);
  chatFileService.createChat(projectFolder, sessionId, JSON.stringify({ title: "first" }));
});

describe("hit and miss", () => {
  it("serves the second request from cache", async () => {
    const first = await listFolders();
    expect(first.folders).toHaveLength(1);
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

  it("recomputes past the TTL rather than serving the entry on", async () => {
    await listFolders();
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });

    // An earlier revision served this on with `stale: true` for another 295s
    // and never revalidated, which made the practical staleness window the
    // backstop rather than the TTL. There is no such branch now.
    const entry = [...folderListCache.values()][0];
    entry.createdAt -= FOLDER_LIST_CACHE_TTL + 1;

    const served = await listFolders();
    expect(served.folders[0].chatTitle).toBe("second");
    expect(served.stale).toBeUndefined();
  });
});

describe("key separation", () => {
  // These assert on the *rows returned*, not on the key strings. A key-format
  // assertion fails for a spelling change and passes for a cache that serves
  // one window's rows to the other window, which is the bug worth catching.
  it("does not serve a narrow window's rows to a wider one", async () => {
    const old = randomUUID();
    discovered.ids = [sessionId, old];
    discovered.ageDaysById[old] = 10;
    discovered.folderById[old] = olderFolder;

    const narrow = await listFolders({ maxAgeDays: "5" });
    expect(narrow.folders.map((f: any) => f.folder)).toEqual([projectFolder]);

    // The 10-day-old session is outside 5 days and inside 30. Sharing one entry
    // would hand this request the single row computed above.
    const wide = await listFolders({ maxAgeDays: "30" });
    expect(wide.folders.map((f: any) => f.folder).sort()).toEqual([olderFolder, projectFolder].sort());
  });

  it("does not serve a wide window's rows to a narrower one", async () => {
    const old = randomUUID();
    discovered.ids = [sessionId, old];
    discovered.ageDaysById[old] = 10;
    discovered.folderById[old] = olderFolder;

    // Warm the wide window first, so a shared entry would over-report.
    expect((await listFolders({ maxAgeDays: "30" })).folders).toHaveLength(2);
    expect((await listFolders({ maxAgeDays: "5" })).folders).toHaveLength(1);
  });

  it("does not serve a sizeless response to a request that asked for sizes", async () => {
    const without = await listFolders({ maxAgeDays: "5" });
    expect(without.folders[0].diskUsage).toBeUndefined();

    // Would silently return the cached sizeless row if the key ignored the flag.
    const withSizes = await listFolders({ maxAgeDays: "5", includeDiskUsage: "true" });
    // `.bytes`, not merely `toBeDefined()`. The budget hands the row an object
    // it has not filled in yet and `await budget.settle()` fills it; a presence
    // check is satisfied by the unfilled placeholder, so it would pass with the
    // settle deleted and the route shipping "did not settle" to every row.
    expect(withSizes.folders[0].diskUsage!.bytes).toBeGreaterThan(0);
    expect(withSizes.folders[0].diskUsage!.error).toBeUndefined();
  });

  /**
   * The cache only helps a request that arrives after another *finished*. These
   * pin the other half: requests that overlap a build share it.
   *
   * This became reachable when `du` moved off the event loop — before that the
   * handler ran to completion in one synchronous block and two requests could
   * not physically interleave. The sidebar polls on a timer from every open tab,
   * so overlapping is the normal case, and a duplicate build costs the whole
   * synchronous head (discovery, git info, chat metadata) that no memo covers.
   */
  it("builds once for two requests that overlap", async () => {
    // Not awaited between calls: the second lands while the first is still in
    // flight, which is exactly the window the cache cannot see.
    const [a, b] = await Promise.all([listFolders(), listFolders()]);

    expect(discovered.builds).toBe(1);
    expect(a).toEqual(b);
    expect(a.folders).toHaveLength(1);
  });

  it("does not let an overlapping request share a build that predates what it knows", async () => {
    const first = listFolders();
    // A session goes live between the two. The second request's fingerprint no
    // longer matches the build in flight, so sharing would serve it rows that
    // predate a transition it can already see.
    registryState.version++;
    registryState.ongoing.add(sessionId);
    const second = listFolders();

    const [, b] = await Promise.all([first, second]);
    expect(discovered.builds).toBe(2);
    expect(b.folders[0].status).toBe("ongoing");
  });

  it("does not let cached=false join or publish a build", async () => {
    const [, bypassed] = await Promise.all([listFolders(), listFolders({ cached: "false" })]);
    // "Compute mine from scratch" has to mean it, so the two do not collapse.
    expect(discovered.builds).toBe(2);
    expect(bypassed.folders).toHaveLength(1);
  });

  /**
   * An invalidation that lands *during* a build must not be undone by that
   * build's own cache write.
   *
   * The fingerprint cannot catch this and no amount of tuning it would: it
   * watches state that moves without a request, while `clearListCaches()` exists
   * precisely for state that moves *because of* one — a deleted chat, a closed
   * card, a toggled bookmark, none of which bump a version counter. So the
   * doomed build's entry looks valid and is served for a full TTL. Unreachable
   * before `du` went async, because the handler was one synchronous block.
   */
  it("does not re-write an entry that was invalidated while the build ran", async () => {
    // Build starts and suspends at its await...
    const inFlight = listFolders();
    // ...and the write plus its invalidation land underneath it. Deliberately
    // no `notifyMetadata`: a delete moves no version, so the fingerprint the
    // build captured is still current and cannot tell this happened.
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });
    clearFolderListCache();
    await inFlight;

    expect(folderListCache.size).toBe(0); // the stale entry was dropped, not stored
    const next = await listFolders();
    expect(next.folders[0].chatTitle).toBe("second");
    expect(discovered.builds).toBe(2); // it genuinely rebuilt rather than serving the re-write
  });

  it("still rebuilds when the invalidation lands before the build starts", async () => {
    await listFolders();
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });
    clearFolderListCache();

    // The ordinary case, and the guard must not break it: nothing was in flight,
    // so the next build's generation matches and its entry is stored.
    const fresh = await listFolders();
    expect(fresh.folders[0].chatTitle).toBe("second");
    expect(folderListCache.size).toBe(1);
  });

  it("drops a mid-build invalidation's entry even when the row set shrinks", async () => {
    // The variant that is visible rather than merely stale: a row disappears.
    const second = randomUUID();
    discovered.ids = [sessionId, second];
    discovered.folderById = { [second]: olderFolder };
    writeFileSync(join(projectsDir, encodedDir, `${second}.jsonl`), `{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}\n`);
    chatFileService.createChat(olderFolder, second, JSON.stringify({ title: "other" }));
    expect((await listFolders()).folders).toHaveLength(2);
    clearFolderListCache();

    const inFlight = listFolders();
    discovered.ids = [sessionId]; // the second chat is deleted mid-build
    clearFolderListCache();
    await inFlight;

    expect((await listFolders()).folders).toHaveLength(1);
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

  it("reports the transition on an entry that is still inside its TTL", async () => {
    await listFolders();
    // Well inside the freshness window: only the fingerprint can force this
    // recompute, which is the whole point of having one.
    const entry = [...folderListCache.values()][0];
    expect(Date.now() - entry.createdAt).toBeLessThan(FOLDER_LIST_CACHE_TTL);

    registryState.ongoing.add(sessionId);
    registryState.version++;

    expect((await listFolders()).folders[0].status).toBe("ongoing");
  });

  it("does not recompute when nothing about the session state moved", async () => {
    await listFolders();
    chatFileService.updateChat(sessionId, { metadata: JSON.stringify({ title: "second" }) });

    // No registry or pending-map movement — the fingerprint must not be
    // spuriously unstable, or the cache never hits and buys nothing.
    expect((await listFolders()).folders[0].chatTitle).toBe("first");
  });
});

/**
 * The regression this file exists to prevent recurring.
 *
 * A folder row's `displayName` comes from the workspace record claiming the
 * directory (`folder-summaries.ts`, `displayNameFor`), and so do `workspaceId`,
 * `workspaces[]` and `directoryState`. `renameWorkspace` and `archiveWorkspace`
 * write a record and return — they call no invalidation, bump no session
 * version, and notify nothing. With a cache keyed only on session state, a
 * rename was invisible until the backstop expired, with no way for a client to
 * ask for the truth.
 *
 * These drive the real store rather than a stub: the claim is that the version
 * counter is wired to the writers, and a stub would assert only that the
 * fingerprint reads *something*.
 */
describe("workspace-record changes are not masked by the cache", () => {
  it("shows a renamed workspace on the next request", async () => {
    const ws = createWorkspace({ cwd: projectFolder, isolation: "local", name: "before-rename" });
    expect((await listFolders()).folders[0].displayName).toBe("before-rename");

    renameWorkspace(ws.id, "after-rename");

    // No clearListCaches(), no session-registry movement — only the workspace
    // registry's version changed, and that has to be enough.
    expect((await listFolders()).folders[0].displayName).toBe("after-rename");
  });

  it("drops an archived workspace's record from the row", async () => {
    const ws = createWorkspace({ cwd: projectFolder, isolation: "local", name: "doomed" });
    const before = await listFolders();
    expect(before.folders[0].displayName).toBe("doomed");
    expect(before.folders[0].workspaces).toHaveLength(1);

    // The state the archive path *requires* before it will quarantine a
    // worktree is exactly the one with no session running — so nothing else
    // moves here either.
    archiveWorkspace(ws.id);

    const after = await listFolders();
    expect(after.folders[0].workspaces).toBeUndefined();
    // Falls back to the directory basename once no record claims it.
    expect(after.folders[0].displayName).toBe("proj");
  });

  it("shows a workspace created after the response was cached", async () => {
    expect((await listFolders()).folders[0].displayName).toBe("proj");

    createWorkspace({ cwd: projectFolder, isolation: "local", name: "brand-new" });

    expect((await listFolders()).folders[0].displayName).toBe("brand-new");
  });
});
