/**
 * The one-time git-trail backfill from a chat's history: what each source
 * yields, how a checkout and its repository are resolved, and the run-once,
 * merge, queue and never-block rules. Real git repositories, real fixture
 * transcripts and a throwaway chat store; provider paths and workspace
 * records are injected.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-backfill-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "callboard-backfill-")));

const { chatFileService } = await import("./chat-file-service.js");
const { parseGitTrail } = await import("./git-trail.js");
const backfill = await import("./git-trail-backfill.js");
const {
  DEFAULT_BACKFILL_DEPS,
  GIT_TRAIL_BACKFILL_VERSION,
  backfillChat,
  backfillIdle,
  claudeObservations,
  codexObservations,
  requestBackfill,
  isSafeSessionId,
  resetBackfillQueue,
  resolveRepoPath,
} = backfill;
type BackfillDeps = import("./git-trail-backfill.js").BackfillDeps;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
/**
 * A point where a backfill parks until the test lets it go. `next()` resolves
 * when the next one parks — the tests wait on events, never on a clock, so
 * load cannot reorder them.
 */
interface HoldPoint {
  hold<T>(value: T): Promise<T>;
  next(): Promise<() => void>;
  releaseAll(): void;
}
const holdPoints: HoldPoint[] = [];
function holdPoint(): HoldPoint {
  const parked: Array<() => void> = [];
  const waiters: Array<() => void> = [];
  const point: HoldPoint = {
    hold: (value) =>
      new Promise((resolve) => {
        parked.push(() => resolve(value));
        waiters.shift()?.();
      }),
    async next() {
      while (parked.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      return parked.shift()!;
    },
    releaseAll: () => {
      for (const release of parked.splice(0)) release();
    },
  };
  holdPoints.push(point);
  return point;
}

beforeEach(() => resetBackfillQueue());
afterEach(() => {
  vi.restoreAllMocks();
  // Whatever a failed test left parked is let go, and the module-level queue
  // starts over, so one failure cannot hang every test after it.
  for (const point of holdPoints.splice(0)) point.releaseAll();
  resetBackfillQueue();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

let n = 0;
/** A main checkout at `<tmp>/<name>` with one commit, its remote set to acme/<name>. */
function makeRepo(name = `repo${++n}`): string {
  const dir = join(tmp, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  git(dir, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
  return dir;
}

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(tmp, name);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}

const claudeLine = (cwd: string, gitBranch: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  cwd,
  gitBranch,
  timestamp,
  sessionId: "s",
  ...extra,
});
const sessionMeta = (cwd: string, branch: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
  timestamp,
  type: "session_meta",
  payload: { id: "t", cwd, git: { branch, commit_hash: "a".repeat(40), repository_url: "https://github.com/acme/app", ...extra } },
});

let chatCount = 0;
function makeChat(folder: string, metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const id = `bf-chat-${++chatCount}`;
  return chatFileService.upsertChat(id, folder, id, {
    metadata: JSON.stringify(metadata),
    updated_at: "2026-06-01T00:00:00.000Z",
    created_at: "2026-05-01T00:00:00.000Z",
    ...extra,
  });
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");
const trailOf = (id: string) => parseGitTrail(metaOf(id).gitTrail);

/** Real filesystem and git, with the transcript paths and workspace records given. */
function deps(paths: string[] = [], over: Partial<BackfillDeps> = {}): BackfillDeps {
  return { ...DEFAULT_BACKFILL_DEPS, logPaths: () => paths, getWorkspace: () => null, ...over };
}

describe("sources", () => {
  it("Claude: distinct (cwd, branch) pairs across session files, with first and last timestamps, skipping non-branches", async () => {
    const a = writeJsonl("claude-a.jsonl", [
      claudeLine("/w/app", "main", "2026-01-01T00:00:00Z"),
      { type: "summary", summary: "no branch here" },
      claudeLine("/w/app/sub", "feat/a", "2026-01-02T00:00:00Z"),
      claudeLine("/w/app", "main", "2026-01-03T00:00:00Z"),
      claudeLine("/w/app", "HEAD", "2026-01-03T00:00:01Z"),
      claudeLine("/w/app", "", "2026-01-03T00:00:02Z"),
      '{"gitBranch": torn',
    ]);
    const b = writeJsonl("claude-b.jsonl", [
      claudeLine("/w/app/sub", "feat/a", "2026-01-05T00:00:00Z"),
      claudeLine("/w/app", "feat/b", "2026-01-06T00:00:00Z"),
    ]);
    expect(await claudeObservations([a, b])).toEqual([
      { cwd: "/w/app", branch: "main", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-03T00:00:00Z" },
      { cwd: "/w/app/sub", branch: "feat/a", firstSeen: "2026-01-02T00:00:00Z", lastSeen: "2026-01-05T00:00:00Z" },
      { cwd: "/w/app", branch: "feat/b", firstSeen: "2026-01-06T00:00:00Z", lastSeen: "2026-01-06T00:00:00Z" },
    ]);
  });

  it("Codex: every session_meta (start and resume), with commit and repository URL", async () => {
    const rollout = writeJsonl("codex.jsonl", [
      sessionMeta("/w/app.feat-x", "feat/x", "2026-02-01T00:00:00Z", { commit_hash: "b".repeat(40) }),
      { timestamp: "2026-02-01T00:01:00Z", type: "response_item", payload: { text: "mentions session_meta in prose" } },
      sessionMeta("/w/app.feat-x", "feat/y", "2026-02-03T00:00:00Z"),
      sessionMeta("/w/app.feat-x", "HEAD", "2026-02-04T00:00:00Z"),
    ]);
    expect(await codexObservations([rollout])).toEqual([
      {
        cwd: "/w/app.feat-x",
        branch: "feat/x",
        firstSeen: "2026-02-01T00:00:00Z",
        lastSeen: "2026-02-01T00:00:00Z",
        head: "b".repeat(40),
        repositoryUrl: "https://github.com/acme/app",
      },
      {
        cwd: "/w/app.feat-x",
        branch: "feat/y",
        firstSeen: "2026-02-03T00:00:00Z",
        lastSeen: "2026-02-03T00:00:00Z",
        head: "a".repeat(40),
        repositoryUrl: "https://github.com/acme/app",
      },
    ]);
  });
});

describe("resolveRepoPath", () => {
  const obs = (cwd: string, branch: string, extra: Record<string, string> = {}) => ({ cwd, branch, firstSeen: "t0", lastSeen: "t1", ...extra });

  it("normalises an existing subdirectory to its checkout root and main repository", async () => {
    const repo = makeRepo();
    const wt = join(tmp, `wt${n}`);
    git(repo, "worktree", "add", "-q", "-b", "feat/live", wt);
    mkdirSync(join(wt, "sub"));
    expect(await resolveRepoPath(obs(join(wt, "sub"), "feat/live"), wt, [], deps())).toEqual({ cwd: wt, repoPath: repo });
  });

  it("maps a deleted subdirectory of the chat's folder to the folder", async () => {
    const repo = makeRepo("app-fold");
    const gone = join(tmp, "app-fold.feat-gone");
    expect(await resolveRepoPath(obs(join(gone, "src"), "feat/gone"), gone, [], deps())).toEqual({ cwd: gone, repoPath: repo });
  });

  it("matches a Codex repository_url against exactly one known repository's remote", async () => {
    const repo = makeRepo("app-url");
    const other = makeRepo("other-url");
    const found = await resolveRepoPath(
      obs("/nowhere/x", "feat/z", { repositoryUrl: "https://github.com/ACME/app-url.git" }),
      "/nowhere/x",
      [other, repo],
      deps(),
    );
    expect(found).toEqual({ cwd: "/nowhere/x", repoPath: repo });
  });

  it("skips an ambiguous repository_url — two known repositories share the remote", async () => {
    const a = makeRepo("dup-a");
    const b = makeRepo("dup-b");
    git(b, "remote", "set-url", "origin", "git@github.com:acme/dup-a.git");
    expect(await resolveRepoPath(obs("/nowhere/y", "feat/z", { repositoryUrl: "https://github.com/acme/dup-a" }), "/nowhere/y", [a, b], deps())).toBeNull();
  });

  it("takes the workspace record's repository for a deleted worktree", async () => {
    const repo = makeRepo("app-ws");
    expect(await resolveRepoPath(obs("/gone/ws-tree", "feat/w", { repoPath: repo }), "/gone/ws-tree", [], deps())).toEqual({
      cwd: "/gone/ws-tree",
      repoPath: repo,
    });
  });

  it("derives the main checkout from Callboard's worktree naming, only when it is a real main checkout", async () => {
    const repo = makeRepo("app-name");
    const gone = join(tmp, "app-name.feat-old-thing");
    expect(await resolveRepoPath(obs(gone, "feat/old-thing"), "/elsewhere", [], deps())).toEqual({ cwd: gone, repoPath: repo });
    // The name fits, but there is no such main checkout.
    expect(await resolveRepoPath(obs(join(tmp, "nothing.feat-x"), "feat/x"), "/elsewhere", [], deps())).toBeNull();
    // The branch does not match the suffix.
    expect(await resolveRepoPath(obs(gone, "feat/other"), "/elsewhere", [], deps())).toBeNull();
  });

  it("does not mistake a prefix-named repository for the main checkout", async () => {
    makeRepo("call");
    const gone = join(tmp, "callboard.feat-x");
    // ~/call exists, ~/callboard does not: no guess.
    expect(await resolveRepoPath(obs(gone, "feat/x"), "/elsewhere", [], deps())).toBeNull();
    const real = makeRepo("callboard");
    expect(await resolveRepoPath(obs(gone, "feat/x"), "/elsewhere", [], deps())).toEqual({ cwd: gone, repoPath: real });
  });

  it("skips what nothing resolves — a wrong repository is worse than none", async () => {
    expect(await resolveRepoPath(obs("/gone/anon", "feat/q"), "/gone/anon", [], deps())).toBeNull();
  });
});

describe("backfillChat", () => {
  it("writes the resolved trail and the marker, without touching updated_at", async () => {
    const repo = makeRepo("app-bf");
    const wt = join(tmp, "app-bf.feat-two");
    git(repo, "worktree", "add", "-q", "-b", "feat/two", wt);
    const t = writeJsonl("bf-1.jsonl", [claudeLine(repo, "main", "2026-03-01T00:00:00Z"), claudeLine(repo, "feat/one", "2026-03-02T00:00:00Z")]);
    const chat = makeChat(repo);
    expect(await backfillChat(chat, { deps: deps([t]) })).toBe("done");
    expect(trailOf(chat.id).map((e) => [e.cwd, e.repoPath, e.branch, e.firstSeen])).toEqual([
      [repo, repo, "main", "2026-03-01T00:00:00Z"],
      [repo, repo, "feat/one", "2026-03-02T00:00:00Z"],
    ]);
    expect(metaOf(chat.id).gitTrailBackfilled).toBe(GIT_TRAIL_BACKFILL_VERSION);
    expect(chatFileService.getChat(chat.id)!.updated_at).toBe("2026-06-01T00:00:00.000Z");
  });

  it("resolves a Codex rollout's deleted cwd outside the chat folder through repository_url", async () => {
    const repo = makeRepo("app-codex-url");
    const goneElsewhere = join(tmp, "somewhere-else", "codex-gone");
    const rollout = writeJsonl("codex-outside.jsonl", [
      sessionMeta(goneElsewhere, "feat/elsewhere", "2026-02-01T00:00:00Z", { repository_url: "https://github.com/acme/app-codex-url" }),
    ]);
    const chat = makeChat(repo, { provider: "codex" });
    await backfillChat(chat, { deps: deps([rollout]) });
    expect(trailOf(chat.id)).toEqual([expect.objectContaining({ cwd: goneElsewhere, repoPath: repo, branch: "feat/elsewhere", head: "a".repeat(40) })]);
  });

  it("reads every session the chat has had", async () => {
    const repo = makeRepo("app-sessions");
    const logPaths = vi.fn(() => [writeJsonl("s1.jsonl", [claudeLine(repo, "feat/s1", "2026-03-01T00:00:00Z")])]);
    const chat = makeChat(repo, { session_ids: ["old-1", "old-2"] });
    await backfillChat(chat, { deps: deps([], { logPaths }) });
    expect(logPaths).toHaveBeenCalledWith("claude-code", ["old-1", "old-2", chat.session_id]);
  });

  it("merges without clobbering a fresher live sighting", async () => {
    const repo = makeRepo("app-merge");
    const live = { cwd: repo, repoPath: repo, branch: "feat/live", head: "live-head", firstSeen: "2026-04-01T00:00:00Z", lastSeen: "2026-04-02T00:00:00Z" };
    const chat = makeChat(repo, { gitTrail: [live] });
    const t = writeJsonl("merge.jsonl", [claudeLine(repo, "feat/live", "2026-03-01T00:00:00Z"), claudeLine(repo, "feat/older", "2026-03-02T00:00:00Z")]);
    await backfillChat(chat, { deps: deps([t]) });
    expect(trailOf(chat.id)).toEqual([{ ...live, firstSeen: "2026-03-01T00:00:00Z" }, expect.objectContaining({ branch: "feat/older" })]);
  });

  it("sets the marker when the transcript is gone, and runs only once", async () => {
    const repo = makeRepo("app-once");
    const chat = makeChat(repo);
    const logPaths = vi.fn(() => []);
    expect(await backfillChat(chat, { deps: deps([], { logPaths }) })).toBe("done");
    expect(metaOf(chat.id).gitTrailBackfilled).toBe(GIT_TRAIL_BACKFILL_VERSION);
    expect(await backfillChat(chatFileService.getChat(chat.id)!, { deps: deps([], { logPaths }) })).toBe("skipped");
    expect(logPaths).toHaveBeenCalledTimes(1);
  });

  it("leaves the marker unset on a transient read failure, so a later request retries", async () => {
    const repo = makeRepo("app-transient");
    const chat = makeChat(repo);
    // A directory where a transcript should be: the read fails.
    const notAFile = join(tmp, "transient-dir.jsonl");
    mkdirSync(notAFile);
    expect(await backfillChat(chat, { deps: deps([notAFile]) })).toBe("transient");
    expect(metaOf(chat.id).gitTrailBackfilled).toBeUndefined();
  });

  it("re-runs once the version is bumped past the stored marker", async () => {
    const repo = makeRepo("app-version");
    const chat = makeChat(repo, { gitTrailBackfilled: GIT_TRAIL_BACKFILL_VERSION - 1 });
    expect(await backfillChat(chat, { deps: deps() })).toBe("done");
  });

  it("backfills a lastBranch / workspace-only chat (Pi and other engines)", async () => {
    const repo = makeRepo("app-pi");
    const goneWt = join(tmp, "app-pi-ws-gone");
    const chat = makeChat(repo, { provider: "pi", lastBranch: "feat/pi-last" }, { workspaceId: "ws-1" });
    const logPaths = vi.fn(() => []);
    const getWorkspace = () => ({
      cwd: goneWt,
      repoPath: repo,
      worktree: { branch: "feat/pi-ws" },
      createdAt: "2026-02-01T00:00:00Z",
      archivedAt: "2026-02-05T00:00:00Z",
    });
    await backfillChat(chat, { deps: deps([], { logPaths, getWorkspace }) });
    expect(logPaths).not.toHaveBeenCalled();
    expect(trailOf(chat.id).map((e) => [e.cwd, e.repoPath, e.branch, e.firstSeen, e.lastSeen])).toEqual([
      [repo, repo, "feat/pi-last", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
      [goneWt, repo, "feat/pi-ws", "2026-02-01T00:00:00Z", "2026-02-05T00:00:00Z"],
    ]);
  });

  it("marks a retired-provider chat without reading anything", async () => {
    const repo = makeRepo("app-retired");
    const chat = makeChat(repo, { provider: "openrouter", lastBranch: "feat/x" });
    const logPaths = vi.fn(() => []);
    expect(await backfillChat(chat, { deps: deps([], { logPaths }) })).toBe("done");
    expect(logPaths).not.toHaveBeenCalled();
    expect(metaOf(chat.id)).toMatchObject({ gitTrailBackfilled: GIT_TRAIL_BACKFILL_VERSION });
    expect(metaOf(chat.id).gitTrail).toBeUndefined();
  });
});

describe("isSafeSessionId", () => {
  it.each(["01a0ab38-6d21-72b3-9de2-005b06f56912", "ee101d16-136d-48c0-b10b-6677a6b46ca2", "abc_123"])("accepts %s", (id) => {
    expect(isSafeSessionId(id)).toBe(true);
  });
  it.each(["", "../etc/passwd", "a/b", "a.b", ".hidden", "-x", "a b", "x".repeat(200)])("refuses %j", (id) => {
    expect(isSafeSessionId(id)).toBe(false);
  });
});

describe("the queue", () => {
  it("returns at once, runs once per chat, dedupes in-flight requests and runs one at a time", async () => {
    const repo = makeRepo("app-queue");
    // Codex chats whose rollout names a deleted directory and a repository_url:
    // resolving it asks for the known repository's remote — the hold point.
    const rollout = writeJsonl("queue.jsonl", [sessionMeta(join(tmp, "queue-gone"), "feat/q", "2026-02-01T00:00:00Z")]);
    const chats = [makeChat(repo, { provider: "codex" }), makeChat(repo, { provider: "codex" }), makeChat(repo, { provider: "codex" })];
    const gate = holdPoint();
    let inFlight = 0;
    let peak = 0;
    const logPaths = vi.fn(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return [rollout];
    });
    const held: BackfillDeps = deps([], {
      logPaths,
      remoteUrl: async () => {
        const remote = await gate.hold<string | null>(null);
        inFlight--;
        return remote;
      },
    });

    const started = performance.now();
    for (const chat of chats) {
      requestBackfill({ chatId: chat.id, chat }, held);
      requestBackfill({ chatId: chat.id, chat }, held); // a second poll while it is queued
    }
    expect(performance.now() - started).toBeLessThan(50);

    // Each backfill parks in turn; let each go once it has.
    for (let i = 0; i < chats.length; i++) (await gate.next())();
    await backfillIdle();
    expect(logPaths).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    for (const chat of chats) expect(metaOf(chat.id).gitTrailBackfilled).toBe(GIT_TRAIL_BACKFILL_VERSION);

    // Asked again after finishing: not queued at all.
    requestBackfill({ chatId: chats[0].id, chat: chats[0] }, held);
    await backfillIdle();
    expect(logPaths).toHaveBeenCalledTimes(3);
  });

  it("puts a priority request ahead of the waiting backlog, moving it up if already waiting, never running it twice", async () => {
    const repo = makeRepo("app-priority");
    const rollout = writeJsonl("priority.jsonl", [sessionMeta(join(tmp, "priority-gone"), "feat/p", "2026-02-01T00:00:00Z")]);
    const [first, a, b, c] = [0, 1, 2, 3].map(() => makeChat(repo, { provider: "codex" }));
    const gate = holdPoint();
    const order: string[] = [];
    const held = (id: string): BackfillDeps =>
      deps([], {
        logPaths: () => (order.push(id), [rollout]),
        remoteUrl: () => gate.hold<string | null>(null),
      });
    requestBackfill({ chatId: first.id, chat: first }, held("first")); // starts at once and holds
    requestBackfill({ chatId: a.id, chat: a }, held("a"));
    requestBackfill({ chatId: b.id, chat: b }, held("b"));
    requestBackfill({ chatId: c.id, chat: c, priority: true }, held("c")); // new, to the front
    requestBackfill({ chatId: b.id, chat: b, priority: true }, held("b")); // already waiting: moves up
    requestBackfill({ chatId: first.id, chat: first, priority: true }, held("first")); // running: left alone
    for (let i = 0; i < 4; i++) (await gate.next())();
    await backfillIdle();
    expect(order).toEqual(["first", "b", "c", "a"]);
  });

  it("starts over on reset, even with a backfill still held — no cascade into later tests", async () => {
    const repo = makeRepo("app-reset");
    const rollout = writeJsonl("reset.jsonl", [sessionMeta(join(tmp, "reset-gone"), "feat/r", "2026-02-01T00:00:00Z")]);
    const [stuck, waiting] = [0, 1].map(() => makeChat(repo, { provider: "codex" }));
    const gate = holdPoint();
    const held = deps([rollout], { remoteUrl: () => gate.hold<string | null>(null) });
    requestBackfill({ chatId: stuck.id, chat: stuck }, held);
    requestBackfill({ chatId: waiting.id, chat: waiting }, held);
    const release = await gate.next(); // the first is parked; the second waits behind it

    resetBackfillQueue();
    await backfillIdle(); // idle at once: nothing counted as running or waiting

    // A fresh request runs straight away instead of queueing behind the held one.
    const fresh = makeChat(repo);
    requestBackfill({ chatId: fresh.id, chat: fresh }, deps([]));
    await backfillIdle();
    expect(metaOf(fresh.id).gitTrailBackfilled).toBe(GIT_TRAIL_BACKFILL_VERSION);

    // The held one settling later must not disturb the new queue's count —
    // without the guard it would drive it to -1 and let two run at once.
    const staleWrote = new Promise<void>((resolve) => {
      const write = chatFileService.updateChatMetadataForRecord.bind(chatFileService);
      vi.spyOn(chatFileService, "updateChatMetadataForRecord").mockImplementation((record, fields, opts) => {
        const result = write(record, fields, opts);
        if (record.id === stuck.id) resolve();
        return result;
      });
    });
    release();
    await staleWrote;
    await Promise.resolve(); // its queue bookkeeping runs right after

    const next = holdPoint();
    const started: string[] = [];
    const [x, y] = [0, 1].map(() => makeChat(repo, { provider: "codex" }));
    const nextDeps = (id: string) => deps([], { logPaths: () => (started.push(id), [rollout]), remoteUrl: () => next.hold<string | null>(null) });
    requestBackfill({ chatId: x.id, chat: x }, nextDeps("x"));
    requestBackfill({ chatId: y.id, chat: y }, nextDeps("y"));
    const releaseX = await next.next();
    expect(started).toEqual(["x"]); // y waits: still one at a time
    releaseX();
    (await next.next())();
    await backfillIdle();
    expect(started).toEqual(["x", "y"]);
  });

  it("does not re-queue a chat that has no stored record", async () => {
    const lookups = vi.spyOn(chatFileService, "getChatBySessionId");
    requestBackfill({ chatId: "native-child-without-record" });
    await backfillIdle();
    const after = lookups.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    requestBackfill({ chatId: "native-child-without-record" });
    await backfillIdle();
    expect(lookups.mock.calls.length).toBe(after);
  });

  it("retries a chat whose backfill failed transiently, the next time it is asked for", async () => {
    const repo = makeRepo("app-retry");
    const chat = makeChat(repo);
    const notAFile = join(tmp, "retry-dir.jsonl");
    mkdirSync(notAFile);
    requestBackfill({ chatId: chat.id, chat }, deps([notAFile]));
    await backfillIdle();
    expect(metaOf(chat.id).gitTrailBackfilled).toBeUndefined();
    requestBackfill({ chatId: chat.id, chat: chatFileService.getChat(chat.id)! }, deps([]));
    await backfillIdle();
    expect(metaOf(chat.id).gitTrailBackfilled).toBe(GIT_TRAIL_BACKFILL_VERSION);
  });
});
