/**
 * The directory → workspace projection.
 *
 * The fallback path is a claim about the filesystem, so the tests that
 * exercise it use real git worktrees rather than invented paths — same
 * approach as workspace-store.test.ts, and for the same reason: the whole
 * point of the record is that it should agree with what is on disk, and a
 * fake directory cannot demonstrate that.
 *
 * DATA_DIR is resolved when utils/paths.js first loads, so CALLBOARD_DATA_DIR
 * is set before the store is imported.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-views-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { createWorkspace, archiveWorkspace } = await import("./workspace-store.js");
const { buildWorkspaceIndex, viewForDirectory, recordSaysWorktree } = await import("./workspace-views.js");
const { evaluateWorktreeRemoval } = await import("./workspace-service.js");

const workspacesDir = join(tmpRoot, "workspaces");

const gitRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-views-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/** A real worktree of the fixture repo. */
function makeWorktree(branch: string): string {
  const path = join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
  git(["worktree", "add", "-q", "-b", branch, path, "main"], repoDir);
  return path;
}

const realWorktree = makeWorktree("feat/real");
const plainDir = join(gitRoot, "not-a-repo");
mkdirSync(plainDir, { recursive: true });

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
});

/** A record in memory — no store round-trip, for the index-shape tests. */
function record(over: Partial<Workspace> & Pick<Workspace, "id" | "cwd">): Workspace {
  return {
    name: over.cwd.split("/").pop()!,
    isolation: "local",
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
    ...over,
  } as Workspace;
}

describe("recordSaysWorktree", () => {
  it("believes a worktree record whose repoPath names a different directory", () => {
    const ws = record({
      id: "ws-a",
      cwd: "/repos/app.feat-x",
      repoPath: "/repos/app",
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "feat/x" },
    });
    expect(recordSaysWorktree(ws)).toBe(true);
  });

  /**
   * The live-data case this rule exists for. `ensureWorktreeDetailed` hands
   * back the main checkout when the requested branch is already checked out
   * there, so `useWorktree: true` on `main` produces a record with
   * `isolation: "worktree"` for a directory whose `.git` is a directory.
   * There is one such record in the real registry today. Believing
   * `isolation` alone would badge the main repo as a worktree.
   */
  it("refuses a worktree record whose repoPath is its own cwd", () => {
    const ws = record({
      id: "ws-b",
      cwd: "/repos/app",
      repoPath: "/repos/app",
      isolation: "worktree",
      worktree: { owned: false, mode: "checkout-branch", branch: "main" },
    });
    expect(recordSaysWorktree(ws)).toBe(false);
  });

  it("refuses a worktree record with no repoPath at all", () => {
    const ws = record({
      id: "ws-c",
      cwd: "/repos/app.feat-y",
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "feat/y" },
    });
    expect(recordSaysWorktree(ws)).toBe(false);
  });

  it("refuses a local record", () => {
    expect(recordSaysWorktree(record({ id: "ws-d", cwd: "/repos/app", isolation: "local" }))).toBe(false);
  });
});

describe("viewForDirectory — record wins", () => {
  it("reads isWorktree and repoPath from the record, without touching the filesystem", () => {
    // The path does not exist. A record-backed answer must not need it to.
    const cwd = "/nowhere/app.feat-ghost";
    const index = buildWorkspaceIndex([
      record({
        id: "ws-ghost",
        cwd,
        repoPath: "/nowhere/app",
        isolation: "worktree",
        worktree: { owned: true, mode: "branch-off", branch: "feat/ghost" },
      }),
    ]);
    const view = viewForDirectory(cwd, index);
    expect(view).toMatchObject({ workspaceId: "ws-ghost", isWorktree: true, repoPath: "/nowhere/app", source: "record" });
    expect(view.workspaceCount).toBeUndefined();
  });

  it("does not badge the main checkout as a worktree just because a record says isolation:worktree", () => {
    const index = buildWorkspaceIndex([
      record({
        id: "ws-main",
        cwd: repoDir,
        repoPath: repoDir,
        isolation: "worktree",
        worktree: { owned: false, mode: "checkout-branch", branch: "main" },
      }),
    ]);
    const view = viewForDirectory(repoDir, index);
    expect(view).toMatchObject({ workspaceId: "ws-main", isWorktree: false, source: "record" });
    expect(view.repoPath).toBeUndefined();
  });

  it("gives the same answer for the local record the write path now produces there", () => {
    // The record above is the legacy shape, kept because existing records are
    // not migrated. A `useWorktree` chat whose branch is already checked out in
    // the main repo now records `isolation: "local"` instead — the projection
    // must land in exactly the same place, from the record rather than the
    // filesystem.
    const index = buildWorkspaceIndex([record({ id: "ws-main-local", cwd: repoDir, isolation: "local" })]);
    const view = viewForDirectory(repoDir, index);
    expect(view).toMatchObject({ workspaceId: "ws-main-local", isWorktree: false, source: "record" });
    expect(view.repoPath).toBeUndefined();
  });

  it("matches a record stored with a non-normalised cwd", () => {
    const index = buildWorkspaceIndex([
      record({
        id: "ws-dots",
        cwd: join(gitRoot, "repo", "..", "repo.feat-real"),
        repoPath: repoDir,
        isolation: "worktree",
        worktree: { owned: true, mode: "branch-off", branch: "feat/real" },
      }),
    ]);
    expect(viewForDirectory(realWorktree, index).workspaceId).toBe("ws-dots");
  });

  it("matches through a symlinked directory", () => {
    const link = join(gitRoot, "link-to-worktree");
    symlinkSync(realWorktree, link);
    const index = buildWorkspaceIndex([
      record({
        id: "ws-link",
        cwd: realWorktree,
        repoPath: repoDir,
        isolation: "worktree",
        worktree: { owned: true, mode: "branch-off", branch: "feat/real" },
      }),
    ]);
    expect(viewForDirectory(link, index).workspaceId).toBe("ws-link");
  });

  it("reports a count and no id when several active records share one directory", () => {
    const shared = {
      cwd: realWorktree,
      repoPath: repoDir,
      isolation: "worktree" as const,
      worktree: { owned: true, mode: "branch-off" as const, branch: "feat/real" },
    };
    const index = buildWorkspaceIndex([record({ id: "ws-1", ...shared }), record({ id: "ws-2", ...shared })]);
    const view = viewForDirectory(realWorktree, index);
    expect(view.workspaceId).toBeUndefined();
    expect(view.workspaceCount).toBe(2);
    // Identity is ambiguous; worktree-ness is not — they describe one directory.
    expect(view).toMatchObject({ isWorktree: true, repoPath: repoDir, source: "record" });
  });

  it("finds both records when one is stored under a symlink and the other under the real path", () => {
    const link = join(gitRoot, "link-mixed-storage");
    symlinkSync(realWorktree, link);
    const shared = {
      repoPath: repoDir,
      isolation: "worktree" as const,
      worktree: { owned: true, mode: "branch-off" as const, branch: "feat/real" },
    };
    const index = buildWorkspaceIndex([record({ id: "ws-via-link", cwd: link, ...shared }), record({ id: "ws-via-real", cwd: realWorktree, ...shared })]);
    // Either spelling of the directory must see both — reporting one id here
    // would claim an unambiguous workspace for a shared directory.
    for (const spelling of [link, realWorktree]) {
      const view = viewForDirectory(spelling, index);
      expect(view.workspaceCount, spelling).toBe(2);
      expect(view.workspaceId, spelling).toBeUndefined();
    }
  });

  it("counts a record reachable under both its resolved and its real path only once", () => {
    const link = join(gitRoot, "link-counted-once");
    symlinkSync(realWorktree, link);
    const index = buildWorkspaceIndex([
      record({
        id: "ws-once",
        cwd: link,
        repoPath: repoDir,
        isolation: "worktree",
        worktree: { owned: true, mode: "branch-off", branch: "feat/real" },
      }),
    ]);
    expect(viewForDirectory(link, index).workspaceId).toBe("ws-once");
    expect(viewForDirectory(link, index).workspaceCount).toBeUndefined();
  });
});

describe("viewForDirectory — no record", () => {
  it("falls back to the .git file for a real worktree", () => {
    const view = viewForDirectory(realWorktree, buildWorkspaceIndex([]));
    expect(view).toMatchObject({ isWorktree: true, repoPath: repoDir, source: "directory" });
    expect(view.workspaceId).toBeUndefined();
  });

  it("reports the main checkout as not a worktree", () => {
    expect(viewForDirectory(repoDir, buildWorkspaceIndex([]))).toMatchObject({ isWorktree: false, source: "directory" });
  });

  it("reports a plain non-git directory as not a worktree", () => {
    const view = viewForDirectory(plainDir, buildWorkspaceIndex([]));
    expect(view).toMatchObject({ isWorktree: false, source: "directory" });
    expect(view.repoPath).toBeUndefined();
  });

  it("does not throw on a directory that no longer exists", () => {
    expect(viewForDirectory("/nowhere/gone", buildWorkspaceIndex([]))).toMatchObject({ isWorktree: false, source: "directory" });
  });
});

/**
 * The boundary Phase 3 must not blur. A display read may answer from the
 * record; a read that decides whether a directory may be *destroyed* must
 * answer from the disk. This pins both halves against one directory whose
 * record and filesystem disagree.
 */
describe("display reads the record; the removal gate reads the disk", () => {
  it("keeps showing a recorded worktree that stopped being one, and still refuses to remove it", () => {
    const cwd = makeWorktree("feat/divergent");
    const ws = createWorkspace({
      cwd,
      repoPath: repoDir,
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "feat/divergent" },
    });

    // The directory stops being a worktree underneath the record.
    rmSync(join(cwd, ".git"), { force: true });

    // Display: the record answers, so the row keeps its identity.
    expect(viewForDirectory(cwd, buildWorkspaceIndex())).toMatchObject({
      workspaceId: ws.id,
      isWorktree: true,
      repoPath: repoDir,
      source: "record",
    });

    // Deletion: the uncached resolver answers, and it says no.
    const verdict = evaluateWorktreeRemoval(ws);
    expect(verdict.removable).toBe(false);
    expect(verdict.blockers.map((b) => b.code)).toContain("not-a-worktree-on-disk");
  });
});

describe("buildWorkspaceIndex — reading the real registry", () => {
  it("ignores archived records and falls back to the filesystem for them", () => {
    const ws = createWorkspace({
      cwd: realWorktree,
      repoPath: repoDir,
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch: "feat/real" },
    });
    expect(viewForDirectory(realWorktree, buildWorkspaceIndex()).workspaceId).toBe(ws.id);

    archiveWorkspace(ws.id);
    const after = viewForDirectory(realWorktree, buildWorkspaceIndex());
    expect(after.workspaceId).toBeUndefined();
    // Still correct — the directory answers when the registry does not.
    expect(after).toMatchObject({ isWorktree: true, repoPath: repoDir, source: "directory" });
  });
});
