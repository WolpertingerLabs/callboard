/**
 * The listing is cheap, the verdict is asked for, and the archive trusts
 * neither of them.
 *
 * `GET /api/workspaces` used to attach a removability verdict to every record.
 * A verdict is roughly five sequential git subprocesses and all of them are
 * synchronous, so at 65 active records the route took 1.6s — and a trivial
 * `GET /api/auth/status` fired 150ms into it took 1.53s, because express has one
 * thread and it was gone. These tests pin the shape of the fix:
 *
 *  1. The default listing carries no verdict at all.
 *  2. `includeRemovability=true` still produces one, for the caller that wants
 *     every verdict and knows what it costs.
 *  3. `GET /:id/removability` produces one for a single record.
 *  4. **The archive does not read any of it.** The verdict is a UI affordance;
 *     the gate is re-evaluated server-side from the record on every archive, and
 *     a body claiming a verdict changes nothing in either direction. That is the
 *     safety property the whole feature rests on, and the one thing making the
 *     verdict optional could plausibly have broken.
 *
 * Handlers are pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in workspaces.create-rename.test.ts. Real git,
 * real worktrees: a mocked git would agree with whatever the implementation
 * believed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspaces-removability-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, stopSessionAndWait: async () => "not-running" }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { get: () => null, getAll: () => ({}), has: () => false, notifyMetadata: () => {} } }));

const { workspacesRouter } = await import("./workspaces.js");
const { getWorkspace, recordWorktreeWorkspace } = await import("../services/workspace-store.js");

const workspacesDir = join(tmpRoot, "workspaces");
const trashDir = join(tmpRoot, "trash");

// Canonical, like the service tests: git reports real paths, and a fixture
// built on a symlinked spelling reads as a *different* worktree to the gate.
const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-workspaces-removability-git-")));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/** A worktree Callboard created, with the identity token that proves it. */
function ownedWorktree(branch: string) {
  const cwd = join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
  git(["worktree", "add", "-q", "-b", branch, cwd, "main"], repoDir);
  const workspace = recordWorktreeWorkspace({ cwd, repoPath: repoDir, created: true, mode: "branch-off", branch, baseBranch: "main" });
  return { workspace, cwd };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
  if (existsSync(trashDir)) for (const file of readdirSync(trashDir)) rmSync(join(trashDir, file), { force: true, recursive: true });
});

function handlerFor(path: string, method: "get" | "post") {
  return (workspacesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;
}

const listHandler = handlerFor("/", "get");
const removabilityHandler = handlerFor("/:id/removability", "get");
const archiveHandler = handlerFor("/:id/archive", "post");

function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ code: number; body: any }> {
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
    handler({ params: {}, body: {}, query: {}, ...req } as unknown as Request, res as unknown as Response);
  });
}

const list = (query: Record<string, string> = {}) => invoke(listHandler, { query: query as any });
const removability = (id: string) => invoke(removabilityHandler, { params: { id } as any });
const archive = (id: string, body: unknown = {}) => invoke(archiveHandler, { params: { id } as any, body: body as any });

describe("GET /api/workspaces", () => {
  it("carries no removal verdict by default", async () => {
    const { cwd } = ownedWorktree("route/default");

    const res = await list({ status: "active" });
    expect(res.code).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    const [entry] = res.body.workspaces;
    // Everything a row needs is still here...
    expect(entry.directory.state).toBe("present");
    expect(entry.chatCount).toBe(0);
    // ...and the expensive part is not.
    expect(entry.removability).toBeUndefined();

    git(["worktree", "remove", cwd], repoDir);
  });

  it("attaches one to every entry when a caller asks for it", async () => {
    const { cwd } = ownedWorktree("route/opted-in");

    const res = await list({ status: "active", includeRemovability: "true" });
    expect(res.body.workspaces[0].removability.removable).toBe(true);

    git(["worktree", "remove", cwd], repoDir);
  });

  /**
   * The string "true" and nothing else, matching `includeDiskUsage`. A caller
   * that sends `?includeRemovability=1` gets the cheap listing rather than the
   * expensive one, which is the right direction for a typo to fail in.
   */
  it("treats anything but the string true as off", async () => {
    const { cwd } = ownedWorktree("route/typo");

    for (const value of ["1", "yes", "false", ""]) {
      const res = await list({ status: "active", includeRemovability: value });
      expect(res.body.workspaces[0].removability).toBeUndefined();
    }

    git(["worktree", "remove", cwd], repoDir);
  });
});

describe("GET /api/workspaces/:id/removability", () => {
  it("evaluates one workspace and explains its refusal", async () => {
    const { workspace, cwd } = ownedWorktree("route/one");
    writeFileSync(join(cwd, "wip.txt"), "in progress\n");

    const res = await removability(workspace.id);
    expect(res.code).toBe(200);
    expect(res.body.workspace.id).toBe(workspace.id);
    expect(res.body.workspace.removability.removable).toBe(false);
    expect(res.body.workspace.removability.blockers.map((b: any) => b.code)).toEqual(["untracked-files"]);
    // Inspection only — asking archives nothing and removes nothing.
    expect(getWorkspace(workspace.id)!.status).toBe("active");
    expect(existsSync(cwd)).toBe(true);

    rmSync(join(cwd, "wip.txt"));
    git(["worktree", "remove", cwd], repoDir);
  });

  it("404s an id that names no record", async () => {
    const res = await removability("ws-nope");
    expect(res.code).toBe(404);
  });
});

/**
 * The verdict is an affordance. These two are the same test run in both
 * directions, because a gate that reads its caller's opinion is broken whichever
 * way the opinion points.
 */
describe("POST /api/workspaces/:id/archive", () => {
  it("refuses a dirty worktree however removable the caller claims it is", async () => {
    const { workspace, cwd } = ownedWorktree("route/lying-removable");
    writeFileSync(join(cwd, "wip.txt"), "unfinished work\n");

    const res = await archive(workspace.id, {
      removability: { removable: true, blockers: [] },
      force: true,
      skipGates: true,
    });

    expect(res.code).toBe(200);
    expect(res.body.worktree.removed).toBe(false);
    expect(res.body.worktree.disposition).toBe("kept");
    expect(res.body.worktree.blockers.map((b: any) => b.code)).toEqual(["untracked-files"]);
    // The work is exactly where it was.
    expect(existsSync(join(cwd, "wip.txt"))).toBe(true);
    expect(existsSync(trashDir) ? readdirSync(trashDir) : []).toEqual([]);

    rmSync(join(cwd, "wip.txt"));
    git(["worktree", "remove", cwd], repoDir);
  });

  it("quarantines a clean worktree however blocked the caller claims it is", async () => {
    const { workspace, cwd } = ownedWorktree("route/lying-blocked");

    const res = await archive(workspace.id, {
      removability: { removable: false, blockers: [{ code: "uncommitted-changes", detail: "invented" }] },
    });

    expect(res.body.worktree.disposition).toBe("quarantined");
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(trashDir)).toHaveLength(1);

    git(["worktree", "prune"], repoDir);
  });
});
