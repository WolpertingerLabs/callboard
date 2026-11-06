import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeInfo } from "../utils/git.js";
import type { PullSummary, RepoPulls } from "./github-prs.js";
import { buildGitOverview, findGitRoot, NOT_A_REPO_TTL_MS, normalizeDir, type OverviewDeps } from "./git-overview.js";

const wt = (path: string, branch: string | null, isMainWorktree = false, head?: string): WorktreeInfo => ({
  path,
  branch,
  isMainWorktree,
  isBare: false,
  ...(head && { head }),
});

const pull = (number: number, headRef: string, state: PullSummary["state"], headSha = "x"): PullSummary => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  title: `PR ${number}`,
  state,
  headRef,
  headSha,
  headOwner: "acme",
  updatedAt: "2026-11-01T00:00:00Z",
});

/** Two repos as git would list them: `app` with two linked worktrees, `lib` alone. */
const WORKTREES: Record<string, WorktreeInfo[]> = {
  "/src/app": [wt("/src/app", "main", true, "m1"), wt("/src/app.feat-x", "feat/x", false, "x1"), wt("/src/app.old", "old", false, "o1")],
  "/src/lib": [wt("/src/lib", "main", true)],
};
const WORKTREE_OF: Record<string, string> = { "/src/app.feat-x": "/src/app", "/src/app.old": "/src/app" };
/** Directories holding a `.git` — what the filesystem walk in findGitRoot looks for. */
const GIT_ROOTS = new Set(["/src/app", "/src/app.feat-x", "/src/app.old", "/src/lib"]);
const NON_REPO_GIT_DIRS = new Set<string>();

/** findGitRoot over the fixture: nearest ancestor in GIT_ROOTS. */
function fakeGitRoot(dir: string): string | null {
  for (let d = dir; d && d !== "/"; d = d.slice(0, d.lastIndexOf("/")) || "/") {
    if (GIT_ROOTS.has(d) || NON_REPO_GIT_DIRS.has(d)) return d;
  }
  return null;
}

function deps(folders: Record<string, string[]>, overrides: Partial<OverviewDeps> = {}): OverviewDeps & { listWorktrees: ReturnType<typeof vi.fn> } {
  const listWorktrees = vi.fn(async (dir: string) => WORKTREES[dir] ?? []);
  return {
    folders: () => new Map(Object.entries(folders).map(([folder, ids]) => [folder, new Set(ids)])),
    listWorktrees,
    // Mirrors resolveWorktreeToMainRepo: a worktree root maps to its main repo,
    // anything else (including a subdirectory) maps to itself.
    mainRepoOf: (dir) => WORKTREE_OF[dir] ?? dir,
    pullsFor: async () => ({ byBranch: new Map() }),
    normalize: (dir) => dir.replace(/\/+$/, ""),
    exists: () => true,
    gitRootOf: fakeGitRoot,
    notRepos: new Map(),
    ...overrides,
  } as OverviewDeps & { listWorktrees: ReturnType<typeof vi.fn> };
}

describe("buildGitOverview", () => {
  it("groups worktrees by repo and attaches cards to the directory they work in", async () => {
    const d = deps({ "/src/app.feat-x": ["c1"], "/src/app": ["c2", "c3"], "/src/lib/": ["c4"] });
    const { repos } = await buildGitOverview({}, d);
    expect(repos.map((r) => r.name)).toEqual(["app", "lib"]);
    expect(repos[0].rows).toEqual([
      { cwd: "/src/app", branch: "main", isMain: true, cardIds: ["c2", "c3"] },
      { cwd: "/src/app.feat-x", branch: "feat/x", isMain: false, cardIds: ["c1"] },
      // A worktree no active card works in still gets a row.
      { cwd: "/src/app.old", branch: "old", isMain: false, cardIds: [] },
    ]);
    expect(repos[1].rows).toEqual([{ cwd: "/src/lib", branch: "main", isMain: true, cardIds: ["c4"] }]);
  });

  it("lists each repository once, however many of its folders are in use", async () => {
    const d = deps({ "/src/app": ["c1"], "/src/app.feat-x": ["c2"], "/src/app.old": ["c3"], "/src/app/backend": ["c4"] });
    await buildGitOverview({}, d);
    expect(d.listWorktrees).toHaveBeenCalledTimes(1);
  });

  it("attaches a chat in a subdirectory to the worktree containing it, not a sibling with a common prefix", async () => {
    const d = deps({ "/src/app.feat-x/backend/src": ["c1"] });
    const { repos } = await buildGitOverview({}, d);
    // Resolved through the worktree's .git to the main repo — one listing.
    expect(d.listWorktrees).toHaveBeenCalledWith("/src/app");
    const rows = repos[0].rows;
    expect(rows.find((r) => r.cwd === "/src/app.feat-x")?.cardIds).toEqual(["c1"]);
    expect(rows.find((r) => r.cwd === "/src/app")?.cardIds).toEqual([]);
  });

  it("dedupes a card with several chats in one directory", async () => {
    const d = deps({ "/src/app": ["c1"], "/src/app/docs": ["c1"] });
    const { repos } = await buildGitOverview({}, d);
    expect(repos[0].rows[0].cardIds).toEqual(["c1"]);
  });

  it("skips folders that are not repositories, or no longer exist, without spawning git", async () => {
    const d = deps({ "/tmp/scratch": ["c1"], "/gone": ["c2"] }, { exists: (dir) => dir !== "/gone" });
    expect((await buildGitOverview({}, d)).repos).toEqual([]);
    expect(d.listWorktrees).not.toHaveBeenCalled();
  });

  it("remembers a .git that would not list across requests, until the TTL runs out", async () => {
    NON_REPO_GIT_DIRS.add("/src/broken");
    try {
      let clock = 1000;
      const notRepos = new Map<string, number>();
      const d = deps({ "/src/broken/sub": ["c1"] }, { notRepos, now: () => clock });
      await buildGitOverview({}, d);
      await buildGitOverview({}, d);
      expect(d.listWorktrees).toHaveBeenCalledTimes(1);
      clock += NOT_A_REPO_TTL_MS;
      await buildGitOverview({}, d);
      expect(d.listWorktrees).toHaveBeenCalledTimes(2);
    } finally {
      NON_REPO_GIT_DIRS.clear();
    }
  });

  it("treats a nested repo or submodule inside a worktree as its own repository", async () => {
    GIT_ROOTS.add("/src/app/vendor/sub");
    WORKTREES["/src/app/vendor/sub"] = [wt("/src/app/vendor/sub", "main", true)];
    try {
      const d = deps({ "/src/app": ["c1"], "/src/app/vendor/sub/src": ["c2"] });
      const { repos } = await buildGitOverview({}, d);
      expect(repos.map((r) => [r.repoPath, r.rows.map((row) => [row.cwd, row.cardIds])])).toEqual([
        [
          "/src/app",
          [
            ["/src/app", ["c1"]],
            ["/src/app.feat-x", []],
            ["/src/app.old", []],
          ],
        ],
        ["/src/app/vendor/sub", [["/src/app/vendor/sub", ["c2"]]]],
      ]);
    } finally {
      GIT_ROOTS.delete("/src/app/vendor/sub");
      delete WORKTREES["/src/app/vendor/sub"];
    }
  });

  it("lists at most two repositories at a time", async () => {
    const roots = ["/r/a", "/r/b", "/r/c", "/r/d", "/r/e"];
    let inFlight = 0;
    let peak = 0;
    const listWorktrees = vi.fn(async (dir: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [wt(dir, "main", true)];
    });
    const d = deps(Object.fromEntries(roots.map((r, i) => [r, [`c${i}`]])), { listWorktrees, gitRootOf: (dir) => dir });
    const { repos } = await buildGitOverview({}, d);
    expect(repos).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("drops linked worktrees whose directory is gone", async () => {
    const d = deps({ "/src/app": ["c1"] }, { exists: (dir) => dir !== "/src/app.old" });
    const { repos } = await buildGitOverview({}, d);
    expect(repos[0].rows.map((r) => r.cwd)).toEqual(["/src/app", "/src/app.feat-x"]);
  });

  it("attaches PRs by branch, validating closed ones against the worktree's HEAD", async () => {
    const byBranch = new Map([
      ["feat/x", [pull(12, "feat/x", "open")]],
      ["old", [pull(3, "old", "merged", "not-o1")]],
    ]);
    const d = deps({ "/src/app": ["c1"] }, { pullsFor: async (repo) => (repo === "/src/app" ? { byBranch } : { byBranch: new Map() }) });
    const { repos } = await buildGitOverview({}, d);
    const rows = repos[0].rows;
    expect(rows.find((r) => r.branch === "feat/x")?.pr).toEqual({ number: 12, url: "https://github.com/acme/app/pull/12", state: "open", title: "PR 12" });
    expect(rows.find((r) => r.branch === "old")?.pr).toBeUndefined();
  });

  it("degrades a failed PR lookup to rows without PRs and a prError", async () => {
    const failed: RepoPulls = { byBranch: new Map(), error: "gh is not installed" };
    const d = deps({ "/src/app": ["c1"], "/src/lib": ["c2"] }, { pullsFor: async (repo) => (repo === "/src/app" ? failed : { byBranch: new Map() }) });
    const { repos } = await buildGitOverview({}, d);
    expect(repos[0].prError).toBe("gh is not installed");
    expect(repos[0].rows.every((r) => r.pr === undefined)).toBe(true);
    expect(repos[1].prError).toBeUndefined();
  });

  it("passes the refresh flag through to the PR lookup", async () => {
    const pullsFor = vi.fn(async () => ({ byBranch: new Map() }));
    await buildGitOverview({ force: true }, deps({ "/src/app": ["c1"] }, { pullsFor }));
    expect(pullsFor).toHaveBeenCalledWith("/src/app", true);
  });

  it("keeps a detached HEAD as a row with no branch and no PR", async () => {
    const d = deps({ "/src/app": ["c1"] });
    d.listWorktrees.mockResolvedValue([wt("/src/app", "main", true), wt("/src/app.bisect", null, false, "d1")]);
    const { repos } = await buildGitOverview({}, d);
    expect(repos[0].rows[1]).toEqual({ cwd: "/src/app.bisect", branch: null, isMain: false, cardIds: [] });
  });
});

describe("the real filesystem helpers", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-overview-")));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("normalizeDir resolves symlinks and drops a trailing slash", () => {
    const real = join(tmp, "real");
    mkdirSync(real);
    symlinkSync(real, join(tmp, "link"));
    expect(normalizeDir(join(tmp, "link") + "/")).toBe(real);
    expect(normalizeDir(real + "/")).toBe(real);
    // A directory that no longer exists keeps its lexical form.
    expect(normalizeDir(join(tmp, "gone") + "/")).toBe(join(tmp, "gone"));
  });

  it("findGitRoot finds the nearest .git, file or directory, and null above every one", () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "vendor", "sub", "src"), { recursive: true });
    writeFileSync(join(repo, "vendor", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");
    expect(findGitRoot(join(repo, "vendor"))).toBe(repo);
    expect(findGitRoot(join(repo, "vendor", "sub", "src"))).toBe(join(repo, "vendor", "sub"));
    expect(findGitRoot(join(tmp, "repo-less"), () => false)).toBeNull();
  });
});
