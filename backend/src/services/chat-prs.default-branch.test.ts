/**
 * The default branch known only from the local `origin/HEAD`: a GitHub repo
 * with no PRs at all, whose REST listings therefore carry no
 * `base.repo.default_branch`. End to end through the real fetchRepoPulls —
 * `gh` answers two empty listings, the git helpers are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const defaultBranch = vi.fn<(dir: string) => Promise<string | null>>();
vi.mock("../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/git.js")>()),
  getRemoteUrlAsync: async () => "git@github.com:acme/app.git",
  getDefaultBranchAsync: (dir: string) => defaultBranch(dir),
}));

import type { WorktreeInfo } from "../utils/git.js";
import { buildChatPrs, type ChatPrsDeps } from "./chat-prs.js";
import { fetchRepoPulls } from "./github-prs.js";

const WORKTREES: WorktreeInfo[] = [
  { path: "/src/app", branch: "trunk", isMainWorktree: true, isBare: false, head: "t1" },
  { path: "/src/app.feat", branch: "feat/x", isMainWorktree: false, isBare: false, head: "f1" },
];

const deps: ChatPrsDeps = {
  listWorktrees: async () => WORKTREES,
  mainRepoOf: () => "/src/app",
  normalize: (dir) => dir,
  exists: () => true,
  gitRootOf: (dir) => (dir.startsWith("/src/app.feat") ? "/src/app.feat" : "/src/app"),
  notRepos: new Map(),
  // The real fetch (not the cache), so every test sees its own stubs.
  pullsFor: (repoPath) => fetchRepoPulls(repoPath),
  cardOf: () => null,
};

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: string, err2: string) => void) => {
    queueMicrotask(() => cb(null, "[]", ""));
    return { stdin: { end() {} } };
  });
  defaultBranch.mockReset();
});

describe("buildChatPrs with no PRs on GitHub", () => {
  it("knows the default branch from origin/HEAD alone", async () => {
    defaultBranch.mockResolvedValue("trunk");
    expect((await buildChatPrs({ folder: "/src/app" }, deps)).current).toMatchObject({ status: "default_branch", branch: "trunk" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("still says no_pr for any other branch", async () => {
    defaultBranch.mockResolvedValue("trunk");
    expect((await buildChatPrs({ folder: "/src/app.feat" }, deps)).current).toMatchObject({ status: "no_pr", branch: "feat/x" });
  });

  it("degrades the default branch to no_pr when origin/HEAD is not set either", async () => {
    defaultBranch.mockResolvedValue(null);
    expect((await buildChatPrs({ folder: "/src/app" }, deps)).current).toMatchObject({ status: "no_pr", branch: "trunk" });
  });
});
