/**
 * The invariant this phase is not allowed to break: **no chat may disappear
 * from the sidebar.**
 *
 * The fixture mirrors the shape of the real data rather than a convenient
 * subset — measured on this machine, 2026-07-28:
 *
 *   6,780 chats, 9 with a workspaceId (0.13%)
 *   324 distinct folders, 61 still on disk, 263 gone
 *   9 workspace records, all active, 6 of them pointing at removed directories
 *   1 record describing the *main checkout* as isolation:"worktree"
 *   88% of recent chats in two record-less, non-git agent-workspace directories
 *
 * So the mix below is: worktrees with records, worktrees without, plain
 * directories, a non-git directory holding most of the chats, a directory
 * whose record is stale, a directory that is gone from disk, and chats outside
 * the age window.
 *
 * Two of those were already invisible before this phase — chats outside the
 * window, and chats in directories that no longer exist (the route has skipped
 * those since long before workspaces existed; 417 chats are in that state
 * right now). The invariant is therefore stated precisely as: *every chat the
 * sidebar showed before this change is still shown, in the same row.* The
 * legacy-parity block at the bottom asserts exactly that by running the
 * pre-change grouping alongside the new one.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "shared";
// Type-only, so it is erased and cannot pull the module in above the env
// assignment below.
import type { DiscoveredSession } from "./folder-summaries.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-folder-summaries-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { buildFolderSummaries } = await import("./folder-summaries.js");
const { buildWorkspaceIndex } = await import("./workspace-views.js");
const { describeWorkspaceDirectory } = await import("./workspace-service.js");

// ── Fixture directories. Real git, because worktree-ness is a filesystem claim. ──
const gitRoot = mkdtempSync(join(tmpdir(), "callboard-folder-summaries-git-"));
const repoDir = join(gitRoot, "repo");

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "pipe" });
}

execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "pipe" });
git(["commit", "-q", "--allow-empty", "-m", "init"], repoDir);

function makeWorktree(branch: string): string {
  const path = join(gitRoot, `repo.${branch.replace(/\//g, "-")}`);
  git(["worktree", "add", "-q", "-b", branch, path, "main"], repoDir);
  return path;
}

/** Worktree with a workspace record. */
const wtRecorded = makeWorktree("feat/recorded");
/** Worktree with no record at all — the common case for anything pre-Phase-1. */
const wtBare = makeWorktree("feat/bare");
/** Worktree whose only record was archived; the directory must still answer. */
const wtStaleRecord = makeWorktree("feat/stale");
/** A non-git directory holding the bulk of the chats — the forge/hex shape. */
const agentWorkspace = join(gitRoot, "agent-workspaces", "forge");
mkdirSync(agentWorkspace, { recursive: true });
/** A directory that is gone. Chats here are invisible today and stay invisible. */
const vanished = join(gitRoot, "deleted-project");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(gitRoot, { recursive: true, force: true });
});

function record(over: Partial<Workspace> & Pick<Workspace, "id" | "cwd">): Workspace {
  return {
    name: over.cwd.split("/").pop()!,
    isolation: "local",
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
    ...over,
  } as Workspace;
}

const records: Workspace[] = [
  record({
    id: "ws-recorded",
    cwd: wtRecorded,
    repoPath: repoDir,
    isolation: "worktree",
    worktree: { owned: true, mode: "branch-off", branch: "feat/recorded" },
  }),
  // The live shape that makes `isolation` untrustworthy: a worktree was asked
  // for, `main` was already checked out in the main repo, so the record
  // describes the main checkout.
  record({
    id: "ws-mainrepo",
    cwd: repoDir,
    repoPath: repoDir,
    isolation: "worktree",
    worktree: { owned: false, mode: "checkout-branch", branch: "main" },
  }),
  // Active record for a directory that was removed outside Callboard — 6 of 9
  // real records are in this state. It must not produce a row.
  record({
    id: "ws-vanished",
    cwd: vanished,
    repoPath: repoDir,
    isolation: "worktree",
    worktree: { owned: true, mode: "branch-off", branch: "feat/vanished" },
  }),
  // Archived: ignored by the index, so the directory answers instead.
  record({
    id: "ws-archived",
    cwd: wtStaleRecord,
    repoPath: repoDir,
    isolation: "worktree",
    status: "archived",
    archivedAt: "2026-07-28T01:00:00.000Z",
    worktree: { owned: true, mode: "branch-off", branch: "feat/stale" },
  }),
];

const NOW = new Date("2026-07-28T12:00:00.000Z").getTime();
const cutoff = new Date(NOW - 5 * 24 * 60 * 60 * 1000);

function session(folder: string, id: string, ageHours: number): DiscoveredSession {
  const at = new Date(NOW - ageHours * 3600_000);
  return { sessionId: id, folder, createdAt: at, updatedAt: at };
}

/**
 * The realistic mix. Counts are scaled down but the *proportions* are the
 * point: most chats in a record-less directory, a long tail of one-chat
 * folders, and a directory (repoDir) holding many chats of which only one was
 * ever stamped with a workspaceId.
 */
const sessions: DiscoveredSession[] = [
  // 40 chats in the record-less non-git agent workspace — the majority case.
  ...Array.from({ length: 40 }, (_, i) => session(agentWorkspace, `forge-${i}`, i)),
  // 12 in the main checkout. In the real data exactly one of these carries a
  // workspaceId; grouping on that would split this into two rows named "repo".
  ...Array.from({ length: 12 }, (_, i) => session(repoDir, `main-${i}`, i)),
  // Worktrees.
  session(wtRecorded, "recorded-a", 3),
  session(wtRecorded, "recorded-b", 1),
  session(wtBare, "bare-a", 2),
  session(wtStaleRecord, "stale-a", 4),
  // Gone from disk — invisible before this change, invisible after.
  session(vanished, "vanished-a", 2),
  session(vanished, "vanished-b", 6),
  // Outside the 5-day window.
  session(wtBare, "bare-old", 24 * 9),
  session(agentWorkspace, "forge-old", 24 * 30),
];

function build(opts: { diskUsage?: (folder: string) => { bytes?: number; error?: string } } = {}) {
  return buildFolderSummaries(sessions, {
    cutoff,
    workspaces: buildWorkspaceIndex(records),
    directoryExists: (folder) => existsSync(folder),
    chatMetadata: () => ({}),
    isOngoing: () => false,
    isWaiting: () => false,
    gitInfo: (folder) => ({ isGitRepo: existsSync(join(folder, ".git")), branch: "main" }),
    describeDirectory: (workspace) => describeWorkspaceDirectory(workspace),
    ...(opts.diskUsage && { diskUsage: opts.diskUsage }),
  });
}

/** Directories an active record claims — the one exception to the exists rule. */
const claimed = new Set(records.filter((r) => r.status === "active").map((r) => r.cwd));

/**
 * Sessions the sidebar is supposed to account for: in window, and either the
 * directory is alive or an active workspace record claims it.
 *
 * The second clause is Phase 4a's one addition to Phase 3's row set. It is
 * narrow on purpose — a record alone still never produces a row, so the
 * registry cannot become the row source — and it is what makes the seven live
 * records pointing at removed directories visible enough to clean up.
 */
const eligible = sessions.filter((s) => s.createdAt >= cutoff && (existsSync(s.folder) || claimed.has(s.folder)));

describe("no chat disappears", () => {
  it("accounts for every eligible chat exactly once", () => {
    const folders = build();
    const total = folders.reduce((sum, f) => sum + f.chatCount, 0);
    expect(total).toBe(eligible.length);
    expect(total).toBe(58); // 40 forge + 12 main + 2 recorded + 1 bare + 1 stale + 2 vanished-but-recorded
  });

  it("gives every eligible chat's folder a row", () => {
    const rows = new Set(build().map((f) => f.folder));
    for (const s of eligible) {
      expect(rows, `no row for ${s.sessionId} in ${s.folder}`).toContain(s.folder);
    }
  });

  it("emits one row per directory, never one per workspace record", () => {
    const folders = build();
    expect(folders).toHaveLength(new Set(eligible.map((s) => s.folder)).size);
    expect(folders.map((f) => f.folder).sort()).toEqual([agentWorkspace, repoDir, vanished, wtBare, wtRecorded, wtStaleRecord].sort());
  });

  /**
   * The regression this design exists to avoid. `repoDir` holds 12 chats and
   * has one workspace record; on the real machine the equivalent directory
   * holds 84 chats of which one carries a workspaceId. Keyed on the chat's
   * workspaceId it becomes two rows with the same display name.
   */
  it("keeps a directory's chats in one row even when a record claims it", () => {
    const row = build().find((f) => f.folder === repoDir)!;
    expect(row.chatCount).toBe(12);
    expect(row.workspaceId).toBe("ws-mainrepo");
  });

  it("still lists a worktree that has no record at all", () => {
    const row = build().find((f) => f.folder === wtBare)!;
    expect(row.workspaceId).toBeUndefined();
    expect(row.isWorktree).toBe(true);
    expect(row.repoPath).toBe(repoDir);
  });

  it("still lists a directory whose only record was archived", () => {
    const row = build().find((f) => f.folder === wtStaleRecord)!;
    expect(row.workspaceId).toBeUndefined();
    expect(row.isWorktree).toBe(true);
  });

  it("picks the newest chat in each row as mostRecentChatId", () => {
    for (const row of build()) {
      const inRow = eligible.filter((s) => s.folder === row.folder);
      const newest = inRow.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      expect(row.mostRecentChatId).toBe(newest.sessionId);
    }
  });

  /**
   * The rule Phase 3 wrote, kept exactly where it was aimed. A directory that
   * is gone and that the registry does not claim stays invisible — 263 of 324
   * real folders are in that state, they have never been listed, and they must
   * not start being listed now.
   *
   * `wtBare`'s old chat is outside the window and `vanished` *is* claimed, so
   * the fixture proves this with the archived-record directory: if `wtStale`
   * were removed from disk its row would go, because `ws-archived` is not an
   * active claim.
   */
  it("does not resurrect a directory that is gone and unclaimed", () => {
    const unclaimedGone = join(gitRoot, "never-listed");
    const rows = buildFolderSummaries([...sessions, session(unclaimedGone, "orphan-a", 1)], {
      cutoff,
      workspaces: buildWorkspaceIndex(records),
      directoryExists: (folder) => existsSync(folder),
      chatMetadata: () => ({}),
      isOngoing: () => false,
      isWaiting: () => false,
      gitInfo: () => ({ isGitRepo: false }),
      describeDirectory: (workspace) => describeWorkspaceDirectory(workspace),
    });
    expect(rows.map((f) => f.folder)).not.toContain(unclaimedGone);
  });

  /**
   * Phase 4a's one deliberate addition. Seven of the ten real records point at
   * directories that were removed outside Callboard, and a cleanup surface that
   * hides them hides the exact thing it exists to clean up. The row is listed
   * and it says plainly that the directory is gone — it does not look normal.
   *
   * The property Phase 3 was protecting survives: the record does not create
   * the row, the chat does. `ws-vanished` would produce nothing without
   * `vanished-a` and `vanished-b` being inside the age window.
   */
  it("lists a gone directory that an active record claims, and marks it missing", () => {
    const row = build().find((f) => f.folder === vanished)!;
    expect(row).toBeTruthy();
    expect(row.directoryState).toBe("missing");
    expect(row.directoryDetail).toContain("does not exist");
    expect(row.chatCount).toBe(2);
    // Nothing on disk to ask git about, but the record still remembers the
    // branch a restore would need.
    expect(row.isGitRepo).toBe(false);
    expect(row.gitBranch).toBe("feat/vanished");
  });
});

describe("what a row now knows about cleanup", () => {
  it("carries the active records claiming a directory, with ownership", () => {
    const row = build().find((f) => f.folder === wtRecorded)!;
    expect(row.workspaces).toHaveLength(1);
    expect(row.workspaces![0]).toMatchObject({ id: "ws-recorded", owned: true, isolation: "worktree", branch: "feat/recorded" });
    expect(row.workspaces![0].directory.state).toBe("present");
  });

  it("reports a record Callboard does not own, which is why it cannot be cleaned up", () => {
    const row = build().find((f) => f.folder === repoDir)!;
    expect(row.workspaces![0]).toMatchObject({ id: "ws-mainrepo", owned: false });
  });

  it("leaves records off a directory no record claims", () => {
    expect(build().find((f) => f.folder === wtBare)!.workspaces).toBeUndefined();
    // An archived record is not a claim, so this one is record-less too.
    expect(build().find((f) => f.folder === wtStaleRecord)!.workspaces).toBeUndefined();
  });

  it("reports no directory state for a directory the registry does not claim", () => {
    const row = build().find((f) => f.folder === wtBare)!;
    expect(row.directoryState).toBeUndefined();
    expect(row.directoryDetail).toBeUndefined();
  });

  /**
   * `du` is the slow part and this listing is polled every fifteen seconds, so
   * the projection measures nothing unless a caller supplies the dependency.
   * The absence of the dependency *is* the opt-in.
   */
  it("measures nothing unless a size dependency is supplied", () => {
    for (const row of build()) expect(row.diskUsage).toBeUndefined();
  });

  it("measures each listed directory when one is", () => {
    const measured: string[] = [];
    const rows = build({
      diskUsage: (folder) => {
        measured.push(folder);
        return { bytes: 4096 };
      },
    });
    expect(rows.find((f) => f.folder === wtRecorded)!.diskUsage).toEqual({ bytes: 4096 });
    // A directory that is gone has no size, and asking would put an error
    // string in the row where `directoryState: "missing"` already says it.
    expect(rows.find((f) => f.folder === vanished)!.diskUsage).toBeUndefined();
    expect(measured).not.toContain(vanished);
  });
});

describe("worktree-ness comes from the record, correctly", () => {
  it("reads a recorded worktree from the record", () => {
    const row = build().find((f) => f.folder === wtRecorded)!;
    expect(row).toMatchObject({ workspaceId: "ws-recorded", isWorktree: true, repoPath: repoDir });
  });

  it("does not badge the main checkout as a worktree despite its isolation:worktree record", () => {
    const row = build().find((f) => f.folder === repoDir)!;
    expect(row.isWorktree).toBe(false);
    expect(row.repoPath).toBeUndefined();
  });

  it("leaves a non-git directory alone", () => {
    const row = build().find((f) => f.folder === agentWorkspace)!;
    expect(row).toMatchObject({ isWorktree: false, isGitRepo: false });
    expect(row.workspaceId).toBeUndefined();
    expect(row.repoPath).toBeUndefined();
  });
});

describe("backward compatibility with the pre-Phase-3 projection", () => {
  /**
   * The grouping the route did before this phase, reimplemented here as the
   * reference. If the new projection ever changes which chat lands in which
   * row, this diverges — which is the only way to prove the invariant rather
   * than assert it.
   */
  function legacyGrouping(): { folder: string; chatCount: number; mostRecentChatId: string }[] {
    const byFolder = new Map<string, DiscoveredSession[]>();
    for (const s of sessions) {
      if (s.createdAt < cutoff) continue;
      const group = byFolder.get(s.folder) || [];
      group.push(s);
      byFolder.set(s.folder, group);
    }
    const out: { folder: string; chatCount: number; mostRecentChatId: string }[] = [];
    for (const [folder, chats] of byFolder) {
      if (!existsSync(folder)) continue;
      chats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      out.push({ folder, chatCount: chats.length, mostRecentChatId: chats[0].sessionId });
    }
    return out.sort((a, b) => a.folder.localeCompare(b.folder));
  }

  /**
   * Phase 4a adds rows for gone directories an active record claims, so parity
   * is asserted over everything else — which is every row the legacy grouping
   * ever produced. The comparison is still exact: a row the legacy rule emitted
   * must still exist, hold the same chats, and open the same chat. The added
   * rows are pinned separately, by name, above.
   */
  it("produces exactly the legacy rows, memberships and entry points", () => {
    const legacy = legacyGrouping();
    const legacyFolders = new Set(legacy.map((r) => r.folder));
    const now = build()
      .filter((f) => legacyFolders.has(f.folder))
      .map((f) => ({ folder: f.folder, chatCount: f.chatCount, mostRecentChatId: f.mostRecentChatId }))
      .sort((a, b) => a.folder.localeCompare(b.folder));
    expect(now).toEqual(legacy);
  });

  it("adds nothing to the legacy row set but gone directories the registry claims", () => {
    const legacyFolders = new Set(legacyGrouping().map((r) => r.folder));
    for (const row of build()) {
      if (legacyFolders.has(row.folder)) continue;
      expect(existsSync(row.folder)).toBe(false);
      expect(claimed.has(row.folder)).toBe(true);
    }
  });

  it("keeps every pre-existing field populated", () => {
    for (const row of build()) {
      expect(row.folder).toBeTruthy();
      expect(row.displayName).toBe(row.folder.split("/").pop());
      expect(row.mostRecentChatId).toBeTruthy();
      expect(typeof row.isGitRepo).toBe("boolean");
      expect(typeof row.isWorktree).toBe("boolean");
      expect(typeof row.isTriggered).toBe("boolean");
      expect(Date.parse(row.mostRecentChatCreatedAt)).not.toBeNaN();
      expect(Date.parse(row.lastUpdatedAt)).not.toBeNaN();
    }
  });

  it("orders rows by last activity, newest first", () => {
    const stamps = build().map((f) => Date.parse(f.lastUpdatedAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });
});
