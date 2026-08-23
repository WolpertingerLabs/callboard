/**
 * Chat search honours the ignore list — the same list discovery honours.
 *
 * `~/.callboard/ignored-project-dirs.json` was applied by
 * `listClaudeProjectDirs()` and by `_discoverPaginated`'s `find` prune, but not
 * by `discoverProjectDirs` here, which matched project dirs on the encoded
 * folder prefix alone. An ignored directory was therefore hidden from every
 * listing and fully searchable — on the machine this was found on, a `-tmp`
 * prefix hid a directory of 164 sessions that `searchChats` returned in full.
 *
 * The filter is unconditional, so these assert *both* directions: an ignored
 * directory is invisible to search even when the caller names it, and a
 * directory that merely shares a repo prefix with one is untouched.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chat-search-"));
// CLAUDE_PROJECTS_DIR is derived from homedir() at paths.js load and
// os.homedir() honours $HOME on POSIX, so both the project tree and the
// ignore-list file land inside the fixture.
process.env.HOME = tmpRoot;
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const projectsDir = join(tmpRoot, ".claude", "projects");
mkdirSync(projectsDir, { recursive: true });

const encode = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");

/** The repo the searches are scoped to. */
const repo = join(tmpRoot, "main");
/** A worktree of `repo` that stays visible. */
const worktreeKept = join(tmpRoot, "main-kept");
/** A worktree of `repo` singled out by its own ignore prefix. */
const worktreeIgnored = join(tmpRoot, "main-ignored");
/** A standalone folder whose whole tree is ignored. */
const scratch = join(tmpRoot, "scratch");

for (const folder of [repo, worktreeKept, worktreeIgnored, scratch]) {
  mkdirSync(folder, { recursive: true });
}

/** Write `count` transcripts into the project dir for `folder`. */
function seed(folder: string, count: number, marker: string): string[] {
  const dir = join(projectsDir, encode(folder));
  mkdirSync(dir, { recursive: true });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const sessionId = `${encode(folder).slice(-12)}-${i}`;
    writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: "user", message: { content: marker } }) + "\n");
    ids.push(sessionId);
  }
  return ids;
}

const repoIds = seed(repo, 2, "shared-marker");
const keptIds = seed(worktreeKept, 1, "shared-marker");
const ignoredWorktreeIds = seed(worktreeIgnored, 1, "shared-marker");
const scratchIds = seed(scratch, 3, "shared-marker");

writeFileSync(
  join(tmpRoot, "ignored-project-dirs.json"),
  JSON.stringify({ prefixes: [encode(scratch), encode(worktreeIgnored)] }),
);

// Real git calls would shell out once per distinct folder. The worktree
// resolution is what makes `main-kept` a worktree *of* `main` rather than an
// unrelated repo that happens to share the prefix.
vi.mock("./git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveWorktreeToMainRepoCached: (folder: string) => {
    if (folder === worktreeKept || folder === worktreeIgnored) return { mainRepoPath: repo, isWorktree: true };
    return { mainRepoPath: folder, isWorktree: false };
  },
}));
// Chat records are a separate store; none of these sessions are tracked, so
// searchChats falls back to reporting the session id as the chat id.
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: { getChatBySessionId: () => null },
}));

const { searchChats } = await import("./chat-search.js");
const { listClaudeProjectDirs, isIgnoredProjectDir } = await import("./paths.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  // The fixture must actually be ignored — otherwise every "not found"
  // assertion below could pass because the ignore file never loaded.
  expect(isIgnoredProjectDir(encode(scratch))).toBe(true);
  expect(isIgnoredProjectDir(encode(worktreeIgnored))).toBe(true);
  expect(isIgnoredProjectDir(encode(repo))).toBe(false);
});

const sessionIdsFor = (filters: Parameters<typeof searchChats>[0]) => searchChats(filters).chats.map((c) => c.sessionId).sort();

describe("searchChats and the ignore list", () => {
  it("does not search an ignored folder, even when the caller names it", () => {
    // Non-vacuous: the transcripts are on disk and would be found but for the
    // ignore list — seeded above and asserted found for `repo` below.
    expect(scratchIds).toHaveLength(3);
    expect(searchChats({ folder: scratch, limit: 50 })).toEqual({ chats: [], total: 0 });
  });

  it("does not search an ignored folder with a grep term either", () => {
    // The grep path narrows a candidate list, so an empty candidate list is
    // the only thing that keeps it off the ignored transcripts.
    expect(searchChats({ folder: scratch, grep: "shared-marker", limit: 50 })).toEqual({ chats: [], total: 0 });
  });

  it("still searches a folder that is not ignored", () => {
    expect(sessionIdsFor({ folder: repo, limit: 50 })).toEqual([...repoIds, ...keptIds].sort());
    expect(sessionIdsFor({ folder: repo, grep: "shared-marker", limit: 50 })).toEqual([...repoIds, ...keptIds].sort());
    expect(sessionIdsFor({ folder: repo, grep: "no-such-text", limit: 50 })).toEqual([]);
  });

  it("drops an ignored worktree while keeping its sibling and its main repo", () => {
    // Per dir *name*: `main-ignored` is a worktree of a repo that is itself
    // visible, so a filter keyed on the resolved main repo would keep it.
    const found = sessionIdsFor({ folder: repo, limit: 50 });
    expect(found).toContain(keptIds[0]);
    expect(found).not.toContain(ignoredWorktreeIds[0]);
  });

  it("surfaces no directory that discovery would have pruned", () => {
    // The invariant the two paths disagreed on. Every folder in the fixture,
    // searched, must only yield sessions from dirs discovery also lists.
    const listed = new Set(listClaudeProjectDirs());
    for (const folder of [repo, worktreeKept, worktreeIgnored, scratch]) {
      for (const chat of searchChats({ folder, limit: 50 }).chats) {
        expect(listed).toContain(encode(chat.folder));
      }
    }
  });
});
