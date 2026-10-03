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
 *     when the caller's memo expires — so git.ts's `execFileSync` is stubbed to
 *     throw. A revision that quietly goes back to shelling out does not fail
 *     slowly here, it fails: `getGitInfo` catches the throw and reports
 *     `"main"`, which is the wrong branch in every fixture below that is not on
 *     `main`.
 *
 * The fixtures are built with the *actual* `execFileSync` (`vi.importActual`),
 * so only spawns made by git.ts are counted — that is what separates "used the
 * fast path" from "used git".
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, cpSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set by the mock below; asserted to stay at zero on the fast path. */
let gitSpawns = 0;
/**
 * Let the counted spawns actually run. Off by default so a regression that
 * shells out is loud rather than merely slow; on for the fallback cases, where
 * the spawn is the correct behaviour and the question is how *many*.
 */
let spawnPassThrough = false;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      gitSpawns++;
      if (spawnPassThrough) return actual.execFileSync(...args);
      throw new Error(`execFileSync called: ${String(args[0])} ${JSON.stringify(args[1])}`);
    },
  };
});

const { execFileSync: realExecFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const { getGitInfo, getGitBranches } = await import("./git.js");

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

    gitSpawns = 0;
    const info = getGitInfo(repo);

    expect(info).toEqual({ isGitRepo: true, branch: "some-branch" });
    expect(info.branch).toBe(gitSaysBranch(repo));
    expect(gitSpawns).toBe(0);
  });

  it("keeps the slashes in a branch name", () => {
    // `refs/heads/feat/x` — the decode has to take everything after
    // `refs/heads/`, not up to the next slash.
    const repo = initRepo("slashes");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["checkout", "-q", "-b", "feat/deeply/nested"], repo);

    gitSpawns = 0;
    const info = getGitInfo(repo);

    expect(info.branch).toBe("feat/deeply/nested");
    expect(info.branch).toBe(gitSaysBranch(repo));
    expect(gitSpawns).toBe(0);
  });

  it("reports an unborn branch, where there is a HEAD but no commit", () => {
    // Fresh `git init`: HEAD names a ref that does not exist yet. Git still
    // reports the branch, and so must this.
    const repo = initRepo("unborn", "trunk");

    gitSpawns = 0;
    const info = getGitInfo(repo);

    expect(info.branch).toBe("trunk");
    expect(info.branch).toBe(gitSaysBranch(repo));
    // An unborn branch is a branch, not a detachment — the flag stays absent.
    expect(info.isDetached).toBeUndefined();
    expect(gitSpawns).toBe(0);
  });

  it("falls back to main on a detached HEAD, and says that is what it did", () => {
    const repo = initRepo("detached");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const sha = git(["rev-parse", "HEAD"], repo).trim();
    git(["checkout", "-q", sha], repo);

    // Git prints nothing here; the historical contract turns that into "main".
    expect(gitSaysBranch(repo)).toBe("");

    gitSpawns = 0;
    const info = getGitInfo(repo);

    // `branch` keeps the fallback — it is read across the sidebar, the chat
    // list and the folder header, and re-pointing it is a change of its own.
    // `isDetached` is the flag beside it, so a caller that must not treat
    // "main" as a real current branch can ask. resolveBranch's dirty guard is
    // the first: without this it compared "main" to "main", never fired, and
    // checked out over uncommitted work.
    expect(info).toEqual({ isGitRepo: true, branch: "main", isDetached: true });
    expect(gitSpawns).toBe(0);
  });

  it("reads a linked worktree's own HEAD, not the main checkout's", () => {
    // The case that would silently report the wrong branch if the pointer in
    // the `.git` *file* were ignored: two directories, one repository, two
    // different branches.
    const repo = initRepo("wt-main");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const wt = join(tmpRoot, "wt-linked");
    git(["worktree", "add", "-q", "-b", "side-branch", wt], repo);

    gitSpawns = 0;
    const linked = getGitInfo(wt);
    const main = getGitInfo(repo);

    expect(linked.branch).toBe("side-branch");
    expect(linked.branch).toBe(gitSaysBranch(wt));
    expect(main.branch).toBe("main");
    expect(main.branch).toBe(gitSaysBranch(repo));
    expect(gitSpawns).toBe(0);
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
    gitSpawns = 0;
    const info = getGitInfo(subDir);

    expect(info.isGitRepo).toBe(true);
    expect(info.branch).toBe(gitSaysBranch(subDir));
    expect(gitSpawns).toBe(0);
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

    gitSpawns = 0;
    spawnPassThrough = true;
    let info;
    try {
      info = getGitInfo(nested);
    } finally {
      spawnPassThrough = false;
    }

    expect(info).toEqual({ isGitRepo: true, branch: "outer-branch" });
    expect(info.branch).toBe(gitSaysBranch(nested));
    expect(gitSpawns).toBe(1);
  });

  it("falls back to git when the .git file does not parse", () => {
    // A `.git` file that is not a `gitdir:` pointer: there is no HEAD to read,
    // so the answer has to come from git rather than from a guess.
    const broken = join(tmpRoot, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "this is not a gitdir pointer\n");

    gitSpawns = 0;
    const info = getGitInfo(broken);

    // `.git` exists, so it is treated as a repo — unchanged from before — and
    // the branch lookup goes to the subprocess.
    expect(info.isGitRepo).toBe(true);
    expect(gitSpawns).toBeGreaterThan(0);
  });

  it("falls back to git when HEAD is a symref outside refs/heads", () => {
    // Not "no branch" — *no answer from this path*. The two must stay distinct:
    // reporting "main" here would invent a branch git never named.
    const repo = initRepo("odd-head");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const odd = join(tmpRoot, "odd-head-copy");
    cpSync(repo, odd, { recursive: true });
    writeFileSync(join(odd, ".git", "HEAD"), "ref: refs/remotes/origin/main\n");

    gitSpawns = 0;
    getGitInfo(odd);

    expect(gitSpawns).toBeGreaterThan(0);
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

    gitSpawns = 0;
    const info = getGitInfo(repo);

    expect(gitSaysBranch(repo)).toBe("");
    expect(info).toEqual({ isGitRepo: true, branch: "main", isDetached: true });
    expect(gitSpawns).toBe(0);
  });

  it("resolves rev-parse's relative answer for a bare repository", () => {
    // A bare repo has no `.git`, so `rev-parse --git-dir` decides — and it
    // answers `.`, relative to the cwd it was run in. Resolving that against the
    // directory is what turns it into a path HEAD can be read from; without the
    // resolve it names the process's cwd and the fast path is lost.
    const bare = join(tmpRoot, "bare.git");
    realExecFileSync("git", ["init", "-q", "--bare", "-b", "bare-branch", bare], { stdio: "pipe" });

    expect(git(["rev-parse", "--git-dir"], bare).trim()).toBe(".");

    gitSpawns = 0;
    spawnPassThrough = true;
    let info;
    try {
      info = getGitInfo(bare);
    } finally {
      spawnPassThrough = false;
    }

    expect(info).toEqual({ isGitRepo: true, branch: "bare-branch" });
    expect(info.branch).toBe(gitSaysBranch(bare));
    // Only the `rev-parse` that decided it is a repository at all.
    expect(gitSpawns).toBe(1);
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

    gitSpawns = 0;
    const info = getGitInfo(repo);

    expect(info.branch).toBe("linked-branch");
    expect(info.branch).toBe(gitSaysBranch(repo));
    expect(gitSpawns).toBe(0);
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

      gitSpawns = 0;
      getGitInfo(dir);

      expect(gitSpawns, `shape ${i}: ${JSON.stringify(contents)}`).toBeGreaterThan(0);
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

    gitSpawns = 0;
    const info = getGitInfo(pointing);

    expect(info).toEqual({ isGitRepo: true, branch: "crlf-branch" });
    expect(gitSpawns).toBe(0);
  });

  it("reports a non-repository as one, without spawning a branch lookup", () => {
    const plain = join(tmpRoot, "not-a-repo");
    mkdirSync(plain, { recursive: true });

    gitSpawns = 0;
    expect(getGitInfo(plain)).toEqual({ isGitRepo: false });
    // One spawn: `rev-parse --git-dir`, which is how "not a repo" is decided.
    // The stub throws, which is the same signal a real git failure gives.
    expect(gitSpawns).toBe(1);
  });
});

describe("getGitInfo remembers where a nested directory's repository is", () => {
  /** Ten calls with real git underneath, counting git.ts's spawns. */
  function tenCalls(dir: string) {
    gitSpawns = 0;
    spawnPassThrough = true;
    try {
      return Array.from({ length: 10 }, () => getGitInfo(dir));
    } finally {
      spawnPassThrough = false;
    }
  }

  it("spawns rev-parse once per directory, not once per call, and still sees a branch switch", () => {
    // findChat calls this about every 250 ms while a chat streams. Measured
    // before the cache: 10 spawns for these 10 calls.
    const repo = initRepo("rev-parse-cache");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const nested = join(repo, "pkg", "src");
    mkdirSync(nested, { recursive: true });

    const infos = tenCalls(nested);
    expect(infos.every((info) => info.isGitRepo && info.branch === "main")).toBe(true);
    expect(gitSpawns).toBe(1);

    // HEAD is still read every call: the switch shows up at once, unspawned.
    git(["checkout", "-q", "-b", "switched"], repo);
    gitSpawns = 0;
    expect(getGitInfo(nested)).toEqual({ isGitRepo: true, branch: "switched" });
    expect(gitSpawns).toBe(0);
  });

  it("caches git's 'not a repository' verdict per directory", () => {
    const plain = join(tmpRoot, "not-a-repo-cached");
    mkdirSync(plain, { recursive: true });

    expect(tenCalls(plain).every((info) => !info.isGitRepo)).toBe(true);
    expect(gitSpawns).toBe(1);
  });

  it("forgets 'not a repository' after 30 seconds, so git init in a parent shows up", () => {
    const parent = join(tmpRoot, "init-later");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      tenCalls(child);
      expect(gitSpawns).toBe(1);

      realExecFileSync("git", ["init", "-q", "-b", "late", parent], { stdio: "pipe" });
      now.mockReturnValue(start + 29_000);
      expect(tenCalls(child).every((info) => !info.isGitRepo)).toBe(true);
      expect(gitSpawns).toBe(0);

      now.mockReturnValue(start + 31_000);
      expect(tenCalls(child)[0]).toEqual({ isGitRepo: true, branch: "late" });
      expect(gitSpawns).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it("does not cache a failure that is not git's verdict", () => {
    // The stub throws without an exit status — a timeout or a missing git
    // says nothing about the directory, so it must be asked again.
    const plain = join(tmpRoot, "not-a-repo-uncached");
    mkdirSync(plain, { recursive: true });

    gitSpawns = 0;
    getGitInfo(plain);
    getGitInfo(plain);
    expect(gitSpawns).toBe(2);
  });

  it("asks again once the cached repository is gone", () => {
    const repo = initRepo("rev-parse-gone");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const nested = join(repo, "inner");
    mkdirSync(nested, { recursive: true });
    tenCalls(nested);

    rmSync(join(repo, ".git"), { recursive: true, force: true });
    gitSpawns = 0;
    spawnPassThrough = true;
    try {
      // tmpRoot is under the OS temp dir, which is not itself a repository.
      expect(getGitInfo(nested)).toEqual({ isGitRepo: false });
    } finally {
      spawnPassThrough = false;
    }
    expect(gitSpawns).toBe(1);
  });
});

describe("getGitBranches puts the current branch first, read from HEAD", () => {
  /** The listing itself always spawns; the current branch should not. */
  function branchesCountingSpawns(dir: string): { branches: string[]; spawns: number } {
    gitSpawns = 0;
    spawnPassThrough = true;
    try {
      return { branches: getGitBranches(dir), spawns: gitSpawns };
    } finally {
      spawnPassThrough = false;
    }
  }

  it("moves the checked-out branch to the front with one spawn", () => {
    const repo = initRepo("branches-plain");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["branch", "aaa"], repo);
    git(["checkout", "-q", "-b", "zzz"], repo);

    const { branches, spawns } = branchesCountingSpawns(repo);

    expect(branches).toEqual(["zzz", "aaa", "main"]);
    expect(spawns).toBe(1);
  });

  it("treats a detached HEAD as no current branch — not as main", () => {
    // getGitInfo reports a detached HEAD as "main" for historical reasons; that
    // fallback must not leak here, where it would hoist a branch that is not
    // checked out.
    const repo = initRepo("branches-detached");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["branch", "aaa"], repo);
    git(["checkout", "-q", git(["rev-parse", "HEAD"], repo).trim()], repo);

    const { branches, spawns } = branchesCountingSpawns(repo);

    // `git branch --list` itself lists the detachment as a pseudo-entry (it
    // always has); it sorts first on its own, and nothing is hoisted over it.
    expect(branches).toEqual([expect.stringMatching(/^\(HEAD detached at [0-9a-f]+\)$/), "aaa", "main"]);
    expect(spawns).toBe(1);
  });

  it("uses a linked worktree's own branch, not the main checkout's", () => {
    const repo = initRepo("branches-wt-main");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const wt = join(tmpRoot, "branches-wt-linked");
    git(["worktree", "add", "-q", "-b", "side", wt], repo);

    const linked = branchesCountingSpawns(wt);
    const main = branchesCountingSpawns(repo);

    expect(linked.branches).toEqual(["side", "main"]);
    expect(linked.spawns).toBe(1);
    expect(main.branches).toEqual(["main", "side"]);
    expect(main.spawns).toBe(1);
  });

  it("falls back to git from a subdirectory, which has no HEAD of its own", () => {
    const repo = initRepo("branches-nested");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["checkout", "-q", "-b", "outer"], repo);
    const nested = join(repo, "sub");
    mkdirSync(nested, { recursive: true });

    const { branches, spawns } = branchesCountingSpawns(nested);

    expect(branches).toEqual(["outer", "main"]);
    expect(spawns).toBe(2);
  });

  it("lists a branch whose name contains quotes verbatim", () => {
    // The shell-string form needed a `'` strip that also mangled this name.
    const repo = initRepo("branches-quotes");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["branch", "'quoted'"], repo);

    expect(branchesCountingSpawns(repo).branches).toEqual(["main", "'quoted'"]);
  });
});
