import { describe, expect, it, vi } from "vitest";
import type { WorktreeInfo } from "../utils/git.js";
import type { PullSummary, RepoPulls } from "./github-prs.js";
import { buildChatPrs, type ChatCard, type ChatPrsDeps } from "./chat-prs.js";

const wt = (path: string, branch: string | null, isMainWorktree = false, head?: string): WorktreeInfo => ({
  path,
  branch,
  isMainWorktree,
  isBare: false,
  ...(head && { head }),
});

const pull = (number: number, headRef: string, state: PullSummary["state"] = "open", headSha = "x", updatedAt = "2026-11-01T00:00:00Z"): PullSummary => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  title: `PR ${number}`,
  state,
  headRef,
  headSha,
  headOwner: "acme",
  updatedAt,
  baseRef: "main",
  author: "dev",
  createdAt: "2026-10-01T00:00:00Z",
});

/** `app` with three linked worktrees, and `lib` on its own. */
const WORKTREES: Record<string, WorktreeInfo[]> = {
  "/src/app": [
    wt("/src/app", "main", true, "m1"),
    wt("/src/app.feat-a", "feat/a", false, "a1"),
    wt("/src/app.feat-b", "feat/b", false, "b1"),
    wt("/src/app.bisect", null, false, "d1"),
  ],
  "/src/lib": [wt("/src/lib", "fix/lib", true, "l1")],
};
const GIT_ROOTS = ["/src/app", "/src/app.feat-a", "/src/app.feat-b", "/src/app.bisect", "/src/lib"];
const MAIN_OF: Record<string, string> = { "/src/app.feat-a": "/src/app", "/src/app.feat-b": "/src/app", "/src/app.bisect": "/src/app" };

const GITHUB = { owner: "acme", repo: "app" };
const APP_PULLS: RepoPulls = {
  github: GITHUB,
  defaultBranch: "main",
  byBranch: new Map([
    ["feat/a", [pull(10, "feat/a")]],
    ["feat/b", [pull(11, "feat/b", "merged", "b1")]],
  ]),
};
const LIB_PULLS: RepoPulls = { github: { owner: "acme", repo: "lib" }, defaultBranch: "main", byBranch: new Map([["fix/lib", [pull(3, "fix/lib", "draft")]]]) };

function deps(overrides: Partial<ChatPrsDeps> = {}, card: ChatCard | null = null): ChatPrsDeps & { pullsFor: ReturnType<typeof vi.fn> } {
  return {
    listWorktrees: async (dir) => WORKTREES[dir] ?? [],
    mainRepoOf: (dir) => MAIN_OF[dir] ?? dir,
    normalize: (dir) => dir.replace(/\/+$/, ""),
    exists: () => true,
    gitRootOf: (dir) => GIT_ROOTS.filter((root) => dir === root || dir.startsWith(root + "/")).sort((a, b) => b.length - a.length)[0] ?? null,
    notRepos: new Map(),
    pullsFor: vi.fn(async (repo: string) => (repo === "/src/app" ? APP_PULLS : repo === "/src/lib" ? LIB_PULLS : { byBranch: new Map() })),
    cardOf: () => card,
    ...overrides,
  } as ChatPrsDeps & { pullsFor: ReturnType<typeof vi.fn> };
}

const member = (chatId: string, folder: string, title: string | null = `Chat ${chatId}`) => ({ chatId, folder, title });

describe("buildChatPrs — this chat's directory", () => {
  it("finds the PR of the branch checked out there, with its detail", async () => {
    const { current, card } = await buildChatPrs({ folder: "/src/app.feat-a" }, deps());
    expect(current).toMatchObject({ folder: "/src/app.feat-a", cwd: "/src/app.feat-a", repoName: "app", branch: "feat/a", status: "found" });
    expect(current.pr).toMatchObject({ number: 10, state: "open", headRef: "feat/a", baseRef: "main", author: "dev" });
    expect(card).toBeUndefined();
  });

  it("answers from a subdirectory of the worktree too", async () => {
    expect((await buildChatPrs({ folder: "/src/app.feat-a/backend" }, deps())).current.pr?.number).toBe(10);
  });

  it("validates a merged PR against the worktree's HEAD", async () => {
    expect((await buildChatPrs({ folder: "/src/app.feat-b" }, deps())).current.pr?.number).toBe(11);
    const moved = deps({
      listWorktrees: async (dir) => (dir === "/src/app" ? [wt("/src/app", "main", true), wt("/src/app.feat-b", "feat/b", false, "later")] : []),
    });
    expect((await buildChatPrs({ folder: "/src/app.feat-b" }, moved)).current.status).toBe("no_pr");
  });

  it.each([
    ["the default branch", "/src/app", "default_branch"],
    ["a detached HEAD", "/src/app.bisect", "detached"],
    ["a folder outside every repository", "/tmp/scratch", "not_git"],
  ])("explains %s", async (_label, folder, status) => {
    expect((await buildChatPrs({ folder }, deps())).current.status).toBe(status);
  });

  it("says when the repository is not on GitHub, without a PR lookup error", async () => {
    const d = deps({ pullsFor: vi.fn(async () => ({ byBranch: new Map() })) });
    expect((await buildChatPrs({ folder: "/src/app.feat-a" }, d)).current).toMatchObject({ status: "not_github", branch: "feat/a" });
  });

  it("reports a failed lookup with its reason", async () => {
    const d = deps({ pullsFor: vi.fn(async () => ({ github: GITHUB, byBranch: new Map(), error: "gh: API rate limit exceeded" })) });
    expect((await buildChatPrs({ folder: "/src/app.feat-a" }, d)).current).toMatchObject({ status: "error", prError: "gh: API rate limit exceeded" });
  });

  it("still shows the last good PR when a refresh failed, flagging the error", async () => {
    const d = deps({ pullsFor: vi.fn(async () => ({ ...APP_PULLS, error: "gh timed out" })) });
    expect((await buildChatPrs({ folder: "/src/app.feat-a" }, d)).current).toMatchObject({ status: "found", prError: "gh timed out" });
  });

  it("says git did not answer rather than calling it not a repository", async () => {
    const d = deps({ listWorktrees: async () => null });
    expect((await buildChatPrs({ folder: "/src/app.feat-a" }, d)).current).toMatchObject({ status: "error", prError: "git did not answer in time" });
  });

  it("passes the refresh flag through", async () => {
    const d = deps();
    await buildChatPrs({ folder: "/src/app.feat-a", force: true }, d);
    expect(d.pullsFor).toHaveBeenCalledWith("/src/app", true);
  });
});

describe("buildChatPrs — status precedence: not GitHub → detached → default branch → PR match", () => {
  const withPulls = (pulls: RepoPulls) => deps({ pullsFor: vi.fn(async () => pulls) });

  it("calls a detached HEAD in a non-GitHub repo not_github", async () => {
    expect((await buildChatPrs({ folder: "/src/app.bisect" }, withPulls({ byBranch: new Map() }))).current).toMatchObject({
      status: "not_github",
      branch: null,
    });
  });

  it("calls a detached HEAD detached even when the default branch is known", async () => {
    expect((await buildChatPrs({ folder: "/src/app.bisect" }, withPulls(APP_PULLS))).current).toMatchObject({ status: "detached", branch: null });
  });

  it("calls a non-GitHub default branch not_github, not default_branch", async () => {
    expect((await buildChatPrs({ folder: "/src/app" }, withPulls({ byBranch: new Map(), defaultBranch: "main" }))).current.status).toBe("not_github");
  });

  it("puts the default branch ahead of a PR whose head is that branch", async () => {
    const pulls: RepoPulls = { github: GITHUB, defaultBranch: "main", byBranch: new Map([["main", [pull(99, "main")]]]) };
    const { current } = await buildChatPrs({ folder: "/src/app" }, withPulls(pulls));
    expect(current).toMatchObject({ status: "default_branch", branch: "main" });
    expect(current.pr).toBeUndefined();
  });

  it("says no_pr for the default branch when nothing knows which branch is default", async () => {
    expect((await buildChatPrs({ folder: "/src/app" }, withPulls({ github: GITHUB, byBranch: new Map() }))).current).toMatchObject({
      status: "no_pr",
      branch: "main",
    });
  });

  it("puts default_branch ahead of a lookup error", async () => {
    const pulls: RepoPulls = { github: GITHUB, defaultBranch: "main", byBranch: new Map(), error: "gh timed out" };
    expect((await buildChatPrs({ folder: "/src/app" }, withPulls(pulls))).current.status).toBe("default_branch");
  });
});

describe("buildChatPrs — the card's other chats", () => {
  const CARD: ChatCard = {
    cardId: "root",
    title: "PR tracking",
    members: [
      member("root", "/src/app.feat-a"),
      member("c1", "/src/app.feat-b"),
      member("c2", "/src/app.feat-b/docs"),
      member("c3", "/src/lib"),
      member("c4", "/src/app.feat-a/sub"),
      member("c5", "/tmp/notes"),
      member("c6", "/src/app"),
    ],
  };

  it("lists the PRs of the other directories, deduplicated with every chat they came from", async () => {
    const { current, card } = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, deps({}, CARD));
    expect(current.pr?.number).toBe(10);
    expect(card?.cardId).toBe("root");
    expect(card?.title).toBe("PR tracking");
    // #10 is this chat's own PR (root and c4 share the directory) and is not
    // repeated; main (c6) has no PR by design; /tmp/notes is no repository.
    expect(card?.prs.map((p) => [p.pr.number, p.repoName, p.branch, p.sources.map((s) => s.chatId)])).toEqual([
      [3, "lib", "fix/lib", ["c3"]],
      [11, "app", "feat/b", ["c1", "c2"]],
    ]);
    expect(card?.prs[1].sources[0]).toEqual({ chatId: "c1", title: "Chat c1", folder: "/src/app.feat-b" });
  });

  it("looks each repository up once", async () => {
    const d = deps({}, CARD);
    await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, d);
    expect(d.pullsFor.mock.calls.map(([repo]) => repo).sort()).toEqual(["/src/app", "/src/lib"]);
  });

  it("keeps the section, with no PRs, when the other directories have none", async () => {
    const card: ChatCard = { cardId: "root", title: "t", members: [member("root", "/src/app.feat-a"), member("c6", "/src/app")] };
    expect((await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, deps({}, card))).card).toEqual({ cardId: "root", title: "t", prs: [] });
  });

  it("skips the section when every chat on the card works in this directory", async () => {
    const card: ChatCard = { cardId: "root", title: "t", members: [member("root", "/src/app.feat-a"), member("c4", "/src/app.feat-a/sub")] };
    expect((await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, deps({}, card))).card).toBeUndefined();
  });

  it("skips the section for a chat on no card, and never asks about one without a chatId", async () => {
    const cardOf = vi.fn(() => null);
    expect((await buildChatPrs({ folder: "/src/app.feat-a", chatId: "x" }, deps({ cardOf }))).card).toBeUndefined();
    await buildChatPrs({ folder: "/src/app.feat-a" }, deps({ cardOf }));
    expect(cardOf).toHaveBeenCalledTimes(1);
  });

  it("puts open PRs before closed ones, then the most recently updated", async () => {
    const pulls: RepoPulls = {
      github: GITHUB,
      defaultBranch: "main",
      byBranch: new Map([
        ["feat/a", [pull(1, "feat/a", "merged", "a1", "2026-11-05T00:00:00Z")]],
        ["feat/b", [pull(2, "feat/b", "open", "x", "2026-10-01T00:00:00Z")]],
        ["fix/lib", [pull(3, "fix/lib", "draft", "x", "2026-10-02T00:00:00Z")]],
      ]),
    };
    const card: ChatCard = { cardId: "r", title: "t", members: [member("a", "/src/app.feat-a"), member("b", "/src/app.feat-b"), member("l", "/src/lib")] };
    const d = deps({ pullsFor: vi.fn(async () => pulls) }, card);
    const result = await buildChatPrs({ folder: "/src/app", chatId: "r" }, d);
    expect(result.card?.prs.map((p) => p.pr.number)).toEqual([3, 2, 1]);
  });
});

describe("buildChatPrs — the git trail", () => {
  const entry = (cwd: string, branch: string, repoPath = "/src/app") => ({ cwd, repoPath, branch, firstSeen: "t0", lastSeen: "t1" });

  /** `app` with more history: an open PR on feat/a, a merged one on feat/old (head not at any local tip), one on main. */
  const TRAIL_PULLS: RepoPulls = {
    github: GITHUB,
    defaultBranch: "main",
    byBranch: new Map([
      ["feat/a", [pull(10, "feat/a", "open", "x", "2026-11-02T00:00:00Z")]],
      ["feat/b", [pull(11, "feat/b", "merged", "b1", "2026-11-03T00:00:00Z")]],
      ["feat/old", [pull(5, "feat/old", "merged", "not-local", "2026-11-05T00:00:00Z")]],
      ["feat/gone", [pull(6, "feat/gone", "closed", "zzz", "2026-11-04T00:00:00Z")]],
      ["main", [pull(1, "main")]],
    ]),
  };
  const withTrail = (trail: ReturnType<typeof entry>[], overrides: Partial<ChatPrsDeps> = {}, card: ChatCard | null = null) =>
    deps({ pullsFor: vi.fn(async (repo: string) => (repo === "/src/app" ? TRAIL_PULLS : LIB_PULLS)), trailOf: () => trail, ...overrides }, card);

  it("lists the PR of a branch the folder was on before, beside the live one, open first", async () => {
    // The chat is on feat/b now (merged #11, HEAD at its head); it was on feat/a earlier.
    const { current } = await buildChatPrs(
      { folder: "/src/app.feat-b", chatId: "c" },
      withTrail([entry("/src/app.feat-b", "feat/a"), entry("/src/app.feat-b", "feat/b")]),
    );
    expect(current.status).toBe("found");
    expect(current.pr?.number).toBe(11);
    expect(current.prs?.map((p) => p.number)).toEqual([10, 11]);
  });

  it("matches trail entries by branch alone — no SHA check", async () => {
    const { current } = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "c" }, withTrail([entry("/src/app.feat-old", "feat/old")]));
    expect(current.prs?.map((p) => p.number)).toEqual([10, 5]);
  });

  it("keeps the SHA rule for the live branch, and does not let its own trail entry bypass it", async () => {
    // feat/b's merged #11 has head b1; the worktree has moved on.
    const moved = {
      listWorktrees: async (dir: string) => (dir === "/src/app" ? [wt("/src/app", "main", true), wt("/src/app.feat-b", "feat/b", false, "later")] : []),
    };
    const { current } = await buildChatPrs({ folder: "/src/app.feat-b", chatId: "c" }, withTrail([entry("/src/app.feat-b", "feat/b")], moved));
    expect(current.status).toBe("no_pr");
    expect(current.prs).toBeUndefined();
  });

  it("still resolves a deleted worktree's branch through its repository", async () => {
    const gone = (dir: string) => !dir.startsWith("/src/app.gone");
    const { current } = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "c" }, withTrail([entry("/src/app.gone", "feat/gone")], { exists: gone }));
    expect(current.prs?.map((p) => p.number)).toEqual([10, 6]);
  });

  it("skips the default branch, and entries whose repository no longer exists", async () => {
    const noOldRepo = (dir: string) => dir !== "/src/removed";
    const trail = [entry("/src/app", "main"), entry("/src/removed", "feat/a", "/src/removed")];
    const d = withTrail(trail, { exists: noOldRepo });
    const { current } = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "c" }, d);
    expect(current.prs?.map((p) => p.number)).toEqual([10]);
    expect(d.pullsFor.mock.calls.map(([repo]) => repo)).toEqual(["/src/app"]);
  });

  it("shows trail PRs beside a status that has none of its own", async () => {
    const { current } = await buildChatPrs({ folder: "/src/app", chatId: "c" }, withTrail([entry("/src/app.feat-a", "feat/a")]));
    expect(current).toMatchObject({ status: "default_branch", branch: "main" });
    expect(current.pr).toBeUndefined();
    expect(current.prs?.map((p) => p.number)).toEqual([10]);
  });

  it("ignores a trail on a repository that is not on GitHub", async () => {
    const d = withTrail([entry("/src/app.feat-a", "feat/a")], { pullsFor: vi.fn(async () => ({ byBranch: new Map() })) });
    expect((await buildChatPrs({ folder: "/src/app", chatId: "c" }, d)).current.prs).toBeUndefined();
  });

  it("asks for no trail without a chatId", async () => {
    const trailOf = vi.fn(() => [entry("/src/app.feat-a", "feat/a")]);
    expect((await buildChatPrs({ folder: "/src/app" }, withTrail([], { trailOf }))).current.prs).toBeUndefined();
    expect(trailOf).not.toHaveBeenCalled();
  });

  it("unions the card members' trails with their live folders, deduplicated by URL", async () => {
    const card: ChatCard = {
      cardId: "root",
      title: "t",
      members: [
        { ...member("root", "/src/app.feat-a"), trail: [entry("/src/app.feat-a", "feat/a")] },
        // Lives on feat/b (#11) and was on feat/old (#5) and feat/gone (#6) earlier.
        { ...member("c1", "/src/app.feat-b"), trail: [entry("/src/app.feat-b", "feat/old"), entry("/src/app.gone", "feat/gone")] },
        // Also once on feat/old, and on feat/a — this chat's own PR, never repeated.
        { ...member("c2", "/src/lib"), trail: [entry("/src/app.feat-old", "feat/old"), entry("/src/app.feat-a", "feat/a")] },
      ],
    };
    const { current, card: section } = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, withTrail([], {}, card));
    expect(current.prs?.map((p) => p.number)).toEqual([10]);
    expect(section?.prs.map((p) => [p.pr.number, p.branch, p.sources.map((s) => s.chatId)])).toEqual([
      [3, "fix/lib", ["c2"]],
      [5, "feat/old", ["c1", "c2"]],
      [6, "feat/gone", ["c1"]],
      [11, "feat/b", ["c1"]],
    ]);
  });

  it("shows the card section for trail PRs even when every member now works in this directory", async () => {
    const card: ChatCard = { cardId: "root", title: "t", members: [{ ...member("c1", "/src/app.feat-a"), trail: [entry("/src/app.feat-old", "feat/old")] }] };
    const { card: section } = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, withTrail([], {}, card));
    expect(section?.prs.map((p) => p.pr.number)).toEqual([5]);
  });

  it("is a strict superset of the answer without a trail", async () => {
    const card: ChatCard = {
      cardId: "root",
      title: "t",
      members: [member("root", "/src/app.feat-a"), member("c1", "/src/app.feat-b"), member("c3", "/src/lib")],
    };
    const trail = [entry("/src/app.feat-a", "feat/old"), entry("/src/app.gone", "feat/gone")];
    const memberTrails: ChatCard = { ...card, members: card.members.map((m) => ({ ...m, trail })) };
    for (const folder of ["/src/app", "/src/app.feat-a", "/src/app.feat-b", "/src/app.bisect", "/tmp/scratch"]) {
      const before = await buildChatPrs({ folder, chatId: "root" }, withTrail([], {}, card));
      const after = await buildChatPrs({ folder, chatId: "root" }, withTrail(trail, {}, memberTrails));
      const { prs: _prs, ...beforeCurrent } = before.current;
      expect(after.current, folder).toMatchObject(beforeCurrent);
      const afterUrls = new Set([...(after.current.prs ?? []).map((p) => p.url), ...(after.card?.prs ?? []).map((p) => p.pr.url)]);
      for (const url of [before.current.pr?.url, ...(before.card?.prs ?? []).map((p) => p.pr.url)].filter(Boolean)) {
        expect(afterUrls.has(url!), `${folder}: ${url}`).toBe(true);
      }
      for (const p of before.card?.prs ?? []) {
        const kept = after.card?.prs.find((q) => q.pr.url === p.pr.url) ?? after.current.prs?.find((q) => q.url === p.pr.url);
        expect(kept, folder).toBeDefined();
      }
    }
  });
});
