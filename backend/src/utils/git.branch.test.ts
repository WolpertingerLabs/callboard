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
 *     per cold listing of 24 folders, and a 295 ms event-loop block every five
 *     minutes when the caller's memo expires — so git.ts's `execFileSync` is
 *     stubbed to throw. A revision that quietly goes back to shelling out does
 *     not fail slowly here, it fails: `getGitInfo` catches the throw and
 *     reports `"main"`, which is the wrong branch in every fixture below that
 *     is not on `main`.
 *
 * The fixtures are built with the *actual* `execFileSync` (`vi.importActual`),
 * so only spawns made by git.ts are counted — that is what separates "used the
 * fast path" from "used git".
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, cpSync, renameSync, symlinkSync, chmodSync } from "node:fs";
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
const { getGitInfo, getGitBranches, tryGetGitBranchesAsync, uniqueBranchName } = await import("./git.js");

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

/** An empty commit on the checked-out branch, committed (not authored) at `date`. */
function commitAt(dir: string, date: string, authored = date): void {
  realExecFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", `at ${date}`], {
    cwd: dir,
    stdio: "pipe",
    env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: authored },
  });
}

/** A branch off `main` with one commit of its own at `date`; leaves `main` checked out. */
function branchCommittedAt(dir: string, name: string, date: string, authored = date): void {
  git(["checkout", "-q", "-b", name, "main"], dir);
  commitAt(dir, date, authored);
  git(["checkout", "-q", "main"], dir);
}

/**
 * The fixture every ordering case below shares. Alphabetical order is
 * `feat/new, main, middle, old/est, tie-a, tie-b` and recency order is not,
 * so neither a missing sort nor a name sort can pass by accident.
 */
function recencyRepo(name: string): string {
  const repo = initRepo(name);
  commitAt(repo, "2020-01-01T00:00:00Z");
  branchCommittedAt(repo, "old/est", "2021-01-01T00:00:00Z");
  branchCommittedAt(repo, "tie-b", "2022-06-01T00:00:00Z");
  branchCommittedAt(repo, "tie-a", "2022-06-01T00:00:00Z");
  branchCommittedAt(repo, "middle", "2023-01-01T00:00:00Z");
  branchCommittedAt(repo, "feat/new", "2024-01-01T00:00:00Z");
  return repo;
}

/** The synchronous listing with its spawn allowed to run, and how many it took. */
function branchesCountingSpawns(dir: string): { branches: string[]; spawns: number } {
  gitSpawns = 0;
  spawnPassThrough = true;
  try {
    return { branches: getGitBranches(dir), spawns: gitSpawns };
  } finally {
    spawnPassThrough = false;
  }
}

/** `uniqueBranchName` with its synchronous spawns allowed to run. */
function uniqueName(dir: string, candidate: string): string {
  spawnPassThrough = true;
  try {
    return uniqueBranchName(dir, candidate);
  } finally {
    spawnPassThrough = false;
  }
}

/** A branch whose ref names a commit that is not in the object store. */
function addBrokenBranch(dir: string, name: string): void {
  mkdirSync(join(dir, ".git", "refs", "heads", name, ".."), { recursive: true });
  writeFileSync(join(dir, ".git", "refs", "heads", name), "1234567890123456789012345678901234567890\n");
}

/**
 * `count` extra branches on `main`'s commit, written straight into
 * `packed-refs` — creating tens of thousands through git would take minutes.
 * Returns their names, sorted.
 */
function addManyBranches(dir: string, count: number, stem: string): string[] {
  const sha = git(["rev-parse", "HEAD"], dir).trim();
  git(["pack-refs", "--all"], dir);
  const names = Array.from({ length: count }, (_, i) => `${stem}-${String(i).padStart(8, "0")}`);
  const refs = [...names, "main"].sort().map((name) => `${sha} refs/heads/${name}\n`);
  writeFileSync(join(dir, ".git", "packed-refs"), "# pack-refs with: peeled fully-peeled sorted \n" + refs.join(""));
  return names;
}

const realGit = realExecFileSync("which", ["git"], { encoding: "utf8" }).trim();
let shims = 0;
/**
 * Run `fn` with a `git` on PATH that misbehaves for one subcommand and is the
 * real git for every other: `"die"` is killed by a signal before it answers,
 * and `"hang"` outlives the caller's timeout.
 */
async function withGitShim<T>(subcommand: string, how: "die" | "hang", fn: () => Promise<T>): Promise<T> {
  const dir = join(tmpRoot, `shim-${shims++}`);
  mkdirSync(dir);
  const misbehave = how === "die" ? "kill -TERM $$" : "exec sleep 30";
  writeFileSync(join(dir, "git"), `#!/bin/bash\nif [ "$1" = "${subcommand}" ]; then ${misbehave}; fi\nexec ${realGit} "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

describe("tryGetGitBranchesAsync: current branch first, then most recently committed", () => {
  it("orders by committer date, newest first, behind the current branch", async () => {
    const repo = recencyRepo("branches-recency");

    // `main` holds the oldest commit of all and still leads: it is checked out.
    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", "feat/new", "middle", "tie-a", "tie-b", "old/est"]);
  });

  it("breaks a tie on the date by name", async () => {
    const repo = initRepo("branches-tie");
    commitAt(repo, "2020-01-01T00:00:00Z");
    // Created in reverse, so creation order cannot be what sorts them.
    for (const name of ["zeta", "Beta", "alpha", "feat/x"]) git(["branch", name], repo);

    // Code-unit order, as the alphabetical listing always was: capitals first.
    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", "Beta", "alpha", "feat/x", "zeta"]);
  });

  it("reads the committer date, not the author date", async () => {
    // A rebase keeps the author date and refreshes the committer date; the
    // branch someone just rebased is the recent one.
    const repo = initRepo("branches-committer");
    commitAt(repo, "2020-01-01T00:00:00Z");
    branchCommittedAt(repo, "rebased-today", "2024-01-01T00:00:00Z", "2019-01-01T00:00:00Z");
    branchCommittedAt(repo, "written-recently", "2023-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", "rebased-today", "written-recently"]);
  });

  it("moves the checked-out branch to the front, whatever its date", async () => {
    const repo = recencyRepo("branches-current");
    git(["checkout", "-q", "old/est"], repo);

    expect(await tryGetGitBranchesAsync(repo)).toEqual(["old/est", "feat/new", "middle", "tie-a", "tie-b", "main"]);
  });

  it("treats a detached HEAD as no current branch — not as main, and not as an entry", async () => {
    // getGitInfo reports a detached HEAD as "main" for historical reasons; that
    // fallback must not leak here, where it would hoist a branch that is not
    // checked out. And `git branch --list`, which this used to run, lists the
    // detachment itself — `(HEAD detached at 1a2b3c4)` — as if it were a branch.
    const repo = recencyRepo("branches-detached");
    git(["checkout", "-q", "--detach", "middle"], repo);

    expect(await tryGetGitBranchesAsync(repo)).toEqual(["feat/new", "middle", "tie-a", "tie-b", "old/est", "main"]);
    expect(branchesCountingSpawns(repo).branches).toEqual(["feat/new", "main", "middle", "old/est", "tie-a", "tie-b"]);
  });

  it("uses a linked worktree's own branch, not the main checkout's", async () => {
    const repo = recencyRepo("branches-wt-main");
    const wt = join(tmpRoot, "branches-wt-linked");
    git(["worktree", "add", "-q", wt, "old/est"], repo);

    // Same repository, same dates: the two differ only in which branch leads.
    expect(await tryGetGitBranchesAsync(wt)).toEqual(["old/est", "feat/new", "middle", "tie-a", "tie-b", "main"]);
    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", "feat/new", "middle", "tie-a", "tie-b", "old/est"]);
  });

  it("answers from a subdirectory as it does from the root", async () => {
    const repo = recencyRepo("branches-nested");
    git(["checkout", "-q", "middle"], repo);
    const nested = join(repo, "sub", "deeper");
    mkdirSync(nested, { recursive: true });

    expect(await tryGetGitBranchesAsync(nested)).toEqual(["middle", "feat/new", "tie-a", "tie-b", "old/est", "main"]);
  });

  it("names a branch that shares its name with a tag as the branch, not as heads/<name>", async () => {
    // `%(refname:short)` disambiguates such a branch to `heads/feat/x`, which is
    // not its name: nothing the picker or uniqueBranchName compares would match.
    const repo = initRepo("branches-tag-clash");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["branch", "feat/x"], repo);
    git(["tag", "feat/x"], repo);
    git(["tag", "main"], repo);

    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", "feat/x"]);
    expect(branchesCountingSpawns(repo).branches).toEqual(["main", "feat/x"]);
  });

  it("makes no synchronous spawn", async () => {
    const repo = recencyRepo("branches-async");
    gitSpawns = 0;
    await tryGetGitBranchesAsync(repo);
    expect(gitSpawns).toBe(0);
  });
});

/**
 * `[]` is a verdict and `null` is the lack of one. The route shows the first as
 * an empty repository and answers the second with an error, so each failure has
 * to land on the right side.
 */
describe("tryGetGitBranchesAsync tells no branches from no answer", () => {
  it("is [] where git answers that there is nothing: unborn, not a repository, missing", async () => {
    expect(await tryGetGitBranchesAsync(initRepo("verdict-unborn"))).toEqual([]);
    const plain = join(tmpRoot, "verdict-not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(await tryGetGitBranchesAsync(plain)).toEqual([]);
    expect(await tryGetGitBranchesAsync(join(tmpRoot, "verdict-missing"))).toEqual([]);
  });

  it("is null when git is killed before it answers", async () => {
    const repo = recencyRepo("verdict-killed");
    expect(await withGitShim("for-each-ref", "die", () => tryGetGitBranchesAsync(repo))).toBeNull();
  });

  it("is null when git cannot be run at all", async () => {
    const repo = recencyRepo("verdict-no-git");
    const empty = join(tmpRoot, "verdict-empty-path");
    mkdirSync(empty);
    const path = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(await tryGetGitBranchesAsync(repo)).toBeNull();
    } finally {
      process.env.PATH = path;
    }
  });

  it("is null when git outlives the timeout, without trying the fallback", async () => {
    const repo = recencyRepo("verdict-timeout");
    const started = Date.now();
    expect(await withGitShim("for-each-ref", "hang", () => tryGetGitBranchesAsync(repo))).toBeNull();
    // One 5s timeout, not two: the names-only listing would wait on the same git.
    expect(Date.now() - started).toBeLessThan(9000);
  }, 20_000);
});

/**
 * Printing a commit date makes git open every branch's commit, so one ref
 * naming a missing object fails the whole dated listing with exit 128. The
 * `git branch --list` this replaced never opened it and listed every branch.
 */
describe("a branch whose commit is missing", () => {
  function brokenRepo(name: string): string {
    const repo = recencyRepo(name);
    addBrokenBranch(repo, "broken");
    addBrokenBranch(repo, "feat/broken-too");
    // The premise: the dated listing really does fail here.
    expect(() => git(["for-each-ref", "--format=%(committerdate:unix) %(refname)", "refs/heads"], repo)).toThrow(/missing object/);
    return repo;
  }

  it("still lists every branch, the broken ones included, by name behind the current one", async () => {
    const repo = brokenRepo("broken-ref");

    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", "broken", "feat/broken-too", "feat/new", "middle", "old/est", "tie-a", "tie-b"]);
    expect(branchesCountingSpawns(repo)).toEqual({
      branches: ["main", "broken", "feat/broken-too", "feat/new", "middle", "old/est", "tie-a", "tie-b"],
      spawns: 1,
    });
  });

  it("keeps uniqueBranchName's collision check against local branches", () => {
    const repo = brokenRepo("broken-ref-unique");

    expect(uniqueName(repo, "middle")).not.toBe("middle");
    expect(uniqueName(repo, "broken")).not.toBe("broken");
    expect(uniqueName(repo, "not-taken")).toBe("not-taken");
  });
});

/**
 * Past the output buffer a listing used to be `[]`: no branches at all, rather
 * than fewer. The dated lines are the longer ones, so that listing overflows
 * first — and must fall back, not vanish.
 */
describe("more branches than the output buffer holds", () => {
  it("falls back to the names-only listing when the dated one overflows", async () => {
    const repo = initRepo("overflow-dated");
    commitAt(repo, "2020-01-01T00:00:00Z");
    const names = addManyBranches(repo, 20_000, "branch-with-a-fairly-long-name");
    // The premise: the dated listing is over the 1 MB default, the old command's was not.
    expect(
      realExecFileSync("git", ["for-each-ref", "--format=%(HEAD)%(committerdate:unix) %(refname)", "refs/heads"], { cwd: repo, maxBuffer: 1e8 }).length,
    ).toBeGreaterThan(1024 * 1024);
    expect(realExecFileSync("git", ["branch", "--list", "--format=%(refname:short)"], { cwd: repo, maxBuffer: 1e8 }).length).toBeLessThan(1024 * 1024);

    expect(await tryGetGitBranchesAsync(repo)).toEqual(["main", ...names]);
    expect(branchesCountingSpawns(repo).branches).toEqual(["main", ...names]);
    expect(uniqueName(repo, names[12_345])).not.toBe(names[12_345]);
  }, 30_000);

  it("is no answer, not an empty repository, when even the names do not fit", async () => {
    const repo = initRepo("overflow-names");
    commitAt(repo, "2020-01-01T00:00:00Z");
    addManyBranches(repo, 80_000, "a-branch-name-long-enough-to-fill-the-buffer-quickly");

    expect(await tryGetGitBranchesAsync(repo)).toBeNull();
  }, 30_000);
});

describe("getGitBranches lists names for uniqueBranchName in one spawn", () => {
  it("puts the checked-out branch first and the rest in name order, whatever their dates", () => {
    const repo = recencyRepo("names-plain");
    git(["checkout", "-q", "old/est"], repo);

    expect(branchesCountingSpawns(repo)).toEqual({ branches: ["old/est", "feat/new", "main", "middle", "tie-a", "tie-b"], spawns: 1 });
  });

  it("lists the same branches as the dated listing, from a linked worktree and a subdirectory too", async () => {
    const repo = recencyRepo("names-same-set");
    const wt = join(tmpRoot, "names-same-set-linked");
    git(["worktree", "add", "-q", wt, "tie-a"], repo);
    const nested = join(repo, "sub");
    mkdirSync(nested, { recursive: true });

    for (const dir of [repo, wt, nested]) {
      const { branches, spawns } = branchesCountingSpawns(dir);
      const dated = (await tryGetGitBranchesAsync(dir))!;
      expect(spawns).toBe(1);
      expect(branches[0]).toBe(dated[0]);
      expect([...branches].sort()).toEqual([...dated].sort());
    }
    expect(branchesCountingSpawns(wt).branches[0]).toBe("tie-a");
  });

  it("lists a branch whose name contains quotes verbatim", () => {
    // The shell-string form needed a `'` strip that also mangled this name.
    const repo = initRepo("names-quotes");
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    git(["branch", "'quoted'"], repo);

    expect(branchesCountingSpawns(repo).branches).toEqual(["main", "'quoted'"]);
  });

  it("is empty for an unborn branch, a directory that is not a repository, and one that does not exist", () => {
    expect(branchesCountingSpawns(initRepo("names-unborn")).branches).toEqual([]);
    const plain = join(tmpRoot, "names-not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(branchesCountingSpawns(plain).branches).toEqual([]);
    expect(branchesCountingSpawns(join(tmpRoot, "names-missing")).branches).toEqual([]);
  });
});
