/**
 * Repo membership: what admits a folder, and — just as load-bearing — what
 * does not. The inference that closes the 51% blind spot only ever applies to a
 * directory that is gone; a directory that is still there gets asked.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "shared/types/workspace.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-repo-scope-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const repo = join(tmpRoot, "callboard");
const nested = join(repo, "packages", "inner");
const liveWorktree = join(tmpRoot, "callboard.feat-live");
const deadWorktree = join(tmpRoot, "callboard.feat-dead"); // never created
const recordedElsewhere = join(tmpRoot, "scratch", "checkout-42"); // never created
const neighbour = join(tmpRoot, "callboard-other");
const stranger = join(tmpRoot, "unrelated");

for (const dir of [repo, nested, liveWorktree, neighbour, stranger]) mkdirSync(dir, { recursive: true });

const gitCalls: string[] = [];
vi.mock("../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/git.js")>()),
  resolveWorktreeToMainRepoCached: (folder: string) =>
    folder === liveWorktree ? { mainRepoPath: repo, isWorktree: true } : { mainRepoPath: folder, isWorktree: false },
  getGitInfo: (folder: string) => {
    gitCalls.push(folder);
    if (folder === repo) return { isGitRepo: true, branch: "main" };
    if (folder === liveWorktree) return { isGitRepo: true, branch: "feat/live" };
    return { isGitRepo: false };
  },
}));

const { createRepoScope, createLiveBranchResolver } = await import("./chat-repo-scope.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function workspace(cwd: string, repoPath: string, branch: string): Workspace {
  return {
    id: `ws-${branch}`,
    name: branch,
    cwd,
    repoPath,
    isolation: "worktree",
    worktree: { owned: true, mode: "branch-off", branch },
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("createRepoScope", () => {
  const scope = createRepoScope(repo, [workspace(recordedElsewhere, repo, "feat/recorded")]);

  it("admits the repo itself and anything inside it", () => {
    expect(scope.classify(repo)).toBe("exact");
    expect(scope.classify(join(repo, "."))).toBe("exact");
    // Callboard spawns worktrees inside a checkout; a chat run in a
    // subdirectory is still a chat in this repo.
    expect(scope.classify(nested)).toBe("descendant");
  });

  it("admits a worktree git can still resolve", () => {
    expect(scope.classify(liveWorktree)).toBe("live-git");
  });

  it("admits a removed worktree on its workspace record, whatever its path", () => {
    // The record outlives the directory, and it does not have to look like
    // anything: `scratch/checkout-42` is neither inside the repo nor beside it.
    expect(scope.classify(recordedElsewhere)).toBe("workspace-record");
  });

  it("admits a removed worktree on the path convention when nothing else can answer", () => {
    expect(scope.classify(deadWorktree)).toBe("sibling-path");
  });

  it("refuses a neighbour that still exists and is its own repo", () => {
    // `callboard-other` matches the sibling shape exactly. It is on disk, so
    // there is something to ask, and the answer is no — this is the precision
    // find_chats had, and the reason the inference is gated on absence.
    expect(scope.classify(neighbour)).toBeNull();
    expect(scope.classify(stranger)).toBeNull();
    expect(scope.classify("")).toBeNull();
  });

  it("refuses a gone directory that does not carry the repo's name", () => {
    expect(scope.classify(join(tmpRoot, "somethingelse.feat-x"))).toBeNull();
    // Right parent, right prefix, but no separator — `callboardish` is a
    // different name, not a worktree of `callboard`.
    expect(scope.classify(join(tmpRoot, "callboardish"))).toBeNull();
  });

  it("does not confuse a different repo's worktrees for this one's", () => {
    const other = createRepoScope(neighbour, [workspace(recordedElsewhere, repo, "feat/recorded")]);
    expect(other.classify(liveWorktree)).toBeNull();
    expect(other.classify(recordedElsewhere)).toBeNull();
    expect(other.classify(deadWorktree)).toBeNull();
  });
});

describe("createLiveBranchResolver", () => {
  it("reads each directory at most once", () => {
    gitCalls.length = 0;
    const branchOf = createLiveBranchResolver();
    expect(branchOf(repo)).toBe("main");
    expect(branchOf(repo)).toBe("main");
    expect(branchOf(liveWorktree)).toBe("feat/live");
    expect(branchOf(deadWorktree)).toBeNull();
    expect(branchOf("")).toBeNull();
    // Two distinct directories asked, plus the one that is gone. The empty
    // string never reaches git at all.
    expect(gitCalls).toEqual([repo, liveWorktree, deadWorktree]);
  });
});
