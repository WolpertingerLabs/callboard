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

function build() {
  return buildFolderSummaries(sessions, {
    cutoff,
    workspaces: buildWorkspaceIndex(records),
    directoryExists: (folder) => existsSync(folder),
    chatMetadata: () => ({}),
    isOngoing: () => false,
    isWaiting: () => false,
    gitInfo: (folder) => ({ isGitRepo: existsSync(join(folder, ".git")), branch: "main" }),
  });
}

/** Sessions the sidebar is supposed to account for: in window, directory alive. */
const eligible = sessions.filter((s) => s.createdAt >= cutoff && existsSync(s.folder));

describe("no chat disappears", () => {
  it("accounts for every eligible chat exactly once", () => {
    const folders = build();
    const total = folders.reduce((sum, f) => sum + f.chatCount, 0);
    expect(total).toBe(eligible.length);
    expect(total).toBe(56); // 40 forge + 12 main + 2 recorded + 1 bare + 1 stale
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
    expect(folders.map((f) => f.folder).sort()).toEqual([agentWorkspace, repoDir, wtBare, wtRecorded, wtStaleRecord].sort());
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
   * An active record for a removed directory must not conjure a row. Six of
   * the nine real records are in exactly this state, so a workspace-first
   * projection would have filled the sidebar with rows pointing nowhere.
   */
  it("does not resurrect a directory that is gone, even with an active record", () => {
    expect(build().map((f) => f.folder)).not.toContain(vanished);
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

  it("produces exactly the legacy rows, memberships and entry points", () => {
    const now = build()
      .map((f) => ({ folder: f.folder, chatCount: f.chatCount, mostRecentChatId: f.mostRecentChatId }))
      .sort((a, b) => a.folder.localeCompare(b.folder));
    expect(now).toEqual(legacyGrouping());
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
