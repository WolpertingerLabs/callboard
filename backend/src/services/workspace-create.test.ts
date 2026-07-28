/**
 * `create_workspace` — what it may write, and what it must refuse to.
 *
 * Two properties are load-bearing here and neither is obvious from the name of
 * the function:
 *
 * 1. **It can never reach `owned: true`.** Phase 2's removal gate is built on
 *    that flag having exactly two writers ("we ran git worktree add" and "a
 *    caller named this path, and we wrote the identity token"). A creation
 *    endpoint is the natural place a third appears, so the tests below assert
 *    the *shape* of what it writes — no worktree block at all — rather than
 *    trusting that no caller will pass one.
 *
 * 2. **A worktree directory is refused.** Not for tidiness: a plain record on an
 *    unmanaged worktree would carry no identity token and would make that
 *    worktree permanently unadoptable, because adoption refuses any directory
 *    that already has an active record. One call would move a directory out of
 *    the backlog into a state nothing can clean up.
 *
 * Real git fixtures, because "is this a worktree?" is a filesystem claim.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-create-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { createLocalWorkspace } = await import("./workspace-create.js");
const { createWorkspace, listWorkspacesByCwd } = await import("./workspace-store.js");
const { evaluateAdoption } = await import("./workspace-adoption.js");

const workspacesDir = join(tmpRoot, "workspaces");

const gitRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-create-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/** A real linked worktree — the thing adoption owns and this must not touch. */
const worktreeDir = join(gitRoot, "repo.feat-x");
git(["worktree", "add", "-q", "-b", "feat/x", worktreeDir, "main"], repoDir);

/** A plain, non-git directory — the ordinary case. */
const plainDir = join(gitRoot, "notes");
mkdirSync(plainDir, { recursive: true });

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
});

describe("what it writes", () => {
  it("creates a local record for an existing directory, named after it by default", () => {
    const result = createLocalWorkspace({ cwd: plainDir });
    expect(result.created).toBe(true);
    expect(result.workspace?.isolation).toBe("local");
    expect(result.workspace?.name).toBe("notes");
    expect(result.workspace?.cwd).toBe(plainDir);
    expect(result.workspace?.status).toBe("active");
  });

  it("takes a name", () => {
    expect(createLocalWorkspace({ cwd: plainDir, name: "  Reading list  " }).workspace?.name).toBe("Reading list");
  });

  /**
   * The invariant, asserted on the record rather than on the arguments: there
   * is no worktree block, so there is no `owned` field to be true. A future
   * change that started passing one through would fail here rather than
   * quietly minting the flag that authorises moving a directory.
   */
  it("cannot produce an owned worktree record — there is no worktree block at all", () => {
    const result = createLocalWorkspace({ cwd: plainDir });
    expect(result.workspace?.worktree).toBeUndefined();
    expect(result.workspace?.repoPath).toBeUndefined();
    expect(JSON.stringify(result.workspace)).not.toContain("owned");
  });

  it("ignores anything a caller tries to smuggle past the signature", () => {
    // The typed surface has no isolation and no worktree; this is the untyped
    // route/tool body reaching the same function.
    const result = createLocalWorkspace({ cwd: plainDir, isolation: "worktree", worktree: { owned: true, mode: "branch-off", branch: "x" } } as any);
    expect(result.created).toBe(true);
    expect(result.workspace?.isolation).toBe("local");
    expect(result.workspace?.worktree).toBeUndefined();
  });

  it("records the canonical directory when handed a symlink to one", () => {
    const link = join(gitRoot, "notes-link");
    symlinkSync(plainDir, link);
    expect(createLocalWorkspace({ cwd: link }).workspace?.cwd).toBe(plainDir);
  });
});

describe("what it refuses", () => {
  /**
   * The one that matters. A record here would be adoption without adoption's
   * gates — and the second assertion is the reason it is a refusal rather than
   * a harmless duplicate: after a record exists, adoption itself refuses.
   */
  it("refuses a git worktree, and says to adopt it instead", () => {
    const result = createLocalWorkspace({ cwd: worktreeDir });
    expect(result.created).toBe(false);
    expect(result.refusal?.code).toBe("is-a-worktree");
    expect(result.refusal?.detail).toMatch(/adopt_worktrees/);
    expect(listWorkspacesByCwd(worktreeDir)).toEqual([]);

    // Proof that the refusal protects something: had the record been written,
    // this is the state the worktree would have been stuck in forever.
    expect(evaluateAdoption(worktreeDir).blockers).toEqual([]);
    createWorkspace({ cwd: worktreeDir, isolation: "local" });
    expect(evaluateAdoption(worktreeDir).blockers.map((b) => b.code)).toContain("already-managed");
  });

  it("refuses a directory that does not exist", () => {
    const result = createLocalWorkspace({ cwd: join(gitRoot, "nope") });
    expect(result.created).toBe(false);
    expect(result.refusal?.code).toBe("cwd-missing");
  });

  it("refuses a path that is a file", () => {
    const file = join(gitRoot, "a-file");
    writeFileSync(file, "hello");
    expect(createLocalWorkspace({ cwd: file }).refusal?.code).toBe("not-a-directory");
  });

  it("refuses an empty cwd", () => {
    expect(createLocalWorkspace({ cwd: "   " }).refusal?.code).toBe("cwd-required");
  });

  /**
   * Names are rejected at the boundary rather than cleaned, because here the
   * caller typed one: a silently mangled name is a name they will not find
   * again.
   */
  it("refuses an unusable name before writing anything", () => {
    const result = createLocalWorkspace({ cwd: plainDir, name: "two\nlines" });
    expect(result.created).toBe(false);
    expect(result.refusal?.code).toBe("invalid-name");
    expect(listWorkspacesByCwd(plainDir)).toEqual([]);
  });
});

describe("a directory that already has a record", () => {
  /**
   * Several workspaces on one `cwd` is a supported state — it is the "two
   * pieces of work in the same checkout" case the entity exists for. So this is
   * reported, not refused.
   */
  it("creates a second record and reports the first", () => {
    const first = createLocalWorkspace({ cwd: plainDir, name: "Research" }).workspace!;
    const second = createLocalWorkspace({ cwd: plainDir, name: "Writing" });
    expect(second.created).toBe(true);
    expect(second.sharedWith).toEqual([{ id: first.id, name: "Research" }]);
    expect(listWorkspacesByCwd(plainDir)).toHaveLength(2);
  });

  it("says nothing about sharing when it is the only record", () => {
    expect(createLocalWorkspace({ cwd: plainDir }).sharedWith).toBeUndefined();
  });
});
