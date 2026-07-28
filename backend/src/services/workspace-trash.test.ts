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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "callboard-trash-view-"));
process.env.CALLBOARD_DATA_DIR = join(root, "data");

const { TRASH_MANIFEST_FILE, TRASH_RETENTION_MS, quarantineDirectory, trashRoot } = await import("../utils/worktree-trash.js");
const { listTrash, restoreTrashEntry } = await import("./workspace-trash.js");

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
  it("reports where an entry came from and what it would take to restore it", () => {
    const entry = listTrash().entries.find((e) => e.entry === entryName)!;
    expect(entry).toMatchObject({ workspaceId: "ws-feature", originalPath: worktree, repoPath: repo, branch: "feature", restorable: true });
    expect(entry.restore.join(" ")).toContain("git -C");
  });

  it("counts down from the manifest, not from the directory's mtime", () => {
    const entry = listTrash().entries.find((e) => e.entry === entryName)!;
    const expected = Date.parse(entry.quarantinedAt!) + TRASH_RETENTION_MS;
    expect(Date.parse(entry.expiresAt!)).toBe(expected);
    expect(listTrash().retentionDays).toBe(30);
  });

  /**
   * The sweep keeps anything it cannot date, forever. Showing a countdown for
   * such an entry would be a lie in the dangerous direction — a user would
   * expect it to disappear, and it never will.
   */
  it("says an undateable entry will never be swept instead of showing an expiry", () => {
    const entries = listTrash().entries;
    for (const name of ["no-manifest-entry", "bad-timestamp-entry"]) {
      const entry = entries.find((e) => e.entry === name)!;
      expect(entry.expiresAt).toBeUndefined();
      expect(entry.sweepBlocked).toContain("never");
    }
  });

  it("refuses to promise a restore it could not perform", () => {
    const entry = listTrash().entries.find((e) => e.entry === "no-manifest-entry")!;
    expect(entry.restorable).toBe(false);
    expect(entry.restoreBlocker).toContain("by hand");
  });

  it("measures nothing unless asked", () => {
    for (const entry of listTrash().entries) expect(entry.diskUsage).toBeUndefined();
    const measured = listTrash({ includeDiskUsage: true }).entries.find((e) => e.entry === entryName)!;
    expect(measured.diskUsage?.bytes).toBeGreaterThan(0);
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
  it("leaves the trash entry intact so a bad restore loses nothing", () => {
    expect(existsSync(join(quarantined.trashPath, ".env"))).toBe(true);
    expect(listTrash().entries.map((e) => e.entry)).toContain(entryName);
  });

  it("never writes over a directory that has come back", () => {
    const result = restoreTrashEntry(entryName);
    expect(result).toMatchObject({ ok: false, trashRetained: true, failure: { code: "destination-occupied" } });
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=hunter2\n");
  });

  it("marks an entry unrestorable once its original path is occupied", () => {
    const entry = listTrash().entries.find((e) => e.entry === entryName)!;
    expect(entry.restorable).toBe(false);
    expect(entry.restoreBlocker).toContain("exists again");
  });
});
