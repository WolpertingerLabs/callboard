/**
 * Worktree resolution against a real throwaway repo.
 *
 * The `created` flag is the safety-critical bit: it is the only thing that can
 * make a workspace `owned`, and `owned` is what will later gate `git worktree
 * remove`. A reused directory must never report as created, so this exercises
 * real git rather than a mock of it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorktreeDetailed, resolveBranch } from "./git.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-git-worktree-"));
const repoDir = join(tmpRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ensureWorktreeDetailed", () => {
  it("reports created=true for a worktree it makes, and false when reusing it", () => {
    const first = ensureWorktreeDetailed(repoDir, "feat/new", true, "main");
    expect(first.path).toBe(join(tmpRoot, "repo.feat-new"));
    expect(first.created).toBe(true);

    // Same branch again: the directory is already there, so we didn't make it.
    const second = ensureWorktreeDetailed(repoDir, "feat/new", false);
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
  });

  it("reports created=false when the branch is already checked out elsewhere", () => {
    // `main` lives in the main checkout — ensureWorktree hands back that path
    // rather than failing, and it is emphatically not ours to remove.
    const ensured = ensureWorktreeDetailed(repoDir, "main", false);
    expect(ensured.path).toBe(repoDir);
    expect(ensured.created).toBe(false);
  });
});

describe("resolveBranch worktree intent", () => {
  it("reports branch-off with its base for a newly branched worktree", () => {
    const result = resolveBranch({ folder: repoDir, newBranch: "feat/off", baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(join(tmpRoot, "repo.feat-off"));
    expect(result.worktree).toEqual({
      repoPath: repoDir,
      created: true,
      mode: "branch-off",
      branch: "feat/off",
      baseBranch: "main",
    });
  });

  it("reports checkout-branch with no base for an existing branch", () => {
    git(["branch", "feat/existing"], repoDir);
    const result = resolveBranch({ folder: repoDir, baseBranch: "feat/existing", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worktree).toEqual({
      repoPath: repoDir,
      created: true,
      mode: "checkout-branch",
      branch: "feat/existing",
    });
  });

  it("reports no worktree when none was asked for", () => {
    const result = resolveBranch({ folder: repoDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worktree).toBeUndefined();
  });

  it("reports no worktree for an in-place branch switch that lands in one", () => {
    // `feat/new` already has a worktree from the suite above, so switchBranch
    // returns that path. The user did not ask for isolation, and Callboard did
    // not create anything — deliberately not reported as worktree intent.
    const result = resolveBranch({ folder: repoDir, baseBranch: "feat/new" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(join(tmpRoot, "repo.feat-new"));
    expect(result.worktree).toBeUndefined();
  });
});
