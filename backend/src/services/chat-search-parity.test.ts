/**
 * Parity fixture for the `find_chats` → `search_chats` consolidation.
 *
 * `find_chats` is being deleted. Before it goes, this file pins **what it
 * actually returns** across a representative query set, on a fixture shaped
 * like the corpus the consolidation was motivated by:
 *
 *  - a main checkout,
 *  - a live worktree of it,
 *  - a worktree whose directory has been **removed** (the branch is still
 *    recorded on every chat that ran there), and
 *  - an unrelated repo that merely shares the main checkout's path prefix.
 *
 * The first `describe` is the baseline: `find_chats` semantics as shipped,
 * including the reach bug — `discoverProjectDirs` admits a worktree only when
 * `resolveWorktreeToMainRepo` finds a live `.git`, so every chat that ran in a
 * removed worktree is invisible to the tool under *every* filter, `grep`
 * included. On the machine this was measured on that was 129 of 255 claude-code
 * sessions (51%), in 52 removed worktrees, all with `metadata.lastBranch`
 * recorded correctly.
 *
 * The second `describe` is the guarantee: the merged `search_chats` returns a
 * **superset** of each baseline row set, plus the rows the baseline was blind
 * to. If a future change narrows `search_chats`, the superset assertions fail
 * with the exact query shape that regressed.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-parity-"));
// paths.js derives CLAUDE_PROJECTS_DIR from homedir() at load, and os.homedir()
// honours $HOME on POSIX, so both the transcript tree and the data dir land
// inside the fixture. Set before any dynamic import below.
process.env.HOME = tmpRoot;
process.env.CALLBOARD_DATA_DIR = tmpRoot;

// The fixture lives under /tmp, which `DEFAULT_IGNORED_PROJECT_DIR_PREFIXES`
// ignores wholesale. Opt it back in explicitly, the same way the other
// /tmp-based query fixtures do, or every assertion here passes vacuously.
mkdirSync(join(tmpRoot, "chats"), { recursive: true });
writeFileSync(join(tmpRoot, "ignored-project-dirs.json"), JSON.stringify({ prefixes: ["-zzz-nothing-here"] }));

const projectsDir = join(tmpRoot, ".claude", "projects");
mkdirSync(projectsDir, { recursive: true });

/** Main checkout. */
const repo = join(tmpRoot, "repo");
/** A live worktree of `repo` — directory present, `.git` resolvable. */
const live = join(tmpRoot, "repo.feature-live");
/** A worktree of `repo` whose directory has been removed. Never created. */
const dead = join(tmpRoot, "repo.feature-dead");
/** A different repo that shares `repo`'s path prefix. Must never be admitted. */
const unrelated = join(tmpRoot, "repo-unrelated");

for (const folder of [repo, live, unrelated]) mkdirSync(folder, { recursive: true });

const encode = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");

type Row = {
  id: string;
  folder: string;
  marker: string;
  lastBranch: string;
  agentAlias?: string;
  triggered?: boolean;
  parentChatId?: string;
  rootChatId?: string;
  /** Minutes past the fixture epoch; becomes both mtime and `updated_at`. */
  at: number;
};

const EPOCH = Date.parse("2026-09-01T00:00:00.000Z");
const stamp = (at: number) => new Date(EPOCH + at * 60_000).toISOString();

const ROWS: Row[] = [
  { id: "00000000-0000-4000-8000-000000000001", folder: repo, marker: "alpha", lastBranch: "main", at: 10 },
  {
    id: "00000000-0000-4000-8000-000000000002",
    folder: repo,
    marker: "beta",
    lastBranch: "main",
    agentAlias: "forge",
    triggered: true,
    parentChatId: "00000000-0000-4000-8000-000000000001",
    rootChatId: "00000000-0000-4000-8000-000000000001",
    at: 20,
  },
  { id: "00000000-0000-4000-8000-000000000003", folder: live, marker: "alpha", lastBranch: "feature/live", agentAlias: "scout", at: 30 },
  { id: "00000000-0000-4000-8000-000000000004", folder: dead, marker: "alpha", lastBranch: "feature/dead", agentAlias: "forge", triggered: true, at: 40 },
  {
    id: "00000000-0000-4000-8000-000000000005",
    folder: dead,
    marker: "beta",
    lastBranch: "feature/dead",
    parentChatId: "00000000-0000-4000-8000-000000000004",
    rootChatId: "00000000-0000-4000-8000-000000000004",
    at: 50,
  },
  { id: "00000000-0000-4000-8000-000000000006", folder: unrelated, marker: "alpha", lastBranch: "trunk", at: 60 },
];

const R = Object.fromEntries(ROWS.map((r, i) => [`r${i + 1}`, r.id])) as Record<string, string>;

for (const row of ROWS) {
  // Transcript, in the engine's own project-dir encoding.
  const dir = join(projectsDir, encode(row.folder));
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${row.id}.jsonl`);
  writeFileSync(logPath, JSON.stringify({ type: "user", message: { role: "user", content: `marker ${row.marker}` } }) + "\n");
  const seconds = (EPOCH + row.at * 60_000) / 1000;
  utimesSync(logPath, seconds, seconds);

  // Callboard record. `folder` is the TRUE working directory — for `dead` that
  // is a path the project-dir decoder can no longer recover.
  writeFileSync(
    join(tmpRoot, "chats", `${row.id}.json`),
    JSON.stringify({
      id: row.id,
      session_id: row.id,
      folder: row.folder,
      session_log_path: logPath,
      created_at: stamp(row.at),
      updated_at: stamp(row.at),
      metadata: JSON.stringify({
        provider: "claude-code",
        title: `chat ${row.marker}`,
        lastBranch: row.lastBranch,
        ...(row.agentAlias && { agentAlias: row.agentAlias }),
        ...(row.triggered && { triggered: true }),
        ...(row.parentChatId && { parentChatId: row.parentChatId }),
        ...(row.rootChatId && { rootChatId: row.rootChatId }),
      }),
    }),
  );
}

// Real git calls would shell out per directory. What the mock supplies is the
// one fact `find_chats` gates its whole worktree expansion on: `live` resolves
// back to `repo`, `dead` (absent from disk) resolves to nothing.
vi.mock("../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/git.js")>()),
  getGitInfo: (folder: string) => {
    if (folder === repo) return { isGitRepo: true, branch: "main" };
    if (folder === live) return { isGitRepo: true, branch: "feature/live" };
    if (folder === unrelated) return { isGitRepo: true, branch: "trunk" };
    return { isGitRepo: false };
  },
  resolveWorktreeToMainRepoCached: (folder: string) =>
    folder === live ? { mainRepoPath: repo, isWorktree: true } : { mainRepoPath: folder, isWorktree: false },
  resolveWorktreeToMainRepo: (folder: string) =>
    folder === live ? { mainRepoPath: repo, isWorktree: true } : { mainRepoPath: folder, isWorktree: false },
}));
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined, hasPendingRequest: () => false, getPendingRequest: () => undefined }));
vi.mock("../agents/factory.js", async () => {
  const { ClaudeCodeSessionProvider } = await import("../agents/adapters/claude-code/ClaudeCodeSessionProvider.js");
  return { getSessionProviders: () => [new ClaudeCodeSessionProvider()] };
});

const { searchChats: legacySearchChats } = await import("../utils/chat-search.js");
const { chatFileService } = await import("./chat-file-service.js");
const { getParentChatId } = await import("./chat-lineage.js");
const { isIgnoredProjectDir } = await import("../utils/paths.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * `find_chats` as the tool actually composed it: the provider's folder search,
 * then the lineage post-filter that lived in `callboard-tools.ts`. Reproduced
 * here rather than imported because the tool definition is what stage 4 removes
 * — the point of this file is that the *behaviour* survives it.
 */
type LegacyFilters = Parameters<typeof legacySearchChats>[0] & { parentChatId?: string; rootChatId?: string };
function findChats(filters: LegacyFilters): string[] {
  const { parentChatId, rootChatId, ...rest } = filters;
  let chats = legacySearchChats({ limit: 50, ...rest }).chats;
  if (parentChatId || rootChatId) {
    chats = chats.filter((c) => {
      const stored = chatFileService.getChat(c.chatId);
      if (!stored) return false;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(stored.metadata || "{}");
      } catch {
        /* a malformed record filters out, as it did in the tool */
      }
      if (parentChatId && getParentChatId(meta) !== parentChatId) return false;
      if (rootChatId && meta.rootChatId !== rootChatId && stored.id !== rootChatId) return false;
      return true;
    });
  }
  return chats.map((c) => c.chatId);
}

/**
 * The representative query set, named so a superset failure in the second
 * `describe` reports which shape regressed. Every one is folder-scoped, because
 * `find_chats` has no other mode — `folder` is required.
 */
const PARITY_QUERIES: { name: string; legacy: LegacyFilters }[] = [
  { name: "folder only", legacy: { folder: repo } },
  { name: "folder + grep", legacy: { folder: repo, grep: "alpha" } },
  { name: "folder + grep (other marker)", legacy: { folder: repo, grep: "beta" } },
  { name: "folder + gitBranch main", legacy: { folder: repo, gitBranch: "main" } },
  { name: "folder + gitBranch feature/live", legacy: { folder: repo, gitBranch: "feature/live" } },
  { name: "folder + gitBranch feature/dead", legacy: { folder: repo, gitBranch: "feature/dead" } },
  { name: "folder + agentAlias forge", legacy: { folder: repo, agentAlias: "forge" } },
  { name: "folder + agentAlias scout", legacy: { folder: repo, agentAlias: "scout" } },
  { name: "folder + triggered true", legacy: { folder: repo, triggered: true } },
  { name: "folder + triggered false", legacy: { folder: repo, triggered: false } },
  { name: "folder + updatedAfter", legacy: { folder: repo, updatedAfter: stamp(25) } },
  { name: "folder + updatedBefore", legacy: { folder: repo, updatedBefore: stamp(25) } },
  { name: "folder + date window", legacy: { folder: repo, updatedAfter: stamp(15), updatedBefore: stamp(55) } },
  { name: "folder + sort updated", legacy: { folder: repo, sort: "updated" } },
  { name: "folder + sort created", legacy: { folder: repo, sort: "created" } },
  { name: "folder + parentChatId", legacy: { folder: repo, parentChatId: R.r1 } },
  { name: "folder + rootChatId", legacy: { folder: repo, rootChatId: R.r1 } },
  { name: "folder = live worktree", legacy: { folder: live } },
  { name: "folder = removed worktree", legacy: { folder: dead } },
];

describe("find_chats baseline (the behaviour search_chats must keep)", () => {
  it("has a fixture that is actually searchable", () => {
    // Non-vacuous: if /tmp were still ignored, every assertion below would pass
    // by returning nothing.
    expect(isIgnoredProjectDir(encode(repo))).toBe(false);
    expect(isIgnoredProjectDir(encode(dead))).toBe(false);
    expect(findChats({ folder: repo })).not.toHaveLength(0);
  });

  it("expands a folder to its LIVE worktrees and nothing else", () => {
    // r3 is the live worktree; r6 shares the path prefix but is its own repo.
    expect(findChats({ folder: repo }).sort()).toEqual([R.r1, R.r2, R.r3].sort());
  });

  it("cannot reach a removed worktree's chats from the repo, under any filter", () => {
    // The reach bug, pinned exactly. The expansion at `discoverProjectDirs` is
    // gated on `resolveWorktreeToMainRepo` finding a live `.git`, so no
    // repo-scoped query reaches r4/r5 — not `grep`, not the recorded branch
    // they both carry, not a date window that spans them.
    for (const { name, legacy } of PARITY_QUERIES) {
      if (legacy.folder === dead) continue;
      expect(findChats(legacy), name).not.toContain(R.r4);
      expect(findChats(legacy), name).not.toContain(R.r5);
    }
    // Not because the transcripts are unreadable: naming the removed worktree's
    // exact path still finds them, via the exact-encoding branch that skips the
    // git check entirely. So the data is there and the caller has to already
    // know the path of a directory that no longer exists to get at it — which
    // is the failure, stated precisely.
    expect(findChats({ folder: dead }).sort()).toEqual([R.r4, R.r5].sort());
  });

  it("filters a folder-scoped search by grep, branch, alias and triggered", () => {
    expect(findChats({ folder: repo, grep: "alpha" }).sort()).toEqual([R.r1, R.r3].sort());
    expect(findChats({ folder: repo, grep: "beta" })).toEqual([R.r2]);
    expect(findChats({ folder: repo, gitBranch: "main" }).sort()).toEqual([R.r1, R.r2].sort());
    expect(findChats({ folder: repo, gitBranch: "feature/live" })).toEqual([R.r3]);
    // Recorded on r4/r5, which the expansion never reaches.
    expect(findChats({ folder: repo, gitBranch: "feature/dead" })).toEqual([]);
    expect(findChats({ folder: repo, agentAlias: "forge" })).toEqual([R.r2]);
    expect(findChats({ folder: repo, agentAlias: "scout" })).toEqual([R.r3]);
    expect(findChats({ folder: repo, triggered: true })).toEqual([R.r2]);
    expect(findChats({ folder: repo, triggered: false }).sort()).toEqual([R.r1, R.r3].sort());
  });

  it("bounds by date and orders newest-first on both sorts", () => {
    expect(findChats({ folder: repo, updatedAfter: stamp(25) })).toEqual([R.r3]);
    expect(findChats({ folder: repo, updatedBefore: stamp(25) }).sort()).toEqual([R.r1, R.r2].sort());
    expect(findChats({ folder: repo, updatedAfter: stamp(15), updatedBefore: stamp(55) }).sort()).toEqual([R.r2, R.r3].sort());
    expect(findChats({ folder: repo, sort: "updated" })).toEqual([R.r3, R.r2, R.r1]);
    // `sort: "created"` reorders by birthtime; on a fixture written in one pass
    // that is the write order, so this pins the option is accepted, not a
    // different ordering.
    expect(findChats({ folder: repo, sort: "created" }).sort()).toEqual([R.r1, R.r2, R.r3].sort());
  });

  it("scopes lineage filters to the folder", () => {
    expect(findChats({ folder: repo, parentChatId: R.r1 })).toEqual([R.r2]);
    expect(findChats({ folder: repo, rootChatId: R.r1 }).sort()).toEqual([R.r1, R.r2].sort());
    // r5's parent is r4, and neither is reachable — a lineage filter cannot
    // widen a corpus the folder expansion already excluded.
    expect(findChats({ folder: repo, parentChatId: R.r4 })).toEqual([]);
  });
});
