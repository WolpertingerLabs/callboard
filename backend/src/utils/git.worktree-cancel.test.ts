/**
 * Creating a worktree is a full checkout, and on a large repository it outlives
 * git's usual 10s budget. These cases pin the three things that path promises:
 * it runs against {@link WORKTREE_CREATE_TIMEOUT_MS} rather than the default,
 * it does not hold the event loop while it runs, and a cancelled (or timed-out)
 * checkout kills git and leaves nothing behind that the call itself made.
 *
 * The checkout is made slow on purpose with a smudge filter that sleeps per
 * file — the same shape as the LFS filters and hooks that make real checkouts
 * slow, down to running in a child process git itself spawns. Each filter
 * invocation records its pid, which is how "git was killed" is checked: the
 * filter processes are git's children, and a kill that reached only git would
 * leave them running.
 *
 * The timeout is shrunk for the suite through the shared constant itself, so a
 * case that times out at that value is evidence the worktree path reads it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A whole number of seconds, so the "timed out after Ns" message is exact.
const TEST_TIMEOUT_MS = 2000;

vi.mock("shared/types/index.js", async (importActual) => ({
  ...(await importActual<typeof import("shared/types/index.js")>()),
  WORKTREE_CREATE_TIMEOUT_MS: TEST_TIMEOUT_MS,
}));

// The real tree kill, observed: it is what makes cancel and timeout work on
// Windows too (`taskkill /T`, where `process.kill(-pid)` throws).
const treeKill = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./tree-kill.js", async (importActual) => {
  const actual = await importActual<typeof import("./tree-kill.js")>();
  return {
    ...actual,
    killProcessTree: (...args: Parameters<typeof actual.killProcessTree>) => {
      treeKill.calls++;
      return actual.killProcessTree(...args);
    },
  };
});

const { WORKTREE_CREATE_TIMEOUT_MS: SHARED_TIMEOUT_MS } = await vi.importActual<typeof import("shared/types/index.js")>("shared/types/index.js");
const { ensureWorktreeDetailed, getGitWorktrees, isAbortError, resolveBranch } = await import("./git.js");

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-git-worktree-cancel-")));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

function localBranches(repoDir: string): string[] {
  return git(["branch", "--list", "--format=%(refname:short)"], repoDir).split("\n").filter(Boolean).sort();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A repository whose checkout takes about `files × delay` seconds, and the file
 * its smudge filter appends each invocation's pid to.
 */
function makeSlowRepo(name: string, { files = 40, delay = 0.1 } = {}): { dir: string; pidFile: string } {
  const parent = mkdtempSync(join(tmpRoot, `${name}-`));
  const dir = join(parent, "repo");
  const pidFile = join(parent, "filter-pids");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=slow\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  // Set after the commit, so only checkouts pay for it.
  git(["config", "filter.slow.smudge", `echo $$ >> '${pidFile}'; sleep ${delay}; cat`], dir);
  return { dir, pidFile };
}

function filterPids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const worktreeOf = (dir: string, branch: string) => join(dirname(dir), `repo.${branch.replace(/\//g, "-")}`);

describe("worktree creation timeout", () => {
  it("is 60s, from the one constant the frontend also reads", () => {
    expect(SHARED_TIMEOUT_MS).toBe(60_000);
  });

  it("checkouts are held to WORKTREE_CREATE_TIMEOUT_MS, then killed and cleaned up", async () => {
    // ~8s of checkout against the suite's 2s budget.
    const { dir, pidFile } = makeSlowRepo("timeout", { files: 80, delay: 0.1 });
    const started = Date.now();
    const killsBefore = treeKill.calls;

    await expect(ensureWorktreeDetailed(dir, "feat/slow", true, "main")).rejects.toThrow(/^git worktree add timed out after 2s$/);

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 50);
    // Well short of the full checkout: the timeout ended it, not git. Loose,
    // for CI machines that run this a couple of times slower.
    expect(elapsed).toBeLessThan(6000);
    expect(treeKill.calls).toBe(killsBefore + 1);
    expect(existsSync(worktreeOf(dir, "feat/slow"))).toBe(false);
    expect(getGitWorktrees(dir)).toHaveLength(1);
    expect(localBranches(dir)).toEqual(["main"]);
    expect(filterPids(pidFile).filter(alive)).toEqual([]);
  }, 15_000); // above vitest's 5s default, so the 6s bound is what fails a slow timeout

  it("a checkout inside the budget completes — longer than it takes is not a failure", async () => {
    // ~0.2s, a tenth of the 2s budget — room for a CI machine several times
    // slower. The old 10s default would also pass this; what it pins is that
    // the async path finishes and reports normally.
    const { dir } = makeSlowRepo("fits", { files: 2, delay: 0.1 });
    const ensured = await ensureWorktreeDetailed(dir, "feat/fits", true, "main");
    expect(ensured).toEqual({ path: worktreeOf(dir, "feat/fits"), created: true, branchCreated: true, isMainCheckout: false });
    expect(readFileSync(join(ensured.path, "f1.txt"), "utf8")).toBe("1\n");
  });

  it("does not block the event loop while git checks out", async () => {
    const { dir } = makeSlowRepo("nonblocking", { files: 5, delay: 0.1 });
    let ticks = 0;
    const interval = setInterval(() => ticks++, 25);
    try {
      await ensureWorktreeDetailed(dir, "feat/loop", true, "main");
    } finally {
      clearInterval(interval);
    }
    // ~0.5s of checkout at 25ms — a synchronous spawn would allow none.
    expect(ticks).toBeGreaterThan(5);
  });
});

describe("cancelling worktree creation", () => {
  it("kills git and its children, and removes the half-made worktree and branch", async () => {
    const { dir, pidFile } = makeSlowRepo("abort", { files: 40, delay: 0.1 });
    const controller = new AbortController();
    const pending = ensureWorktreeDetailed(dir, "feat/cancelled", true, "main", { signal: controller.signal });

    // Abort mid-checkout: the directory exists and some files are through the filter.
    await until(() => filterPids(pidFile).length >= 2);
    expect(existsSync(worktreeOf(dir, "feat/cancelled"))).toBe(true);
    const killsBefore = treeKill.calls;
    controller.abort();

    const err = await pending.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(treeKill.calls).toBe(killsBefore + 1);
    expect(existsSync(worktreeOf(dir, "feat/cancelled"))).toBe(false);
    expect(getGitWorktrees(dir).map((wt) => wt.branch)).toEqual(["main"]);
    expect(localBranches(dir)).toEqual(["main"]);
    // No filter process outlives the cancel, and none starts after it.
    expect(filterPids(pidFile).filter(alive)).toEqual([]);
    const seen = filterPids(pidFile).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(filterPids(pidFile).length).toBe(seen);
    expect(seen).toBeLessThan(40);
  });

  it("keeps a branch it did not create — only the worktree was this call's", async () => {
    const { dir, pidFile } = makeSlowRepo("abort-existing", { files: 40, delay: 0.1 });
    git(["branch", "feat/existing"], dir);
    const controller = new AbortController();
    // `createBranch: true` on a branch that already exists checks it out instead.
    const pending = ensureWorktreeDetailed(dir, "feat/existing", true, "main", { signal: controller.signal });
    await until(() => filterPids(pidFile).length >= 1);
    controller.abort();

    expect(isAbortError(await pending.catch((e: unknown) => e))).toBe(true);
    expect(existsSync(worktreeOf(dir, "feat/existing"))).toBe(false);
    expect(localBranches(dir)).toEqual(["feat/existing", "main"]);
  });

  it("an already-aborted signal makes nothing at all", async () => {
    const { dir, pidFile } = makeSlowRepo("pre-aborted", { files: 2, delay: 0 });
    const controller = new AbortController();
    controller.abort();

    const err = await resolveBranch({ folder: dir, newBranch: "feat/never", baseBranch: "main", useWorktree: true, signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(isAbortError(err)).toBe(true);
    expect(existsSync(worktreeOf(dir, "feat/never"))).toBe(false);
    expect(localBranches(dir)).toEqual(["main"]);
    expect(filterPids(pidFile)).toEqual([]);
  });

  it("resolveBranch forwards its signal to the checkout", async () => {
    const { dir } = makeSlowRepo("resolve-abort", { files: 40, delay: 0.1 });
    const controller = new AbortController();
    const pending = resolveBranch({ folder: dir, newBranch: "feat/via-resolve", baseBranch: "main", useWorktree: true, signal: controller.signal });
    await until(() => existsSync(worktreeOf(dir, "feat/via-resolve")));
    controller.abort();

    expect(isAbortError(await pending.catch((e: unknown) => e))).toBe(true);
    expect(existsSync(worktreeOf(dir, "feat/via-resolve"))).toBe(false);
    expect(localBranches(dir)).toEqual(["main"]);
  });

  it("a git failure of its own still reports git's message, and leaves nothing behind", async () => {
    const { dir } = makeSlowRepo("bad-base", { files: 1, delay: 0 });
    await expect(ensureWorktreeDetailed(dir, "feat/bad", true, "no-such-base")).rejects.toThrow(/no-such-base/);
    expect(existsSync(worktreeOf(dir, "feat/bad"))).toBe(false);
    expect(localBranches(dir)).toEqual(["main"]);
  });
});

/**
 * Two requests for one branch. While the add was synchronous, "does the
 * directory exist?" and "make it" could not be split; now that the checkout
 * yields they can, and the second request must wait for the first instead of
 * reusing a half checkout or tearing it down.
 */
describe("concurrent creation of one worktree", () => {
  it("a second call started mid-checkout waits, then reuses the finished worktree", async () => {
    const { dir } = makeSlowRepo("concurrent-late", { files: 10, delay: 0.05 });
    const path = worktreeOf(dir, "feat/shared");
    const first = ensureWorktreeDetailed(dir, "feat/shared", true, "main");
    await until(() => existsSync(path));
    const second = ensureWorktreeDetailed(dir, "feat/shared", true, "main").then((r) => ({ r, files: readdirSync(path).length }));

    const [a, b] = await Promise.all([first, second]);
    expect(a.created).toBe(true);
    expect(b.r).toEqual({ path, created: false, branchCreated: false, isMainCheckout: false });
    // Complete when the second call got it: 10 files plus .gitattributes and .git.
    expect(b.files).toBe(12);
  });

  it("two calls in the same tick: one creates, the other reuses, nothing is torn down", async () => {
    const { dir } = makeSlowRepo("concurrent-same-tick", { files: 10, delay: 0.05 });
    const path = worktreeOf(dir, "feat/twin");
    const results = await Promise.allSettled([ensureWorktreeDetailed(dir, "feat/twin", true, "main"), ensureWorktreeDetailed(dir, "feat/twin", true, "main")]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ created: boolean }>).value.created);
    expect(values).toEqual([true, false]);
    expect(readdirSync(path)).toHaveLength(12);
    expect(localBranches(dir)).toEqual(["feat/twin", "main"]);
  });

  it("if the first is cancelled, the waiting second creates the worktree afresh", async () => {
    const { dir, pidFile } = makeSlowRepo("concurrent-retry", { files: 20, delay: 0.05 });
    const path = worktreeOf(dir, "feat/retry");
    const controller = new AbortController();
    const first = ensureWorktreeDetailed(dir, "feat/retry", true, "main", { signal: controller.signal });
    await until(() => filterPids(pidFile).length >= 1);
    const second = ensureWorktreeDetailed(dir, "feat/retry", true, "main");
    controller.abort();

    expect(isAbortError(await first.catch((e: unknown) => e))).toBe(true);
    expect(await second).toEqual({ path, created: true, branchCreated: true, isMainCheckout: false });
    expect(readdirSync(path)).toHaveLength(22);
  });

  it("a waiter cancelled while it waits leaves the first call alone", async () => {
    const { dir } = makeSlowRepo("concurrent-waiter-abort", { files: 10, delay: 0.05 });
    const path = worktreeOf(dir, "feat/wait");
    const first = ensureWorktreeDetailed(dir, "feat/wait", true, "main");
    await until(() => existsSync(path));
    const controller = new AbortController();
    const second = ensureWorktreeDetailed(dir, "feat/wait", true, "main", { signal: controller.signal });
    controller.abort();

    expect(isAbortError(await second.catch((e: unknown) => e))).toBe(true);
    expect((await first).created).toBe(true);
    expect(readdirSync(path)).toHaveLength(12);
  });
});

/**
 * Cleanup is for a checkout *we* killed. When git fails on its own it has
 * already undone its half, and what it refused may be someone else's — here,
 * another process creating the same directory between our existence check and
 * git's (played by a `git` wrapper on PATH that makes the directory first).
 */
describe("a git that fails on its own", () => {
  it("is not cleaned up after: the directory it refused is not ours to remove", async () => {
    const { dir } = makeSlowRepo("not-ours", { files: 1, delay: 0 });
    const path = worktreeOf(dir, "feat/contested");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const binDir = mkdtempSync(join(tmpRoot, "bin-"));
    writeFileSync(
      join(binDir, "git"),
      `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then mkdir -p '${path}' && echo theirs > '${path}/theirs.txt'; fi\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(join(binDir, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath}`;
    try {
      await expect(ensureWorktreeDetailed(dir, "feat/contested", true, "main")).rejects.toThrow(/already exists/);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(readFileSync(join(path, "theirs.txt"), "utf8")).toBe("theirs\n");
  });
});
