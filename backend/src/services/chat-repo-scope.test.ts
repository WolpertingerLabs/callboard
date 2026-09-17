/**
 * Repo membership: what admits a folder, what **refuses** it, and what cannot
 * answer at all.
 *
 * The three-way distinction is the whole point. A caller holds two spellings of
 * a chat's cwd — the record's, which is real, and the browse projection, which
 * for a removed directory is a decode that may name a path that never existed.
 * If "refused" and "no evidence" were the same value, a refusal on the real
 * spelling would hand the fabricated one a second turn at the same question,
 * and the lexical `descendant` rule would admit a neighbouring repo as fact.
 * These tests assert the refusals as hard as the admissions.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Only the checkouts get a `.git`; `nested` deliberately does not, because a
// directory inside a repository is the case the branch resolver used to pay a
// subprocess for.
for (const dir of [repo, liveWorktree, neighbour, stranger]) writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n");

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
    id: `ws-${branch.replace(/\W/g, "-")}`,
    name: branch,
    cwd,
    repoPath,
    isolation: "worktree",
    worktree: { owned: true, mode: "branch-off", branch },
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** A removed directory shaped exactly like a worktree of `callboard`. */
const deadButOwnedElsewhere = join(tmpRoot, "callboard.owned-elsewhere");

const RECORDS = [workspace(recordedElsewhere, repo, "feat/recorded"), workspace(deadButOwnedElsewhere, stranger, "feat/theirs")];

describe("createRepoScope", () => {
  const scope = createRepoScope(repo, RECORDS);

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

  it("REFUSES a neighbour that still exists and is its own repo", () => {
    // `callboard-other` matches the sibling shape exactly. It is on disk, so
    // there is something to ask, and the answer is no. The verdict must be
    // `refused` and not `null`: null would let the caller try the fabricated
    // spelling of the same directory and get a `descendant` out of it.
    expect(scope.classify(neighbour)).toBe("refused");
    expect(scope.classify(stranger)).toBe("refused");
  });

  it("REFUSES a removed directory whose record names a different main checkout", () => {
    // Nothing on disk can be asked and the path looks like a worktree of this
    // repo, so `sibling-path` would fire. The record is the strongest evidence
    // anyone holds and it must not lose to the weakest inference.
    expect(scope.classify(deadButOwnedElsewhere)).toBe("refused");
    // Non-vacuous: identical path shape, no record, admitted.
    expect(scope.classify(join(tmpRoot, "callboard.no-record"))).toBe("sibling-path");
  });

  it("has no answer for a folder nothing relates to this repo", () => {
    expect(scope.classify(join(tmpRoot, "somethingelse.feat-x"))).toBeNull();
    // Right parent, right prefix, but no separator — `callboardish` is a
    // different name, not a worktree of `callboard`.
    expect(scope.classify(join(tmpRoot, "callboardish"))).toBeNull();
    expect(scope.classify("")).toBeNull();
  });

  it("does not confuse a different repo's worktrees for this one's", () => {
    const other = createRepoScope(neighbour, RECORDS);
    expect(other.classify(liveWorktree)).toBe("refused");
    expect(other.classify(recordedElsewhere)).toBe("refused");
    expect(other.classify(deadWorktree)).toBeNull();
  });

  it("normalises a worktree path up to its main checkout", () => {
    // Callboard's normal mode is an agent running inside a worktree, so
    // `repo: process.cwd()` is the natural value to pass — and, taken
    // verbatim, the one that silently returns just that worktree's chats.
    const fromWorktree = createRepoScope(liveWorktree, RECORDS);
    expect(fromWorktree.repoRoot).toBe(repo);
    expect(fromWorktree.normalisedFrom).toBe(liveWorktree);
    expect(fromWorktree.classify(repo)).toBe("exact");
    expect(fromWorktree.classify(deadWorktree)).toBe("sibling-path");
    expect(fromWorktree.classify(liveWorktree)).toBe("live-git");
  });

  it("normalises a REMOVED worktree path through its workspace record", () => {
    // git cannot answer for a directory that is gone; the record can.
    const fromGone = createRepoScope(deadButOwnedElsewhere, RECORDS);
    expect(fromGone.repoRoot).toBe(stranger);
    expect(fromGone.normalisedFrom).toBe(deadButOwnedElsewhere);
  });

  it("reports no normalisation when given a main checkout", () => {
    expect(createRepoScope(repo, RECORDS).normalisedFrom).toBeNull();
  });
});

describe("createLiveBranchResolver", () => {
  it("reads each directory at most once and never spawns for a missing .git", () => {
    gitCalls.length = 0;
    const branchOf = createLiveBranchResolver();
    expect(branchOf(repo)).toBe("main");
    expect(branchOf(repo)).toBe("main");
    expect(branchOf(liveWorktree)).toBe("feat/live");
    // Gone: no `.git` anywhere above it inside the fixture, so git is never
    // asked. This is the call that used to cost a 2.73 ms subprocess.
    expect(branchOf(deadWorktree)).toBeNull();
    expect(branchOf("")).toBeNull();
    expect(gitCalls).toEqual([repo, liveWorktree]);
  });

  it("answers for a directory inside a repo by walking up, not by spawning", () => {
    gitCalls.length = 0;
    const branchOf = createLiveBranchResolver();
    // `nested` has no `.git` of its own. The old code handed it to getGitInfo,
    // which spawned `git rev-parse --git-dir`; this walks up with stat calls
    // and hands git a directory it can serve from HEAD.
    expect(branchOf(nested)).toBe("main");
    expect(gitCalls).toEqual([repo]);
  });
});
