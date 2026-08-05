/**
 * Worktrees created from inside another worktree.
 *
 * Git has no notion of a nested worktree: `git worktree add` run from a linked
 * worktree registers the new one against the repository's **common dir**, so it
 * is a sibling of the one it was created from, not a child of it. Callboard
 * recorded the cwd it was called from as `repoPath`, which meant the removal
 * gate compared the record against a directory git had never registered it
 * under — every such worktree came back `not-a-worktree-on-disk` and could only
 * be removed by hand.
 *
 * Everything here runs against real throwaway repositories, because the claim
 * being made is precisely that git and the record agree; a mocked git would
 * agree with whatever the implementation believed.
 *
 * DATA_DIR is a module const captured when utils/paths.js first loads, so
 * CALLBOARD_DATA_DIR is set before the module graph is imported — hence the
 * top-level dynamic imports. A workspace test that skips this writes records
 * into the developer's real ~/.callboard (#302).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-nested-worktree-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { resolveBranch, resolveRepoCommonRoot } = await import("../utils/git.js");
const { captureWorktreeWorkspace, getWorkspace, recordWorktreeWorkspace } = await import("./workspace-store.js");
const { archiveWorkspace, describeWorkspaceDirectory, evaluateWorktreeRemoval } = await import("./workspace-service.js");

const workspacesDir = join(tmpRoot, "workspaces");

// ── Real git fixtures ───────────────────────────────────────────────

// Canonical, not as `tmpdir()` spells it: on macOS that is `/var/folders/...`,
// a symlink to `/private/var/folders/...`. Git reports worktree paths as the
// real ones, so a fixture built on the symlinked spelling reads to the removal
// gate as a *different* directory.
const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-nested-worktree-git-")));
const repoDir = join(gitRoot, "repo");
/** A worktree of `repoDir`. New worktrees are asked for from in here. */
const parentWorktree = join(gitRoot, "repo.parent");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);
git(["worktree", "add", "-q", parentWorktree, "-b", "parent"], repoDir);

function blockerCodes(blockers: Array<{ code: string }>): string[] {
  return blockers.map((b) => b.code);
}

/**
 * Ask for a worktree exactly as the chat-start path does: resolve the branch in
 * `from`, then capture whatever that resolution produced as a record.
 */
function startWorktreeChat(from: string, newBranch: string) {
  const result = resolveBranch({ folder: from, newBranch, baseBranch: "main", useWorktree: true });
  if (!result.ok) throw new Error(`resolveBranch refused: ${result.message}`);
  const id = captureWorktreeWorkspace(result);
  if (!id) throw new Error("no workspace was recorded");
  const workspace = getWorkspace(id);
  if (!workspace) throw new Error(`workspace ${id} was not persisted`);
  return { workspace, cwd: result.folder };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(workspacesDir)) for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
});

// ── The common dir ──────────────────────────────────────────────────

describe("resolveRepoCommonRoot", () => {
  it("answers with the repository root from a main checkout", () => {
    expect(resolveRepoCommonRoot(repoDir)).toBe(repoDir);
  });

  it("answers with the *main* checkout from inside a worktree", () => {
    expect(resolveRepoCommonRoot(parentWorktree)).toBe(repoDir);
  });

  it("returns null for a directory that is not a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "callboard-not-a-repo-"));
    try {
      expect(resolveRepoCommonRoot(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("answers with the bare repository itself when there is no working root", () => {
    const bare = join(gitRoot, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", repoDir, bare], { stdio: "pipe" });
    try {
      // basename is "bare.git", not ".git" — there is no working tree to strip
      // back to, so the common dir *is* the answer. Stripping a trailing ".git"
      // as a string would have named a directory that does not exist.
      expect(resolveRepoCommonRoot(bare)).toBe(bare);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ── The bug ─────────────────────────────────────────────────────────

describe("a worktree created from inside another worktree", () => {
  it("records the repository's common dir, not the worktree it was asked from", () => {
    const { workspace, cwd } = startWorktreeChat(parentWorktree, "nested/records-common-dir");

    // git registered it against the common dir; so must the record.
    expect(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim()).toBe(join(repoDir, ".git"));
    expect(workspace.repoPath).toBe(repoDir);
    expect(workspace.worktree?.owned).toBe(true);
  });

  it("is archivable — the removal gate finds no reason to refuse", () => {
    const { workspace } = startWorktreeChat(parentWorktree, "nested/archivable");

    const removability = evaluateWorktreeRemoval(workspace);
    expect(blockerCodes(removability.blockers)).toEqual([]);
    expect(removability.removable).toBe(true);
    expect(describeWorkspaceDirectory(workspace).state).toBe("present");
  });

  it("actually quarantines, and unregisters from the repository git knows it by", async () => {
    const { workspace, cwd } = startWorktreeChat(parentWorktree, "nested/quarantined");

    const result = await archiveWorkspace(workspace.id);
    expect(result?.worktree.blockers).toEqual([]);
    expect(result?.worktree.disposition).toBe("quarantined");
    expect(existsSync(cwd)).toBe(false);
    // The prune has to have run in the *common* repo — running it in the
    // worktree the chat was started from would leave the registration behind.
    expect(git(["worktree", "list"], repoDir)).not.toContain(cwd);
  });
});

// ── Records already written with the wrong repoPath ─────────────────
//
// These are tolerated at read time and never rewritten: see the doc comment on
// `repoPathNamesSameRepo` in workspace-service.ts.

describe("a legacy record whose repoPath names a sibling worktree", () => {
  it("is no longer refused as not-a-worktree-on-disk", () => {
    const cwd = join(gitRoot, "repo.legacy-nested");
    git(["worktree", "add", "-q", cwd, "-b", "legacy/nested"], parentWorktree);
    // Exactly the shape the write path produced before the fix: a real worktree
    // of `repoDir`, recorded against the worktree it was created from.
    const workspace = recordWorktreeWorkspace({
      cwd,
      repoPath: parentWorktree,
      created: true,
      mode: "branch-off",
      branch: "legacy/nested",
      baseBranch: "main",
    });
    expect(workspace.repoPath).toBe(parentWorktree);

    const removability = evaluateWorktreeRemoval(workspace);
    expect(blockerCodes(removability.blockers)).toEqual([]);
    expect(describeWorkspaceDirectory(workspace).state).toBe("present");
  });

  it("is tolerated, not migrated — the stored repoPath is left exactly as it was", () => {
    const cwd = join(gitRoot, "repo.legacy-unmigrated");
    git(["worktree", "add", "-q", cwd, "-b", "legacy/unmigrated"], parentWorktree);
    const workspace = recordWorktreeWorkspace({
      cwd,
      repoPath: parentWorktree,
      created: true,
      mode: "branch-off",
      branch: "legacy/unmigrated",
      baseBranch: "main",
    });

    evaluateWorktreeRemoval(workspace);
    describeWorkspaceDirectory(workspace);

    expect(getWorkspace(workspace.id)?.repoPath).toBe(parentWorktree);
  });

  it("is still refused when the recorded repoPath is a different repository", () => {
    const otherRepo = join(gitRoot, "other-repo");
    execFileSync("git", ["init", "-q", "-b", "main", otherRepo], { stdio: "pipe" });
    git(["commit", "-q", "--allow-empty", "-m", "init"], otherRepo);

    const cwd = join(gitRoot, "repo.wrong-repo");
    git(["worktree", "add", "-q", cwd, "-b", "legacy/wrong-repo"], parentWorktree);
    const workspace = recordWorktreeWorkspace({ cwd, repoPath: otherRepo, created: true, mode: "branch-off", branch: "legacy/wrong-repo", baseBranch: "main" });

    // Tolerance is "the same repository, spelled as one of its worktrees" —
    // never "some other repository". This gate has not been loosened.
    expect(blockerCodes(evaluateWorktreeRemoval(workspace).blockers)).toContain("not-a-worktree-on-disk");
    expect(describeWorkspaceDirectory(workspace).state).toBe("not-a-worktree");
  });

  it("is still refused when the recorded repoPath no longer exists", () => {
    const cwd = join(gitRoot, "repo.vanished-parent");
    git(["worktree", "add", "-q", cwd, "-b", "legacy/vanished-parent"], parentWorktree);
    const workspace = recordWorktreeWorkspace({
      cwd,
      repoPath: join(gitRoot, "repo.never-existed"),
      created: true,
      mode: "branch-off",
      branch: "legacy/vanished-parent",
      baseBranch: "main",
    });

    // Nothing on disk can establish that the recorded path named this
    // repository, so the record stays unproven and the gate stands.
    expect(blockerCodes(evaluateWorktreeRemoval(workspace).blockers)).toContain("not-a-worktree-on-disk");
  });
});
