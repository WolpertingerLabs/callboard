/**
 * `getGitInfo` reads the branch from `HEAD` instead of spawning for it.
 *
 * Two properties, and both need proving because either alone is worthless:
 *
 *  1. **It gives the same answer git does.** Every case here is built with real
 *     git and asserted against `git branch --show-current` run in the same
 *     directory, so the oracle is git itself rather than what this test's author
 *     believed about HEAD files.
 *  2. **It does not spawn.** That is the entire point of the change — 22 spawns
 *     per cold folder listing, and a 295 ms event-loop block every five minutes
 *     when the caller's memo expires — so `execSync` is stubbed to throw. A
 *     revision that quietly goes back to shelling out does not fail slowly here,
 *     it fails: `getGitInfo` catches the throw and reports `"main"`, which is
 *     the wrong branch in every fixture below that is not on `main`.
 *
 * `execFileSync` is deliberately passed through, because that is what builds the
 * fixtures — and because the fallback path this change keeps is `execSync`, so
 * stubbing exactly it is what separates "used the fast path" from "used git".
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync as realExecFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, cpSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set by the mock below; asserted to stay at zero on the fast path. */
let execSyncCalls = 0;
/**
 * Let the counted spawns actually run. Off by default so a regression that
 * shells out is loud rather than merely slow; on for the fallback cases, where
 * the spawn is the correct behaviour and the question is how *many*.
 */
let execSyncPassThrough = false;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: (...args: Parameters<typeof actual.execSync>) => {
      execSyncCalls++;
      if (execSyncPassThrough) return actual.execSync(...args);
      throw new Error(`execSync called: ${String(args[0])}`);
    },
  };
});

const { getGitInfo } = await import("./git.js");

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-branch-")));

function git(args: string[], cwd: string): string {
  return realExecFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

/** What git itself says, so the assertions below are not graded by this file. */
function gitSaysBranch(dir: string): string {
  return git(["branch", "--show-current"], dir).trim();
}

function initRepo(name: string, branch = "main"): string {
  const dir = join(tmpRoot, name);
  realExecFileSync("git", ["init", "-q", "-b", branch, dir], { stdio: "pipe" });
  return dir;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getGitInfo reads the branch from HEAD", () => {
  it("reports the branch of a plain checkout without spawning", () => {
    const repo = initRepo("plain");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["checkout", "-q", "-b", "some-branch"], repo);

    execSyncCalls = 0;
    const info = getGitInfo(repo);

    expect(info).toEqual({ isGitRepo: true, branch: "some-branch" });
    expect(info.branch).toBe(gitSaysBranch(repo));
    expect(execSyncCalls).toBe(0);
  });

  it("keeps the slashes in a branch name", () => {
    // `refs/heads/feat/x` — the decode has to take everything after
    // `refs/heads/`, not up to the next slash.
    const repo = initRepo("slashes");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["checkout", "-q", "-b", "feat/deeply/nested"], repo);

    execSyncCalls = 0;
    const info = getGitInfo(repo);

    expect(info.branch).toBe("feat/deeply/nested");
    expect(info.branch).toBe(gitSaysBranch(repo));
    expect(execSyncCalls).toBe(0);
  });

  it("reports an unborn branch, where there is a HEAD but no commit", () => {
    // Fresh `git init`: HEAD names a ref that does not exist yet. Git still
    // reports the branch, and so must this.
    const repo = initRepo("unborn", "trunk");

    execSyncCalls = 0;
    const info = getGitInfo(repo);

    expect(info.branch).toBe("trunk");
    expect(info.branch).toBe(gitSaysBranch(repo));
    // An unborn branch is a branch, not a detachment — the flag stays absent.
    expect(info.isDetached).toBeUndefined();
    expect(execSyncCalls).toBe(0);
  });

  it("falls back to main on a detached HEAD, and says that is what it did", () => {
    const repo = initRepo("detached");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const sha = git(["rev-parse", "HEAD"], repo).trim();
    git(["checkout", "-q", sha], repo);

    // Git prints nothing here; the historical contract turns that into "main".
    expect(gitSaysBranch(repo)).toBe("");

    execSyncCalls = 0;
    const info = getGitInfo(repo);

    // `branch` keeps the fallback — it is read across the sidebar, the chat
    // list and the folder header, and re-pointing it is a change of its own.
    // `isDetached` is the flag beside it, so a caller that must not treat
    // "main" as a real current branch can ask. resolveBranch's dirty guard is
    // the first: without this it compared "main" to "main", never fired, and
    // checked out over uncommitted work.
    expect(info).toEqual({ isGitRepo: true, branch: "main", isDetached: true });
    expect(execSyncCalls).toBe(0);
  });

  it("reads a linked worktree's own HEAD, not the main checkout's", () => {
    // The case that would silently report the wrong branch if the pointer in
    // the `.git` *file* were ignored: two directories, one repository, two
    // different branches.
    const repo = initRepo("wt-main");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const wt = join(tmpRoot, "wt-linked");
    git(["worktree", "add", "-q", "-b", "side-branch", wt], repo);

    execSyncCalls = 0;
    const linked = getGitInfo(wt);
    const main = getGitInfo(repo);

    expect(linked.branch).toBe("side-branch");
    expect(linked.branch).toBe(gitSaysBranch(wt));
    expect(main.branch).toBe("main");
    expect(main.branch).toBe(gitSaysBranch(repo));
    expect(execSyncCalls).toBe(0);
  });

  it("reads a submodule's HEAD through the same pointer", () => {
    // A submodule's `.git` is also a file, pointing at `.git/modules/<name>`
    // rather than `.git/worktrees/<slug>`. It holds a HEAD all the same, and it
    // is the one git reads — so following the pointer generically is correct,
    // and resolving it as a *worktree* (which rejects submodules) would not be.
    const inner = initRepo("sub-inner");
    git(["commit", "-q", "--allow-empty", "-m", "init"], inner);
    git(["checkout", "-q", "-b", "sub-branch"], inner);

    const outer = initRepo("sub-outer");
    git(["commit", "-q", "--allow-empty", "-m", "init"], outer);
    git(["-c", "protocol.file.allow=always", "submodule", "-q", "add", inner, "vendor"], outer);

    const subDir = join(outer, "vendor");
    execSyncCalls = 0;
    const info = getGitInfo(subDir);

    expect(info.isGitRepo).toBe(true);
    expect(info.branch).toBe(gitSaysBranch(subDir));
    expect(execSyncCalls).toBe(0);
  });

  it("answers a directory inside a repository with one spawn, not two", () => {
    // No `.git` here, so `rev-parse --git-dir` is the only thing that can decide
    // whether this is a repository at all — that spawn stays. What must not come
    // back is the *second* one: `rev-parse` has already named the directory HEAD
    // lives in, so the branch is read from it rather than asked for again.
    const repo = initRepo("nested");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["checkout", "-q", "-b", "outer-branch"], repo);
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });

    execSyncCalls = 0;
    execSyncPassThrough = true;
    let info;
    try {
      info = getGitInfo(nested);
    } finally {
      execSyncPassThrough = false;
    }

    expect(info).toEqual({ isGitRepo: true, branch: "outer-branch" });
    expect(info.branch).toBe(gitSaysBranch(nested));
    expect(execSyncCalls).toBe(1);
  });

  it("falls back to git when the .git file does not parse", () => {
    // A `.git` file that is not a `gitdir:` pointer: there is no HEAD to read,
    // so the answer has to come from git rather than from a guess.
    const broken = join(tmpRoot, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "this is not a gitdir pointer\n");

    execSyncCalls = 0;
    const info = getGitInfo(broken);

    // `.git` exists, so it is treated as a repo — unchanged from before — and
    // the branch lookup goes to the subprocess.
    expect(info.isGitRepo).toBe(true);
    expect(execSyncCalls).toBeGreaterThan(0);
  });

  it("falls back to git when HEAD is a symref outside refs/heads", () => {
    // Not "no branch" — *no answer from this path*. The two must stay distinct:
    // reporting "main" here would invent a branch git never named.
    const repo = initRepo("odd-head");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const odd = join(tmpRoot, "odd-head-copy");
    cpSync(repo, odd, { recursive: true });
    writeFileSync(join(odd, ".git", "HEAD"), "ref: refs/remotes/origin/main\n");

    execSyncCalls = 0;
    getGitInfo(odd);

    expect(execSyncCalls).toBeGreaterThan(0);
  });

  it("reads a detached HEAD in a sha-256 repository as detached", () => {
    // The 64-character arm of the object-id test. Without it a sha-256 repo's
    // detached HEAD reads as an unparseable file and takes the fallback — which
    // is not a wrong *answer*, but it is a silently lost fast path, and this is
    // the only repository format that produces the second length.
    const repo = join(tmpRoot, "sha256");
    realExecFileSync("git", ["init", "-q", "--object-format=sha256", "-b", "main", repo], { stdio: "pipe" });
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const sha = git(["rev-parse", "HEAD"], repo).trim();
    expect(sha).toHaveLength(64);
    git(["checkout", "-q", sha], repo);

    execSyncCalls = 0;
    const info = getGitInfo(repo);

    expect(gitSaysBranch(repo)).toBe("");
    expect(info).toEqual({ isGitRepo: true, branch: "main", isDetached: true });
    expect(execSyncCalls).toBe(0);
  });

  it("resolves rev-parse's relative answer for a bare repository", () => {
    // A bare repo has no `.git`, so `rev-parse --git-dir` decides — and it
    // answers `.`, relative to the cwd it was run in. Resolving that against the
    // directory is what turns it into a path HEAD can be read from; without the
    // resolve it names the process's cwd and the fast path is lost.
    const bare = join(tmpRoot, "bare.git");
    realExecFileSync("git", ["init", "-q", "--bare", "-b", "bare-branch", bare], { stdio: "pipe" });

    expect(git(["rev-parse", "--git-dir"], bare).trim()).toBe(".");

    execSyncCalls = 0;
    execSyncPassThrough = true;
    let info;
    try {
      info = getGitInfo(bare);
    } finally {
      execSyncPassThrough = false;
    }

    expect(info).toEqual({ isGitRepo: true, branch: "bare-branch" });
    expect(info.branch).toBe(gitSaysBranch(bare));
    // Only the `rev-parse` that decided it is a repository at all.
    expect(execSyncCalls).toBe(1);
  });

  it("follows a .git symlink onto the fast path", () => {
    // `.git` as a symlink to the real git directory is a working checkout.
    // `lstatSync` would call it neither a directory nor a file and hand it to
    // the subprocess — the right answer for an extra spawn. `statSync` follows.
    const repo = initRepo("symlinked");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["checkout", "-q", "-b", "linked-branch"], repo);

    const moved = join(tmpRoot, "symlinked-gitdir");
    renameSync(join(repo, ".git"), moved);
    symlinkSync(moved, join(repo, ".git"));

    execSyncCalls = 0;
    const info = getGitInfo(repo);

    expect(info.branch).toBe("linked-branch");
    expect(info.branch).toBe(gitSaysBranch(repo));
    expect(execSyncCalls).toBe(0);
  });

  it("hands a malformed .git file to git rather than parsing it loosely", () => {
    // Every shape here is one real git refuses, so none of them may be answered
    // from the file — each must reach the subprocess. A permissive parser
    // *succeeds*, which means the fallback never fires and the row shows a
    // confidently wrong branch instead of git's error.
    //
    // The two groups fail git's two different rules, and the second group is
    // the one a "first line, trimmed" parser would wrongly repair.
    const real = initRepo("malformed-real");
    git(["commit", "-q", "--allow-empty", "-m", "init"], real);
    const realGitDir = join(real, ".git");

    const malformed = [
      // Rule 1 — the file must begin with the literal `gitdir: `.
      `gitdir:${realGitDir}\n`, // no space after the colon
      `  gitdir: ${realGitDir}\n`, // leading whitespace
      `gitdir:\n${realGitDir}\n`, // path on the next line
      `# comment\ngitdir: ${realGitDir}\n`, // not at the start of the file
      `GITDIR: ${realGitDir}\n`, // wrong case
      // Rule 2 — the path is the whole remainder, minus trailing \n and \r
      // only. Git keeps what is left and then cannot open it:
      // `fatal: not a git repository: <path>   `.
      `gitdir: ${realGitDir}   \n`, // trailing spaces are part of the path
      `gitdir: ${realGitDir}\nextra\n`, // so is a second line
    ];

    for (const [i, contents] of malformed.entries()) {
      const dir = join(tmpRoot, `malformed-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".git"), contents);

      execSyncCalls = 0;
      getGitInfo(dir);

      expect(execSyncCalls, `shape ${i}: ${JSON.stringify(contents)}`).toBeGreaterThan(0);
    }
  });

  it("accepts a trailing carriage return, because git does", () => {
    // The other half of rule 2, and the reason it is `\n`/`\r` rather than
    // "trailing whitespace": a CRLF-written `.git` file is valid to git and
    // resolves. Stripping nothing would break it; stripping spaces too would
    // wrongly accept the shapes above.
    const real = initRepo("crlf-real");
    git(["commit", "-q", "--allow-empty", "-m", "init"], real);
    git(["checkout", "-q", "-b", "crlf-branch"], real);

    const pointing = join(tmpRoot, "crlf-pointer");
    mkdirSync(pointing, { recursive: true });
    writeFileSync(join(pointing, ".git"), `gitdir: ${join(real, ".git")}\r\n`);

    // Git itself resolves this one, which is what makes it the positive case.
    expect(gitSaysBranch(pointing)).toBe("crlf-branch");

    execSyncCalls = 0;
    const info = getGitInfo(pointing);

    expect(info).toEqual({ isGitRepo: true, branch: "crlf-branch" });
    expect(execSyncCalls).toBe(0);
  });

  it("reports a non-repository as one, without spawning a branch lookup", () => {
    const plain = join(tmpRoot, "not-a-repo");
    mkdirSync(plain, { recursive: true });

    execSyncCalls = 0;
    expect(getGitInfo(plain)).toEqual({ isGitRepo: false });
    // One spawn: `rev-parse --git-dir`, which is how "not a repo" is decided.
    // The stub throws, which is the same signal a real git failure gives.
    expect(execSyncCalls).toBe(1);
  });
});
