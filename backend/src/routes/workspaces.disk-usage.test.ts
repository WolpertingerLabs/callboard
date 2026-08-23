/**
 * `GET /api/workspaces?includeDiskUsage=true` — that the sizes actually arrive.
 *
 * The route measures through an async budget, which is the whole point of it
 * not freezing the daemon: the rows are built synchronously and come back
 * holding a `WorktreeDiskUsage` the budget has **not filled in yet**, and one
 * `await budget.settle()` fills them from a bounded pool.
 *
 * That design has exactly one obligation, and it is invisible in the type
 * system: forget the `await` and every row still has a `diskUsage` object, so
 * anything that checks for presence keeps passing while the response ships
 * "not measured — the listing did not settle its disk-usage budget" to every
 * entry. This file exists to make that failure loud, so the assertions here are
 * deliberately on `.bytes` rather than on the field being there at all.
 *
 * Same no-supertest style as workspaces.removability.test.ts: the handler is
 * pulled off the router stack and driven with a fake req/res, against real git
 * worktrees.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspaces-disk-usage-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, stopSessionAndWait: async () => "not-running" }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { get: () => null, getAll: () => ({}), has: () => false, notifyMetadata: () => {} } }));

const { workspacesRouter } = await import("./workspaces.js");
const { recordWorktreeWorkspace } = await import("../services/workspace-store.js");
const { clearDiskUsageCache } = await import("../utils/disk-usage.js");

const workspacesDir = join(tmpRoot, "workspaces");
const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-workspaces-disk-usage-git-")));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/** A worktree with something in it, so `du` has a non-zero total to report. */
function worktreeWithContent(branch: string) {
  const cwd = join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
  git(["worktree", "add", "-q", "-b", branch, cwd, "main"], repoDir);
  writeFileSync(join(cwd, "payload.bin"), "x".repeat(64 * 1024));
  return { workspace: recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch, baseBranch: "main" }), cwd };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
  clearDiskUsageCache();
});

const listHandler = (workspacesRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function list(query: Record<string, string>): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    listHandler({ params: {}, body: {}, query } as unknown as Request, res as unknown as Response);
  });
}

describe("GET /api/workspaces?includeDiskUsage=true", () => {
  it("returns a measured size, not the placeholder the budget hands out", async () => {
    const a = worktreeWithContent("du/one");
    const b = worktreeWithContent("du/two");

    const res = await list({ status: "active", includeRemovability: "false", includeDiskUsage: "true" });
    expect(res.code).toBe(200);
    expect(res.body.workspaces).toHaveLength(2);

    for (const entry of res.body.workspaces) {
      // The assertion that the `await` is load-bearing: a settled measurement
      // has a number and no error. An unsettled one has neither.
      expect(entry.diskUsage.bytes).toBeGreaterThan(0);
      expect(entry.diskUsage.error).toBeUndefined();
    }
    // Nothing was skipped, so the listing carries no note.
    expect(res.body.diskUsageNote).toBeUndefined();

    git(["worktree", "remove", "--force", a.cwd], repoDir);
    git(["worktree", "remove", "--force", b.cwd], repoDir);
  });

  it("leaves diskUsage off entirely when it was not asked for", async () => {
    const { cwd } = worktreeWithContent("du/absent");

    const res = await list({ status: "active", includeRemovability: "false" });
    // Absence *is* the opt-in — not an empty object, not a zero.
    expect(res.body.workspaces[0].diskUsage).toBeUndefined();

    git(["worktree", "remove", "--force", cwd], repoDir);
  });

  it("does not measure a record whose directory is gone, and says nothing was skipped", async () => {
    const { cwd } = worktreeWithContent("du/vanished");
    git(["worktree", "remove", "--force", cwd], repoDir);

    const res = await list({ status: "active", includeRemovability: "false", includeDiskUsage: "true" });
    const [entry] = res.body.workspaces;
    expect(entry.directory.state).toBe("missing");
    // A missing directory is reported by `directory.state`; attaching a `du`
    // failure on top would read as a measurement that went wrong.
    expect(entry.diskUsage).toBeUndefined();
    expect(res.body.diskUsageNote).toBeUndefined();
  });
});
