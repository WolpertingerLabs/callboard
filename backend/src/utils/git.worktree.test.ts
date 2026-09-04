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
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureWorktreeDetailed, fallbackBranchName, getGitInfo, hasUncommittedChanges, resolveBranch, uniqueBranchName } from "./git.js";

// Canonical, not as `tmpdir()` spells it: on macOS that is `/var/folders/...`,
// a symlink to `/private/var/folders/...`. Worktree resolution reports the real
// path, so a fixture built on the symlinked spelling never compares equal.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-worktree-")));
const repoDir = join(tmpRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

/** The commit a ref names, for asserting what a new branch was actually cut from. */
function revParse(cwd: string, rev: string): string {
  return execFileSync("git", ["rev-parse", rev], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
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

/**
 * The guard asks whether `folder` is dirty. That is the right question only
 * when `folder` is where the checkout is going to happen — and when the target
 * branch already lives in another worktree, `switchBranch` returns that path
 * and never writes here at all. Both directions are pinned: skipping the guard
 * when it applies would let a real in-place switch stomp uncommitted work,
 * which is the failure it exists to prevent.
 */
describe("the dirty-state guard and where the checkout actually lands", () => {
  /** A repo with one uncommitted change, so the guard has something to find. */
  function dirtyRepo(name: string): string {
    const dir = makeRepo(name);
    writeFileSync(join(dir, "scratch.txt"), "uncommitted");
    return dir;
  }

  it("refuses an in-place switch over uncommitted changes", () => {
    const dir = dirtyRepo("dirty-in-place");
    git(["branch", "feat/target"], dir);

    const result = resolveBranch({ folder: dir, baseBranch: "feat/target" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("uncommitted_changes");
    if (result.error !== "uncommitted_changes") return;
    expect(result.currentBranch).toBe("main");
    expect(result.targetBranch).toBe("feat/target");
  });

  it("allows the same switch when the target branch lives in another worktree", () => {
    const dir = dirtyRepo("dirty-redirected");
    const elsewhere = join(dirname(dir), "repo.feat-elsewhere");
    git(["worktree", "add", "-q", "-b", "feat/elsewhere", elsewhere, "main"], dir);

    // The chat runs in `elsewhere`. Nothing reads or writes `dir`, so its
    // uncommitted changes are not this request's business.
    const result = resolveBranch({ folder: dir, baseBranch: "feat/elsewhere" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(elsewhere);
    // Still dirty: the point is that nothing here was touched, not that the
    // changes were dealt with.
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  /**
   * The redirect is what lifts the guard, not the mere existence of some other
   * worktree. A repo with a worktree on an unrelated branch is still doing an
   * in-place switch and must still be refused.
   */
  it("still refuses when the other worktree is on a different branch", () => {
    const dir = dirtyRepo("dirty-unrelated-worktree");
    git(["worktree", "add", "-q", "-b", "feat/unrelated", join(dirname(dir), "repo.feat-unrelated"), "main"], dir);
    git(["branch", "feat/target"], dir);

    const result = resolveBranch({ folder: dir, baseBranch: "feat/target" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("uncommitted_changes");
  });

  /**
   * `newBranch` is the target when it is set, so the lookup has to follow it
   * rather than the base — the same precedence `switchBranch` uses.
   */
  it("follows the typed name rather than the base branch", () => {
    const dir = dirtyRepo("dirty-redirected-by-name");
    const elsewhere = join(dirname(dir), "repo.feat-named");
    git(["worktree", "add", "-q", "-b", "feat/named", elsewhere, "main"], dir);

    const result = resolveBranch({ folder: dir, newBranch: "feat/named", baseBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(elsewhere);
  });

  /**
   * A detached HEAD has no current branch, but `getGitInfo.branch` reports one
   * anyway — `"main"`, its "empty means main" fallback. Taken at face value the
   * guard compared `"main" !== "main"`, never fired, and `git checkout main`
   * ran over uncommitted work: the changes ride onto a branch nobody asked for
   * and the detached commit survives only in the reflog.
   *
   * `main` as the target is the whole point. Any other target already differed
   * from the fallback and was already guarded, which is why this went unseen.
   */
  it("refuses a switch to main from a dirty detached HEAD", () => {
    const dir = dirtyRepo("dirty-detached");
    git(["commit", "-q", "--allow-empty", "-m", "second"], dir);
    git(["checkout", "-q", "--detach", "HEAD~1"], dir);
    const detachedAt = revParse(dir, "HEAD");

    const result = resolveBranch({ folder: dir, baseBranch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("uncommitted_changes");
    if (result.error !== "uncommitted_changes") return;
    expect(result.targetBranch).toBe("main");
    // Named for what it is rather than as the branch the fallback invents.
    expect(result.message).toContain("detached HEAD");

    // Nothing moved: still detached, still on the same commit, still dirty.
    expect(revParse(dir, "HEAD")).toBe(detachedAt);
    expect(getGitInfo(dir).isDetached).toBe(true);
    expect(hasUncommittedChanges(dir)).toBe(true);
  });

  /**
   * The force flag still works from a detached HEAD, and the switch still
   * happens — the guard is a question, not a prohibition.
   */
  it("still switches from a detached HEAD when forced", () => {
    const dir = dirtyRepo("dirty-detached-forced");
    git(["commit", "-q", "--allow-empty", "-m", "second"], dir);
    git(["checkout", "-q", "--detach", "HEAD~1"], dir);

    const result = resolveBranch({ folder: dir, baseBranch: "main", forceBranchChange: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getGitInfo(dir).branch).toBe("main");
    expect(getGitInfo(dir).isDetached).toBeUndefined();
  });

  /** A clean checkout was never blocked, and still is not. */
  it("leaves a clean in-place switch alone", () => {
    const dir = makeRepo("clean-in-place");
    git(["branch", "feat/target"], dir);

    const result = resolveBranch({ folder: dir, baseBranch: "feat/target" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(dir);
    expect(getGitInfo(dir).branch).toBe("feat/target");
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

  /**
   * Git stores refs as files under `refs/heads/`, so a branch name is a path
   * and no branch may be a directory prefix of another — in either direction.
   * `generateBranchName` validates `^(feat|fix|…)\/.+$` and scrubs to git-safe
   * characters, both of which keep `/`, so a generated `feat/login/redirect` is
   * an ordinary thing to reach this function with.
   *
   * Neither the branch list, the worktree list nor the derived path sees this:
   * `feat/login` and `feat/login/redirect` are different strings that sanitize
   * to different directories. Only the ref tree objects, and it objects by
   * failing the creation.
   */
  it("suffixes when an existing branch sits underneath the candidate", () => {
    // `git checkout -b feat/api` → fatal: cannot lock ref 'refs/heads/feat/api':
    // 'refs/heads/feat/api/v1' exists; cannot create 'refs/heads/feat/api'
    const dir = makeRepo("unique-ref-child");
    git(["branch", "feat/api/v1"], dir);
    expect(uniqueBranchName(dir, "feat/api")).toBe("feat/api-2");
  });

  it("sees the same conflict from a branch only a remote has", () => {
    const dir = makeRepo("unique-ref-child-remote");
    git(["update-ref", "refs/remotes/origin/feat/api/v1", "HEAD"], dir);
    expect(uniqueBranchName(dir, "feat/api")).toBe("feat/api-2");
  });

  /**
   * The other direction, and the one a suffix cannot rescue: every `-n` variant
   * of `feat/login/redirect` is still underneath `refs/heads/feat/login/`, so
   * the loop exhausts and the candidate is abandoned for a stamped name.
   *
   * That is the right answer rather than a missed one — no name derived from
   * this candidate is creatable — but it is the one place where "suffix to -2"
   * is not what happens, so it is pinned rather than assumed.
   */
  it("abandons a candidate nested under an existing branch", () => {
    // `git checkout -b feat/login/redirect` → fatal: cannot lock ref
    // 'refs/heads/feat/login/redirect': 'refs/heads/feat/login' exists
    const dir = makeRepo("unique-ref-parent");
    git(["branch", "feat/login"], dir);
    expect(uniqueBranchName(dir, "feat/login/redirect")).toMatch(/^chat\/\d{8}-[0-9a-f]{6}$/);
  });

  /**
   * A conflict is a shared *path* segment, not a shared prefix of characters.
   * `feat/logins` is not underneath `feat/login`, and refusing it would suffix
   * names that git would have accepted — the failure mode of a `startsWith`
   * without the separator.
   */
  it("leaves a name that merely shares a prefix of characters alone", () => {
    const dir = makeRepo("unique-ref-nonconflict");
    git(["branch", "feat/login"], dir);
    expect(uniqueBranchName(dir, "feat/logins")).toBe("feat/logins");
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

  /**
   * The two halves of the ref-tree conflict, end to end through the route's own
   * composition — `uniqueBranchName` then `resolveBranch` — on both creation
   * paths. The un-uniquified call is asserted to throw in each, because a test
   * that only shows the fixed name working would still pass if the conflict
   * had never been real.
   */
  it("survives a ref-tree conflict in place, where raw checkout -b is fatal", () => {
    const dir = makeRepo("ref-conflict-inplace");
    git(["branch", "feat/api/v1"], dir);

    // The hazard, unmediated: `git checkout -b feat/api` cannot lock the ref.
    expect(() => resolveBranch({ folder: dir, newBranch: "feat/api", baseBranch: "main" })).toThrow();

    const unique = uniqueBranchName(dir, "feat/api");
    expect(unique).toBe("feat/api-2");
    const result = resolveBranch({ folder: dir, newBranch: unique, baseBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(dir);
    expect(getGitInfo(dir).branch).toBe("feat/api-2");
  });

  it("survives a ref-tree conflict in a worktree, where raw worktree add -b is fatal", () => {
    const dir = makeRepo("ref-conflict-worktree");
    git(["branch", "feat/api/v1"], dir);

    expect(() => resolveBranch({ folder: dir, newBranch: "feat/api", baseBranch: "main", useWorktree: true })).toThrow();

    const unique = uniqueBranchName(dir, "feat/api");
    const result = resolveBranch({ folder: dir, newBranch: unique, baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(join(dirname(dir), "repo.feat-api-2"));
    expect(result.worktree?.created).toBe(true);
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

  /**
   * The in-place twin of the case above, and a live 500 until now.
   *
   * `switchBranch`'s worktree lookup only catches a branch checked out
   * *somewhere*. One that exists and lives nowhere fell through to
   * `git checkout -b`, which refuses with the same "a branch named 'x' already
   * exists" — exit 128, straight out of the route. Typing an existing branch
   * name with the worktree toggle off is an ordinary thing to do, and it is
   * about to become the way the UI offers "switch to this branch".
   */
  it("checks out an existing, unchecked-out branch in place rather than failing on -b", () => {
    const dir = makeRepo("existing-branch-inplace");
    git(["branch", "feat/orphan"], dir);

    const result = resolveBranch({ folder: dir, newBranch: "feat/orphan", baseBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // In place: the same directory, now on the branch that already existed.
    expect(result.folder).toBe(dir);
    expect(result.worktree).toBeUndefined();
    expect(getGitInfo(dir).branch).toBe("feat/orphan");
  });

  /**
   * The other half of the same decision: a name that does *not* exist must
   * still be created, off the base it was given. Without this, "drop `-b`
   * whenever the checkout would fail" would pass the test above by never
   * branching at all.
   */
  it("still creates a branch that does not exist, off the given base", () => {
    const dir = makeRepo("new-branch-inplace");
    git(["commit", "-q", "--allow-empty", "-m", "second"], dir);
    git(["branch", "feat/base"], dir);
    git(["commit", "-q", "--allow-empty", "-m", "third"], dir);

    const result = resolveBranch({ folder: dir, newBranch: "feat/fresh", baseBranch: "feat/base" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.folder).toBe(dir);
    expect(getGitInfo(dir).branch).toBe("feat/fresh");
    // Branched off `feat/base`, not off wherever HEAD happened to be.
    expect(revParse(dir, "feat/fresh")).toBe(revParse(dir, "feat/base"));
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
    // reaches here routinely. `git checkout` there is a 500.
    const plain = mkdtempSync(join(tmpRoot, "not-a-repo-"));

    const result = resolveBranch({ folder: plain, newBranch: "feat/x", baseBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe(plain);
    expect(result.worktree).toBeUndefined();
  });

  /**
   * The no-op stops at `useWorktree`, because that flag is a request the
   * success shape cannot answer honestly.
   *
   * `{ok: true, folder}` with the folder unchanged is exactly what "no worktree
   * was asked for" returns, so a caller cannot tell the two apart. The HTTP
   * route has the UI's `is_git_repo` gate in front of it and never sees this;
   * `start_chat_session` has no gate, so an agent passing `useWorktree: true`
   * on a plain directory got a chatId, no isolation, and no way to find out.
   */
  it("refuses a worktree on a folder that is not a repository", () => {
    const plain = mkdtempSync(join(tmpRoot, "not-a-repo-worktree-"));

    const result = resolveBranch({ folder: plain, newBranch: "feat/x", baseBranch: "main", useWorktree: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_a_git_repo");
    // A distinct code, not `uncommitted_changes`: there is no force flag that
    // makes this one work, and the client's retry modal must not offer one.
    expect(result.message).toContain(plain);
    expect(existsSync(`${plain}.feat-x`)).toBe(false);
  });
});
