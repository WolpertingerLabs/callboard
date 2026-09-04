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
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

import { gitRouter } from "./git.js";

const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-branches-")));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);
git(["branch", "feat/idle"], repoDir);

const linkedDir = join(gitRoot, "repo.feat-a");
git(["worktree", "add", "-q", "-b", "feat/a", linkedDir, "main"], repoDir);

const detachedDir = join(gitRoot, "repo.detached");
git(["worktree", "add", "-q", "--detach", detachedDir, "main"], repoDir);

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
});
