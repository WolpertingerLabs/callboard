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
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureWorktreeDetailed, fallbackBranchName, resolveBranch, uniqueBranchName } from "./git.js";

// Canonical, not as `tmpdir()` spells it: on macOS that is `/var/folders/...`,
// a symlink to `/private/var/folders/...`. Worktree resolution reports the real
// path, so a fixture built on the symlinked spelling never compares equal.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-worktree-")));
const repoDir = join(tmpRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

/**
 * A repository of its own, in a parent directory of its own.
 *
 * Uniqueness is answered partly from sibling directories on disk, so every case
 * that asserts about collisions needs a parent nobody else is writing worktrees
 * into — including the shared `repoDir` above, whose siblings accumulate as the
 * suite runs.
 */
function makeRepo(name: string): string {
  const parent = mkdtempSync(join(tmpRoot, `${name}-`));
  const dir = join(parent, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
  return dir;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ensureWorktreeDetailed", () => {
  it("reports created=true for a worktree it makes, and false when reusing it", () => {
    const first = ensureWorktreeDetailed(repoDir, "feat/new", true, "main");
    expect(first.path).toBe(join(tmpRoot, "repo.feat-new"));
    expect(first.created).toBe(true);
    expect(first.isMainCheckout).toBe(false);

    // Same branch again: the directory is already there, so we didn't make it.
    const second = ensureWorktreeDetailed(repoDir, "feat/new", false);
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
    // Reused, but still a linked worktree — `.git` there is a file.
    expect(second.isMainCheckout).toBe(false);
  });

  it("reports the main checkout as one when the branch is already checked out there", () => {
    // `main` lives in the main checkout — ensureWorktree hands back that path
    // rather than failing. It is emphatically not ours to remove, and it is not
    // a worktree: a record written from this resolution must say so.
    const ensured = ensureWorktreeDetailed(repoDir, "main", false);
    expect(ensured.path).toBe(repoDir);
    expect(ensured.created).toBe(false);
    expect(ensured.isMainCheckout).toBe(true);
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
      isMainCheckout: false,
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
      isMainCheckout: false,
      mode: "checkout-branch",
      branch: "feat/existing",
    });
  });

  it("flags a resolution that landed on the main checkout", () => {
    // The branch is already checked out in the main repo, so the "worktree"
    // that comes back is the repository itself. The intent is still reported —
    // a worktree was asked for — but with the one field that stops a caller
    // recording the main repo as a worktree of itself.
    const result = resolveBranch({ folder: repoDir, baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(repoDir);
    expect(result.worktree).toEqual({
      repoPath: repoDir,
      created: false,
      isMainCheckout: true,
      mode: "checkout-branch",
      branch: "main",
    });
  });

  it("reports no worktree when none was asked for", () => {
    const result = resolveBranch({ folder: repoDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worktree).toBeUndefined();
  });

  it("reports no worktree for an in-place branch switch that lands in one", () => {
    // Stand up the worktree here rather than leaning on one an earlier test
    // left behind — this must hold under `.only` and under any test order.
    const inPlacePath = join(tmpRoot, "repo.feat-inplace");
    git(["worktree", "add", "-q", "-b", "feat/inplace", inPlacePath, "main"], repoDir);

    // The branch already lives in a worktree, so switchBranch returns that
    // path. The user did not ask for isolation, and Callboard did not create
    // anything — deliberately not reported as worktree intent.
    const result = resolveBranch({ folder: repoDir, baseBranch: "feat/inplace" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(inPlacePath);
    expect(result.worktree).toBeUndefined();
  });
});

describe("uniqueBranchName", () => {
  it("hands back a free name untouched", () => {
    const dir = makeRepo("unique-free");
    expect(uniqueBranchName(dir, "feat/free")).toBe("feat/free");
  });

  it("suffixes -2 when the branch already exists", () => {
    const dir = makeRepo("unique-branch");
    git(["branch", "feat/dup"], dir);
    expect(uniqueBranchName(dir, "feat/dup")).toBe("feat/dup-2");
  });

  it("suffixes -2 when only the derived path collides", () => {
    // `feat/a-b` and `feat/a/b` are different branches that sanitize onto one
    // directory. Neither the branch list nor the worktree list says so — the
    // second chat would just be handed the first one's worktree.
    const dir = makeRepo("unique-path");
    git(["worktree", "add", "-q", "-b", "feat/a-b", join(dirname(dir), "repo.feat-a-b"), "main"], dir);

    expect(uniqueBranchName(dir, "feat/a/b")).toBe("feat/a/b-2");
  });

  it("suffixes -2 for a name that exists only on a remote", () => {
    // `git branch --list` is local refs only, so `origin/feat/remote-only`
    // reads as free and `worktree add -b` happily mints an unrelated local
    // branch of that name — verified against a real repo, it exits 0. The
    // collision then waits until a push, with the work already done.
    const dir = makeRepo("unique-remote");
    git(["update-ref", "refs/remotes/origin/feat/remote-only", "HEAD"], dir);
    // A remote's default-branch symref is not a branch of its own and must not
    // make every candidate look taken.
    git(["update-ref", "refs/remotes/origin/HEAD", "HEAD"], dir);

    expect(uniqueBranchName(dir, "feat/remote-only")).toBe("feat/remote-only-2");
    expect(uniqueBranchName(dir, "feat/untaken")).toBe("feat/untaken");
  });

  it("keeps suffixing past an occupied -2", () => {
    const dir = makeRepo("unique-chain");
    git(["branch", "fix/login"], dir);
    git(["branch", "fix/login-2"], dir);
    expect(uniqueBranchName(dir, "fix/login")).toBe("fix/login-3");
  });

  it("falls back to a stamped name for a candidate git would refuse", () => {
    // `generateBranchName` scrubs unsafe characters *after* its structure
    // check, so a description made entirely of punctuation leaves a bare
    // `feat/` — a ref git rejects, and one no suffix can rescue.
    const dir = makeRepo("unique-invalid");
    expect(uniqueBranchName(dir, "feat/")).toMatch(/^chat\/\d{8}-[0-9a-f]{6}$/);
  });

  it("stays inside the 60-character cap when it suffixes", () => {
    const dir = makeRepo("unique-long");
    const long = `feat/${"a".repeat(55)}`; // exactly 60
    git(["branch", long], dir);

    const unique = uniqueBranchName(dir, long);
    expect(unique).not.toBe(long);
    expect(unique.length).toBeLessThanOrEqual(60);
    expect(unique.endsWith("-2")).toBe(true);
  });
});

describe("fallbackBranchName", () => {
  it("is a dated, git-legal name that differs run to run", () => {
    expect(fallbackBranchName()).toMatch(/^chat\/\d{8}-[0-9a-f]{6}$/);
    // 24 bits of randomness: a repeat here is a broken generator, not luck.
    expect(fallbackBranchName()).not.toBe(fallbackBranchName());
  });
});

describe("generated names never share a worktree", () => {
  it("still reuses one worktree for a name asked for twice", () => {
    // The regression guard on uniqueness: it belongs on the generated path in
    // the route, never inside resolveBranch. Two chats on a name the user
    // typed are meant to land in the same place.
    const dir = makeRepo("typed-reuse");

    const first = resolveBranch({ folder: dir, newBranch: "feat/typed", baseBranch: "main", useWorktree: true });
    const second = resolveBranch({ folder: dir, newBranch: "feat/typed", baseBranch: "main", useWorktree: true });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.folder).toBe(join(dirname(dir), "repo.feat-typed"));
    expect(second.folder).toBe(first.folder);
    expect(first.worktree?.created).toBe(true);
    expect(second.worktree?.created).toBe(false);
    expect(existsSync(join(dirname(dir), "repo.feat-typed-2"))).toBe(false);
  });

  it("leaves a typed name that matches a remote branch alone", () => {
    // The remote check belongs to `uniqueBranchName` and nothing else. Typing a
    // name that matches `origin/feat/shared` is a choice the user is entitled
    // to make — quietly redirecting them to `feat/shared-2` would be worse than
    // today's behaviour, not better.
    const dir = makeRepo("typed-remote");
    git(["update-ref", "refs/remotes/origin/feat/shared", "HEAD"], dir);

    const result = resolveBranch({ folder: dir, newBranch: "feat/shared", baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(join(dirname(dir), "repo.feat-shared"));
    expect(result.worktree?.branch).toBe("feat/shared");
  });

  it("never lands in the main checkout when generation failed", () => {
    // The route's fallback composition. Before it, a null from
    // `generateBranchName` meant no `newBranch` at all, so `useWorktree` +
    // `baseBranch: "main"` found `main` checked out in the main repo and
    // returned it — isolation asked for, silently not delivered.
    const dir = makeRepo("generation-failed");

    const fallback = uniqueBranchName(dir, fallbackBranchName());
    const result = resolveBranch({ folder: dir, newBranch: fallback, baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.folder).not.toBe(dir);
    expect(result.worktree?.created).toBe(true);
    expect(result.worktree?.isMainCheckout).toBe(false);
    expect(result.worktree?.mode).toBe("branch-off");
  });
});

describe("existing branches and non-repositories", () => {
  it("checks out an existing, unchecked-out branch rather than failing on -b", () => {
    // The branch exists and lives nowhere, so neither reuse path fires and
    // `git worktree add -b` refuses with "a branch named 'x' already exists".
    // The worktree is still what the caller wanted; only `-b` was wrong.
    const dir = makeRepo("existing-branch");
    git(["branch", "feat/orphan"], dir);

    const ensured = ensureWorktreeDetailed(dir, "feat/orphan", true, "main");
    expect(ensured.path).toBe(join(dirname(dir), "repo.feat-orphan"));
    expect(ensured.created).toBe(true);
    expect(ensured.branchCreated).toBe(false);
    expect(ensured.isMainCheckout).toBe(false);
    expect(existsSync(ensured.path)).toBe(true);
  });

  it("reports checkout-branch, with no invented base, for that resolution", () => {
    const dir = makeRepo("existing-branch-resolve");
    git(["branch", "feat/orphan"], dir);

    const result = resolveBranch({ folder: dir, newBranch: "feat/orphan", baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `baseBranch` absent: nothing was branched off `main`, and a workspace
    // record claiming otherwise would be describing history git never has.
    expect(result.worktree).toEqual({
      repoPath: dir,
      created: true,
      isMainCheckout: false,
      mode: "checkout-branch",
      branch: "feat/orphan",
    });
  });

  it("is a no-op on a folder that is not a repository", () => {
    // `branchConfig` rides on nearly every new chat now, so a plain directory
    // reaches here routinely. `git worktree add` there is a 500.
    const plain = mkdtempSync(join(tmpRoot, "not-a-repo-"));

    const result = resolveBranch({ folder: plain, newBranch: "feat/x", baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(plain);
    expect(result.worktree).toBeUndefined();
    expect(existsSync(`${plain}.feat-x`)).toBe(false);
  });
});
