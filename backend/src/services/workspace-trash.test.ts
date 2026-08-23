/**
 * Trash visibility and restore.
 *
 * The sweep is the only unprompted deletion in Callboard, so the listing has to
 * be honest about two things it would be easy to fudge: an entry it cannot date
 * is kept *forever*, not "expiring soon", and the countdown comes from the
 * manifest rather than the directory's mtime (`rename(2)` does not update
 * mtime, so a stale worktree would look instantly sweepable).
 *
 * Restore is proven end to end against real git: quarantine a worktree with an
 * ignored `.env` in it, prune, restore, and assert that both the tracked file
 * and the `.env` are back — the `.env` being the whole reason quarantine exists.
 * And the property that makes restore safe to offer at all: the trash entry is
 * still there afterwards, so a restore can be wrong without costing anything.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "callboard-trash-view-"));
process.env.CALLBOARD_DATA_DIR = join(root, "data");

const { TRASH_MANIFEST_FILE, TRASH_RETENTION_MS, quarantineDirectory, trashRoot } = await import("../utils/worktree-trash.js");
const { listTrash, restoreTrashEntry } = await import("./workspace-trash.js");
const { clearDiskUsageCache } = await import("../utils/disk-usage.js");

afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

// ── A real repository with a real worktree ──────────────────────────
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
writeFileSync(join(repo, ".gitignore"), ".env\n");
writeFileSync(join(repo, "tracked.txt"), "from main\n");
git(["add", "."], repo);
git(["commit", "-q", "-m", "init"], repo);

const worktree = join(root, "repo.feature");
git(["worktree", "add", "-q", "-b", "feature", worktree, "main"], repo);
// The file the whole quarantine design exists to protect: invisible to
// `git status`, deleted by `git worktree remove`.
writeFileSync(join(worktree, ".env"), "SECRET=hunter2\n");
mkdirSync(join(worktree, "node_modules"), { recursive: true });
writeFileSync(join(worktree, "node_modules", "marker"), "regenerable\n");

const quarantined = quarantineDirectory(worktree, {
  entryPrefix: "ws-feature",
  manifest: { workspaceId: "ws-feature", originalPath: worktree, repoPath: repo, branch: "feature" },
});
if (!quarantined.ok) throw new Error(`fixture quarantine failed: ${quarantined.error}`);
git(["worktree", "prune"], repo);

const entryName = quarantined.trashPath.split("/").pop()!;

// ── Two entries the sweep will never take ───────────────────────────
const noManifest = join(trashRoot(), "no-manifest-entry");
mkdirSync(noManifest, { recursive: true });
writeFileSync(join(noManifest, "leftover.txt"), "something\n");

const badTimestamp = join(trashRoot(), "bad-timestamp-entry");
mkdirSync(badTimestamp, { recursive: true });
writeFileSync(join(badTimestamp, TRASH_MANIFEST_FILE), JSON.stringify({ workspaceId: "ws-x", quarantinedAt: "not a date", restore: [] }));

describe("listing", () => {
  it("reports where an entry came from and what it would take to restore it", async () => {
    const entry = (await listTrash()).entries.find((e) => e.entry === entryName)!;
    expect(entry).toMatchObject({ workspaceId: "ws-feature", originalPath: worktree, repoPath: repo, branch: "feature", restorable: true });
    expect(entry.restore.join(" ")).toContain("git -C");
  });

  it("counts down from the manifest, not from the directory's mtime", async () => {
    const entry = (await listTrash()).entries.find((e) => e.entry === entryName)!;
    const expected = Date.parse(entry.quarantinedAt!) + TRASH_RETENTION_MS;
    expect(Date.parse(entry.expiresAt!)).toBe(expected);
    expect((await listTrash()).retentionDays).toBe(30);
  });

  /**
   * The sweep keeps anything it cannot date, forever. Showing a countdown for
   * such an entry would be a lie in the dangerous direction — a user would
   * expect it to disappear, and it never will.
   */
  it("says an undateable entry will never be swept instead of showing an expiry", async () => {
    const entries = (await listTrash()).entries;
    for (const name of ["no-manifest-entry", "bad-timestamp-entry"]) {
      const entry = entries.find((e) => e.entry === name)!;
      expect(entry.expiresAt).toBeUndefined();
      expect(entry.sweepBlocked).toContain("never");
    }
  });

  it("refuses to promise a restore it could not perform", async () => {
    const entry = (await listTrash()).entries.find((e) => e.entry === "no-manifest-entry")!;
    expect(entry.restorable).toBe(false);
    expect(entry.restoreBlocker).toContain("by hand");
  });

  it("measures nothing unless asked", async () => {
    for (const entry of (await listTrash()).entries) expect(entry.diskUsage).toBeUndefined();
    const measured = (await listTrash({ includeDiskUsage: true })).entries.find((e) => e.entry === entryName)!;
    expect(measured.diskUsage?.bytes).toBeGreaterThan(0);
  });

  /**
   * The per-directory timeout is not a bound on a listing: without a budget over
   * the whole thing, N entries is N × 15s — and this endpoint's caller opts in
   * unconditionally, so N is whatever the trash happens to hold. The `du`s now
   * run off the event loop, which bounds who *waits* for them, not how many
   * there are; the budget is still the only thing that bounds the listing.
   */
  it("stops measuring when the listing's budget runs out, and says so", async () => {
    // The memo is emptied first because a hit is served regardless of the
    // deadline — it costs no `du` and no pool slot, so refusing it would be a
    // skip reported for nothing. The test above measures one of these entries,
    // so without this the budget-exhausted listing would legitimately hand back
    // that entry's real size, and this test would be asserting the memo is cold
    // rather than that the budget is spent.
    clearDiskUsageCache();
    const listing = await listTrash({ includeDiskUsage: true, diskUsageBudgetMs: 0 });
    expect(listing.entries.length).toBeGreaterThan(0);
    for (const entry of listing.entries) {
      expect(entry.diskUsage?.bytes).toBeUndefined();
      expect(entry.diskUsage?.error).toContain("budget");
    }
    expect(listing.diskUsageNote).toContain("budget");
  });
});

describe("restore", () => {
  it("refuses an entry with no recipe, and touches nothing", () => {
    const result = restoreTrashEntry("no-manifest-entry");
    expect(result).toMatchObject({ ok: false, trashRetained: true, failure: { code: "no-manifest" } });
    expect(existsSync(join(noManifest, "leftover.txt"))).toBe(true);
  });

  it("refuses a name that tries to escape the trash root", () => {
    expect(restoreTrashEntry("../repo")).toMatchObject({ ok: false, failure: { code: "entry-not-found" } });
  });

  it("brings back the tracked checkout and the ignored files with it", () => {
    const result = restoreTrashEntry(entryName);
    expect(result.ok).toBe(true);
    expect(result.originalPath).toBe(worktree);
    // This manifest has no `headSha` — it is shaped like every entry
    // quarantined before commits were recorded. Those still restore, by name,
    // and the result says which of the two it was rather than implying the
    // stronger guarantee.
    expect(result.branchOutcome).toBe("branch-unverified");
    // Tracked: git wrote it. Ignored: copied back out of the trash — and this
    // is the file that a `git worktree remove` would have destroyed.
    expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("from main\n");
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=hunter2\n");
    expect(readFileSync(join(worktree, "node_modules", "marker"), "utf8")).toBe("regenerable\n");
    expect(git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], repo).trim()).toBe("feature");
  });

  /**
   * The property that makes restore safe to offer: it copies out and leaves the
   * quarantined directory alone, so a restore that half-works costs nothing.
   */
  it("leaves the trash entry intact so a bad restore loses nothing", async () => {
    expect(existsSync(join(quarantined.trashPath, ".env"))).toBe(true);
    expect((await listTrash()).entries.map((e) => e.entry)).toContain(entryName);
  });

  it("never writes over a directory that has come back", () => {
    const result = restoreTrashEntry(entryName);
    expect(result).toMatchObject({ ok: false, trashRetained: true, failure: { code: "destination-occupied" } });
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=hunter2\n");
  });

  it("marks an entry unrestorable once its original path is occupied", async () => {
    const entry = (await listTrash()).entries.find((e) => e.entry === entryName)!;
    expect(entry.restorable).toBe(false);
    expect(entry.restoreBlocker).toContain("exists again");
  });
});

// ── A monorepo, which is the shape the top-level copy loop lost ──────
//
// The original fixture's only tracked entries were `.gitignore` and
// `tracked.txt`, with both ignored files at the root: no tracked *subdirectory*
// existed, so no collision was possible and the one shape that worked was the
// only shape exercised. Every real repository has tracked subdirectories, and
// `git worktree add` recreates them before the copy runs.

function makeRepo(name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", path], { stdio: "pipe" });
  return path;
}

describe("restoring a repository with tracked subdirectories", () => {
  const repo2 = makeRepo("monorepo");
  const worktree2 = join(root, "monorepo.feature");

  writeFileSync(join(repo2, ".gitignore"), ".env\ndist/\nnode_modules/\n");
  mkdirSync(join(repo2, "backend"), { recursive: true });
  mkdirSync(join(repo2, "frontend"), { recursive: true });
  writeFileSync(join(repo2, "backend", "server.js"), "tracked\n");
  writeFileSync(join(repo2, "frontend", "app.js"), "tracked\n");
  git(["add", "."], repo2);
  git(["commit", "-q", "-m", "init"], repo2);
  git(["worktree", "add", "-q", "-b", "feature", worktree2, "main"], repo2);

  // The files the whole design exists to protect, and every one of them is
  // *nested under a tracked directory* — which is exactly what a top-level copy
  // loop cannot see.
  writeFileSync(join(worktree2, "backend", ".env"), "SECRET=nested\n");
  mkdirSync(join(worktree2, "backend", "dist"), { recursive: true });
  writeFileSync(join(worktree2, "backend", "dist", "bundle.js"), "built\n");
  mkdirSync(join(worktree2, "frontend", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(worktree2, "frontend", "node_modules", "pkg", "index.js"), "dep\n");
  writeFileSync(join(worktree2, ".env"), "SECRET=root\n");

  const headSha = git(["-C", worktree2, "rev-parse", "HEAD"], repo2).trim();
  const quarantined2 = quarantineDirectory(worktree2, {
    entryPrefix: "ws-monorepo",
    manifest: { workspaceId: "ws-monorepo", originalPath: worktree2, repoPath: repo2, branch: "feature", headSha },
  });
  if (!quarantined2.ok) throw new Error(`fixture quarantine failed: ${quarantined2.error}`);
  git(["worktree", "prune"], repo2);
  const entry2 = quarantined2.trashPath.split("/").pop()!;

  const result = restoreTrashEntry(entry2);

  /**
   * The regression this fixture exists for. With a top-level copy loop this
   * reported `{ ok: true, copiedEntries: 2, skippedEntries: [".gitignore",
   * "backend", "frontend"] }` — success, while `backend/.env` stayed in the
   * trash for the sweep to delete thirty days later.
   */
  it("brings back ignored files nested under tracked directories", () => {
    expect(result.ok).toBe(true);
    expect(readFileSync(join(worktree2, "backend", ".env"), "utf8")).toBe("SECRET=nested\n");
    expect(readFileSync(join(worktree2, "backend", "dist", "bundle.js"), "utf8")).toBe("built\n");
    expect(readFileSync(join(worktree2, "frontend", "node_modules", "pkg", "index.js"), "utf8")).toBe("dep\n");
    expect(readFileSync(join(worktree2, ".env"), "utf8")).toBe("SECRET=root\n");
  });

  it("still lets the tracked files git wrote win, and skips only leaves", () => {
    expect(readFileSync(join(worktree2, "backend", "server.js"), "utf8")).toBe("tracked\n");
    // Whole directories are never skipped — that is what lost the subtree.
    expect(result.skippedEntries).not.toContain("backend");
    expect(result.skippedEntries).toContain("backend/server.js");
    expect(result.skippedCount).toBeGreaterThan(0);
  });

  it("counts every file it copied, at any depth", () => {
    // .env, backend/.env, backend/dist/bundle.js, frontend/node_modules/pkg/index.js
    expect(result.copiedEntries).toBe(4);
    expect(result.failedCount).toBeUndefined();
  });
});

// ── An unreadable directory, which used to abort the daemon ─────────

describe("a directory the daemon cannot read", () => {
  const repo3 = makeRepo("locked-repo");
  const worktree3 = join(root, "locked-repo.feature");

  writeFileSync(join(repo3, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(repo3, "tracked.txt"), "tracked\n");
  git(["add", "."], repo3);
  git(["commit", "-q", "-m", "init"], repo3);
  git(["worktree", "add", "-q", "-b", "locked", worktree3, "main"], repo3);

  writeFileSync(join(worktree3, ".env"), "SECRET=readable\n");
  mkdirSync(join(worktree3, "node_modules", "locked"), { recursive: true });
  writeFileSync(join(worktree3, "node_modules", "locked", "inside.txt"), "unreachable\n");
  writeFileSync(join(worktree3, "node_modules", "readable.txt"), "fine\n");

  const headSha3 = git(["-C", worktree3, "rev-parse", "HEAD"], repo3).trim();
  const quarantined3 = quarantineDirectory(worktree3, {
    entryPrefix: "ws-locked",
    manifest: { workspaceId: "ws-locked", originalPath: worktree3, repoPath: repo3, branch: "locked", headSha: headSha3 },
  });
  if (!quarantined3.ok) throw new Error(`fixture quarantine failed: ${quarantined3.error}`);
  git(["worktree", "prune"], repo3);
  const entry3 = quarantined3.trashPath.split("/").pop()!;

  // Made unreadable *after* the quarantine, exactly as a root-owned bind-mount
  // or a hostile test fixture would be found: the directory is there, its
  // contents cannot be listed.
  const lockedInTrash = join(quarantined3.trashPath, "node_modules", "locked");
  chmodSync(lockedInTrash, 0o000);
  afterAll(() => chmodSync(lockedInTrash, 0o755));

  const result = restoreTrashEntry(entry3);

  /**
   * The blocker. `fs.cpSync` is native in Node 22 and throws a C++
   * `std::filesystem_error` that no JS `try`/`catch` can see: the process calls
   * `terminate()` and aborts with exit 134, taking the HTTP server, every SSE
   * stream and every running agent session with it — on the Restore button.
   *
   * That this test *runs at all* is the assertion. A restore that aborted the
   * process would take the whole vitest worker with it.
   */
  it("does not abort the process on an unreadable directory", () => {
    expect(result).toBeTruthy();
    expect(result.entry).toBe(entry3);
  });

  it("reports the unreadable path instead of losing it silently", () => {
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("copy-failed");
    expect(result.failedCount).toBe(1);
    expect(result.failedEntries?.[0].path).toBe("node_modules/locked");
    expect(result.failedEntries?.[0].error).toMatch(/could not be read/);
    // ...and says where the originals still are.
    expect(result.failure?.detail).toContain("still only in");
  });

  it("restores everything it could read, so one bad directory costs only itself", () => {
    expect(readFileSync(join(worktree3, ".env"), "utf8")).toBe("SECRET=readable\n");
    expect(readFileSync(join(worktree3, "node_modules", "readable.txt"), "utf8")).toBe("fine\n");
    expect(readFileSync(join(worktree3, "tracked.txt"), "utf8")).toBe("tracked\n");
    // An unreadable directory leaves no empty shell of itself behind: a hollow
    // `node_modules/locked` would read as "restored, and it was empty".
    expect(existsSync(join(worktree3, "node_modules", "locked"))).toBe(false);
  });

  it("keeps the trash entry, which is where the unreadable files still are", () => {
    expect(result.trashRetained).toBe(true);
    expect(statSync(join(quarantined3.trashPath, "node_modules", "locked")).isDirectory()).toBe(true);
  });
});

// ── The branch name is not the commit ────────────────────────────────

describe("restoring after the branch has been deleted", () => {
  const repo4 = makeRepo("dwim-repo");
  const remote = join(root, "dwim-remote.git");
  const worktree4 = join(root, "dwim-repo.feature");

  writeFileSync(join(repo4, ".gitignore"), ".env\n");
  writeFileSync(join(repo4, "tracked.txt"), "quarantined revision\n");
  git(["add", "."], repo4);
  git(["commit", "-q", "-m", "the commit that was quarantined"], repo4);
  git(["worktree", "add", "-q", "-b", "feature", worktree4, "main"], repo4);
  writeFileSync(join(worktree4, ".env"), "SECRET=dwim\n");

  const quarantinedSha = git(["-C", worktree4, "rev-parse", "HEAD"], repo4).trim();
  const quarantined4 = quarantineDirectory(worktree4, {
    entryPrefix: "ws-dwim",
    manifest: { workspaceId: "ws-dwim", originalPath: worktree4, repoPath: repo4, branch: "feature", headSha: quarantinedSha },
  });
  if (!quarantined4.ok) throw new Error(`fixture quarantine failed: ${quarantined4.error}`);
  git(["worktree", "prune"], repo4);
  const entry4 = quarantined4.trashPath.split("/").pop()!;

  // While the directory sits in the trash: work moves on, `feature` is pushed
  // somewhere else and the local branch is deleted. `git worktree add <path>
  // feature` now DWIMs the *name* against the remote — a different commit,
  // checked out under the right label, with the ignored files copied on top and
  // a cheerful ok:true. That is what recording the SHA prevents.
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git(["remote", "add", "origin", remote], repo4);
  writeFileSync(join(repo4, "tracked.txt"), "a later revision that was never quarantined\n");
  git(["add", "."], repo4);
  git(["commit", "-q", "-m", "moved on"], repo4);
  const laterSha = git(["rev-parse", "HEAD"], repo4).trim();
  git(["push", "-q", "origin", "main:feature"], repo4);
  git(["fetch", "-q", "origin"], repo4);
  git(["branch", "-D", "feature"], repo4);

  const result = restoreTrashEntry(entry4);

  it("restores the commit that was quarantined, not the one the name now resolves to", () => {
    expect(result.ok).toBe(true);
    expect(git(["-C", worktree4, "rev-parse", "HEAD"], repo4).trim()).toBe(quarantinedSha);
    expect(git(["-C", worktree4, "rev-parse", "HEAD"], repo4).trim()).not.toBe(laterSha);
    expect(readFileSync(join(worktree4, "tracked.txt"), "utf8")).toBe("quarantined revision\n");
    expect(readFileSync(join(worktree4, ".env"), "utf8")).toBe("SECRET=dwim\n");
  });

  it("recreates the deleted branch at that commit, and says that is what it did", () => {
    expect(result.branchOutcome).toBe("branch-recreated");
    expect(result.restoredCommit).toBe(quarantinedSha);
    expect(git(["-C", worktree4, "rev-parse", "--abbrev-ref", "HEAD"], repo4).trim()).toBe("feature");
  });
});

describe("restoring after the branch has moved on", () => {
  const repo5 = makeRepo("moved-repo");
  const worktree5 = join(root, "moved-repo.feature");

  writeFileSync(join(repo5, "tracked.txt"), "quarantined revision\n");
  git(["add", "."], repo5);
  git(["commit", "-q", "-m", "one"], repo5);
  git(["worktree", "add", "-q", "-b", "feature", worktree5, "main"], repo5);

  const quarantinedSha = git(["-C", worktree5, "rev-parse", "HEAD"], repo5).trim();
  const quarantined5 = quarantineDirectory(worktree5, {
    entryPrefix: "ws-moved",
    manifest: { workspaceId: "ws-moved", originalPath: worktree5, repoPath: repo5, branch: "feature", headSha: quarantinedSha },
  });
  if (!quarantined5.ok) throw new Error(`fixture quarantine failed: ${quarantined5.error}`);
  git(["worktree", "prune"], repo5);

  writeFileSync(join(repo5, "tracked.txt"), "someone else's work\n");
  git(["add", "."], repo5);
  git(["commit", "-q", "-m", "two"], repo5);
  const movedSha = git(["rev-parse", "HEAD"], repo5).trim();
  git(["branch", "-f", "feature", movedSha], repo5);

  const result = restoreTrashEntry(quarantined5.trashPath.split("/").pop()!);

  /**
   * Following the name here would check out somebody else's commit and copy the
   * quarantined worktree's untracked files over the top of it. Detaching is the
   * honest outcome: the user gets exactly what they had, and the branch is left
   * alone rather than yanked backwards.
   */
  it("checks the recorded commit out detached rather than following the name", () => {
    expect(result.ok).toBe(true);
    expect(result.branchOutcome).toBe("detached");
    expect(git(["-C", worktree5, "rev-parse", "HEAD"], repo5).trim()).toBe(quarantinedSha);
    expect(readFileSync(join(worktree5, "tracked.txt"), "utf8")).toBe("quarantined revision\n");
    expect(git(["rev-parse", "refs/heads/feature"], repo5).trim()).toBe(movedSha);
  });
});
