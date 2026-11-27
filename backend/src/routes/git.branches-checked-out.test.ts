/**
 * `GET /api/git/branches` — the `checkedOut` sibling added so the branch picker
 * can say "that one lives in another directory".
 *
 * Two things here are worth pinning. The first is that `checkedOut` reports the
 * *main* checkout too: a chat started inside `repo.feat-a` that picks `main`
 * gets redirected into the main worktree, exactly as symmetrically as the other
 * direction, and a listing that only reported the linked worktrees would leave
 * the UI silent for half the cases.
 *
 * The second is detached HEAD. `WorktreeInfo.branch` is `string | null`, and the
 * route drops the nulls rather than passing them through — a null branch matches
 * no branch name, so it is an entry no caller can ever use, and shipping it just
 * moves the filter into every consumer.
 *
 * Same no-supertest style as workspaces.unmanaged.test.ts: the handler comes off
 * the router stack and is driven with a fake req/res against a real repo.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

/** Synchronous git spawns made by the code under test — the handler must make none. */
let syncSpawns = 0;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      syncSpawns++;
      return actual.execFileSync(...args);
    },
  };
});

const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const { gitRouter } = await import("./git.js");
const { getGitWorktrees } = await import("../utils/git.js");

const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-branches-")));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
/** An empty commit on the checked-out branch at a fixed committer date. */
function commitAt(date: string, cwd: string): void {
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", date], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
}

commitAt("2020-01-01T00:00:00Z", repoDir);
git(["branch", "feat/idle"], repoDir);

const linkedDir = join(gitRoot, "repo.feat-a");
git(["worktree", "add", "-q", "-b", "feat/a", linkedDir, "main"], repoDir);

const detachedDir = join(gitRoot, "repo.detached");
git(["worktree", "add", "-q", "--detach", detachedDir, "main"], repoDir);

// Dates that run against the alphabet: `feat/a` is the newest, `feat/idle` and
// `main` share the oldest commit, and `aaa/stale` sits between.
git(["checkout", "-q", "-b", "aaa/stale"], repoDir);
commitAt("2021-01-01T00:00:00Z", repoDir);
git(["checkout", "-q", "main"], repoDir);
commitAt("2024-01-01T00:00:00Z", linkedDir);

const subDir = join(repoDir, "packages", "inner");
mkdirSync(subDir, { recursive: true });

afterAll(() => rmSync(gitRoot, { recursive: true, force: true }));

interface CheckedOut {
  branch: string | null;
  path: string;
  isMainWorktree: boolean;
}
interface BranchesBody {
  branches: string[];
  checkedOut: CheckedOut[];
}

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response) => void }[] } };

const branchesHandler = (gitRouter as unknown as { stack: Layer[] }).stack.find((layer) => layer.route?.path === "/branches" && layer.route.methods.get)!
  .route!.stack[0].handle;

function listBranches(folder: string): Promise<{ code: number; body: BranchesBody }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: BranchesBody) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    branchesHandler({ params: {}, body: {}, query: { folder } } as unknown as Request, res as unknown as Response);
  });
}

describe("GET /api/git/branches", () => {
  it("still returns the branch names it always did", async () => {
    const res = await listBranches(repoDir);
    expect(res.code).toBe(200);
    expect(res.body.branches).toEqual(expect.arrayContaining(["main", "feat/a", "feat/idle"]));
  });

  it("reports where each occupied branch is checked out, including the main worktree", async () => {
    const res = await listBranches(repoDir);
    const byBranch = new Map(res.body.checkedOut.map((c) => [c.branch, c]));

    expect(byBranch.get("main")).toEqual({ branch: "main", path: repoDir, isMainWorktree: true });
    expect(byBranch.get("feat/a")).toEqual({ branch: "feat/a", path: linkedDir, isMainWorktree: false });
  });

  /**
   * The distinction the whole field exists to draw: `feat/idle` is a real branch
   * with no worktree, so selecting it switches this checkout. Listing it here
   * would make the UI claim a redirect that will not happen.
   */
  it("omits a branch that exists but is checked out nowhere", async () => {
    const res = await listBranches(repoDir);
    expect(res.body.checkedOut.some((c) => c.branch === "feat/idle")).toBe(false);
  });

  it("omits the detached-HEAD worktree rather than emitting a null branch", async () => {
    const res = await listBranches(repoDir);
    expect(res.body.checkedOut.some((c) => c.branch === null)).toBe(false);
    expect(res.body.checkedOut.some((c) => c.path === detachedDir)).toBe(false);
  });

  /**
   * Asked from inside the linked worktree, the answer is the same list — the
   * data is a property of the repository, not of the directory you asked from.
   * This is what lets the picker describe the `repo.feat-a` → `main` redirect.
   */
  it("answers identically when asked from a linked worktree", async () => {
    const fromLinked = await listBranches(linkedDir);
    const fromMain = await listBranches(repoDir);
    const key = (c: CheckedOut) => `${c.branch} ${c.path} ${c.isMainWorktree}`;
    expect(new Set(fromLinked.body.checkedOut.map(key))).toEqual(new Set(fromMain.body.checkedOut.map(key)));
  });

  /**
   * The order is part of the answer: the picker shows `branches` as it comes.
   * Current first, then by last commit — `feat/a` (2024) ahead of `aaa/stale`
   * (2021), which alphabetical order would have led with — and the two that
   * share the 2020 commit by name.
   */
  it("lists the current branch first and the rest most recently committed first", async () => {
    expect((await listBranches(repoDir)).body.branches).toEqual(["main", "feat/a", "aaa/stale", "feat/idle"]);
    // From the linked worktree the same repository leads with *its* branch.
    expect((await listBranches(linkedDir)).body.branches).toEqual(["feat/a", "aaa/stale", "feat/idle", "main"]);
    // No branch leads from a detached HEAD, and the detachment is not listed as one.
    expect((await listBranches(detachedDir)).body.branches).toEqual(["feat/a", "aaa/stale", "feat/idle", "main"]);
  });

  it("answers from a subdirectory of the repository as it does from its root", async () => {
    expect((await listBranches(subDir)).body).toEqual((await listBranches(repoDir)).body);
  });

  /**
   * `checkedOut` is `git worktree list`, entry for entry and in its order —
   * paths as git spells them, the main worktree flagged — whichever directory
   * asks. The synchronous lister is the reference the route used to call.
   */
  it("reports exactly what git worktree list does, without a synchronous spawn", async () => {
    for (const dir of [repoDir, linkedDir, detachedDir, subDir]) {
      const expected = getGitWorktrees(dir)
        .filter((wt) => wt.branch !== null)
        .map((wt) => ({ branch: wt.branch, path: wt.path, isMainWorktree: wt.isMainWorktree }));
      expect(expected.length).toBe(2);

      syncSpawns = 0;
      const res = await listBranches(dir);
      expect(syncSpawns).toBe(0);
      expect(res.body.checkedOut).toEqual(expected);
    }
  });

  it("answers with empty lists for a directory that is not a repository", async () => {
    const plain = join(gitRoot, "plain");
    mkdirSync(plain);
    expect(await listBranches(plain)).toEqual({ code: 200, body: { branches: [], checkedOut: [] } });
  });
});
