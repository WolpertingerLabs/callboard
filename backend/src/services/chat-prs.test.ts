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

const member = (chatId: string, folder: string) => ({ chatId, folder });

describe("buildChatPrs — this chat's directory", () => {
  it("finds the PR of the branch checked out there, with its detail", async () => {
    const { current, prs } = await buildChatPrs({ folder: "/src/app.feat-a" }, deps());
    expect(current).toMatchObject({ folder: "/src/app.feat-a", cwd: "/src/app.feat-a", repoName: "app", branch: "feat/a", status: "found" });
    expect(current.pr).toMatchObject({ number: 10, state: "open", headRef: "feat/a", baseRef: "main", author: "dev" });
    expect(prs).toEqual([current.pr]);
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

describe("buildChatPrs — backfill requests", () => {
  it("queues the whole card ahead of the backlog — the chat itself last, so first — with the repositories in view", async () => {
    const requestBackfill = vi.fn();
    const card: ChatCard = { members: [member("root", "/src/app.feat-a"), member("c1", "/src/lib")] };
    await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, deps({ requestBackfill }, card));
    expect(requestBackfill.mock.calls.map(([r]) => [r.chatId, r.priority ?? false, [...r.knownRepos].sort()])).toEqual([
      ["c1", true, ["/src/app", "/src/lib"]],
      ["root", true, ["/src/app", "/src/lib"]],
    ]);
  });

  it("queues nothing for a chat not yet created", async () => {
    const requestBackfill = vi.fn();
    await buildChatPrs({ folder: "/src/app" }, deps({ requestBackfill }));
    expect(requestBackfill).not.toHaveBeenCalled();
  });
});

describe("buildChatPrs — one list", () => {
  const entry = (cwd: string, branch: string, repoPath = "/src/app") => ({ cwd, repoPath, branch, firstSeen: "t0", lastSeen: "t1" });

  /**
   * `app` with history: open #10 on feat/a, merged #11 on feat/b (head b1, at
   * the local tip), merged #5 on feat/old and closed #6 on feat/gone (heads
   * at no local tip), #1 on main. `lib` has draft #3 on fix/lib.
   */
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
  const numbers = (r: { prs: { number: number }[] }) => r.prs.map((p) => p.number);

  it("has only the live PR, and no card fields, without a trail or a card", async () => {
    const result = await buildChatPrs({ folder: "/src/app.feat-a" }, deps());
    expect(numbers(result)).toEqual([10]);
    expect(Object.keys(result).sort()).toEqual(["current", "generatedAt", "prs"]);
  });

  it("adds the PR of a branch the folder was on before, open first, then most recently updated", async () => {
    // Live on feat/b (merged #11 at its head); earlier on feat/a (open #10) and feat/old (merged #5, updated later).
    const result = await buildChatPrs(
      { folder: "/src/app.feat-b", chatId: "c" },
      withTrail([entry("/src/app.feat-b", "feat/a"), entry("/src/app.feat-b", "feat/old")]),
    );
    expect(result.current).toMatchObject({ status: "found", pr: expect.objectContaining({ number: 11 }) });
    expect(numbers(result)).toEqual([10, 5, 11]);
  });

  describe("a live branch that has moved past its merged PR", () => {
    const moved = {
      listWorktrees: async (dir: string) => (dir === "/src/app" ? [wt("/src/app", "main", true), wt("/src/app.feat-b", "feat/b", false, "later")] : []),
    };

    it("finds the PR through the chat's own trail entry for that branch", async () => {
      const result = await buildChatPrs({ folder: "/src/app.feat-b", chatId: "c" }, withTrail([entry("/src/app.feat-b", "feat/b")], moved));
      expect(result.current).toMatchObject({ status: "found", pr: expect.objectContaining({ number: 11 }) });
      expect(numbers(result)).toEqual([11]);
    });

    it("does not claim a PR that closed before the chat ever saw the branch", async () => {
      const closedEarlier: RepoPulls = {
        ...TRAIL_PULLS,
        byBranch: new Map([["feat/b", [{ ...pull(11, "feat/b", "merged", "b1"), closedAt: "2026-01-01T00:00:00Z" }]]]),
      };
      const d = withTrail([{ ...entry("/src/app.feat-b", "feat/b"), firstSeen: "2026-06-01T00:00:00Z" }], { ...moved, pullsFor: vi.fn(async () => closedEarlier) });
      const result = await buildChatPrs({ folder: "/src/app.feat-b", chatId: "c" }, d);
      expect(result.current.status).toBe("no_pr");
      expect(result.prs).toEqual([]);
    });
  });

  describe("PR links from the chats' own histories", () => {
    const link = (number: number, repo = "acme/app") => ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, firstSeen: "2026-06-01T00:00:00Z" });
    /** Resolves links against a table, recording what it was asked. */
    const linkedPulls = (table: Record<number, PullSummary | undefined>, error?: string) =>
      vi.fn(async (links: ReturnType<typeof link>[]) => ({ pulls: links.map((l) => table[l.number]), ...(error && { error }) }));

    it("lists every PR the chat and its card's chats made, whatever branch each is on now", async () => {
      // One chat on main made #20 and #21 inside single turns; a child whose worktree is gone made #22.
      const card: ChatCard = { members: [member("root", "/src/app"), member("kid", "/src/app.deleted")] };
      const linksOf = vi.fn(async (chatId: string) => (chatId === "root" ? [link(20), link(21)] : [link(22)]));
      const table = { 20: pull(20, "feat/one", "merged"), 21: pull(21, "feat/two", "open"), 22: pull(22, "feat/three", "merged") };
      const exists = (dir: string) => dir !== "/src/app.deleted";
      const d = deps({ linksOf, linkedPulls: linkedPulls(table), exists }, card);
      const result = await buildChatPrs({ folder: "/src/app", chatId: "root", force: true }, d);
      expect(numbers(result).sort()).toEqual([20, 21, 22]);
      expect(result.current.status).toBe("default_branch");
      expect(linksOf.mock.calls.map(([id]) => id)).toEqual(["root", "kid"]);
      expect((d.linkedPulls as ReturnType<typeof vi.fn>).mock.calls[0].slice(1)).toEqual([[APP_PULLS], true]);
    });

    it("makes a linked PR the live branch's when the SHA rule has none for it", async () => {
      const moved = {
        listWorktrees: async (dir: string) => (dir === "/src/app" ? [wt("/src/app", "main", true), wt("/src/app.feat-b", "feat/b", false, "later")] : []),
      };
      const d = deps({ ...moved, linksOf: async () => [link(11)], linkedPulls: linkedPulls({ 11: pull(11, "feat/b", "merged", "b1") }) });
      const result = await buildChatPrs({ folder: "/src/app.feat-b", chatId: "c" }, d);
      expect(result.current).toMatchObject({ status: "found", pr: expect.objectContaining({ number: 11 }) });
      expect(numbers(result)).toEqual([11]);
    });

    it("keeps links whose lookup failed, as unknown PRs, and says the lookup failed", async () => {
      const unknown: PullSummary = { ...pull(30, "", "unknown"), title: "acme/app#30", baseRef: "", author: null, createdAt: "" };
      const d = deps({ linksOf: async () => [link(30)], linkedPulls: linkedPulls({ 30: unknown }, "gh is not installed") });
      const result = await buildChatPrs({ folder: "/src/app.feat-a", chatId: "c" }, d);
      expect(result.prs.map((p) => [p.number, p.state])).toEqual([
        [10, "open"],
        [30, "unknown"],
      ]);
      expect(result.current).toMatchObject({ status: "found", prError: "gh is not installed" });
    });

    it("asks for no links without a chat", async () => {
      const linksOf = vi.fn(async () => [link(20)]);
      expect(numbers(await buildChatPrs({ folder: "/src/app.feat-a" }, deps({ linksOf })))).toEqual([10]);
      expect(linksOf).not.toHaveBeenCalled();
    });
  });

  it("resolves a deleted worktree's branch through its repository; skips the default branch and removed repositories", async () => {
    const exists = (dir: string) => !dir.startsWith("/src/app.gone") && dir !== "/src/removed";
    const trail = [entry("/src/app.gone", "feat/gone"), entry("/src/app", "main"), entry("/src/removed", "feat/a", "/src/removed")];
    const d = withTrail(trail, { exists });
    expect(numbers(await buildChatPrs({ folder: "/src/app.feat-a", chatId: "c" }, d))).toEqual([10, 6]);
    expect(d.pullsFor.mock.calls.map(([repo]) => repo)).toEqual(["/src/app"]);
  });

  it("keeps the status line's subject when the live branch has no PR but the list does", async () => {
    const result = await buildChatPrs({ folder: "/src/app", chatId: "c" }, withTrail([entry("/src/app.feat-a", "feat/a")]));
    expect(result.current).toMatchObject({ status: "default_branch", branch: "main" });
    expect(result.current.pr).toBeUndefined();
    expect(numbers(result)).toEqual([10]);
  });

  it("ignores a trail on a repository that is not on GitHub, and asks for none without a chatId", async () => {
    const notGithub = withTrail([entry("/src/app.feat-a", "feat/a")], { pullsFor: vi.fn(async () => ({ byBranch: new Map() })) });
    expect((await buildChatPrs({ folder: "/src/app", chatId: "c" }, notGithub)).prs).toEqual([]);
    const trailOf = vi.fn(() => [entry("/src/app.feat-a", "feat/a")]);
    await buildChatPrs({ folder: "/src/app" }, withTrail([], { trailOf }));
    expect(trailOf).not.toHaveBeenCalled();
  });

  it("collapses the same PR from this chat and the card to one entry", async () => {
    // This chat is live on feat/a (#10) and was on feat/b (#11) and feat/old (#5).
    // c1 lives on feat/b (#11 again); c2 lives in lib (#3) and was on feat/old (#5 again) and feat/a (#10 again).
    const card: ChatCard = {
      members: [
        { ...member("root", "/src/app.feat-a"), trail: [entry("/src/app.feat-a", "feat/b"), entry("/src/app.feat-a", "feat/old")] },
        { ...member("c1", "/src/app.feat-b"), trail: [entry("/src/app.gone", "feat/gone")] },
        { ...member("c2", "/src/lib"), trail: [entry("/src/app.feat-old", "feat/old"), entry("/src/app.feat-a", "feat/a")] },
      ],
    };
    const result = await buildChatPrs(
      { folder: "/src/app.feat-a", chatId: "root" },
      withTrail([entry("/src/app.feat-a", "feat/b"), entry("/src/app.feat-a", "feat/old")], {}, card),
    );
    // Open/draft first — #10 (updated 11-02) before #3 (11-01) — then the rest, most recently updated first.
    expect(numbers(result)).toEqual([10, 3, 5, 6, 11]);
    expect(new Set(result.prs.map((p) => p.url)).size).toBe(result.prs.length);
  });

  it("looks each repository up once, however many chats and trail entries name it", async () => {
    const card: ChatCard = {
      members: [member("root", "/src/app.feat-a"), member("c1", "/src/app.feat-b"), member("c2", "/src/lib"), member("c3", "/src/app")],
    };
    const d = withTrail([entry("/src/app.feat-a", "feat/old")], {}, card);
    await buildChatPrs({ folder: "/src/app.feat-a", chatId: "root" }, d);
    expect(d.pullsFor.mock.calls.map(([repo]) => repo).sort()).toEqual(["/src/app", "/src/lib"]);
  });

  it("is a strict superset of what either former section showed, each PR exactly once", async () => {
    const card: ChatCard = {
      members: [
        member("root", "/src/app.feat-a"),
        { ...member("c1", "/src/app.feat-b"), trail: [entry("/src/app.gone", "feat/gone")] },
        member("c3", "/src/lib"),
      ],
    };
    const own = [entry("/src/app.feat-a", "feat/old"), entry("/src/app.feat-a", "feat/b")];
    for (const folder of ["/src/app", "/src/app.feat-a", "/src/app.feat-b", "/src/app.bisect", "/tmp/scratch"]) {
      const result = await buildChatPrs({ folder, chatId: "root" }, withTrail(own, {}, card));
      const urls = result.prs.map((p) => p.url);
      expect(new Set(urls).size, folder).toBe(urls.length);
      // What "This chat" showed: the live PR and the trail's; what the card
      // section showed: c1's live #11 and trail #6, c3's live #3.
      const expected = [result.current.pr?.number, 5, 11, 6, 3].filter((n): n is number => n !== undefined);
      for (const n of expected) expect(numbers(result), folder).toContain(n);
    }
  });
});
