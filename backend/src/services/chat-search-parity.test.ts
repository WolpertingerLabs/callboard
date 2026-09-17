/**
 * Parity fixture for the `find_chats` → `search_chats` consolidation.
 *
 * `find_chats` is being deleted. Before it goes, this file pins **what it
 * actually returns** across a representative query set, on a fixture shaped
 * like the corpus the consolidation was motivated by.
 *
 * The fixture fills all four cells of {worktree, unrelated} × {present, gone},
 * because the two that decide correctness are the ones a smaller fixture omits:
 *
 *  - a main checkout, and a **live** worktree of it;
 *  - a **removed** worktree with a workspace record naming this repo, and one
 *    with no record at all — the actual shape of the 51%, admitted on the path
 *    convention alone;
 *  - an unrelated repo that still exists and merely shares the path prefix,
 *    whose browse projection decodes to a path *inside* the repo;
 *  - a **removed** directory shaped exactly like a worktree of this repo whose
 *    workspace record names a different main checkout.
 *
 * The last two are what separate "refused" from "no evidence". Drop them and
 * the precision half of this file cannot fail.
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
/**
 * A different repo that shares `repo`'s path prefix. Must never be admitted.
 *
 * `<repo>/unrelated` is created alongside it so the project-dir decoder's
 * greedy directory scan resolves `-…-repo-unrelated` to `<repo>/unrelated` —
 * a browse projection that is lexically *inside* the repo. That is not a
 * contrivance, it is how the decoder works: it commits a segment as soon as the
 * path so far exists. Without this row the precision assertion below passes
 * because the fabricated path happens to land nowhere, which is luck, not the
 * property under test.
 */
const unrelated = join(tmpRoot, "repo-unrelated");
const decoyInsideRepo = join(repo, "unrelated");

/**
 * A removed directory that looks exactly like a worktree of `repo` — right
 * parent, right prefix, right separator — but whose workspace record names a
 * different main checkout. The record is the only thing that can answer, and it
 * says no. Fills the {unrelated × removed} cell.
 */
const deadOther = join(tmpRoot, "repo.other-removed");

/**
 * A removed worktree of `repo` with NO workspace record at all — the actual
 * shape of the 51%. Workspace records are only written when a chat starts in a
 * worktree, and the entity is recent, so the overwhelming majority of removed
 * worktrees have nothing but their path. This is the row `sibling-path` exists
 * for, and the only one that reaches it now that `dead` has a record.
 */
const deadOrphan = join(tmpRoot, "repo.feature-orphan");

for (const folder of [repo, live, unrelated, decoyInsideRepo]) mkdirSync(folder, { recursive: true });

// Workspace registry: one record admitting `dead` to `repo`, one refusing
// `deadOther`. Both directories are gone, so these records are all the
// evidence there is — which is the point of writing them.
mkdirSync(join(tmpRoot, "workspaces"), { recursive: true });
for (const [id, cwd, repoPath, branch] of [
  ["ws-dead", dead, repo, "feature/dead"],
  ["ws-dead-other", deadOther, unrelated, "other/removed"],
]) {
  writeFileSync(
    join(tmpRoot, "workspaces", `${id}.json`),
    JSON.stringify({
      id,
      name: branch,
      cwd,
      repoPath,
      isolation: "worktree",
      worktree: { owned: true, mode: "branch-off", branch },
      status: "active",
      createdAt: "2026-08-01T00:00:00Z",
    }),
  );
}

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
  // {unrelated × removed}: sibling-shaped, gone, and owned by another repo.
  { id: "00000000-0000-4000-8000-000000000007", folder: deadOther, marker: "alpha", lastBranch: "other/removed", at: 70 },
  // {worktree × removed, no record}: path inference is all there is.
  { id: "00000000-0000-4000-8000-000000000008", folder: deadOrphan, marker: "gamma", lastBranch: "feature/orphan", at: 80 },
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
// Native-lineage discovery reads Codex's home directly. Point it inside the
// fixture, or this test reads whatever rollouts the machine happens to have.
vi.mock("./agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-settings.js")>()),
  getAgentSettings: () => ({ codexHome: join(tmpRoot, "codex") }),
}));
vi.mock("../agents/factory.js", async () => {
  const { ClaudeCodeSessionProvider } = await import("../agents/adapters/claude-code/ClaudeCodeSessionProvider.js");
  return { getSessionProviders: () => [new ClaudeCodeSessionProvider()] };
});

const { searchChats: legacySearchChats } = await import("../utils/chat-search.js");
const { searchChats: mergedSearchChats } = await import("./chat-query.js");
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

/**
 * The mechanical translation of a `find_chats` call into the merged tool.
 *
 * `find_chats`' `folder` always meant "this repo *and its worktrees*", which is
 * the merged tool's `repo`; its exact-cwd sense is `folder`. `gitBranch` is
 * `branch`. Everything else keeps its name. Mechanical on purpose — a
 * hand-tuned translation could hide a narrowing by translating around it.
 */
function toMerged(legacy: LegacyFilters) {
  const { folder, gitBranch, ...rest } = legacy;
  return { repo: folder, ...(gitBranch !== undefined && { branch: gitBranch }), ...rest, limit: 100 };
}
const mergedIds = async (legacy: LegacyFilters) => (await mergedSearchChats(toMerged(legacy))).chats.map((c) => c.chatId);

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

describe("search_chats is a superset of find_chats", () => {
  it("returns every row the baseline returned, for every query shape", async () => {
    // `arrayContaining([])` is vacuously true, and some shapes legitimately
    // have an empty baseline (`gitBranch: "feature/dead"` is the reach bug
    // itself). Count the ones that actually constrain something, so a fixture
    // that stops producing rows fails here instead of passing silently.
    let constraining = 0;
    for (const { name, legacy } of PARITY_QUERIES) {
      const baseline = findChats(legacy);
      if (baseline.length) constraining++;
      const merged = await mergedIds(legacy);
      expect(merged, `${name}: lost rows ${baseline.filter((id) => !merged.includes(id)).join(", ")}`).toEqual(expect.arrayContaining(baseline));
    }
    expect(constraining).toBeGreaterThanOrEqual(PARITY_QUERIES.length - 2);
  });

  it("reaches the removed worktree the baseline could not", async () => {
    // The 51%. Same queries, same fixture — these are the rows the live-`.git`
    // gate hid, now admitted on the record's own evidence.
    expect((await mergedIds({ folder: repo })).sort()).toEqual([R.r1, R.r2, R.r3, R.r4, R.r5, R.r8].sort());
    expect((await mergedIds({ folder: repo, gitBranch: "feature/dead" })).sort()).toEqual([R.r4, R.r5].sort());
    expect(await mergedIds({ folder: repo, agentAlias: "forge" })).toEqual(expect.arrayContaining([R.r2, R.r4]));
    expect(await mergedIds({ folder: repo, triggered: true })).toEqual(expect.arrayContaining([R.r2, R.r4]));
    expect(await mergedIds({ folder: repo, grep: "alpha" })).toEqual(expect.arrayContaining([R.r1, R.r3, R.r4]));
    expect(await mergedIds({ folder: repo, parentChatId: R.r4 })).toEqual([R.r5]);
    expect((await mergedIds({ folder: repo, rootChatId: R.r4 })).sort()).toEqual([R.r4, R.r5].sort());
  });

  it("still refuses a neighbouring repo that only shares the path prefix", async () => {
    // The precision `find_chats` had, kept. `repo-unrelated` is beside `repo`,
    // its name starts with `repo`, and it is its own checkout — the path
    // inference must not reach it, because the directory is there to be asked.
    //
    // Non-vacuous by construction: the fixture creates `<repo>/unrelated`, so
    // r6's browse projection decodes to a path lexically INSIDE the repo. If a
    // refusal on the record's true cwd did not end the question, the projection
    // would get a second turn and be admitted as `descendant`.
    expect((await mergedSearchChats({ folder: unrelated, limit: 100 })).chats[0].folder).toBe(decoyInsideRepo);
    for (const { name, legacy } of PARITY_QUERIES) {
      if (legacy.folder !== repo) continue;
      expect(await mergedIds(legacy), name).not.toContain(R.r6);
    }
    expect(await mergedIds({ folder: unrelated })).toEqual(expect.arrayContaining([R.r6]));
  });

  it("refuses a removed sibling whose workspace record names a different repo", async () => {
    // {unrelated × removed}: nothing on disk can be asked, the path looks
    // exactly like a worktree of `repo`, and the only evidence — the workspace
    // record — says it belongs to `repo-unrelated`. The strongest evidence
    // anyone holds must not lose to the weakest inference.
    for (const { name, legacy } of PARITY_QUERIES) {
      if (legacy.folder !== repo) continue;
      expect(await mergedIds(legacy), name).not.toContain(R.r7);
    }
    // And it is genuinely reachable — this is a refusal, not a row the fixture
    // forgot to make findable.
    expect(await mergedIds({ folder: unrelated })).toEqual(expect.arrayContaining([R.r7]));
    expect((await mergedSearchChats({ repo: unrelated, limit: 100 })).chats.find((c) => c.chatId === R.r7)?.repoSource).toBe("workspace-record");
  });

  it("normalises a worktree path up to its main checkout", async () => {
    // Callboard's normal mode is an agent running inside a worktree, so
    // `repo: process.cwd()` is the natural value to pass. Taken verbatim it
    // would return only that worktree's chats, with a confident total.
    const result = await mergedSearchChats({ repo: live, limit: 100 });
    expect(result.chats.map((c) => c.chatId).sort()).toEqual([R.r1, R.r2, R.r3, R.r4, R.r5, R.r8].sort());
    expect(result.appliedFilters.repoRoot).toBe(repo);
    expect(result.appliedFilters.repoNormalisedFrom).toBe(live);
  });

  it("stamps how each row was admitted and where its branch came from", async () => {
    const rows = (await mergedSearchChats({ repo, limit: 100 })).chats;
    const by = new Map(rows.map((row) => [row.chatId, row]));
    // The main checkout is exact; the live worktree is git-resolved; the
    // removed one is the inference, and says so rather than passing as fact.
    expect(by.get(R.r1)).toMatchObject({ repoSource: "exact", branch: "main", branchSource: "record" });
    expect(by.get(R.r3)).toMatchObject({ repoSource: "live-git", branch: "feature/live", branchSource: "record" });
    expect(by.get(R.r4)).toMatchObject({ repoSource: "workspace-record", branch: "feature/dead", branchSource: "record" });
    // The 51% shape: gone, no record, admitted on the path convention alone —
    // and reported as that inference rather than as fact.
    expect(by.get(R.r8)).toMatchObject({ repoSource: "sibling-path", branch: "feature/orphan", branchSource: "record" });
  });

  it("labels a grep hit with what the engine actually matched", async () => {
    const rows = (await mergedSearchChats({ repo, grep: "alpha", limit: 100 })).chats;
    expect(rows.map((r) => r.chatId).sort()).toEqual([R.r1, R.r3, R.r4].sort());
    // claude-code greps the whole transcript; a codex row here would say
    // first-prompt. The row carries the distinction so the caller need not know
    // which engine wrote the log.
    for (const row of rows) expect(row.matchKind).toBe("transcript");
    expect((await mergedSearchChats({ repo, grep: "alpha", limit: 100 })).appliedFilters.contentSearchSemantics).toMatch(/matchKind/);
  });

  it("keeps date bounds and both sort orders", async () => {
    expect((await mergedIds({ folder: repo, updatedAfter: stamp(25) })).sort()).toEqual([R.r3, R.r4, R.r5, R.r8].sort());
    expect((await mergedIds({ folder: repo, updatedBefore: stamp(25) })).sort()).toEqual([R.r1, R.r2].sort());
    expect(await mergedIds({ folder: repo, sort: "updated" })).toEqual([R.r8, R.r5, R.r4, R.r3, R.r2, R.r1]);
    // `sort: "created"` orders by the transcript's birth time, which on a
    // fixture written in one pass is millisecond-granular — so the contract to
    // assert is that it is non-increasing over the same row set, not a
    // hand-written permutation of it.
    const created = (await mergedSearchChats({ repo, sort: "created", limit: 100 })).chats;
    expect(created.map((c) => c.chatId).sort()).toEqual([R.r1, R.r2, R.r3, R.r4, R.r5, R.r8].sort());
    const keys = created.map((c) => Date.parse(c.createdAt));
    expect(keys).toEqual([...keys].sort((a, b) => b - a));
  });
});
