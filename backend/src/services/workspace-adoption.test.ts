/**
 * Adoption safety (Phase 2b).
 *
 * Phase 2's tests are claims about things not being destroyed. These are claims
 * about `owned: true` not being written for anything the user did not name —
 * the other half of the same guarantee, because `owned` is what unlocks the
 * removal path at all.
 *
 * Two properties carry the phase, and every test here serves one of them:
 *
 *  1. **Discovery never writes.** Listing candidates creates no record, writes
 *     no token, and touches nothing on disk.
 *  2. **Pattern-matching offers; it never acts.** A path that matches
 *     Callboard's naming convention gains nothing from that, and a path that
 *     matches neither convention loses nothing. The only reason anything is
 *     adopted is that a caller named it. Proved behaviourally rather than by
 *     grepping the source — a regex over source is satisfied by a doc comment,
 *     as Phase 2's `--force` scan discovered.
 *
 * Real throwaway git repositories and real worktrees throughout: a mocked git
 * would agree with whatever the implementation believes, and the thing under
 * test is precisely whether git, the filesystem and the registry agree.
 *
 * DATA_DIR is resolved when utils/paths.js first loads, so CALLBOARD_DATA_DIR
 * is set before any module is imported (hence the top-level dynamic imports).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-workspace-adoption-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { guessWorktreeNaming } = await import("../utils/worktree-naming.js");
const { directoryDiskUsage } = await import("../utils/disk-usage.js");
const { readWorktreeToken, worktreeTokenPath } = await import("../utils/worktree-token.js");
const { createWorkspace, getWorkspace, listWorkspaces, recordWorktreeWorkspace } = await import("./workspace-store.js");
const { adoptWorktrees, evaluateAdoption, newAdoptionContext } = await import("./workspace-adoption.js");
const { listUnmanagedWorktrees } = await import("./workspace-discovery.js");
const { archiveWorkspace, evaluateWorktreeRemoval } = await import("./workspace-service.js");

const workspacesDir = join(tmpRoot, "workspaces");
const trashDir = join(tmpRoot, "trash");

// ── Real git fixtures ───────────────────────────────────────────────

// Canonical, not as `tmpdir()` spells it: on macOS that is `/var/folders/...`,
// a symlink to `/private/var/folders/...`. Adoption records git's spelling of a
// path, which is the real one, so a fixture built on the symlinked spelling
// never compares equal.
const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), "callboard-workspace-adoption-git-")));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);
writeFileSync(join(repoDir, ".gitignore"), ".env\n*.sqlite\nnode_modules/\n");
git(["add", ".gitignore"], repoDir);
git(["commit", "-q", "-m", "ignore local state"], repoDir);

/** Where Callboard's *current* convention would put a worktree for `branch`. */
function conventionalPath(branch: string): string {
  return join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
}

/**
 * A worktree that predates the workspace entity: made with plain git, with no
 * record and no identity token anywhere. This is the thing adoption exists for,
 * and it is created the way the 43 real ones on the author's machine were.
 */
function unmanagedWorktree(branch: string, path = conventionalPath(branch)): string {
  git(["worktree", "add", "-q", "-b", branch, path, "main"], repoDir);
  return path;
}

/** Drop a worktree without going through Callboard, for test teardown. */
function dropWorktree(path: string): void {
  try {
    if (existsSync(path)) git(["worktree", "remove", "--force", path], repoDir);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
  try {
    git(["worktree", "prune"], repoDir);
  } catch {
    /* nothing registered to prune */
  }
}

function refusalCode(outcome: { refusal?: { code: string } }): string | undefined {
  return outcome.refusal?.code;
}

function adoptOnePath(path: string) {
  const result = adoptWorktrees([path]);
  expect(result.outcomes).toHaveLength(1);
  return result.outcomes[0];
}

function workspaceRecordFiles(): string[] {
  return existsSync(workspacesDir) ? readdirSync(workspacesDir) : [];
}

function trashEntries(): string[] {
  return existsSync(trashDir) ? readdirSync(trashDir).sort() : [];
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(workspacesDir)) rmSync(join(workspacesDir, file), { force: true, recursive: true });
  if (existsSync(trashDir)) for (const file of readdirSync(trashDir)) rmSync(join(trashDir, file), { force: true, recursive: true });
});

// ── 1. Discovery writes nothing ─────────────────────────────────────

describe("discovery", () => {
  it("lists an unmanaged worktree — and creates no record while doing it", async () => {
    const cwd = unmanagedWorktree("disco/plain");
    writeFileSync(join(cwd, ".env"), "SECRET=1\n"); // ignored: invisible to status, would ride into the trash

    const listing = await listUnmanagedWorktrees(repoDir);
    const entry = listing.worktrees.find((w) => w.path === cwd);

    expect(entry).toBeTruthy();
    expect(entry!.branch).toBe("disco/plain");
    expect(entry!.repoPath).toBe(repoDir);
    // Cleanliness comes from the same check that gates removal in Phase 2, so
    // the answer here and the answer there cannot disagree. `.env` is ignored,
    // so this worktree is clean despite having a file in it.
    expect(entry!.cleanliness.clean).toBe(true);
    // ...and the ignored preview is what says the .env is there at all.
    expect(entry!.ignored.entries).toContain(".env");
    expect(entry!.diskUsage.bytes).toBeGreaterThan(0);
    expect(entry!.adoptable).toBe(true);
    expect(entry!.adoptionBlockers).toEqual([]);

    // THE claim of this test: discovery is read-only.
    expect(workspaceRecordFiles()).toEqual([]);
    expect(readWorktreeToken(cwd)).toBeNull();
    expect(trashEntries()).toEqual([]);
    expect(existsSync(join(cwd, ".env"))).toBe(true);

    dropWorktree(cwd);
  });

  it("excludes the main checkout, and drops a worktree once it has a record", async () => {
    const cwd = unmanagedWorktree("disco/managed");

    const before = await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false });
    expect(before.worktrees.map((w) => w.path)).toContain(cwd);
    expect(before.worktrees.map((w) => w.path)).not.toContain(repoDir);
    expect(before.totalWorktrees).toBeGreaterThan(before.worktrees.length); // the main checkout is counted, not listed
    expect(before.managedWorktrees).toBe(0);

    expect(adoptOnePath(cwd).adopted).toBe(true);

    const after = await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false });
    expect(after.worktrees.map((w) => w.path)).not.toContain(cwd);
    expect(after.managedWorktrees).toBe(1);

    dropWorktree(cwd);
  });

  it("accepts a worktree path as the repository argument", async () => {
    // A caller holding a worktree path should not have to work out the repo.
    const cwd = unmanagedWorktree("disco/from-worktree");
    const listing = await listUnmanagedWorktrees(cwd, { includeDiskUsage: false });
    expect(listing.repoPath).toBe(repoDir);
    expect(listing.worktrees.map((w) => w.path)).toContain(cwd);
    dropWorktree(cwd);
  });

  it("reports a detached worktree as a candidate that adoption would refuse", async () => {
    const cwd = join(gitRoot, "repo.detached");
    git(["worktree", "add", "-q", "--detach", cwd, "main"], repoDir);

    const entry = (await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees.find((w) => w.path === cwd);
    expect(entry!.branch).toBeNull();
    expect(entry!.adoptable).toBe(false);
    expect(entry!.adoptionBlockers.map((b) => b.code)).toContain("detached-head");

    dropWorktree(cwd);
  });

  it("says so when disk usage was not measured, rather than reporting zero", async () => {
    const cwd = unmanagedWorktree("disco/no-du");
    const entry = (await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees.find((w) => w.path === cwd);
    expect(entry!.diskUsage.bytes).toBeUndefined();
    expect(entry!.diskUsage.error).toBeTruthy();
    dropWorktree(cwd);
  });

  /**
   * The other half of "a skip is never silent": the per-entry error above says
   * why one measurement is missing, and this says the *listing* carries a
   * sentence a caller can surface. The trash listing has had this test since it
   * was written; discovery never did, so dropping `diskUsageNote` from the
   * returned object passed the whole suite.
   */
  it("puts a note on the listing when the budget runs out, not just on the entries", async () => {
    const cwd = unmanagedWorktree("disco/budget-note");

    const listing = await listUnmanagedWorktrees(repoDir, { includeDiskUsage: true, diskUsageBudgetMs: 0 });
    expect(listing.worktrees.length).toBeGreaterThan(0);
    for (const w of listing.worktrees) {
      expect(w.diskUsage.bytes).toBeUndefined();
      expect(w.diskUsage.error).toContain("budget");
    }
    expect(listing.diskUsageNote).toContain("budget");
    expect(listing.diskUsageNote).toContain("du -sh");

    dropWorktree(cwd);
  });

  it("measures a real directory", () => {
    const usage = directoryDiskUsage(repoDir);
    expect(usage.bytes).toBeGreaterThan(0);
    expect(directoryDiskUsage(join(gitRoot, "does-not-exist")).bytes).toBeUndefined();
  });
});

// ── 2. Pattern-matching offers; it never acts ───────────────────────

describe("the naming heuristic", () => {
  it("labels each convention, and labels itself a guess", () => {
    const current = guessWorktreeNaming(conventionalPath("feat/x"), repoDir, "feat/x");
    expect(current.convention).toBe("current");
    expect(current.matches).toBe(true);
    expect(current.detail.toLowerCase()).toContain("guess");

    const legacy = guessWorktreeNaming(join(gitRoot, "repo-wt-chatcards"), repoDir, "chatcards");
    expect(legacy.convention).toBe("legacy");
    expect(legacy.matches).toBe(true);
    expect(legacy.detail.toLowerCase()).toContain("guess");

    const unknown = guessWorktreeNaming(join(gitRoot, "somewhere-else"), repoDir, "feat/x");
    expect(unknown.convention).toBe("unrecognized");
    expect(unknown.matches).toBe(false);

    // The branch is part of the current convention, so a renamed branch stops
    // matching a worktree Callboard really did create. Both directions of error
    // are live, which is why this may never decide anything.
    expect(guessWorktreeNaming(conventionalPath("feat/x"), repoDir, "feat/renamed").convention).toBe("unrecognized");
  });

  it("adopts a worktree whose path matches NO convention", async () => {
    // If a pattern were a gate for "yes", this would be refused. It is not.
    const cwd = unmanagedWorktree("naming/unrecognized", join(gitRoot, "nothing-like-callboards-layout"));

    const entry = (await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees.find((w) => w.path === cwd);
    expect(entry!.naming.matches).toBe(false);
    expect(entry!.adoptable).toBe(true);

    const outcome = adoptOnePath(cwd);
    expect(outcome.adopted).toBe(true);
    expect(outcome.workspace!.worktree!.owned).toBe(true);

    dropWorktree(cwd);
  });

  it("refuses a directory that matches the convention exactly but is not a registered worktree", () => {
    // And if a pattern were a gate for "yes" in the other direction, this would
    // be adopted. Callboard's own layout, byte for byte — and it is nothing.
    const impostor = conventionalPath("naming/impostor");
    mkdirSync(impostor, { recursive: true });
    expect(guessWorktreeNaming(impostor, repoDir, "naming/impostor").convention).toBe("current");

    const outcome = adoptOnePath(impostor);
    expect(outcome.adopted).toBe(false);
    expect(refusalCode(outcome)).toBe("not-a-registered-worktree");
    expect(workspaceRecordFiles()).toEqual([]);

    rmSync(impostor, { recursive: true, force: true });
  });
});

// ── 3. Adoption ─────────────────────────────────────────────────────

describe("adoption", () => {
  it("writes the identity token and an owned record, and the worktree then passes Phase 2's gate", async () => {
    const cwd = unmanagedWorktree("adopt/clean");

    // Before: unremovable precisely because it is not ours.
    const preview = (await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees.find((w) => w.path === cwd);
    expect(preview).toBeTruthy();
    expect(readWorktreeToken(cwd)).toBeNull();

    const outcome = adoptOnePath(cwd);
    expect(outcome.adopted).toBe(true);
    const workspace = outcome.workspace!;

    // The token lives in the git admin dir, where git owns it and destroys it
    // with the worktree — never in the working tree, where it would be an
    // untracked file and would trip the cleanliness gate.
    expect(worktreeTokenPath(cwd)!.startsWith(join(repoDir, ".git", "worktrees"))).toBe(true);
    expect(readWorktreeToken(cwd)).toBe(workspace.id);
    expect(existsSync(join(cwd, ".callboard-workspace-id"))).toBe(false);

    // The record, and the intent reconstructed from git rather than the path.
    expect(workspace.isolation).toBe("worktree");
    expect(workspace.worktree!.owned).toBe(true);
    expect(workspace.worktree!.branch).toBe("adopt/clean");
    expect(workspace.worktree!.mode).toBe("checkout-branch");
    expect(workspace.worktree!.baseBranch).toBeUndefined(); // never invented
    expect(workspace.repoPath).toBe(repoDir);
    expect(workspace.status).toBe("active");
    expect(getWorkspace(workspace.id)).toBeTruthy();

    // And the point of all of it: Phase 2 now says yes.
    expect(evaluateWorktreeRemoval(getWorkspace(workspace.id)!).removable).toBe(true);
    expect(outcome.removability!.removable).toBe(true);

    dropWorktree(cwd);
  });

  it("deletes nothing and quarantines nothing", () => {
    const cwd = unmanagedWorktree("adopt/inert");
    writeFileSync(join(cwd, ".env"), "SECRET=1\n");
    writeFileSync(join(cwd, "scratch.txt"), "untracked work\n");

    expect(adoptOnePath(cwd).adopted).toBe(true);

    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(cwd, "scratch.txt"), "utf8")).toBe("untracked work\n");
    expect(trashEntries()).toEqual([]);

    dropWorktree(cwd);
  });

  it("records git's spelling of the path, not the caller's", () => {
    // Adoption is the only place an arbitrary caller-supplied path becomes a
    // workspace `cwd`. A symlink to the worktree satisfies every check, but
    // recording it would leave Phase 2's quarantine renaming the *link* and
    // leaving the worktree behind. git's own answer wins.
    const cwd = unmanagedWorktree("adopt/canonical");
    const link = join(gitRoot, "link-to-worktree");
    symlinkSync(cwd, link);

    const outcome = adoptOnePath(link);
    expect(outcome.adopted).toBe(true);
    expect(outcome.path).toBe(cwd);
    expect(outcome.workspace!.cwd).toBe(cwd);
    expect(readWorktreeToken(cwd)).toBe(outcome.workspace!.id);

    rmSync(link, { force: true });
    dropWorktree(cwd);
  });

  it("adopts a dirty worktree — and Phase 2 still refuses to remove it", async () => {
    // Cleanliness gates REMOVAL, not management. Wanting to manage something
    // with work in it is legitimate; refusing to adopt it would just leave it
    // in the unmanageable backlog forever.
    const cwd = unmanagedWorktree("adopt/dirty");
    writeFileSync(join(cwd, "wip.txt"), "half-finished\n");

    const outcome = adoptOnePath(cwd);
    expect(outcome.adopted).toBe(true);
    expect(outcome.workspace!.worktree!.owned).toBe(true);

    // The dirt is reported, not refused on.
    expect(outcome.removability!.removable).toBe(false);
    expect(outcome.removability!.blockers.map((b) => b.code)).toContain("untracked-files");

    const archived = await archiveWorkspace(outcome.workspace!.id);
    expect(archived!.worktree.removed).toBe(false);
    expect(archived!.worktree.disposition).toBe("kept");
    expect(archived!.worktree.blockers.map((b) => b.code)).toContain("untracked-files");
    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(join(cwd, "wip.txt"), "utf8")).toBe("half-finished\n");
    expect(trashEntries()).toEqual([]);

    dropWorktree(cwd);
  });

  it("adopts a worktree carrying unpushed commits, which Phase 2 then refuses", async () => {
    const cwd = unmanagedWorktree("adopt/unpushed");
    writeFileSync(join(cwd, "work.txt"), "committed nowhere else\n");
    git(["add", "work.txt"], cwd);
    git(["commit", "-q", "-m", "work"], cwd);

    const outcome = adoptOnePath(cwd);
    expect(outcome.adopted).toBe(true);
    expect(outcome.removability!.blockers.map((b) => b.code)).toContain("unpushed-commits");

    const archived = await archiveWorkspace(outcome.workspace!.id);
    expect(archived!.worktree.removed).toBe(false);
    expect(existsSync(join(cwd, "work.txt"))).toBe(true);

    dropWorktree(cwd);
  });

  it("adopt → archive → quarantine → restore, end to end", async () => {
    const cwd = unmanagedWorktree("adopt/roundtrip");
    // Something git tracks, and something it cannot see. The ignored file is
    // the whole reason removal is a move: `git worktree remove` would have
    // deleted it.
    writeFileSync(join(cwd, ".env"), "SECRET=roundtrip\n");
    const trackedBefore = readFileSync(join(cwd, ".gitignore"), "utf8");

    const outcome = adoptOnePath(cwd);
    expect(outcome.adopted).toBe(true);

    const archived = await archiveWorkspace(outcome.workspace!.id);
    expect(archived!.worktree.blockers).toEqual([]);
    expect(archived!.worktree.disposition).toBe("quarantined");
    expect(archived!.worktree.removed).toBe(true);
    expect(existsSync(cwd)).toBe(false);

    // Nothing was deleted: both files are in the trash, ignored one included.
    const trashPath = archived!.worktree.trashPath!;
    expect(readFileSync(join(trashPath, ".env"), "utf8")).toBe("SECRET=roundtrip\n");
    expect(readFileSync(join(trashPath, ".gitignore"), "utf8")).toBe(trackedBefore);
    expect(archived!.worktree.ignored!.entries).toContain(".env");

    // Restore, exactly as the manifest's recipe says: re-add the worktree, then
    // copy back what git does not track.
    git(["worktree", "add", "-q", cwd, "adopt/roundtrip"], repoDir);
    cpSync(join(trashPath, ".env"), join(cwd, ".env"));
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(trackedBefore);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("SECRET=roundtrip\n");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim()).toBe("adopt/roundtrip");

    // The restored worktree is a *different* directory as far as ownership
    // goes: git made a fresh admin dir, so it carries no token and is back to
    // being unmanaged — which is correct, and is what adoption is for.
    expect(readWorktreeToken(cwd)).toBeNull();
    expect((await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees.map((w) => w.path)).toContain(cwd);

    dropWorktree(cwd);
  });
});

// ── 4. Every refusal ────────────────────────────────────────────────

describe("adoption refuses", () => {
  it("a path that does not exist", () => {
    const outcome = adoptOnePath(join(gitRoot, "no-such-directory"));
    expect(refusalCode(outcome)).toBe("not-a-registered-worktree");
    expect(workspaceRecordFiles()).toEqual([]);
  });

  it("a directory that is not a git worktree", () => {
    const plain = join(gitRoot, "just-a-folder");
    mkdirSync(plain, { recursive: true });
    expect(refusalCode(adoptOnePath(plain))).toBe("not-a-registered-worktree");
    expect(workspaceRecordFiles()).toEqual([]);
    rmSync(plain, { recursive: true, force: true });
  });

  it("the main checkout", () => {
    // The one directory that must never become removable: it is the repository.
    const outcome = adoptOnePath(repoDir);
    expect(outcome.adopted).toBe(false);
    expect(refusalCode(outcome)).toBe("main-checkout");
    expect(workspaceRecordFiles()).toEqual([]);
  });

  it("a worktree that already has an active record — so adoption is safe to repeat", () => {
    const cwd = unmanagedWorktree("refuse/twice");

    const first = adoptOnePath(cwd);
    expect(first.adopted).toBe(true);

    const second = adoptOnePath(cwd);
    expect(second.adopted).toBe(false);
    expect(refusalCode(second)).toBe("already-managed");
    // One record, one token, and the token still names the original.
    expect(workspaceRecordFiles()).toHaveLength(1);
    expect(readWorktreeToken(cwd)).toBe(first.workspace!.id);

    dropWorktree(cwd);
  });

  it("a worktree Callboard created itself and already tracks", () => {
    const cwd = conventionalPath("refuse/callboard-made");
    git(["worktree", "add", "-q", "-b", "refuse/callboard-made", cwd, "main"], repoDir);
    const existing = recordWorktreeWorkspace({
      cwd,
      repoPath: repoDir,
      created: true,
      mode: "branch-off",
      branch: "refuse/callboard-made",
      baseBranch: "main",
    });

    const outcome = adoptOnePath(cwd);
    expect(refusalCode(outcome)).toBe("already-managed");
    // The original record's intent survives untouched — adoption did not
    // overwrite "branch-off" with its own reconstructed "checkout-branch".
    expect(getWorkspace(existing.id)!.worktree!.mode).toBe("branch-off");
    expect(readWorktreeToken(cwd)).toBe(existing.id);

    dropWorktree(cwd);
  });

  it("a worktree carrying another active workspace's identity token", () => {
    // Overwriting that token would silently strip the other workspace's proof
    // of ownership and leave its worktree unremovable forever.
    const cwd = unmanagedWorktree("refuse/foreign-token");
    const other = createWorkspace({
      cwd: join(gitRoot, "somewhere-else"),
      repoPath: repoDir,
      isolation: "worktree",
      worktree: { owned: true, mode: "checkout-branch", branch: "other" },
    });
    writeFileSync(worktreeTokenPath(cwd)!, `${other.id}\n`);

    const outcome = adoptOnePath(cwd);
    expect(refusalCode(outcome)).toBe("already-managed");
    expect(readWorktreeToken(cwd)).toBe(other.id);
    expect(workspaceRecordFiles()).toHaveLength(1);

    dropWorktree(cwd);
  });

  it("a detached HEAD, because a record needs a branch to be restorable", () => {
    const cwd = join(gitRoot, "repo.refuse-detached");
    git(["worktree", "add", "-q", "--detach", cwd, "main"], repoDir);

    const outcome = adoptOnePath(cwd);
    expect(refusalCode(outcome)).toBe("detached-head");
    expect(workspaceRecordFiles()).toEqual([]);

    dropWorktree(cwd);
  });

  it("a worktree whose git admin dir has gone, since no token could be written", () => {
    // The race this guards: git listed the worktree, and the admin dir went
    // away before the token could be written. A record here would be owned,
    // tokenless and therefore permanently unremovable — worse than no record.
    const cwd = unmanagedWorktree("refuse/no-admin-dir");
    const ctx = newAdoptionContext(repoDir);
    const adminDir = join(repoDir, ".git", "worktrees", basename(cwd));
    expect(existsSync(adminDir)).toBe(true);
    rmSync(adminDir, { recursive: true, force: true });

    const blockers = evaluateAdoption(cwd, ctx).blockers;
    expect(blockers.map((b) => b.code)).toContain("admin-dir-unresolvable");

    // Through the public entry point the same worktree is refused too — just
    // one gate earlier, since git no longer lists it at all.
    expect(refusalCode(adoptOnePath(cwd))).toBe("not-a-registered-worktree");
    expect(workspaceRecordFiles()).toEqual([]);

    rmSync(cwd, { recursive: true, force: true });
    dropWorktree(cwd);
  });

  it("a repository git cannot be asked about", () => {
    const cwd = unmanagedWorktree("refuse/no-repo");
    const blockers = evaluateAdoption(cwd, { repoPath: repoDir, worktrees: [], activeWorkspaces: [] }).blockers;
    expect(blockers.map((b) => b.code)).toEqual(["not-a-git-repo"]);
    dropWorktree(cwd);
  });

  it("keeps NO record when the identity token cannot be written", async () => {
    // The invariant that matters most in this phase. A record without a token
    // looks managed and can never be cleaned up — the worst outcome available
    // here — so the record is rolled back and the failure reported.
    const cwd = unmanagedWorktree("refuse/token-unwritable");
    const adminDir = join(repoDir, ".git", "worktrees", basename(cwd));
    chmodSync(adminDir, 0o555);

    let outcome;
    try {
      outcome = adoptOnePath(cwd);
    } finally {
      chmodSync(adminDir, 0o755);
    }

    expect(outcome.adopted).toBe(false);
    expect(refusalCode(outcome)).toBe("token-write-failed");
    expect(outcome.refusal!.detail).toContain("No record was kept");
    expect(workspaceRecordFiles()).toEqual([]);
    expect(readWorktreeToken(cwd)).toBeNull();
    // And the worktree is untouched, still a candidate.
    expect(existsSync(cwd)).toBe(true);
    expect((await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees.map((w) => w.path)).toContain(cwd);

    dropWorktree(cwd);
  });
});

// ── 5. Naming several paths at once ─────────────────────────────────

describe("adoptWorktrees over several paths", () => {
  it("treats each path independently and collapses duplicates", () => {
    const good = unmanagedWorktree("multi/good");
    const alsoGood = unmanagedWorktree("multi/also-good");
    const missing = join(gitRoot, "multi-missing");

    const result = adoptWorktrees([good, missing, alsoGood, good]);

    expect(result.outcomes.map((o) => o.path)).toEqual([good, missing, alsoGood]); // the repeat is collapsed, not adopted twice
    expect(result.adopted).toBe(2);
    expect(result.refused).toBe(1);
    expect(result.outcomes[0].adopted).toBe(true);
    expect(refusalCode(result.outcomes[1])).toBe("not-a-registered-worktree");
    expect(result.outcomes[2].adopted).toBe(true);

    // One record each, and each token names its own record.
    expect(workspaceRecordFiles()).toHaveLength(2);
    expect(readWorktreeToken(good)).toBe(result.outcomes[0].workspace!.id);
    expect(readWorktreeToken(alsoGood)).toBe(result.outcomes[2].workspace!.id);

    dropWorktree(good);
    dropWorktree(alsoGood);
  });

  it("never marks a workspace owned for a path the caller did not name", async () => {
    // The whole phase in one assertion: two candidates, one named. The other is
    // in the listing, matches the naming convention, is clean and adoptable —
    // and stays untouched, because nobody named it.
    const named = unmanagedWorktree("multi/named");
    const unnamed = unmanagedWorktree("multi/unnamed");

    const candidates = (await listUnmanagedWorktrees(repoDir, { includeDiskUsage: false })).worktrees;
    expect(candidates.find((w) => w.path === unnamed)!.naming.convention).toBe("current");
    expect(candidates.find((w) => w.path === unnamed)!.adoptable).toBe(true);

    adoptWorktrees([named]);

    const owned = listWorkspaces().filter((w) => w.worktree?.owned);
    expect(owned.map((w) => w.cwd)).toEqual([named]);
    expect(readWorktreeToken(unnamed)).toBeNull();

    dropWorktree(named);
    dropWorktree(unnamed);
  });
});
