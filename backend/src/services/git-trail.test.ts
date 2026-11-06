/**
 * The per-chat git trail: what a sighting records, when it writes, and that it
 * fires from the session registry — the seam every chat turn passes through.
 * Real git repositories and a real (throwaway) chat store throughout.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-git-trail-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-trail-")));

const { chatFileService } = await import("./chat-file-service.js");
const { sessionRegistry } = await import("./session-registry.js");
const { initGitTrailRecorder, mergeSighting, mergeTrails, noteChatSession, parseGitTrail, recordGitTrail, sightFolder } = await import("./git-trail.js");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

let repoCount = 0;
function makeRepo(): string {
  const dir = join(tmp, `repo${++repoCount}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

let chatCount = 0;
function makeChat(folder: string, metadata: Record<string, unknown> = {}) {
  const id = `trail-chat-${++chatCount}`;
  return chatFileService.upsertChat(id, folder, id, { metadata: JSON.stringify(metadata), updated_at: "2026-01-01T00:00:00.000Z" });
}

const trailOf = (id: string) => parseGitTrail(JSON.parse(chatFileService.getChat(id)!.metadata || "{}").gitTrail);
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");

describe("sightFolder", () => {
  it("reads checkout, repository, branch and commit without git", () => {
    const repo = makeRepo();
    expect(sightFolder(repo)).toEqual({ cwd: repo, repoPath: repo, branch: "main", head: git(repo, "rev-parse", "HEAD") });
  });

  it("resolves a linked worktree to its main checkout, from a subdirectory too", () => {
    const repo = makeRepo();
    const wt = join(tmp, `wt${repoCount}`);
    git(repo, "worktree", "add", "-q", "-b", "feat/x", wt);
    git(wt, "commit", "-q", "--allow-empty", "-m", "on x");
    execFileSync("mkdir", ["-p", join(wt, "sub")]);
    expect(sightFolder(join(wt, "sub"))).toEqual({ cwd: wt, repoPath: repo, branch: "feat/x", head: git(wt, "rev-parse", "HEAD") });
  });

  it("follows packed refs", () => {
    const repo = makeRepo();
    git(repo, "pack-refs", "--all");
    expect(sightFolder(repo)?.head).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("normalises a symlinked folder to the real checkout", () => {
    const repo = makeRepo();
    const link = join(tmp, `link${repoCount}`);
    symlinkSync(repo, link);
    expect(sightFolder(link)?.cwd).toBe(repo);
  });

  it("records nothing for a detached HEAD, a non-repository, or a missing folder", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "--detach");
    expect(sightFolder(repo)).toBeNull();
    expect(sightFolder(tmp)).toBeNull();
    expect(sightFolder(join(tmp, "gone"))).toBeNull();
  });
});

describe("mergeSighting", () => {
  const base = { cwd: "/r", repoPath: "/r", branch: "a", head: "1" };
  const entry = { ...base, firstSeen: "t0", lastSeen: "t0" };

  it("adds a new (cwd, branch) pair", () => {
    expect(mergeSighting([entry], { ...base, branch: "b" }, "t1")).toEqual([entry, { ...base, branch: "b", firstSeen: "t1", lastSeen: "t1" }]);
  });

  it("changes nothing for the same pair at the same commit — lastSeen alone is not a write", () => {
    expect(mergeSighting([entry], base, "t1")).toBeNull();
    expect(mergeSighting([entry], { cwd: "/r", repoPath: "/r", branch: "a" }, "t1")).toBeNull();
  });

  it("updates the commit and lastSeen, keeping firstSeen, when HEAD moved", () => {
    expect(mergeSighting([entry], { ...base, head: "2" }, "t1")).toEqual([{ ...entry, head: "2", lastSeen: "t1" }]);
  });

  it("keeps entries for other checkouts of the same branch apart", () => {
    expect(mergeSighting([entry], { ...base, cwd: "/r.wt" }, "t1")).toHaveLength(2);
  });

  it("has no cap", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...entry, branch: `b${i}` }));
    expect(mergeSighting(many, { ...base, branch: "new" }, "t1")).toHaveLength(501);
  });
});

describe("mergeTrails", () => {
  const e = (branch: string, firstSeen: string, lastSeen: string, extra: Record<string, string> = {}) => ({
    cwd: "/r",
    repoPath: "/r",
    branch,
    firstSeen,
    lastSeen,
    ...extra,
  });

  it("unions by (cwd, branch): earliest firstSeen, and lastSeen/head/repoPath from the latest sighting", () => {
    const a = [e("a", "t1", "t2", { head: "a1" }), e("b", "t1", "t3", { head: "b-old", repoPath: "/old" })];
    const b = [e("b", "t2", "t5", { head: "b-new" }), e("c", "t4", "t4")];
    expect(mergeTrails(a, b)).toEqual([e("a", "t1", "t2", { head: "a1" }), e("b", "t1", "t5", { head: "b-new" }), e("c", "t4", "t4")]);
  });

  it("keeps the earlier side's head and repoPath when it is the more recent sighting", () => {
    expect(mergeTrails([e("b", "t3", "t9", { head: "keep", repoPath: "/keep" })], [e("b", "t1", "t2", { head: "older" })])).toEqual([
      e("b", "t1", "t9", { head: "keep", repoPath: "/keep" }),
    ]);
  });

  it("does not invent a head when the latest sighting had none", () => {
    expect(mergeTrails([e("b", "t1", "t2", { head: "h" })], [e("b", "t1", "t3")])).toEqual([e("b", "t1", "t3")]);
  });
});

describe("recordGitTrail", () => {
  it("records a new pair, without touching updated_at or other metadata", () => {
    const repo = makeRepo();
    const chat = makeChat(repo, { lastBranch: "main", title: "keep me" });
    expect(recordGitTrail(chat.id, "2026-11-06T00:00:00.000Z")).toBe(true);
    expect(trailOf(chat.id)).toEqual([
      {
        cwd: repo,
        repoPath: repo,
        branch: "main",
        head: git(repo, "rev-parse", "HEAD"),
        firstSeen: "2026-11-06T00:00:00.000Z",
        lastSeen: "2026-11-06T00:00:00.000Z",
      },
    ]);
    const stored = chatFileService.getChat(chat.id)!;
    expect(stored.updated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(metaOf(chat.id)).toMatchObject({ lastBranch: "main", title: "keep me" });
  });

  it("does not write when nothing changed", () => {
    const repo = makeRepo();
    const chat = makeChat(repo);
    recordGitTrail(chat.id);
    const write = vi.spyOn(chatFileService, "updateChatMetadataForRecord");
    expect(recordGitTrail(chat.id)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("updates the entry when the branch's commit moved, and adds one per branch switched to", () => {
    const repo = makeRepo();
    const chat = makeChat(repo);
    recordGitTrail(chat.id, "t1");
    git(repo, "commit", "-q", "--allow-empty", "-m", "more");
    expect(recordGitTrail(chat.id, "t2")).toBe(true);
    expect(trailOf(chat.id)).toEqual([expect.objectContaining({ branch: "main", head: git(repo, "rev-parse", "HEAD"), firstSeen: "t1", lastSeen: "t2" })]);

    git(repo, "checkout", "-q", "-b", "feat/next");
    recordGitTrail(chat.id, "t3");
    expect(trailOf(chat.id).map((e) => e.branch)).toEqual(["main", "feat/next"]);
  });

  it("ignores a detached HEAD", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "--detach");
    const chat = makeChat(repo);
    expect(recordGitTrail(chat.id)).toBe(false);
    expect(metaOf(chat.id).gitTrail).toBeUndefined();
  });

  it("merges into the freshest record, so a concurrent metadata write survives", () => {
    const repo = makeRepo();
    const chat = makeChat(repo);
    const stale = chatFileService.getChat(chat.id)!;
    // Another writer lands after the copy the caller would have read.
    chatFileService.updateChatMetadata(chat.id, {
      model: "opus",
      gitTrail: [{ cwd: "/elsewhere", repoPath: "/elsewhere", branch: "x", firstSeen: "t0", lastSeen: "t0" }],
    });
    // The recorder's first read returns the stale copy; its re-read must not.
    vi.spyOn(chatFileService, "getChatBySessionId").mockReturnValueOnce(stale);
    expect(recordGitTrail(chat.id)).toBe(true);
    expect(metaOf(chat.id).model).toBe("opus");
    expect(trailOf(chat.id).map((e) => e.branch)).toEqual(["x", "main"]);
  });

  it("finds a chat filed under another session id without scanning, once sendMessage noted it", () => {
    const repo = makeRepo();
    const chat = chatFileService.upsertChat("trail-id-differs", repo, "trail-session-xyz", { metadata: "{}" });
    noteChatSession(chat.id, chat.session_id);
    const scan = vi.spyOn(chatFileService, "getChat");
    expect(recordGitTrail(chat.id)).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    expect(parseGitTrail(JSON.parse(chatFileService.getChatBySessionId("trail-session-xyz")!.metadata).gitTrail)).toHaveLength(1);
  });

  it("scans at most once for an id it was not told about, then remembers", () => {
    const repo = makeRepo();
    const chat = chatFileService.upsertChat("trail-id-unnoted", repo, "trail-session-unnoted", { metadata: "{}" });
    const scan = vi.spyOn(chatFileService, "getChat");
    recordGitTrail(chat.id);
    git(repo, "commit", "-q", "--allow-empty", "-m", "more");
    recordGitTrail(chat.id);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("swallows a failure rather than reaching the turn", () => {
    vi.spyOn(chatFileService, "getChat").mockImplementation(() => {
      throw new Error("disk on fire");
    });
    expect(recordGitTrail("anything")).toBe(false);
  });

  it("skips a new chat's temporary id and an unknown chat", () => {
    expect(recordGitTrail("new-12345")).toBe(false);
    expect(recordGitTrail("no-such-chat")).toBe(false);
  });
});

describe("the session-registry hook", () => {
  const tick = () => new Promise((r) => setImmediate(r));
  initGitTrailRecorder();

  it("records at turn start and again at turn end", async () => {
    const repo = makeRepo();
    const chat = makeChat(repo);
    sessionRegistry.register(chat.id, { type: "web" });
    await tick();
    expect(trailOf(chat.id).map((e) => e.branch)).toEqual(["main"]);

    // The agent switches branch during the turn; the end of the turn sees it.
    git(repo, "checkout", "-q", "-b", "feat/during");
    sessionRegistry.unregister(chat.id);
    await tick();
    expect(trailOf(chat.id).map((e) => e.branch)).toEqual(["main", "feat/during"]);
  });

  it("records a new chat once its temporary id migrates to the real one", async () => {
    const repo = makeRepo();
    const chat = makeChat(repo);
    sessionRegistry.register("new-999", { type: "web" });
    sessionRegistry.migrate("new-999", chat.session_id);
    await tick();
    expect(trailOf(chat.id)).toHaveLength(1);
    sessionRegistry.unregister(chat.session_id);
  });

  it("records CLI-watched sessions too", async () => {
    const repo = makeRepo();
    const chat = makeChat(repo);
    sessionRegistry.register(chat.id, { type: "cli" });
    await tick();
    expect(trailOf(chat.id)).toHaveLength(1);
    sessionRegistry.unregister(chat.id);
  });
});
