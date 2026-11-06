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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TEST_TIMEOUT_MS = 1500;

vi.mock("shared/types/index.js", async (importActual) => ({
  ...(await importActual<typeof import("shared/types/index.js")>()),
  WORKTREE_CREATE_TIMEOUT_MS: TEST_TIMEOUT_MS,
}));

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
    // ~4s of checkout against the suite's 1.5s budget.
    const { dir, pidFile } = makeSlowRepo("timeout", { files: 40, delay: 0.1 });
    const started = Date.now();

    await expect(ensureWorktreeDetailed(dir, "feat/slow", true, "main")).rejects.toThrow(/worktree add timed out after 2s/);

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 50);
    // Well short of the full checkout: the timeout ended it, not git.
    expect(elapsed).toBeLessThan(3500);
    expect(existsSync(worktreeOf(dir, "feat/slow"))).toBe(false);
    expect(getGitWorktrees(dir)).toHaveLength(1);
    expect(localBranches(dir)).toEqual(["main"]);
    expect(filterPids(pidFile).filter(alive)).toEqual([]);
  });

  it("a checkout inside the budget completes — longer than it takes is not a failure", async () => {
    // ~0.5s, under the 1.5s budget. The old 10s default would also pass this;
    // what it pins is that the async path finishes and reports normally.
    const { dir } = makeSlowRepo("fits", { files: 5, delay: 0.1 });
    const ensured = await ensureWorktreeDetailed(dir, "feat/fits", true, "main");
    expect(ensured).toEqual({ path: worktreeOf(dir, "feat/fits"), created: true, branchCreated: true, isMainCheckout: false });
    expect(readFileSync(join(ensured.path, "f4.txt"), "utf8")).toBe("4\n");
  });

  it("does not block the event loop while git checks out", async () => {
    const { dir } = makeSlowRepo("nonblocking", { files: 8, delay: 0.1 });
    let ticks = 0;
    const interval = setInterval(() => ticks++, 25);
    try {
      await ensureWorktreeDetailed(dir, "feat/loop", true, "main");
    } finally {
      clearInterval(interval);
    }
    // ~0.8s of checkout at 25ms — a synchronous spawn would allow none.
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
    controller.abort();

    const err = await pending.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
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
