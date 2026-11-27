import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeInfo } from "../utils/git.js";
import { clearRepoPullsCache, resolveBranchPulls, type BranchAnswer, type BranchAsk, type PullSummary, type RepoPulls } from "./github-prs.js";
import { buildGitOverview, findGitRoot, normalizeDir, type OverviewDeps } from "./git-overview.js";

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
  baseRef: "main",
  author: "dev",
  createdAt: "2026-10-01T00:00:00Z",
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
      // `/src/app.old` is a worktree too, but no open card works in it: no row.
    ]);
    expect(repos[1].rows).toEqual([{ cwd: "/src/lib", branch: "main", isMain: true, cardIds: ["c4"] }]);
  });

  it("lists only worktrees with active chats — the main checkout included", async () => {
    const d = deps({ "/src/app.feat-x": ["c1"] });
    const { repos } = await buildGitOverview({}, d);
    expect(repos.map((r) => r.rows.map((row) => row.cwd))).toEqual([["/src/app.feat-x"]]);
    expect(repos.flatMap((r) => r.rows).every((row) => row.cardIds.length > 0)).toBe(true);
  });

  it("drops a repository left with no rows, and spends no PR lookup on it", async () => {
    // The folder is inside the repository but in no listed worktree (a pruned
    // one), so nothing attaches anywhere in it.
    const pullsFor = vi.fn(async () => ({ byBranch: new Map() }));
    const d = deps({ "/src/app.pruned": ["c1"], "/src/lib": ["c2"] }, { pullsFor });
    GIT_ROOTS.add("/src/app.pruned");
    WORKTREE_OF["/src/app.pruned"] = "/src/app";
    try {
      const { repos } = await buildGitOverview({}, d);
      expect(repos.map((r) => r.repoPath)).toEqual(["/src/lib"]);
      expect(pullsFor.mock.calls).toEqual([["/src/lib", false]]);
    } finally {
      GIT_ROOTS.delete("/src/app.pruned");
      delete WORKTREE_OF["/src/app.pruned"];
    }
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
    expect(repos[0].rows.map((r) => [r.cwd, r.cardIds])).toEqual([["/src/app.feat-x", ["c1"]]]);
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

  it("asks git again on the next request about a .git that would not list — a refusal is not remembered", async () => {
    NON_REPO_GIT_DIRS.add("/src/broken");
    try {
      const d = deps({ "/src/broken/sub": ["c1"] });
      expect((await buildGitOverview({}, d)).repos).toEqual([]);
      expect((await buildGitOverview({}, d)).repos).toEqual([]);
      expect(d.listWorktrees).toHaveBeenCalledTimes(2);
    } finally {
      NON_REPO_GIT_DIRS.clear();
    }
  });

  /**
   * The regression: one `git worktree list` that exited non-zero (or listed
   * nothing usable) was remembered for five minutes, so every row of a real
   * repository disappeared for that long after a single transient failure.
   */
  it("shows a repository again on the very next request after one failed listing", async () => {
    const d = deps({ "/src/app": ["c1"], "/src/app.feat-x": ["c2"] });
    d.listWorktrees.mockResolvedValueOnce([]);
    expect((await buildGitOverview({}, d)).repos).toEqual([]);

    const { repos } = await buildGitOverview({}, d);
    expect(repos.map((r) => r.rows.map((row) => row.cwd))).toEqual([["/src/app", "/src/app.feat-x"]]);
    expect(d.listWorktrees).toHaveBeenCalledTimes(2);
  });

  it("asks again next poll after a listing that gave no verdict (timeout)", async () => {
    const d = deps({ "/src/app": ["c1"] });
    d.listWorktrees.mockResolvedValueOnce(null);
    expect((await buildGitOverview({}, d)).repos).toEqual([]);

    const { repos } = await buildGitOverview({}, d);
    expect(repos.map((r) => r.repoPath)).toEqual(["/src/app"]);
    expect(d.listWorktrees).toHaveBeenCalledTimes(2);
  });

  it("treats a nested repo or submodule inside a worktree as its own repository", async () => {
    GIT_ROOTS.add("/src/app/vendor/sub");
    WORKTREES["/src/app/vendor/sub"] = [wt("/src/app/vendor/sub", "main", true)];
    try {
      const d = deps({ "/src/app": ["c1"], "/src/app/vendor/sub/src": ["c2"] });
      const { repos } = await buildGitOverview({}, d);
      expect(repos.map((r) => [r.repoPath, r.rows.map((row) => [row.cwd, row.cardIds])])).toEqual([
        ["/src/app", [["/src/app", ["c1"]]]],
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
    // A chat still recorded in the deleted directory has nowhere to attach.
    const d = deps({ "/src/app": ["c1"], "/src/app.feat-x": ["c2"], "/src/app.old": ["c3"] }, { exists: (dir) => dir !== "/src/app.old" });
    const { repos } = await buildGitOverview({}, d);
    expect(repos[0].rows.map((r) => r.cwd)).toEqual(["/src/app", "/src/app.feat-x"]);
  });

  it("attaches PRs by branch, validating closed ones against the worktree's HEAD", async () => {
    const byBranch = new Map([
      ["feat/x", [pull(12, "feat/x", "open")]],
      ["old", [pull(3, "old", "merged", "not-o1")]],
    ]);
    const d = deps(
      { "/src/app": ["c1"], "/src/app.feat-x": ["c2"], "/src/app.old": ["c3"] },
      { pullsFor: async (repo) => (repo === "/src/app" ? { byBranch } : { byBranch: new Map() }) },
    );
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
    const d = deps({ "/src/app": ["c1"], "/src/app.bisect": ["c2"] });
    GIT_ROOTS.add("/src/app.bisect");
    WORKTREE_OF["/src/app.bisect"] = "/src/app";
    d.listWorktrees.mockResolvedValue([wt("/src/app", "main", true), wt("/src/app.bisect", null, false, "d1")]);
    try {
      const { repos } = await buildGitOverview({}, d);
      expect(repos[0].rows[1]).toEqual({ cwd: "/src/app.bisect", branch: null, isMain: false, cardIds: ["c2"] });
    } finally {
      GIT_ROOTS.delete("/src/app.bisect");
      delete WORKTREE_OF["/src/app.bisect"];
    }
  });
});

describe("buildGitOverview — the git trail", () => {
  const at = (pr: PullSummary, updatedAt: string): PullSummary => ({ ...pr, updatedAt });
  const entry = (cwd: string, branch: string, lastSeen = "t1", repoPath = "/src/app") => ({ cwd, repoPath, branch, firstSeen: "t0", lastSeen });
  const APP: RepoPulls = {
    github: { owner: "acme", repo: "app" },
    defaultBranch: "main",
    byBranch: new Map([
      ["feat/x", [at(pull(12, "feat/x", "open"), "2026-11-01T00:00:00Z")]],
      ["feat/old", [at(pull(5, "feat/old", "merged", "not-local"), "2026-11-05T00:00:00Z")]],
      ["feat/older", [at(pull(7, "feat/older", "open"), "2026-10-01T00:00:00Z")]],
      ["feat/gone", [at(pull(6, "feat/gone", "closed"), "2026-11-04T00:00:00Z")]],
      ["feat/gone2", [at(pull(8, "feat/gone2", "merged"), "2026-11-02T00:00:00Z")]],
      ["main", [pull(1, "main", "open")]],
    ]),
  };
  const pullsFor = vi.fn(async (repo: string) => (repo === "/src/app" ? APP : { byBranch: new Map() }));
  const gone = (dir: string) => !dir.startsWith("/src/app.gone") && !dir.startsWith("/src/other.gone");
  const rowOf = (repos: Awaited<ReturnType<typeof buildGitOverview>>["repos"], cwd: string) => repos.flatMap((r) => r.rows).find((row) => row.cwd === cwd);

  it("badges a live row with the PRs of its chats' earlier branches: current first, then open, then most recent", async () => {
    const trails = [
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/old") },
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/older") },
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/x") },
    ];
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, trails: () => trails }));
    const row = rowOf(repos, "/src/app.feat-x")!;
    expect(row.pr?.number).toBe(12);
    // #5 is merged with a head that is not the local tip: no SHA check for trail branches.
    expect(row.prs?.map((p) => p.number)).toEqual([12, 7, 5]);
    expect(repos[0].rows).toHaveLength(1);
  });

  it("lists a PR once per row however many chats recorded its branch", async () => {
    const trails = [
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/old") },
      { cardId: "c2", entry: entry("/src/app.feat-x", "feat/old") },
    ];
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1", "c2"] }, { pullsFor, trails: () => trails }));
    expect(rowOf(repos, "/src/app.feat-x")!.prs?.map((p) => p.number)).toEqual([12, 5]);
  });

  it("skips the default branch, and adds no prs when the trail adds nothing", async () => {
    const { repos } = await buildGitOverview(
      {},
      deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, trails: () => [{ cardId: "c1", entry: entry("/src/app.feat-x", "main") }] }),
    );
    expect(rowOf(repos, "/src/app.feat-x")).toEqual({
      cwd: "/src/app.feat-x",
      branch: "feat/x",
      isMain: false,
      pr: expect.objectContaining({ number: 12 }),
      cardIds: ["c1"],
    });
  });

  it("only takes trail entries from the row's own cards", async () => {
    const trails = [{ cardId: "elsewhere", entry: entry("/src/app.feat-x", "feat/old") }];
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, trails: () => trails }));
    expect(rowOf(repos, "/src/app.feat-x")!.prs).toBeUndefined();
  });

  it("gives a removed worktree one row with every PR it carried, marked removed", async () => {
    const trails = [
      { cardId: "c1", entry: entry("/src/app.gone", "feat/gone", "t1") },
      { cardId: "c2", entry: entry("/src/app.gone", "feat/gone2", "t2") },
      { cardId: "c1", entry: entry("/src/app.gone", "main", "t0") },
    ];
    const { repos } = await buildGitOverview({}, deps({ "/src/app": ["c3"] }, { pullsFor, trails: () => trails, exists: gone }));
    expect(repos[0].rows.map((r) => r.cwd)).toEqual(["/src/app", "/src/app.gone"]);
    expect(rowOf(repos, "/src/app.gone")).toEqual({
      cwd: "/src/app.gone",
      branch: "feat/gone2",
      isMain: false,
      removed: true,
      prs: [expect.objectContaining({ number: 6 }), expect.objectContaining({ number: 8 })],
      cardIds: ["c1", "c2"],
    });
  });

  it("shows no removed row without a PR, nor one whose repository is gone too", async () => {
    const trails = [
      { cardId: "c1", entry: entry("/src/app.gone", "main") },
      { cardId: "c1", entry: entry("/src/app.gone-nopr", "feat/none") },
      { cardId: "c1", entry: entry("/src/other.gone", "feat/gone", "t1", "/src/other.gone-repo") },
    ];
    const { repos } = await buildGitOverview({}, deps({ "/src/app": ["c3"] }, { pullsFor, trails: () => trails, exists: gone }));
    expect(repos.flatMap((r) => r.rows).filter((r) => r.removed)).toEqual([]);
  });

  it("lists a repository reachable only through a trail", async () => {
    const trails = [{ cardId: "c1", entry: entry("/src/app.gone", "feat/gone") }];
    const { repos } = await buildGitOverview({}, deps({ "/src/lib": ["c2"] }, { pullsFor, trails: () => trails, exists: gone }));
    expect(repos.map((r) => [r.name, r.rows.map((row) => [row.cwd, row.removed ?? false])])).toEqual([
      ["app", [["/src/app.gone", true]]],
      ["lib", [["/src/lib", false]]],
    ]);
  });

  it("gives a live row whose branch has moved past its merged PR that PR, through the trail", async () => {
    // feat/old is checked out at a commit that is not #5's head: the SHA rule alone finds nothing.
    const listWorktrees = async (dir: string) => (dir === "/src/app" ? [wt("/src/app", "main", true), wt("/src/app.feat-x", "feat/old", false, "later")] : []);
    const d = deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, listWorktrees, trails: () => [{ cardId: "c1", entry: entry("/src/app.feat-x", "feat/old") }] });
    const row = rowOf((await buildGitOverview({}, d)).repos, "/src/app.feat-x")!;
    expect(row.pr?.number).toBe(5);
    expect(row.prs).toBeUndefined();
  });

  describe("PR links from the chats' own histories", () => {
    const link = (number: number) => ({ repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, firstSeen: "t0" });
    const linkedPulls = vi.fn(async (links: ReturnType<typeof link>[], _known?: unknown, _force?: boolean) => ({
      pulls: links.map((l) => (l.number === 99 ? undefined : pull(l.number, `b${l.number}`, "merged"))),
    }));

    it("badges the row a chat's folder is in with the PRs its history names, and a removed worktree's row too", async () => {
      const d = deps(
        { "/src/app": ["c1"], "/src/app.gone1": ["c2"] },
        {
          pullsFor,
          exists: gone,
          linkedPulls,
          trails: () => [{ cardId: "c2", entry: entry("/src/app.gone1", "feat/none") }],
          links: () => [
            { cardId: "c1", folder: "/src/app", link: link(20) },
            { cardId: "c1", folder: "/src/app", link: link(21) },
            { cardId: "c1", folder: "/src/app", link: link(99) }, // GitHub has no such PR
            { cardId: "c2", folder: "/src/app.gone1", link: link(22) },
            { cardId: "c3", folder: "/src/nowhere", link: link(23) }, // no row to put it on
          ],
        },
      );
      const { repos } = await buildGitOverview({ force: true }, d);
      // The main checkout: the fixture's live PR first, then the two its chat made.
      const main = rowOf(repos, "/src/app")!;
      expect(main.prs?.map((p) => p.number)).toEqual([1, 20, 21]);
      expect(rowOf(repos, "/src/app.gone1")).toMatchObject({ removed: true, prs: [expect.objectContaining({ number: 22 })], cardIds: ["c2"] });
      expect(linkedPulls.mock.calls[0][0].map((l: { number: number }) => l.number)).toEqual([20, 21, 99, 22]);
      expect(linkedPulls.mock.calls[0][2]).toBe(true);
    });

    /** Resolves each link to the PR the table has for its number. */
    const resolving = (table: Record<number, PullSummary>, error?: string) => async (links: ReturnType<typeof link>[]) => ({
      pulls: links.map((l) => table[l.number]),
      ...(error && { error, errors: { "acme/app": error } }),
    });
    /** `app` with nothing listed on any branch: only what the chats recorded can give a row a PR. */
    const BARE: RepoPulls = { github: { owner: "acme", repo: "app" }, defaultBranch: "main", byBranch: new Map() };
    const bare = async (repo: string) => (repo === "/src/app" ? BARE : { byBranch: new Map() });
    const linksIn = (folder: string, cardId: string, ...numbers: number[]) => numbers.map((n) => ({ cardId, folder, link: link(n) }));

    it("never makes a fork's PR, or one headed by the default branch, the row's own — it stays a badge", async () => {
      const table = {
        70: { ...pull(70, "main", "open"), headOwner: "stranger" }, // stranger:main, against this repository
        71: { ...pull(71, "feat/x", "merged"), headOwner: "stranger" }, // stranger:feat/x
        72: pull(72, "main", "merged"), // this owner's default branch as a head
      };
      const d = deps(
        { "/src/app": ["c1"], "/src/app.feat-x": ["c2"] },
        { pullsFor: bare, linkedPulls: resolving(table), links: () => [...linksIn("/src/app", "c1", 70, 72), ...linksIn("/src/app.feat-x", "c2", 71)] },
      );
      const { repos } = await buildGitOverview({}, d);
      expect(rowOf(repos, "/src/app")).toMatchObject({
        branch: "main",
        prs: [expect.objectContaining({ number: 70 }), expect.objectContaining({ number: 72 })],
      });
      expect(rowOf(repos, "/src/app")!.pr).toBeUndefined();
      expect(rowOf(repos, "/src/app.feat-x")).toMatchObject({ branch: "feat/x", prs: [expect.objectContaining({ number: 71 })] });
      expect(rowOf(repos, "/src/app.feat-x")!.pr).toBeUndefined();
    });

    it("picks, of two linked PRs on the row's branch, the most recently updated — as the PRs tab does", async () => {
      const table = { 5: at(pull(5, "feat/x", "merged", "old5"), "2026-01-10T00:00:00Z"), 9: at(pull(9, "feat/x", "merged", "old9"), "2026-09-10T00:00:00Z") };
      const d = deps({ "/src/app.feat-x": ["c1"] }, { pullsFor: bare, linkedPulls: resolving(table), links: () => linksIn("/src/app.feat-x", "c1", 5, 9) });
      const row = rowOf((await buildGitOverview({}, d)).repos, "/src/app.feat-x")!;
      expect(row.pr?.number).toBe(9);
      expect(row.prs?.map((p) => p.number)).toEqual([9, 5]);
    });

    it("does not badge a row with a PR of another repository, known or unknown", async () => {
      const other = { repo: "other/lib", number: 12, url: "https://github.com/other/lib/pull/12", firstSeen: "t0" };
      const unseen = { repo: "other/lib", number: 13, url: "https://github.com/other/lib/pull/13", firstSeen: "t0" };
      const linkedPulls = async (links: Array<{ number: number; url: string }>) => ({
        pulls: links.map(
          (l): PullSummary => (l.number === 13 ? { ...pull(13, "", "unknown"), url: l.url } : { ...pull(l.number, "feat/x", "merged"), url: l.url }),
        ),
        error: "gh timed out",
      });
      const links = () => [
        ...linksIn("/src/app.feat-x", "c1", 20),
        { cardId: "c1", folder: "/src/app.feat-x", link: other },
        { cardId: "c1", folder: "/src/app.feat-x", link: unseen },
      ];
      const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, linkedPulls, links }));
      const row = rowOf(repos, "/src/app.feat-x")!;
      // The live #12 is this repository's; other/lib#12 and #13 are not on this row at all.
      expect(row.pr).toMatchObject({ number: 12, url: "https://github.com/acme/app/pull/12" });
      expect(row.prs?.map((p) => p.url)).toEqual(["https://github.com/acme/app/pull/12", "https://github.com/acme/app/pull/20"]);
      // …so the unknown one it does not show is no reason to flag this repository.
      expect(repos[0].prError).toBeUndefined();
    });

    it("shows a link whose lookup failed as an unknown PR, and says why on the repository that shows it", async () => {
      const unknown: PullSummary = { ...pull(30, "", "unknown"), title: "acme/app#30" };
      const d = deps(
        { "/src/app.feat-x": ["c1"], "/src/lib": ["c2"] },
        { pullsFor, linkedPulls: resolving({ 30: unknown }, "gh is not installed"), links: () => linksIn("/src/app.feat-x", "c1", 30) },
      );
      const { repos } = await buildGitOverview({}, d);
      expect(rowOf(repos, "/src/app.feat-x")!.prs).toEqual([
        expect.objectContaining({ number: 12 }),
        { number: 30, url: unknown.url, state: "unknown", title: "acme/app#30" },
      ]);
      expect(repos.map((r) => [r.name, r.prError, r.prErrorPartial])).toEqual([
        ["app", "gh is not installed", true],
        ["lib", undefined, undefined],
      ]);
    });

    it("quotes a repository's own lookup failure, never the first one of another repository", async () => {
      const lib = { repo: "other/lib", number: 4, url: "https://github.com/other/lib/pull/4", firstSeen: "t0" };
      const linkedPulls = async (links: Array<{ repo: string; number: number; url: string }>) => ({
        pulls: links.map((l): PullSummary => ({ ...pull(l.number, "", "unknown"), url: l.url })),
        error: "Could not resolve to a Repository 'other/lib'",
        errors: { "other/lib": "Could not resolve to a Repository 'other/lib'", "acme/app": "gh timed out" },
      });
      const links = () => [{ cardId: "c1", folder: "/src/app.feat-x", link: lib }, ...linksIn("/src/app.feat-x", "c1", 30)];
      const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, linkedPulls, links }));
      expect(rowOf(repos, "/src/app.feat-x")!.prs?.map((p) => p.number)).toEqual([12, 30]);
      expect(repos[0]).toMatchObject({ prError: "gh timed out", prErrorPartial: true });
      // A failed listing is the repository's error outright, and is not "partial".
      const failing = async () => ({ ...APP, error: "gh: rate limited" });
      const failed = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor: failing, linkedPulls, links }));
      expect(failed.repos[0].prError).toBe("gh: rate limited");
      expect(failed.repos[0].prErrorPartial).toBeUndefined();
    });

    it("keeps a row's linked PRs across a rename: the link names the row's repository though GitHub's URL no longer does", async () => {
      const renamed = (n: number, headRef: string): PullSummary => ({ ...pull(n, headRef, "merged"), url: `https://github.com/acme/renamed/pull/${n}` });
      const d = deps(
        { "/src/app.feat-x": ["c1"] },
        {
          pullsFor: bare,
          linkedPulls: resolving({ 40: renamed(40, "feat/x"), 41: renamed(41, "feat/earlier") }),
          links: () => linksIn("/src/app.feat-x", "c1", 40, 41),
        },
      );
      const row = rowOf((await buildGitOverview({}, d)).repos, "/src/app.feat-x")!;
      expect(row.pr).toMatchObject({ number: 40, url: "https://github.com/acme/renamed/pull/40" });
      expect(row.prs?.map((p) => p.number)).toEqual([40, 41]);
    });

    it("badges a PR once when a failed lookup spells its repository differently than GitHub does", async () => {
      const spelled = { repo: "Acme/App", number: 12, url: "https://github.com/Acme/App/pull/12", firstSeen: "t0" };
      const linkedPulls = async () => ({ pulls: [{ ...pull(12, "", "unknown"), url: spelled.url }], error: "gh timed out" });
      const d = deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, linkedPulls, links: () => [{ cardId: "c1", folder: "/src/app.feat-x", link: spelled }] });
      const row = rowOf((await buildGitOverview({}, d)).repos, "/src/app.feat-x")!;
      expect(row.pr?.number).toBe(12);
      expect(row.prs).toBeUndefined();
    });

    it("puts the card whose chat made a PR on the removed row that shows it", async () => {
      // c2's trail recorded the directory; c3's chat, in the same (gone) folder, made #22.
      const d = deps(
        { "/src/app": ["c1"], "/src/app.gone1": ["c2", "c3"] },
        {
          pullsFor,
          exists: gone,
          linkedPulls,
          trails: () => [{ cardId: "c2", entry: entry("/src/app.gone1", "feat/gone") }],
          links: () => [...linksIn("/src/app.gone1", "c3", 22), ...linksIn("/src/app.gone1", "c4", 99)],
        },
      );
      // c4's link resolves to nothing (#99 does not exist): it puts no PR on the row, so c4 is not on it.
      expect(rowOf((await buildGitOverview({}, d)).repos, "/src/app.gone1")).toMatchObject({ removed: true, branch: "feat/gone", cardIds: ["c2", "c3"] });
    });

    it("gives a removed folder no trail recorded a row in the one repository here its link names", async () => {
      const d = deps(
        { "/src/app": ["c1"], "/src/app.gone2": ["c2"] },
        { pullsFor, exists: gone, linkedPulls, links: () => linksIn("/src/app.gone2", "c2", 22) },
      );
      const { repos } = await buildGitOverview({}, d);
      expect(rowOf(repos, "/src/app.gone2")).toEqual({
        cwd: "/src/app.gone2",
        branch: null,
        isMain: false,
        removed: true,
        prs: [expect.objectContaining({ number: 22 })],
        cardIds: ["c2"],
      });
      expect(repos.map((r) => r.repoPath)).toEqual(["/src/app"]);
    });

    it("shows no row for such a folder when no repository here, or more than one, is the link's", async () => {
      const links = () => linksIn("/src/app.gone2", "c2", 22);
      // No repository of that name is in view…
      const elsewhere = await buildGitOverview({}, deps({ "/src/lib": ["c1"], "/src/app.gone2": ["c2"] }, { pullsFor, exists: gone, linkedPulls, links }));
      expect(elsewhere.repos.flatMap((r) => r.rows).map((r) => r.cwd)).toEqual(["/src/lib"]);
      // …or two checkouts of it are: which one the folder was a worktree of is not known.
      const twice = async (repo: string) => (repo === "/src/app" || repo === "/src/lib" ? APP : { byBranch: new Map() });
      const ambiguous = await buildGitOverview(
        {},
        deps({ "/src/app": ["c1"], "/src/lib": ["c3"], "/src/app.gone2": ["c2"] }, { pullsFor: twice, exists: gone, linkedPulls, links }),
      );
      expect(ambiguous.repos.flatMap((r) => r.rows).filter((r) => r.removed)).toEqual([]);
      // …or the folder's chats made PRs in two repositories, both here: one row in each would be a guess twice over.
      const libLink = {
        cardId: "c2",
        folder: "/src/app.gone2",
        link: { repo: "acme/lib", number: 3, url: "https://github.com/acme/lib/pull/3", firstSeen: "t0" },
      };
      const both = async (repo: string) => (repo === "/src/app" ? APP : { github: { owner: "acme", repo: "lib" }, byBranch: new Map() });
      const anyPull = async (asked: Array<{ number: number; url: string }>) => ({
        pulls: asked.map((l) => ({ ...pull(l.number, "b", "merged"), url: l.url })),
      });
      const folders = { "/src/app": ["c1"], "/src/lib": ["c3"], "/src/app.gone2": ["c2"] };
      const split = await buildGitOverview({}, deps(folders, { pullsFor: both, exists: gone, linkedPulls: anyPull, links: () => [...links(), libLink] }));
      expect(split.repos.flatMap((r) => r.rows).filter((r) => r.removed)).toEqual([]);
      // (With the one link alone, the same folder does get its row — in the repository that link names.)
      const single = await buildGitOverview({}, deps(folders, { pullsFor: both, exists: gone, linkedPulls: anyPull, links: () => [libLink] }));
      expect(single.repos.map((r) => [r.name, r.rows.filter((row) => row.removed).map((row) => row.cwd)])).toEqual([
        ["app", []],
        ["lib", ["/src/app.gone2"]],
      ]);
      // A folder that still exists but is in no worktree is not a removed one.
      const present = await buildGitOverview(
        {},
        deps({ "/src/app": ["c1"], "/src/elsewhere": ["c2"] }, { pullsFor, linkedPulls, links: () => linksIn("/src/elsewhere", "c2", 22) }),
      );
      expect(present.repos.flatMap((r) => r.rows).filter((r) => r.removed)).toEqual([]);
    });
  });

  it("is a strict superset: without trails the answer is today's, and a trail on another branch changes no live field", async () => {
    const folders = { "/src/app.feat-x": ["c1"], "/src/app": ["c2"], "/src/lib": ["c3"] };
    const strip = (r: Awaited<ReturnType<typeof buildGitOverview>>) => r.repos;
    const today = strip(await buildGitOverview({}, deps(folders, { pullsFor })));
    expect(strip(await buildGitOverview({}, deps(folders, { pullsFor, trails: () => [] })))).toEqual(today);

    const trails = [
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/old") },
      { cardId: "c2", entry: entry("/src/app.gone", "feat/gone") },
    ];
    const withTrail = strip(await buildGitOverview({}, deps(folders, { pullsFor, trails: () => trails, exists: gone })));
    for (const repo of today) {
      for (const row of repo.rows) {
        const { prs: _prs, ...live } = rowOf(withTrail, row.cwd)!;
        expect(live).toEqual(row);
      }
    }
  });
});

/**
 * The hole this closes: the listing holds only the 100 most recently updated
 * closed PRs, so a branch's PR merged before that was found only if a Claude
 * Code transcript happened to name it. Through the real resolveBranchPulls,
 * with GitHub's answer faked.
 */
describe("buildGitOverview — PRs older than the listing reaches, by head branch", () => {
  beforeEach(() => clearRepoPullsCache());
  const entry = (cwd: string, branch: string, firstSeen = "2026-02-01T00:00:00Z", repoPath = "/src/app") => ({
    cwd,
    repoPath,
    branch,
    firstSeen,
    lastSeen: firstSeen,
  });
  const old = (number: number, headRef: string, headSha: string): PullSummary => ({
    ...pull(number, headRef, "merged", headSha),
    updatedAt: "2026-03-01T00:00:00Z",
    closedAt: "2026-03-01T00:00:00Z",
    mergedAt: "2026-03-01T00:00:00Z",
  });
  /** The listing: only `feat/listed` has a PR in it. */
  const LISTED: RepoPulls = {
    github: { owner: "acme", repo: "app" },
    defaultBranch: "main",
    byBranch: new Map([["feat/listed", [pull(40, "feat/listed", "open")]]]),
    byNumber: new Map([[40, pull(40, "feat/listed", "open")]]),
  };
  const pullsFor = async (repo: string): Promise<RepoPulls> => (repo === "/src/app" ? LISTED : { byBranch: new Map() });
  const gone = (dir: string) => !dir.startsWith("/src/app.gone");
  const rowOf = (repos: Awaited<ReturnType<typeof buildGitOverview>>["repos"], cwd: string) => repos.flatMap((r) => r.rows).find((row) => row.cwd === cwd);
  /** `branchPulls` over what GitHub has for each head branch. */
  function byBranch(table: Record<string, PullSummary[]>) {
    const fetch = vi.fn(async (_ref: unknown, branches: string[]) => new Map<string, BranchAnswer>(branches.map((b) => [b, table[b] ?? []])));
    const branchPulls = vi.fn((repoPath: string, pulls: RepoPulls, branches: BranchAsk, force: boolean) =>
      resolveBranchPulls(pulls, branches, { cwd: repoPath, force }, { fetch, now: () => 0 }),
    );
    return { fetch, branchPulls };
  }

  it("gives a live row its branch's old merged PR — by the SHA rule, so only at that commit", async () => {
    // `feat/x` is checked out at x1; `old` at o1.
    const { fetch, branchPulls } = byBranch({ "feat/x": [old(3, "feat/x", "x1")], old: [old(4, "old", "an-earlier-tip")] });
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"], "/src/app.old": ["c2"], "/src/app": ["c3"] }, { pullsFor, branchPulls }));
    expect(rowOf(repos, "/src/app.feat-x")).toMatchObject({ pr: { number: 3, state: "merged" } });
    // A reused name: the PR's head is not what is checked out, and no chat recorded it.
    expect(rowOf(repos, "/src/app.old")).toEqual({ cwd: "/src/app.old", branch: "old", isMain: false, cardIds: ["c2"] });
    expect(repos[0].prError).toBeUndefined();
    // One call for the repository; the default branch is never asked about.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...fetch.mock.calls[0][1]].sort()).toEqual(["feat/x", "old"]);
  });

  it("badges a live row and a removed one with their trails' old PRs — by the time rule", async () => {
    const { fetch, branchPulls } = byBranch({
      "feat/earlier": [old(5, "feat/earlier", "e1")],
      // Closed before the chat ever saw the branch: someone else's use of the name.
      "feat/reused": [{ ...old(6, "feat/reused", "r1"), closedAt: "2026-01-01T00:00:00Z" }],
      "feat/gone": [old(7, "feat/gone", "g1")],
      // A fork's PR that carries the branch's name is not this repository's branch's.
      "feat/forked": [{ ...old(8, "feat/forked", "f1"), headOwner: "someone-else" }],
    });
    const trails = [
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/earlier") },
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/reused") },
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/forked") },
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/listed") },
      { cardId: "c1", entry: entry("/src/app.feat-x", "main") },
      { cardId: "c2", entry: entry("/src/app.gone", "feat/gone") },
    ];
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, branchPulls, trails: () => trails, exists: gone }));
    expect(rowOf(repos, "/src/app.feat-x")!.prs?.map((p) => p.number)).toEqual([40, 5]);
    expect(rowOf(repos, "/src/app.gone")).toMatchObject({ removed: true, prs: [{ number: 7, state: "merged" }], cardIds: ["c2"] });
    // Asked about: what the listing has no PR for — not `feat/listed`, not `main`.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...fetch.mock.calls[0][1]].sort()).toEqual(["feat/earlier", "feat/forked", "feat/gone", "feat/reused", "feat/x"]);
  });

  it("asks only about branches of rows that are shown, and passes the refresh flag", async () => {
    const { branchPulls } = byBranch({});
    const trails = [{ cardId: "elsewhere", entry: entry("/src/app.feat-x", "feat/not-this-cards") }];
    await buildGitOverview({ force: true }, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, branchPulls, trails: () => trails }));
    expect(branchPulls.mock.calls.map(([repoPath, , branches, force]) => [repoPath, branches, force])).toEqual([
      ["/src/app", { live: ["feat/x"], trail: [] }, true],
    ]);
  });

  it("says so, as a partial failure, when the branches could not be asked about — and keeps the listing's PRs", async () => {
    const branchPulls = async (_repoPath: string, pulls: RepoPulls) => ({ ...pulls, branchError: "gh: HTTP 502" });
    const trails = [{ cardId: "c1", entry: entry("/src/app.feat-x", "feat/listed") }];
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, branchPulls, trails: () => trails }));
    expect(repos[0]).toMatchObject({ prError: "gh: HTTP 502", prErrorPartial: true });
    expect(rowOf(repos, "/src/app.feat-x")!.prs?.map((p) => p.number)).toEqual([40]);
    // A failed listing is still the repository's error outright.
    const failing = async () => ({ ...LISTED, error: "gh: rate limited" });
    const failed = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor: failing, branchPulls, trails: () => trails }));
    expect(failed.repos[0].prError).toBe("gh: rate limited");
    expect(failed.repos[0].prErrorPartial).toBeUndefined();
  });

  it("tells live rows' branches from trail branches when it asks", async () => {
    const { branchPulls } = byBranch({});
    const trails = [
      { cardId: "c1", entry: entry("/src/app.feat-x", "feat/earlier") },
      { cardId: "c2", entry: entry("/src/app.gone", "feat/gone") },
    ];
    await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"], "/src/app.old": ["c3"] }, { pullsFor, branchPulls, trails: () => trails, exists: gone }));
    expect(branchPulls.mock.calls.map(([, , branches]) => branches)).toEqual([{ live: ["feat/x", "old"], trail: ["feat/earlier", "feat/gone"] }]);
  });

  /**
   * What the repository's marker says has to match what its rows show:
   * "PR data unavailable" only when there is none; "may be incomplete or out
   * of date" whenever PRs are shown beside a failure.
   */
  it("words the failure by what is shown: partial whenever PR data is held, unavailable only when none is", async () => {
    const trails = [{ cardId: "c1", entry: entry("/src/app.feat-x", "feat/listed") }];
    const marker = async (pulls: RepoPulls, branchPulls?: OverviewDeps["branchPulls"]) => {
      const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor: async () => pulls, branchPulls, trails: () => trails }));
      return [repos[0].prError, repos[0].prErrorPartial, rowOf(repos, "/src/app.feat-x")!.prs?.map((p) => p.number)];
    };
    // Nothing held: the first lookup's open listing failed.
    expect(await marker({ github: LISTED.github, defaultBranch: "main", byBranch: new Map(), byNumber: new Map(), error: "gh: HTTP 502" })).toEqual([
      "gh: HTTP 502",
      undefined,
      undefined,
    ]);
    // Open PRs without the closed listing, or an earlier entry kept through a failed refresh.
    expect(await marker({ ...LISTED, error: "gh: HTTP 502", errorPartial: true })).toEqual(["gh: HTTP 502", true, [40]]);
    // A whole listing beside a by-branch lookup that failed.
    expect(await marker(LISTED, async (_repoPath, pulls) => ({ ...pulls, branchError: "GraphQL refused" }))).toEqual(["GraphQL refused", true, [40]]);
    // No failure, no marker.
    expect(await marker(LISTED)).toEqual([undefined, undefined, [40]]);
  });

  it("is the overview without it when the lookup throws", async () => {
    const branchPulls = async (): Promise<RepoPulls> => {
      throw new Error("boom");
    };
    const { repos } = await buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, branchPulls }));
    expect(repos[0].rows).toEqual([{ cwd: "/src/app.feat-x", branch: "feat/x", isMain: false, cardIds: ["c1"] }]);
  });

  it("does not hold the linked PRs up: both lookups are in flight together", async () => {
    let releaseBranches!: () => void;
    const branchPulls = vi.fn(
      (_repoPath: string, pulls: RepoPulls) => new Promise<RepoPulls>((resolvePromise) => (releaseBranches = () => resolvePromise(pulls))),
    );
    const linkedPulls = vi.fn(async (links: Array<{ number: number }>) => ({ pulls: links.map((l) => pull(l.number, `b${l.number}`, "merged")) }));
    const links = () => [
      { cardId: "c1", folder: "/src/app.feat-x", link: { repo: "acme/app", number: 30, url: "https://github.com/acme/app/pull/30", firstSeen: "t0" } },
    ];
    const building = buildGitOverview({}, deps({ "/src/app.feat-x": ["c1"] }, { pullsFor, branchPulls, linkedPulls, links }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(branchPulls).toHaveBeenCalledTimes(1);
    expect(linkedPulls).toHaveBeenCalledTimes(1);
    releaseBranches();
    expect(rowOf((await building).repos, "/src/app.feat-x")!.prs?.map((p) => p.number)).toEqual([30]);
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
