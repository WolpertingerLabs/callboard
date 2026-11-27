import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const remoteUrl = vi.fn<(dir: string) => Promise<string | null>>();
const defaultBranch = vi.fn<(dir: string) => Promise<string | null>>();
vi.mock("../utils/git.js", () => ({ getRemoteUrlAsync: (dir: string) => remoteUrl(dir), getDefaultBranchAsync: (dir: string) => defaultBranch(dir) }));

import {
  BRANCH_SETTLED_TTL_MS,
  clearRepoPullsCache,
  fetchPullsByBranch,
  fetchPullsByNumber,
  fetchRepoPulls,
  getRepoPulls,
  indexPullsByBranch,
  isLinkOf,
  isPullOf,
  matchPull,
  parseGitHubRemote,
  PR_CACHE_TTL_MS,
  PR_FETCH_CONCURRENCY,
  PR_FORCE_MIN_AGE_MS,
  PR_FORCE_WAIT_MS,
  PR_STALE_MAX_MS,
  pullsForTrailEntry,
  recordedPullForBranch,
  resolveBranchPulls,
  resolveLinkedPulls,
  runGh,
  toChatPr,
  toPullSummary,
  type BranchAnswer,
  type GitHubRepoRef,
  type PullSummary,
  type RepoPulls,
} from "./github-prs.js";

function pr(overrides: Partial<PullSummary> & Pick<PullSummary, "number" | "headRef">): PullSummary {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    title: `PR ${overrides.number}`,
    state: "open",
    headSha: `sha${overrides.number}`,
    headOwner: "acme",
    updatedAt: "2026-11-01T00:00:00Z",
    baseRef: "main",
    author: "dev",
    createdAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

/** A REST pull object as `gh api .../pulls` returns it, trimmed to what we read. */
function rawPull(
  n: number,
  ref: string,
  opts: { state?: string; draft?: boolean; merged?: boolean; sha?: string; owner?: string | null; updated?: string } = {},
) {
  return {
    number: n,
    html_url: `https://github.com/acme/app/pull/${n}`,
    title: `PR ${n}`,
    state: opts.state ?? "open",
    draft: opts.draft ?? false,
    merged_at: opts.merged ? "2026-11-01T00:00:00Z" : null,
    updated_at: opts.updated ?? "2026-11-01T00:00:00Z",
    head: { ref, sha: opts.sha ?? `sha${n}`, repo: opts.owner === null ? null : { owner: { login: opts.owner ?? "acme" } } },
    base: { ref: "main", repo: { default_branch: "main", owner: { login: "acme" } } },
  };
}

/** Answer the next `gh` spawn the way execFile's callback would. */
function ghAnswers(result: { stdout?: string; error?: Error & { code?: string; killed?: boolean }; stderr?: string }) {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => cb(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { stdin: { end() {} } };
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  remoteUrl.mockReset();
  defaultBranch.mockReset();
  defaultBranch.mockResolvedValue(null);
  clearRepoPullsCache();
});

describe("parseGitHubRemote", () => {
  it.each([
    ["https://github.com/acme/app.git", { owner: "acme", repo: "app" }],
    ["https://github.com/acme/app", { owner: "acme", repo: "app" }],
    ["https://x-access-token:abc@github.com/acme/app.git", { owner: "acme", repo: "app" }],
    ["git@github.com:acme/app.git", { owner: "acme", repo: "app" }],
    ["git@github.com:acme/app", { owner: "acme", repo: "app" }],
    ["ssh://git@github.com/acme/app.git", { owner: "acme", repo: "app" }],
    ["ssh://git@github.com:22/acme/my.dotted.repo.git", { owner: "acme", repo: "my.dotted.repo" }],
  ])("parses %s", (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected);
  });

  it.each(["https://gitlab.com/acme/app.git", "git@bitbucket.org:acme/app.git", "/srv/git/app.git", "https://github.com/acme", ""])("rejects %s", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });

  // Owner and repo are spliced into a `gh api` path: anything that could
  // change what that path asks for is refused, not escaped.
  it.each([
    "https://github.com/acme/app?x=1",
    "https://github.com/acme/app#frag",
    "https://github.com/acme/a&state=open",
    "https://github.com/acme/..",
    "https://github.com/acme/.",
    "git@github.com:..//app.git",
    "https://github.com/ac_me/app",
    "https://github.com/acme%2F/app",
    `https://github.com/${"a".repeat(40)}/app`,
    // Shapes left unsupported on purpose (see the comment by the regexes).
    "git@github-work:acme/app.git",
    "ssh://git@ssh.github.com:443/acme/app.git",
  ])("refuses %s", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });

  it("accepts the full legal alphabet", () => {
    expect(parseGitHubRemote("https://github.com/a-b-9/x_y.z-1.git")).toEqual({ owner: "a-b-9", repo: "x_y.z-1" });
  });
});

describe("toPullSummary", () => {
  it("keeps the display fields the chat's PRs tab shows, from the same listing", () => {
    const raw = {
      ...rawPull(7, "feat/x", { state: "closed", merged: true }),
      user: { login: "octo" },
      created_at: "2026-10-01T00:00:00Z",
      closed_at: "2026-11-01T00:00:00Z",
    };
    const summary = toPullSummary(raw)!;
    expect(toChatPr(summary)).toEqual({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "PR 7",
      state: "merged",
      headRef: "feat/x",
      baseRef: "main",
      author: "octo",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      mergedAt: "2026-11-01T00:00:00Z",
      closedAt: "2026-11-01T00:00:00Z",
    });
  });

  it("leaves the optional timestamps off an open PR, and author null when GitHub has none", () => {
    const pr = toChatPr(toPullSummary({ ...rawPull(8, "feat/y"), user: null })!);
    expect(pr.author).toBeNull();
    expect("mergedAt" in pr || "closedAt" in pr).toBe(false);
  });

  it("derives the four states", () => {
    expect(toPullSummary(rawPull(1, "a"))?.state).toBe("open");
    expect(toPullSummary(rawPull(2, "a", { draft: true }))?.state).toBe("draft");
    expect(toPullSummary(rawPull(3, "a", { state: "closed", merged: true }))?.state).toBe("merged");
    expect(toPullSummary(rawPull(4, "a", { state: "closed" }))?.state).toBe("closed");
  });

  it("keeps a PR whose head repo is gone, with no owner", () => {
    expect(toPullSummary(rawPull(5, "a", { owner: null }))?.headOwner).toBeNull();
  });

  it("drops an object missing the head", () => {
    expect(toPullSummary({ number: 1, html_url: "x" })).toBeNull();
  });
});

describe("indexPullsByBranch", () => {
  it("excludes forks that reuse a branch name", () => {
    const index = indexPullsByBranch([pr({ number: 1, headRef: "fix", headOwner: "someone-else" }), pr({ number: 2, headRef: "fix" })], "acme", "main");
    expect(index.get("fix")?.map((p) => p.number)).toEqual([2]);
  });

  it("drops PRs from a deleted head repo", () => {
    expect(indexPullsByBranch([pr({ number: 1, headRef: "fix", headOwner: null })], "acme", "main").has("fix")).toBe(false);
  });

  it("matches the owner case-insensitively", () => {
    expect(indexPullsByBranch([pr({ number: 1, headRef: "fix", headOwner: "ACME" })], "acme", "main").has("fix")).toBe(true);
  });

  it("skips the default branch", () => {
    expect(indexPullsByBranch([pr({ number: 1, headRef: "main" })], "acme", "main").has("main")).toBe(false);
  });

  it("orders open first, then most recently updated", () => {
    const index = indexPullsByBranch(
      [
        pr({ number: 1, headRef: "b", state: "merged", updatedAt: "2026-11-05T00:00:00Z" }),
        pr({ number: 2, headRef: "b", state: "open", updatedAt: "2026-10-01T00:00:00Z" }),
        pr({ number: 3, headRef: "b", state: "closed", updatedAt: "2026-11-06T00:00:00Z" }),
      ],
      "acme",
      "main",
    );
    expect(index.get("b")?.map((p) => p.number)).toEqual([2, 3, 1]);
  });
});

describe("matchPull", () => {
  it("takes an open or draft PR whatever the local sha", () => {
    expect(matchPull([pr({ number: 1, headRef: "b", state: "draft" })], "local-ahead")?.number).toBe(1);
    expect(matchPull([pr({ number: 1, headRef: "b" })], undefined)?.number).toBe(1);
  });

  it("takes a merged or closed PR only when its head is the local tip", () => {
    const merged = pr({ number: 7, headRef: "b", state: "merged", headSha: "abc" });
    expect(matchPull([merged], "abc")?.number).toBe(7);
    expect(matchPull([merged], "def")).toBeUndefined();
    expect(matchPull([merged], undefined)).toBeUndefined();
  });

  it("reaches past a newer closed PR whose head is not ours", () => {
    const newer = pr({ number: 9, headRef: "b", state: "closed", headSha: "zzz", updatedAt: "2026-11-06T00:00:00Z" });
    const older = pr({ number: 4, headRef: "b", state: "merged", headSha: "abc", updatedAt: "2026-01-01T00:00:00Z" });
    expect(matchPull([newer, older], "abc")?.number).toBe(4);
  });

  it("has nothing for a branch without candidates", () => {
    expect(matchPull(undefined, "abc")).toBeUndefined();
  });
});

/**
 * Answer `gh` by which listing it asks for. `open`/`closed` are the bodies (or
 * errors) for the two queries; every spawn is recorded in execFileMock.
 */
function ghServes(listings: { open?: unknown[] | Error; closed?: unknown[] | Error; stderr?: string }) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const body = args[1].includes("state=open") ? listings.open : listings.closed;
    queueMicrotask(() => (body instanceof Error ? cb(body, "", listings.stderr ?? "") : cb(null, JSON.stringify(body ?? []), "")));
    return { stdin: { end() {} } };
  });
}

/**
 * The filter gh applies to each listing, pinned whole: every field
 * toPullSummary and the default-branch lookup read has to survive it, and a
 * dropped one is a PR that silently stops matching.
 */
const JQ_FILTER =
  "[.[] | {number, html_url, title, state, draft, merged_at, closed_at, created_at, updated_at, user: {login: .user.login}, " +
  "head: {ref: .head.ref, sha: .head.sha, repo: {owner: {login: .head.repo.owner.login}}}, base: {ref: .base.ref, repo: {default_branch: .base.repo.default_branch}}}]";

describe("fetchRepoPulls", () => {
  it("lists every open PR and the recent closed ones, as two REST calls", async () => {
    remoteUrl.mockResolvedValue("git@github.com:acme/app.git");
    ghServes({
      open: [rawPull(1, "feat/x"), rawPull(2, "main"), rawPull(3, "feat/x", { owner: "fork" })],
      closed: [rawPull(4, "fix/y", { state: "closed", merged: true })],
    });
    const result = await fetchRepoPulls("/r");
    expect(result.error).toBeUndefined();
    expect([...result.byBranch.keys()].sort()).toEqual(["feat/x", "fix/y"]);
    expect(result.byBranch.get("feat/x")?.map((p) => p.number)).toEqual([1]);
    expect(execFileMock.mock.calls.map(([cmd, args]) => [cmd, ...args])).toEqual([
      ["gh", "api", "repos/acme/app/pulls?state=open&per_page=100", "--jq", JQ_FILTER],
      ["gh", "api", "repos/acme/app/pulls?state=closed&sort=updated&direction=desc&per_page=100", "--jq", JQ_FILTER],
    ]);
    // Every listed PR is reachable by number — the fork's and the default branch's too.
    expect([...result.byNumber!.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ cwd: "/r", timeout: expect.any(Number) });
  });

  /**
   * The regression: one `state=all&sort=updated` page of 50 let recently
   * closed PRs push an old open one off the end. Listed separately, the open
   * PR is there however many closed PRs were updated after it.
   */
  it("keeps an old open PR that 50 newer closed ones would push off a state=all page", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const closed = Array.from({ length: 50 }, (_, i) => rawPull(1000 + i, `done/${i}`, { state: "closed", updated: "2026-11-05T00:00:00Z" }));
    ghServes({ open: [rawPull(337, "fix/old", { updated: "2026-01-01T00:00:00Z" })], closed });
    const result = await fetchRepoPulls("/r");
    expect(matchPull(result.byBranch.get("fix/old"), undefined)?.number).toBe(337);
  });

  it("names the GitHub repo and the default branch the listing carries", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/x")], closed: [] });
    const result = await fetchRepoPulls("/r");
    expect(result.github).toEqual({ owner: "acme", repo: "app" });
    expect(result.defaultBranch).toBe("main");
    expect(defaultBranch).not.toHaveBeenCalled();
  });

  it("falls back to the local origin/HEAD for the default branch when there are no PRs", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    defaultBranch.mockResolvedValue("trunk");
    ghServes({ open: [], closed: [] });
    expect((await fetchRepoPulls("/r")).defaultBranch).toBe("trunk");
  });

  it("omits the default branch when nothing knows it", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [], closed: [] });
    expect("defaultBranch" in (await fetchRepoPulls("/r"))).toBe(false);
  });

  it("does not spawn gh for a non-GitHub remote, and reports no error", async () => {
    remoteUrl.mockResolvedValue("https://gitlab.com/acme/app.git");
    expect(await fetchRepoPulls("/r")).toEqual({ byBranch: new Map() });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not spawn gh without an origin", async () => {
    remoteUrl.mockResolvedValue(null);
    expect((await fetchRepoPulls("/r")).byBranch.size).toBe(0);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("degrades to no data when gh is missing, without starting the second listing", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    ghServes({ open: missing, closed: missing });
    expect(await fetchRepoPulls("/r")).toEqual({
      byBranch: new Map(),
      byNumber: new Map(),
      github: { owner: "acme", repo: "app" },
      error: "gh is not installed",
    });
    // One process is started per turn of the event loop, and a spawn that
    // cannot happen fails within the turn: the closed listing never starts.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("probes with the open listing alone, and skips the closed one when that fails", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
    expect((await fetchRepoPulls("/r", { probe: true })).error).toBe("gh is not installed");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("follows a probe that worked with the closed listing", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/x")], closed: [rawPull(4, "fix/y", { state: "closed", merged: true })] });
    const result = await fetchRepoPulls("/r", { probe: true });
    expect(result.error).toBeUndefined();
    expect([...result.byBranch.keys()].sort()).toEqual(["feat/x", "fix/y"]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("starts both listings before either has answered", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const answers: Array<() => void> = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      const body = args[1].includes("state=open") ? [rawPull(1, "feat/x")] : [rawPull(4, "fix/y", { state: "closed", merged: true })];
      answers.push(() => cb(null, JSON.stringify(body), ""));
      return { stdin: { end() {} } };
    });
    const fetching = fetchRepoPulls("/r");
    for (let i = 0; i < 5; i++) await flush();
    expect(answers).toHaveLength(2);
    // Answered out of order: the result does not depend on which lands first.
    answers[1]();
    await flush();
    answers[0]();
    const result = await fetching;
    expect([...result.byBranch.keys()].sort()).toEqual(["feat/x", "fix/y"]);
    expect(result.defaultBranch).toBe("main");
  });

  /**
   * The open-first rule: a closed PR is a branch's PR only while no open one
   * exists. With the open listing failed that cannot be known, so the closed
   * PRs that did arrive are not offered — `feat/x` has open #20 here, and its
   * earlier closed #10 must not be shown as the branch's PR in its place.
   */
  it("offers no closed PRs when the open listing fails, though the closed one arrived", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const answers = new Map<string, (err: Error | null, out: string, stderr: string) => void>();
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      answers.set(args[1].includes("state=open") ? "open" : "closed", cb);
      return { stdin: { end() {} } };
    });
    const fetching = fetchRepoPulls("/r");
    for (let i = 0; i < 5; i++) await flush();
    // Both are running; the closed one answers, then the open one fails.
    answers.get("closed")!(null, JSON.stringify([rawPull(10, "feat/x", { state: "closed", sha: "local-tip" })]), "");
    await flush();
    answers.get("open")!(Object.assign(new Error("exit 1"), { code: 1 as unknown as string }), "", "gh: HTTP 502");
    const result = await fetching;
    expect(result.error).toBe("gh: HTTP 502");
    expect(result.errorPartial).toBeUndefined();
    expect(result.byBranch.size).toBe(0);
    expect(result.byNumber!.size).toBe(0);
    expect(matchPull(result.byBranch.get("feat/x"), "local-tip")).toBeUndefined();
    // Which branch is the default is true whichever listing said so.
    expect(result.defaultBranch).toBe("main");
  });

  it("marks a failed closed listing as partial: the open PRs are whole", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/x")], closed: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }), stderr: "gh: HTTP 502" });
    const result = await fetchRepoPulls("/r");
    expect(result).toMatchObject({ error: "gh: HTTP 502", errorPartial: true });
    expect(result.byBranch.get("feat/x")?.map((p) => p.number)).toEqual([1]);
  });

  it("drops a closed listing still queued when its open listing fails", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const running: Array<{ args: string[]; cb: (e: Error | null, out: string, err: string) => void }> = [];
    execFileMock.mockImplementation((_c: string, args: string[], opts: { cwd: string }, cb: (e: Error | null, out: string, err: string) => void) => {
      running.push({ args: [opts.cwd, args[1]], cb });
      return { stdin: { end() {} } };
    });
    // Enough repositories to fill every slot, and one more whose two listings queue.
    const full = Array.from({ length: PR_FETCH_CONCURRENCY / 2 }, (_, i) => fetchRepoPulls(`/full${i}`));
    for (let i = 0; i < 5; i++) await flush();
    const last = fetchRepoPulls("/last");
    for (let i = 0; i < 5; i++) await flush();
    expect(running).toHaveLength(PR_FETCH_CONCURRENCY);
    // One slot frees: the queued open listing runs, and fails.
    running.shift()!.cb(null, "[]", "");
    for (let i = 0; i < 5; i++) await flush();
    const open = running.find(({ args }) => args[0] === "/last")!;
    expect(open.args[1]).toContain("state=open");
    open.cb(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), "", "");
    for (const { cb } of running) if (cb !== open.cb) cb(null, "[]", "");
    expect((await last).error).toBe("gh is not installed");
    await Promise.all(full);
    // Every other listing, and /last's open one — never its closed one.
    expect(execFileMock).toHaveBeenCalledTimes(PR_FETCH_CONCURRENCY + 1);
    expect(execFileMock.mock.calls.filter(([, , opts]) => opts.cwd === "/last")).toHaveLength(1);
  });

  it("reports the first line of gh's stderr", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }), stderr: "gh: API rate limit exceeded\nmore detail" });
    expect((await fetchRepoPulls("/r")).error).toBe("gh: API rate limit exceeded");
  });

  it("keeps the open PRs when only the closed listing fails", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/x")], closed: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }) });
    const result = await fetchRepoPulls("/r");
    expect(result.byBranch.has("feat/x")).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it("degrades on a body that is not JSON", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghAnswers({ stdout: "<html>" });
    const result = await fetchRepoPulls("/r");
    expect(result.byBranch.size).toBe(0);
    expect(result.error).toBeTruthy();
  });
});

/**
 * Settle every queued microtask and zero-delay timer, and let the event loop
 * come round a few times: the limiter starts one process per turn, so a fetch
 * (git remote, then two listings) needs several before it is fully under way.
 */
const flush = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise((r) => setTimeout(() => setImmediate(r), 0));
};

describe("getRepoPulls", () => {
  it("serves one fetch per repo within the TTL", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [], closed: [] });
    await Promise.all([getRepoPulls("/r", false, 1000), getRepoPulls("/r", false, 1001)]);
    await getRepoPulls("/r", false, 1000 + PR_CACHE_TTL_MS - 1);
    // One fetch = the two listings.
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("serves an expired entry at once and refreshes it in the background", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/old")] });
    const first = await getRepoPulls("/r", false, 0);
    expect(first.byBranch.has("feat/old")).toBe(true);

    // gh now hangs: an expired entry must not wait on it.
    const releases: Array<() => void> = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      const body = args[1].includes("state=open") ? [rawPull(2, "feat/new")] : [];
      releases.push(() => cb(null, JSON.stringify(body), ""));
      return { stdin: { end() {} } };
    });
    const stale = await getRepoPulls("/r", false, PR_CACHE_TTL_MS);
    expect(stale).toBe(first);
    // A second poll during the refresh shares it rather than spawning again.
    expect(await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 1)).toBe(first);
    await flush();
    // The refresh's two listings, both running.
    expect(execFileMock).toHaveBeenCalledTimes(4);

    for (const release of releases) release();
    for (let i = 0; i < 5; i++) await flush();
    const fresh = await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 2);
    expect(fresh.byBranch.has("feat/new")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the last good PRs, with the error alongside, when a background refresh fails", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/a")] });
    await getRepoPulls("/r", false, 0);

    ghServes({
      open: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }),
      stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
    });
    await getRepoPulls("/r", false, PR_CACHE_TTL_MS); // serves stale, refreshes behind
    for (let i = 0; i < 5; i++) await flush();

    const after = await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 1);
    expect(after.byBranch.has("feat/a")).toBe(true);
    expect(after.error).toBe("gh: To get started with GitHub CLI, please run: gh auth login");
    // Out of date, not absent.
    expect(after.errorPartial).toBe(true);
    // Stamped as a fresh entry: the failure is not retried before the TTL…
    expect(execFileMock).toHaveBeenCalledTimes(3);
    // …and the in-flight slot was released, so the next expiry refreshes again.
    ghServes({ open: [rawPull(2, "feat/b")] });
    await getRepoPulls("/r", false, 2 * PR_CACHE_TTL_MS);
    for (let i = 0; i < 5; i++) await flush();
    const recovered = await getRepoPulls("/r", false, 2 * PR_CACHE_TTL_MS + 1);
    expect(recovered.byBranch.has("feat/b")).toBe(true);
    expect(recovered.error).toBeUndefined();
  });

  it("caches a failure too, so a missing gh is not respawned every poll", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    ghServes({ open: missing, closed: missing });
    const first = await getRepoPulls("/r", false, 0);
    await getRepoPulls("/r", false, 5000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // Nothing is held: this is "unavailable", not "incomplete".
    expect(first.errorPartial).toBeUndefined();
  });

  it("probes a repo whose last lookup failed with one listing, then goes back to two at once when it works", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const down = Object.assign(new Error("exit 1"), { code: 1 as unknown as string });
    // Both listings fail, slowly enough that both were started.
    const answers: Array<() => void> = [];
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      answers.push(() => cb(down, "", "gh: HTTP 503"));
      return { stdin: { end() {} } };
    });
    const first = getRepoPulls("/r", false, 0);
    for (let i = 0; i < 5; i++) await flush();
    expect(execFileMock).toHaveBeenCalledTimes(2);
    answers.splice(0).forEach((answer) => answer());
    expect((await first).error).toBe("gh: HTTP 503");

    // Still down a TTL later: one process finds out, not two — however slowly it fails.
    await getRepoPulls("/r", false, PR_CACHE_TTL_MS);
    for (let i = 0; i < 5; i++) await flush();
    expect(execFileMock).toHaveBeenCalledTimes(3);
    answers.splice(0).forEach((answer) => answer());
    for (let i = 0; i < 5; i++) await flush();
    expect(execFileMock).toHaveBeenCalledTimes(3);

    // GitHub is back: the probe is followed by the closed listing.
    ghServes({ open: [rawPull(1, "feat/a")], closed: [] });
    await getRepoPulls("/r", false, 2 * PR_CACHE_TTL_MS);
    for (let i = 0; i < 5; i++) await flush();
    expect(execFileMock).toHaveBeenCalledTimes(5);
    const recovered = await getRepoPulls("/r", false, 2 * PR_CACHE_TTL_MS + 1);
    expect(recovered.byBranch.has("feat/a")).toBe(true);
    expect(recovered.error).toBeUndefined();
  });

  /**
   * The first entry is an open-failed one — nothing held, though the closed
   * listing had arrived. The refresh that works replaces it whole.
   */
  it("replaces an open-failed first entry, which held nothing, with the refresh that works", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const answers = new Map<string, (err: Error | null, out: string, stderr: string) => void>();
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      answers.set(args[1].includes("state=open") ? "open" : "closed", cb);
      return { stdin: { end() {} } };
    });
    const fetching = getRepoPulls("/r", false, 0);
    for (let i = 0; i < 5; i++) await flush();
    answers.get("closed")!(null, JSON.stringify([rawPull(10, "feat/x", { state: "closed", sha: "tip" })]), "");
    answers.get("open")!(Object.assign(new Error("exit 1"), { code: 1 as unknown as string }), "", "gh: HTTP 502");
    const first = await fetching;
    expect(first).toMatchObject({ error: "gh: HTTP 502", byBranch: new Map() });
    expect(first.errorPartial).toBeUndefined();

    ghServes({ open: [rawPull(20, "feat/x")], closed: [rawPull(10, "feat/x", { state: "closed", sha: "tip" })] });
    expect(await getRepoPulls("/r", false, PR_CACHE_TTL_MS)).toBe(first); // served, refreshed behind
    for (let i = 0; i < 8; i++) await flush();
    const fresh = await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 1);
    expect(fresh.error).toBeUndefined();
    expect(fresh.errorPartial).toBeUndefined();
    // Open first: #20 is the branch's PR even at #10's commit.
    expect(matchPull(fresh.byBranch.get("feat/x"), "tip")?.number).toBe(20);
  });

  /**
   * The regression: any refresh carrying an error lost to the entry before
   * it, so a closed listing that kept failing froze the open PRs at whatever
   * they were when it started.
   */
  it("keeps the open PRs fresh while the closed listing keeps failing, beside the closed PRs it had", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const down = Object.assign(new Error("exit 1"), { code: 1 as unknown as string });
    ghServes({
      open: [rawPull(1, "feat/a"), rawPull(2, "feat/b")],
      closed: [rawPull(9, "feat/done", { state: "closed", merged: true }), rawPull(8, "feat/back", { state: "closed" })],
    });
    await getRepoPulls("/r", false, 0);

    // #1 has since merged (in neither listing now), #3 is new, #8 was reopened.
    ghServes({ open: [rawPull(2, "feat/b"), rawPull(3, "feat/c"), rawPull(8, "feat/back")], closed: down, stderr: "gh: HTTP 502" });
    await getRepoPulls("/r", false, PR_CACHE_TTL_MS);
    for (let i = 0; i < 8; i++) await flush();
    const merged = await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 1);
    expect(merged).toMatchObject({ error: "gh: HTTP 502", errorPartial: true, defaultBranch: "main" });
    expect([...merged.byNumber!.keys()].sort()).toEqual([2, 3, 8, 9]);
    expect(merged.byBranch.get("feat/c")?.map((p) => [p.number, p.state])).toEqual([[3, "open"]]);
    // The earlier closed PRs stay; one that is open again is the open one, once.
    expect(merged.byBranch.get("feat/done")?.map((p) => [p.number, p.state])).toEqual([[9, "merged"]]);
    expect(merged.byBranch.get("feat/back")?.map((p) => [p.number, p.state])).toEqual([[8, "open"]]);
    // What was open and no longer is, is not kept as open.
    expect(merged.byBranch.has("feat/a")).toBe(false);

    // Still failing a TTL later: the open PRs move again, they are not frozen.
    ghServes({ open: [rawPull(4, "feat/d")], closed: down, stderr: "gh: HTTP 502" });
    await getRepoPulls("/r", false, 2 * PR_CACHE_TTL_MS);
    for (let i = 0; i < 8; i++) await flush();
    const later = await getRepoPulls("/r", false, 2 * PR_CACHE_TTL_MS + 1);
    expect([...later.byNumber!.keys()].sort()).toEqual([4, 9]);
    expect(later.errorPartial).toBe(true);
  });

  it("keeps the whole earlier entry when the open listing fails, and says it is out of date rather than absent", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    const down = Object.assign(new Error("exit 1"), { code: 1 as unknown as string });
    ghServes({ open: [rawPull(1, "feat/a")], closed: [rawPull(9, "feat/done", { state: "closed", merged: true })] });
    await getRepoPulls("/r", false, 0);
    ghServes({ open: down, closed: [rawPull(7, "feat/other", { state: "closed" })], stderr: "gh: HTTP 500" });
    await getRepoPulls("/r", false, PR_CACHE_TTL_MS);
    for (let i = 0; i < 8; i++) await flush();
    const kept = await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 1);
    expect(kept).toMatchObject({ error: "gh: HTTP 500", errorPartial: true });
    expect([...kept.byNumber!.keys()].sort()).toEqual([1, 9]);
  });

  it("lets a forced refresh through only past the minimum age, and waits for it", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/a")] });
    await getRepoPulls("/r", false, 0);
    await getRepoPulls("/r", true, 2000);
    expect(execFileMock).toHaveBeenCalledTimes(2);

    ghServes({ open: [rawPull(2, "feat/b")] });
    const forced = await getRepoPulls("/r", true, 20_000);
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(forced.byBranch.has("feat/b")).toBe(true);
  });

  it("serves the stale entry when a forced refresh outlasts the wait cap", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/a")] });
    const first = await getRepoPulls("/r", false, 0);
    // A gh that does not answer within the cap. (In production execFile's
    // own timeout kills it; here it is answered at the end, so the fetch does
    // not keep a limiter slot into the next test.)
    const hung: Array<() => void> = [];
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      hung.push(() => cb(null, "[]", ""));
      return { stdin: { end() {} } };
    });
    vi.useFakeTimers();
    try {
      const forced = getRepoPulls("/r", true, 20_000);
      await vi.advanceTimersByTimeAsync(PR_FORCE_WAIT_MS);
      expect(await forced).toBe(first);
    } finally {
      vi.useRealTimers();
      while (hung.length > 0) {
        hung.shift()!();
        await flush();
      }
    }
  });

  it("waits for the first fetch when there is no entry at all", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/a")] });
    expect((await getRepoPulls("/r", false, 0)).byBranch.has("feat/a")).toBe(true);
  });

  it("runs at most PR_FETCH_CONCURRENCY gh processes at once, counting processes — a repo's two listings are two", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    let inFlight = 0;
    let peak = 0;
    const callbacks: Array<() => void> = [];
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      callbacks.push(() => {
        inFlight--;
        cb(null, "[]", "");
      });
      return { stdin: { end() {} } };
    });
    const repos = Array.from({ length: PR_FETCH_CONCURRENCY + 1 }, (_, i) => `/repo${i}`);
    const all = Promise.all(repos.map((repo) => getRepoPulls(repo, false, 0)));
    try {
      // Drain: release whatever is running until every repo's two listings ran.
      // Several ticks between releases, so every fetch the limiter would admit
      // has had time to reach gh before one finishes.
      for (let released = 0; released < repos.length * 2; ) {
        for (let i = 0; i < 5; i++) await flush();
        expect(inFlight).toBeLessThanOrEqual(PR_FETCH_CONCURRENCY);
        const next = callbacks.shift();
        if (next) {
          next();
          released++;
        }
      }
    } finally {
      // A failed expectation must not leave slots held into the next test.
      for (const next of callbacks.splice(0)) next();
    }
    await all;
    expect(execFileMock).toHaveBeenCalledTimes(repos.length * 2);
    expect(peak).toBe(PR_FETCH_CONCURRENCY);
  });
});

describe("the limiter — one process per turn of the event loop", () => {
  /**
   * Starting a process blocks the loop (~18 ms per gh in a 400 MB daemon), so
   * six started back to back are one 110 ms stall. However many are admitted,
   * no two are started in the same turn.
   */
  it("never starts two processes in the same turn, git and gh alike", async () => {
    // A turn counter: an immediate that re-queues itself runs first in every check phase.
    let turn = 0;
    let ticking = true;
    const tick = () => {
      turn++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const startedIn: number[] = [];
    remoteUrl.mockImplementation(async () => {
      startedIn.push(turn);
      return "https://github.com/acme/app";
    });
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      startedIn.push(turn);
      setTimeout(() => cb(null, "[]", ""), 5);
      return { stdin: { end() {} } };
    });
    defaultBranch.mockImplementation(async () => {
      startedIn.push(turn);
      return null;
    });
    try {
      await Promise.all(["/a", "/b", "/c", "/d"].map((repo) => getRepoPulls(repo, false, 0)));
    } finally {
      ticking = false;
    }
    // Per repo: git remote, two listings, git symbolic-ref (no PRs came back).
    expect(startedIn).toHaveLength(16);
    expect(new Set(startedIn).size).toBe(16);
  });
});

describe("getRepoPulls — an entry too old to serve", () => {
  it("waits for the refresh once the entry is older than PR_STALE_MAX_MS, forced or not", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: [rawPull(1, "feat/old")] });
    await getRepoPulls("/stale", false, 0);
    ghServes({ open: [rawPull(2, "feat/new")] });
    // Days later, an unforced poll: yesterday's listing is not today's answer.
    const fresh = await getRepoPulls("/stale", false, PR_STALE_MAX_MS);
    expect(fresh.byBranch.has("feat/new")).toBe(true);
    expect(fresh.byBranch.has("feat/old")).toBe(false);
  });
});

describe("pullsForTrailEntry", () => {
  const pulls = (list: PullSummary[]) => ({
    github: { owner: "acme", repo: "app" },
    defaultBranch: "main",
    byBranch: indexPullsByBranch(list, "acme", "main"),
  });
  const entry = (branch: string, firstSeen: string) => ({ branch, firstSeen });

  it("takes every PR of the branch that was not closed before the chat first saw it — no SHA involved", () => {
    const list = [
      pr({ number: 1, headRef: "fix/scroll", state: "merged", closedAt: "2026-01-10T00:00:00Z" }), // a reused name, long finished
      pr({ number: 2, headRef: "fix/scroll", state: "merged", closedAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z" }),
      pr({ number: 3, headRef: "fix/scroll", state: "open", updatedAt: "2026-06-03T00:00:00Z" }),
    ];
    expect(pullsForTrailEntry(pulls(list), entry("fix/scroll", "2026-06-01T00:00:00Z")).map((p) => p.number)).toEqual([3, 2]);
  });

  it("compares the close and the first sighting as instants, not as strings", () => {
    // GitHub's timestamps have no milliseconds, a trail's do: as strings, "…:00Z" sorts after "…:00.500Z".
    const closed = (closedAt: string) => [pr({ number: 1, headRef: "fix/x", state: "merged", closedAt })];
    const seen = entry("fix/x", "2026-06-01T00:00:00.500Z");
    expect(pullsForTrailEntry(pulls(closed("2026-06-01T00:00:00Z")), seen)).toEqual([]);
    expect(pullsForTrailEntry(pulls(closed("2026-06-01T00:00:01Z")), seen).map((p) => p.number)).toEqual([1]);
  });

  it("never claims the default branch, nor anything off GitHub", () => {
    const list = [pr({ number: 1, headRef: "feat/x" })];
    expect(pullsForTrailEntry(pulls(list), entry("main", "t0"))).toEqual([]);
    expect(pullsForTrailEntry({ byBranch: indexPullsByBranch(list, "acme", "main") }, entry("feat/x", "t0"))).toEqual([]);
    expect(pullsForTrailEntry(undefined, entry("feat/x", "t0"))).toEqual([]);
  });
});

describe("recordedPullForBranch", () => {
  const here = { github: { owner: "Acme", repo: "App" }, defaultBranch: "main", byBranch: new Map() };
  const merged = (number: number, extra: Partial<PullSummary> = {}) => pr({ number, headRef: "feat/x", state: "merged", ...extra });

  it("takes the recorded PR headed by the live branch: open first, then most recently updated, whatever order they were recorded in", () => {
    const january = merged(5, { updatedAt: "2026-01-01T00:00:00Z" });
    const september = merged(9, { updatedAt: "2026-09-01T00:00:00Z" });
    expect(recordedPullForBranch([january, september], "feat/x", here)?.number).toBe(9);
    expect(recordedPullForBranch([september, january, pr({ number: 12, headRef: "feat/x", updatedAt: "2025-01-01T00:00:00Z" })], "feat/x", here)?.number).toBe(
      12,
    );
    expect(recordedPullForBranch([january], "feat/other", here)).toBeUndefined();
  });

  it("is held to what a listed PR is: this owner's head, this repository, never the default branch", () => {
    expect(recordedPullForBranch([merged(70, { headOwner: "stranger" })], "feat/x", here)).toBeUndefined();
    expect(recordedPullForBranch([merged(70, { headOwner: null })], "feat/x", here)).toBeUndefined();
    expect(recordedPullForBranch([pr({ number: 70, headRef: "main" })], "main", here)).toBeUndefined();
    expect(recordedPullForBranch([merged(70)], "feat/x", { byBranch: new Map() })).toBeUndefined();
    expect(recordedPullForBranch([merged(70)], null, here)).toBeUndefined();
    // Owner and repository names are compared without case.
    expect(recordedPullForBranch([merged(70)], "feat/x", here)?.number).toBe(70);
  });

  it("isLinkOf takes a link for a repository when the link names it or the PR's URL does — a rename leaves only one of them true", () => {
    const at = (url: string) => ({ url });
    expect(isLinkOf({ repo: "acme/app" }, at("https://github.com/acme/app/pull/3"), here.github)).toBe(true);
    // Renamed on GitHub, `origin` still on the old name: the transcript agrees with origin, the URL does not.
    expect(isLinkOf({ repo: "ACME/app" }, at("https://github.com/acme/renamed/pull/3"), here.github)).toBe(true);
    // The other way round: the link was recorded under the old name, origin has been updated.
    expect(isLinkOf({ repo: "acme/old-name" }, at("https://github.com/acme/app/pull/3"), here.github)).toBe(true);
    expect(isLinkOf({ repo: "other/lib" }, at("https://github.com/other/lib/pull/3"), here.github)).toBe(false);
    expect(isLinkOf({ repo: "acme/app" }, at("https://github.com/acme/app/pull/3"), undefined)).toBe(false);
  });

  it("isPullOf goes by the URL, so a link's unknown PR counts by the repository the link names", () => {
    expect(isPullOf({ url: "https://github.com/acme/app/pull/3" }, here.github)).toBe(true);
    expect(isPullOf({ url: "https://github.com/acme/app-two/pull/3" }, here.github)).toBe(false);
    expect(isPullOf({ url: "https://github.com/acme/app/pull/3" }, undefined)).toBe(false);
  });
});

describe("fetchPullsByNumber", () => {
  const node = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: `b${number}`,
    headRefOid: `sha${number}`,
    baseRefName: "main",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    author: { login: "dev" },
    headRepositoryOwner: { login: "acme" },
    ...extra,
  });

  it("asks for every number in one aliased query and maps each answer back to its number", async () => {
    // gh exits 1 when any aliased field errors, with the rest of the answer on stdout.
    ghAnswers({
      error: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }),
      stderr: "gh: Could not resolve to a PullRequest with the number of 99.",
      stdout: JSON.stringify({
        data: {
          repository: {
            p7: node(7, { state: "MERGED", mergedAt: "2026-11-02T00:00:00Z", closedAt: "2026-11-02T00:00:00Z" }),
            p8: node(8, { isDraft: true, author: null, headRepositoryOwner: null }),
            p9: node(9, { state: "CLOSED", closedAt: "2026-11-03T00:00:00Z" }),
            p99: null,
            p100: null,
          },
        },
        errors: [
          { type: "NOT_FOUND", path: ["repository", "p99"], message: "Could not resolve to a PullRequest with the number of 99." },
          { type: "FORBIDDEN", path: ["repository", "p100"], message: "Resource not accessible by integration" },
        ],
      }),
    });
    const answers = await fetchPullsByNumber({ owner: "acme", repo: "app" }, [7, 8, 9, 99, 100], "/work");

    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect([cmd, ...args.slice(0, 6)]).toEqual(["gh", "api", "graphql", "-f", "owner=acme", "-f", "name=app"]);
    expect(args[6]).toBe("-f");
    const fields =
      "{ number url title state isDraft headRefName headRefOid baseRefName createdAt updatedAt mergedAt closedAt author{login} headRepositoryOwner{login} }";
    expect(args[7]).toBe(
      "query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { " +
        [7, 8, 9, 99, 100].map((n) => `p${n}: pullRequest(number: ${n}) ${fields}`).join(" ") +
        " } }",
    );
    expect(opts).toMatchObject({ cwd: "/work" });

    expect(answers.get(7)).toMatchObject({ number: 7, state: "merged", headRef: "b7", headSha: "sha7", headOwner: "acme", baseRef: "main", author: "dev" });
    expect(answers.get(7)).toMatchObject({ url: "https://github.com/acme/app/pull/7", mergedAt: "2026-11-02T00:00:00Z", closedAt: "2026-11-02T00:00:00Z" });
    expect(answers.get(8)).toMatchObject({ number: 8, state: "draft", author: null, headOwner: null });
    expect(answers.get(9)).toMatchObject({ number: 9, state: "closed" });
    // Only GitHub's own NOT_FOUND makes a number "no such PR"…
    expect(answers.get(99)).toBeNull();
    // …any other empty field is a failure for that number, not a PR that does not exist.
    expect(answers.get(100)).toEqual({ error: "Resource not accessible by integration" });
    expect([...answers.keys()]).toEqual([7, 8, 9, 99, 100]);
  });

  it("fails with GitHub's reason when no repository came back — a GraphQL error or an HTTP one", async () => {
    const exit1 = () => Object.assign(new Error("exit 1"), { code: 1 as unknown as string });
    ghAnswers({
      error: exit1(),
      stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }),
    });
    await expect(fetchPullsByNumber({ owner: "acme", repo: "nope" }, [1], "/")).rejects.toThrow("Could not resolve to a Repository");
    // A 401 prints its JSON body on stdout: the reason is there, not "Unexpected response".
    ghAnswers({
      error: exit1(),
      stdout: JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }),
      stderr: "gh: Bad credentials (HTTP 401)",
    });
    await expect(fetchPullsByNumber({ owner: "acme", repo: "app" }, [1], "/")).rejects.toThrow("Bad credentials");
  });
});

describe("resolveLinkedPulls", () => {
  const link = (number: number, repo = "acme/app") => ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, firstSeen: "2026-06-01T00:00:00Z" });
  const listing = (list: PullSummary[]) => ({
    github: { owner: "Acme", repo: "App" },
    byBranch: new Map(),
    byNumber: new Map(list.map((p) => [p.number, p])),
  });
  const merged = (number: number) => pr({ number, headRef: `b${number}`, state: "merged" });

  it("answers from the listings already fetched, without a call", async () => {
    const fetch = vi.fn();
    const { pulls, error } = await resolveLinkedPulls([link(7)], [listing([merged(7)])], { cwd: "/" }, { fetch, now: () => 0 });
    expect(pulls.map((p) => p?.number)).toEqual([7]);
    expect(error).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for everything else in one call per repository, and never again about a merged PR", async () => {
    const fetch = vi.fn(async (_ref: unknown, numbers: number[]) => new Map(numbers.map((n) => [n, n === 99 ? null : merged(n)])));
    const links = [link(7), link(8), link(99), link(3, "acme/lib")];
    const first = await resolveLinkedPulls(links, [listing([merged(7)])], { cwd: "/" }, { fetch, now: () => 0 });
    // #99 does not exist on GitHub: dropped. The rest keep their order.
    expect(first.pulls.map((p) => p?.number)).toEqual([7, 8, undefined, 3]);
    expect(fetch.mock.calls.map(([ref, numbers]) => [ref, numbers])).toEqual([
      [{ owner: "acme", repo: "app" }, [8, 99]],
      [{ owner: "acme", repo: "lib" }, [3]],
    ]);
    // A day later, forced: merged PRs are settled; only the miss is re-asked.
    fetch.mockClear();
    await resolveLinkedPulls(links, [listing([merged(7)])], { cwd: "/", force: true }, { fetch, now: () => 86_400_000 });
    expect(fetch.mock.calls.map(([, numbers]) => numbers)).toEqual([[99]]);
  });

  it("re-asks about an open PR once the TTL has passed", async () => {
    const fetch = vi.fn(async (_ref: unknown, numbers: number[]) => new Map(numbers.map((n) => [n, pr({ number: n, headRef: "b" })])));
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS - 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("still returns a link GitHub could not be asked about, as an unknown PR, with the error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("gh is not installed");
    });
    const { pulls, error } = await resolveLinkedPulls([link(41)], [], { cwd: "/" }, { fetch, now: () => 0 });
    expect(error).toBe("gh is not installed");
    expect(pulls).toEqual([expect.objectContaining({ number: 41, state: "unknown", url: "https://github.com/acme/app/pull/41", title: "acme/app#41" })]);
  });
});

describe("resolveLinkedPulls — failures, sharing and the wait cap", () => {
  const link = (number: number, repo = "acme/app") => ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, firstSeen: "2026-06-01T00:00:00Z" });
  const open = (number: number) => pr({ number, headRef: `b${number}` });
  type Fetch = Parameters<typeof resolveLinkedPulls>[3] extends infer D ? (D extends { fetch: infer F } ? F : never) : never;

  it("caches a failed lookup for the TTL: a second poll spawns nothing and still answers unknown, with the error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("Could not resolve to a Repository");
    });
    const links = [link(41), link(42), link(7, "acme/private")];
    for (const now of [0, 30_000, PR_CACHE_TTL_MS - 1]) {
      const { pulls, error } = await resolveLinkedPulls(links, [], { cwd: "/" }, { fetch, now: () => now });
      expect(pulls.map((p) => [p?.number, p?.state])).toEqual([
        [41, "unknown"],
        [42, "unknown"],
        [7, "unknown"],
      ]);
      expect(error).toBe("Could not resolve to a Repository");
    }
    // One call per repository, once — not once per poll.
    expect(fetch).toHaveBeenCalledTimes(2);
    // Past the TTL it is asked again, and a forced refresh asks sooner.
    await resolveLinkedPulls(links, [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(fetch).toHaveBeenCalledTimes(4);
    await resolveLinkedPulls(links, [], { cwd: "/", force: true }, { fetch, now: () => PR_CACHE_TTL_MS + 20_000 });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("reports each repository's own failure apart, beside the first overall", async () => {
    const fetch = vi.fn<Fetch>(async (ref, numbers) => {
      if (ref.repo === "lib") return new Map(numbers.map((n) => [n, open(n)]));
      throw new Error(`no ${ref.repo}`);
    });
    const links = [link(1, "Acme/Private"), link(2, "acme/lib"), link(43), link(44)];
    const { pulls, error, errors } = await resolveLinkedPulls(links, [], { cwd: "/" }, { fetch, now: () => 0 });
    expect(pulls.map((p) => p?.state)).toEqual(["unknown", "open", "unknown", "unknown"]);
    expect(error).toBe("no Private");
    expect(errors).toEqual({ "acme/private": "no Private", "acme/app": "no app" });
    // Nothing failed: neither is set.
    expect(await resolveLinkedPulls([link(2, "acme/lib")], [], { cwd: "/" }, { fetch, now: () => 0 })).toEqual({
      pulls: [expect.objectContaining({ number: 2 })],
    });
  });

  it("keeps the last good answer beside the error when a later ask fails", async () => {
    const fetch = vi.fn<Fetch>(async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n)])));
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    fetch.mockRejectedValueOnce(new Error("gh timed out"));
    // The expired answer is served while the re-ask runs behind it…
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    for (let i = 0; i < 5; i++) await flush();
    // …and once that has failed, the answer is still there, with the reason.
    const { pulls, error } = await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 1 });
    expect(pulls.map((p) => [p?.number, p?.state])).toEqual([[20, "open"]]);
    expect(error).toBe("gh timed out");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serves unknown once the wait cap passes, and the fetch lands for the next poll", async () => {
    let answer!: () => void;
    const fetch = vi.fn<Fetch>((_ref, numbers) => new Promise((resolvePromise) => (answer = () => resolvePromise(new Map(numbers.map((n) => [n, open(n)]))))));
    vi.useFakeTimers();
    try {
      const first = resolveLinkedPulls([link(50)], [], { cwd: "/" }, { fetch, now: () => 0 });
      await vi.advanceTimersByTimeAsync(PR_FORCE_WAIT_MS);
      const capped = await first;
      expect(capped.pulls.map((p) => [p?.number, p?.state])).toEqual([[50, "unknown"]]);
      expect(capped.error).toBe("GitHub did not answer in time");

      // A poll arriving while it still runs joins it rather than spawning another.
      const second = resolveLinkedPulls([link(50)], [], { cwd: "/" }, { fetch, now: () => 6_000 });
      answer();
      expect((await second).pulls.map((p) => [p?.number, p?.state])).toEqual([[50, "open"]]);
    } finally {
      vi.useRealTimers();
    }
    const third = await resolveLinkedPulls([link(50)], [], { cwd: "/" }, { fetch, now: () => 7_000 });
    expect(third).toEqual({ pulls: [expect.objectContaining({ number: 50, state: "open" })] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares one fetch between lookups that arrive together", async () => {
    const fetch = vi.fn<Fetch>(async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n)])));
    const all = await Promise.all([1, 2, 3].map(() => resolveLinkedPulls([link(60)], [], { cwd: "/" }, { fetch, now: () => 0 })));
    expect(all.map((r) => r.pulls[0]?.number)).toEqual([60, 60, 60]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks once for a repository spelled two ways", async () => {
    const fetch = vi.fn<Fetch>(async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n)])));
    const { pulls } = await resolveLinkedPulls([link(1, "Acme/App"), link(2, "acme/app")], [], { cwd: "/" }, { fetch, now: () => 0 });
    expect(pulls.map((p) => p?.number)).toEqual([1, 2]);
    expect(fetch.mock.calls.map(([ref, numbers]) => [ref, numbers])).toEqual([[{ owner: "Acme", repo: "App" }, [1, 2]]]);
  });

  it("reports a number GitHub answered with an error as unknown, without dropping its siblings", async () => {
    const fetch = vi.fn<Fetch>(
      async (_ref, numbers) => new Map(numbers.map((n) => [n, n === 71 ? { error: "Something went wrong" } : n === 72 ? null : open(n)])),
    );
    const { pulls, error } = await resolveLinkedPulls([link(70), link(71), link(72)], [], { cwd: "/" }, { fetch, now: () => 0 });
    expect(pulls.map((p) => [p?.number, p?.state])).toEqual([
      [70, "open"],
      [71, "unknown"],
      [undefined, undefined],
    ]);
    expect(error).toBe("Something went wrong");
  });

  it("releases its slot when a fetch throws before returning a promise", async () => {
    const thrower = vi.fn<Fetch>(() => {
      throw new Error("boom");
    });
    // More throws than there are slots: a leaked slot would hang the last lookup.
    for (const n of [1, 2, 3]) expect((await resolveLinkedPulls([link(n)], [], { cwd: "/" }, { fetch: thrower, now: () => 0 })).error).toBe("boom");
    const fetch = vi.fn<Fetch>(async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n)])));
    expect((await resolveLinkedPulls([link(80)], [], { cwd: "/" }, { fetch, now: () => 0 })).pulls[0]?.number).toBe(80);
  });
});

describe("resolveLinkedPulls — stale-while-revalidate", () => {
  const link = (number: number, repo = "acme/app") => ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, firstSeen: "2026-06-01T00:00:00Z" });
  const open = (number: number, title = `PR ${number}`) => pr({ number, headRef: `b${number}`, title });
  type Fetch = Parameters<typeof resolveLinkedPulls>[3] extends infer D ? (D extends { fetch: infer F } ? F : never) : never;

  /** A fetch that answers at once the first time and hangs afterwards, until `answer()`. */
  function hangingAfterFirst() {
    const held: Array<() => void> = [];
    const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>((_ref, numbers) => {
      const answer = new Map(numbers.map((n) => [n, open(n, fetch.mock.calls.length === 1 ? "first" : "refreshed")]));
      if (fetch.mock.calls.length === 1) return Promise.resolve(answer);
      return new Promise((resolvePromise) => held.push(() => resolvePromise(answer)));
    });
    return { fetch, answer: () => held.splice(0).forEach((release) => release()) };
  }

  /**
   * The regression: an expired, unmerged link the listing does not hold was
   * awaited (up to PR_FORCE_WAIT_MS) on every ordinary poll, so a 60 s poll
   * could block on GraphQL though a perfectly good answer was cached.
   */
  it("serves an expired answer at once on an ordinary poll and refreshes it behind the response", async () => {
    const { fetch, answer } = hangingAfterFirst();
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });

    // GitHub now hangs. Real timers: were this waited for, the test would time out.
    const stale = await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(stale).toEqual({ pulls: [expect.objectContaining({ number: 20, title: "first" })] });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);

    // A second poll during the refresh shares it: no wait, no second call.
    const again = await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 1 });
    expect(again.pulls[0]?.title).toBe("first");
    expect(fetch).toHaveBeenCalledTimes(2);

    answer();
    for (let i = 0; i < 5; i++) await flush();
    const fresh = await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 2 });
    expect(fresh.pulls[0]?.title).toBe("refreshed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for a forced request, past the minimum age only", async () => {
    const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>(
      async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n, `ask ${fetch.mock.calls.length}`)])),
    );
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    const tooSoon = await resolveLinkedPulls([link(20)], [], { cwd: "/", force: true }, { fetch, now: () => PR_FORCE_MIN_AGE_MS - 1 });
    expect(tooSoon.pulls[0]?.title).toBe("ask 1");
    const forced = await resolveLinkedPulls([link(20)], [], { cwd: "/", force: true }, { fetch, now: () => PR_FORCE_MIN_AGE_MS });
    expect(forced.pulls[0]?.title).toBe("ask 2");
  });

  it("a forced request waits for a refresh already running behind an ordinary poll", async () => {
    const { fetch, answer } = hangingAfterFirst();
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    await flush();
    const forced = resolveLinkedPulls([link(20)], [], { cwd: "/", force: true }, { fetch, now: () => PR_CACHE_TTL_MS + 1 });
    await flush();
    answer();
    expect((await forced).pulls[0]?.title).toBe("refreshed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for a link with no cached answer — never asked, or only ever failed", async () => {
    const fetch = vi.fn<Fetch>(async () => {
      throw new Error("offline");
    });
    expect((await resolveLinkedPulls([link(41)], [], { cwd: "/" }, { fetch, now: () => 0 })).pulls[0]?.state).toBe("unknown");
    // Past the TTL there is still nothing to serve meanwhile: this poll waits, and gets the answer.
    fetch.mockImplementation(async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n)])));
    const answered = await resolveLinkedPulls([link(41)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(answered).toEqual({ pulls: [expect.objectContaining({ number: 41, state: "open" })] });
  });

  it("waits for an answer too old to pass off as today's, like the listing", async () => {
    const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>(
      async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n, `ask ${fetch.mock.calls.length}`)])),
    );
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    const days = await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_STALE_MAX_MS });
    expect(days.pulls[0]?.title).toBe("ask 2");
  });

  it("waits only for the links that need it, in one call with those that could have waited", async () => {
    const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>(
      async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n, `ask ${fetch.mock.calls.length}`)])),
    );
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    // #20 is expired (servable), #21 was never asked about: one call, waited for.
    const both = await resolveLinkedPulls([link(20), link(21)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(fetch.mock.calls.map(([, numbers]) => numbers)).toEqual([[20], [20, 21]]);
    expect(both.pulls.map((p) => p?.title)).toEqual(["ask 2", "ask 2"]);
  });
});

describe("fetchPullsByBranch", () => {
  const node = (n: number, head: string, over: Record<string, unknown> = {}) => ({
    number: n,
    url: `https://github.com/acme/app/pull/${n}`,
    title: `PR ${n}`,
    state: "MERGED",
    isDraft: false,
    headRefName: head,
    headRefOid: `sha${n}`,
    baseRefName: "main",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    mergedAt: "2026-01-02T00:00:00Z",
    closedAt: "2026-01-02T00:00:00Z",
    author: { login: "octo" },
    headRepositoryOwner: { login: "acme" },
    ...over,
  });

  it("asks for every branch in one aliased query, the names as variables, and maps each answer back", async () => {
    const awkward = 'we"ird=$b0 }';
    ghAnswers({
      stdout: JSON.stringify({
        data: {
          repository: {
            b0: { nodes: [node(7, "feat/x"), node(6, "feat/x", { state: "CLOSED", mergedAt: null })] },
            b1: { nodes: [] },
            b2: { nodes: [node(9, "other")] },
          },
        },
      }),
    });
    const found = await fetchPullsByBranch({ owner: "acme", repo: "app" }, ["feat/x", "none", awkward], "/cwd");
    expect((found.get("feat/x") as PullSummary[]).map((p) => [p.number, p.state, p.headSha, p.headOwner, p.closedAt])).toEqual([
      [7, "merged", "sha7", "acme", "2026-01-02T00:00:00Z"],
      [6, "closed", "sha6", "acme", "2026-01-02T00:00:00Z"],
    ]);
    // An empty list is an answer: no PR.
    expect(found.get("none")).toEqual([]);
    // Held to the name asked for, whatever came back.
    expect(found.get(awkward)).toEqual([]);

    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(opts).toMatchObject({ cwd: "/cwd" });
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    // Every `-f` pair, in order: the branch names travel as values, verbatim.
    const fields = args.slice(2).filter((_: string, i: number) => i % 2 === 1);
    expect(fields.slice(0, 5)).toEqual(["owner=acme", "name=app", "b0=feat/x", "b1=none", `b2=${awkward}`]);
    const query = fields[5];
    expect(query).toMatch(/^query=query\(\$owner: String!, \$name: String!, \$b0: String!, \$b1: String!, \$b2: String!\)/);
    expect(query).toContain("b1: pullRequests(headRefName: $b1, first: 10, orderBy: {field: UPDATED_AT, direction: DESC})");
    // Nothing of a branch name is spliced into the query itself.
    expect(query).not.toContain("feat/x");
    expect(query).not.toContain("we");
  });

  /**
   * A branch name is anything git allows. Each must reach GitHub as the value
   * of a GraphQL variable: not part of the query, not a `gh` flag, and — `-f`
   * being gh's raw-string field, unlike `-F` — not read as a file or a typed
   * literal.
   */
  it("passes awkward branch names as raw `-f` variables, each in one argument, none of it in the query", async () => {
    const awkward = [
      'quo"te',
      "sing'le",
      "back\\slash",
      "dol$lar",
      "$owner",
      "ünï/côdé-分支-🌿",
      "-f",
      "--jq",
      "-leading-dash",
      "@file",
      "@/etc/passwd",
      "has=equals",
      "key[sub]",
      "true",
      "null",
      "123",
      "with space",
      "}) { viewer { login } } #",
    ];
    ghAnswers({ stdout: JSON.stringify({ data: { repository: Object.fromEntries(awkward.map((name, i) => [`b${i}`, { nodes: [node(100 + i, name)] }])) } }) });
    const found = await fetchPullsByBranch({ owner: "acme", repo: "app" }, awkward, "/");
    // Each answer maps back to the exact name it was asked under.
    expect(awkward.map((name) => (found.get(name) as PullSummary[]).map((p) => [p.number, p.headRef]))).toEqual(awkward.map((name, i) => [[100 + i, name]]));

    const args: string[] = execFileMock.mock.calls[0][1];
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    const pairs = args.slice(2);
    // Strictly `-f`, `key=value` pairs — so no value, whatever it starts with, sits where gh looks for a flag.
    expect(pairs.filter((_, i) => i % 2 === 0).every((flag) => flag === "-f")).toBe(true);
    const values = pairs.filter((_, i) => i % 2 === 1);
    expect(values.slice(2, -1)).toEqual(awkward.map((name, i) => `b${i}=${name}`));
    const query = values[values.length - 1];
    expect(query.startsWith("query=query(")).toBe(true);
    // (`$owner`, `-f`, `true`… are in any query; the equality below covers those.)
    for (const name of awkward.filter((n) => !["$owner", "-f", "true", "null", "123"].includes(n))) expect(query, name).not.toContain(name);
    // The query is a function of how many branches there are, nothing else.
    execFileMock.mockClear();
    ghAnswers({ stdout: JSON.stringify({ data: { repository: {} } }) });
    await fetchPullsByBranch(
      { owner: "acme", repo: "app" },
      awkward.map((_, i) => `plain-${i}`),
      "/",
    );
    const plain: string[] = execFileMock.mock.calls[0][1];
    expect(plain[plain.length - 1]).toBe(query);
  });

  it("makes a branch whose field came back without a list an error, not a branch with no PR", async () => {
    ghAnswers({
      error: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }),
      stdout: JSON.stringify({
        data: { repository: { b0: { nodes: [] }, b1: null } },
        errors: [{ path: ["repository", "b1"], message: "Something went wrong" }],
      }),
    });
    const found = await fetchPullsByBranch({ owner: "acme", repo: "app" }, ["a", "b"], "/");
    expect(found.get("a")).toEqual([]);
    expect(found.get("b")).toEqual({ error: "Something went wrong" });
  });

  it("fails with GitHub's reason when no repository came back", async () => {
    ghAnswers({
      error: Object.assign(new Error("exit 1"), { code: 1 as unknown as string }),
      stdout: JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] }),
    });
    await expect(fetchPullsByBranch({ owner: "acme", repo: "nope" }, ["a"], "/")).rejects.toThrow("Could not resolve to a Repository");
  });
});

describe("resolveBranchPulls", () => {
  const GITHUB: GitHubRepoRef = { owner: "acme", repo: "app" };
  const listing = (list: PullSummary[], over: Partial<RepoPulls> = {}): RepoPulls => ({
    github: GITHUB,
    defaultBranch: "main",
    byBranch: indexPullsByBranch(list, "acme", "main"),
    byNumber: new Map(list.map((p) => [p.number, p])),
    ...over,
  });
  const merged = (number: number, headRef: string, over: Partial<PullSummary> = {}) =>
    pr({ number, headRef, state: "merged", closedAt: "2026-03-01T00:00:00Z", mergedAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", ...over });
  type Fetch = (ref: GitHubRepoRef, branches: string[], cwd: string) => Promise<Map<string, BranchAnswer>>;
  /** Answers each branch from `table`; a branch not in it has no PR. */
  /** Every branch asked about as a live row's — the short TTL, and `force` applies. */
  const ask = (pulls: RepoPulls, live: Array<string | null | undefined>, opts: { cwd: string; force?: boolean }, deps: { fetch: Fetch; now: () => number }) =>
    resolveBranchPulls(pulls, { live }, opts, deps);
  const serving = (table: Record<string, PullSummary[]>) => vi.fn<Fetch>(async (_ref, branches) => new Map(branches.map((b) => [b, table[b] ?? []])));

  it("asks, in one call, only about the branches the listing has no PR for — never the default branch", async () => {
    const fetch = serving({ "feat/old": [merged(5, "feat/old")] });
    const base = listing([pr({ number: 1, headRef: "feat/live" })]);
    const found = await ask(base, ["feat/live", "feat/old", "main", "feat/none", null, "feat/old", undefined, ""], { cwd: "/r" }, { fetch, now: () => 0 });
    expect(fetch.mock.calls).toEqual([[GITHUB, ["feat/old", "feat/none"], "/r"]]);
    expect(found.byBranch.get("feat/old")?.map((p) => p.number)).toEqual([5]);
    expect(found.byBranch.get("feat/live")?.map((p) => p.number)).toEqual([1]);
    expect(found.byBranch.has("feat/none")).toBe(false);
    // Reachable by number too, beside the listing's own.
    expect([...found.byNumber!.keys()].sort()).toEqual([1, 5]);
    expect(found.branchError).toBeUndefined();
    // The listing handed in is not touched.
    expect(base.byBranch.has("feat/old")).toBe(false);
  });

  it("returns the listing itself when there is nothing to ask or nothing was found", async () => {
    const fetch = serving({});
    const base = listing([pr({ number: 1, headRef: "feat/live" })]);
    expect(await ask(base, ["feat/live", "main"], { cwd: "/" }, { fetch, now: () => 0 })).toBe(base);
    expect(fetch).not.toHaveBeenCalled();
    expect(await ask(base, ["feat/none"], { cwd: "/" }, { fetch, now: () => 0 })).toBe(base);
    const offGitHub: RepoPulls = { byBranch: new Map() };
    expect(await ask(offGitHub, ["feat/x"], { cwd: "/" }, { fetch, now: () => 0 })).toBe(offGitHub);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches a branch with no PR like an answer: within the TTL nothing is asked again", async () => {
    const fetch = serving({});
    const branches = Array.from({ length: 30 }, (_, i) => `stale/${i}`);
    await ask(listing([]), branches, { cwd: "/" }, { fetch, now: () => 0 });
    await ask(listing([]), branches, { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS - 1 });
    // Thirty PR-less branches, two polls: one gh process.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toHaveLength(30);
  });

  it("asks about more branches than one call holds a call at a time, not a process per branch", async () => {
    const fetch = serving({});
    const branches = Array.from({ length: 120 }, (_, i) => `b/${i}`);
    await ask(listing([]), branches, { cwd: "/" }, { fetch, now: () => 0 });
    expect(fetch.mock.calls.map(([, asked]) => asked.length)).toEqual([50, 50, 20]);
  });

  it("past the TTL, serves the cached answer without waiting and refreshes it in one background call", async () => {
    const held: Array<() => void> = [];
    const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>((_ref, branches) => {
      const first = fetch.mock.calls.length === 1;
      const answer = new Map<string, BranchAnswer>(
        branches.map((b) => [b, b === "feat/old" ? [merged(5, "feat/old", { title: first ? "first" : "refreshed" })] : []]),
      );
      return first ? Promise.resolve(answer) : new Promise((resolvePromise) => held.push(() => resolvePromise(answer)));
    });
    const asked = ["feat/old", "feat/none"];
    await ask(listing([]), asked, { cwd: "/" }, { fetch, now: () => 0 });

    // GitHub now hangs. Real timers: were this waited for, the test would time out.
    const stale = await ask(listing([]), asked, { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(stale.byBranch.get("feat/old")?.[0].title).toBe("first");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    // The negative answer is refreshed in that same call, and a poll meanwhile shares it.
    expect(fetch.mock.calls[1][1]).toEqual(asked);
    await ask(listing([]), asked, { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 1 });
    expect(fetch).toHaveBeenCalledTimes(2);

    held.splice(0).forEach((release) => release());
    for (let i = 0; i < 5; i++) await flush();
    const fresh = await ask(listing([]), asked, { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 2 });
    expect(fresh.byBranch.get("feat/old")?.[0].title).toBe("refreshed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for a branch never asked about, but no longer than the cap — then says GitHub did not answer", async () => {
    let answer!: () => void;
    const fetch = vi.fn<Fetch>(
      (_ref, branches) => new Promise((resolvePromise) => (answer = () => resolvePromise(new Map(branches.map((b) => [b, [merged(5, b)]]))))),
    );
    const base = listing([pr({ number: 1, headRef: "feat/live" })]);
    vi.useFakeTimers();
    try {
      const first = ask(base, ["feat/old"], { cwd: "/" }, { fetch, now: () => 0 });
      await vi.advanceTimersByTimeAsync(PR_FORCE_WAIT_MS);
      const capped = await first;
      expect(capped.branchError).toBe("GitHub did not answer in time");
      // The listing's own PRs are there regardless.
      expect(capped.byBranch.get("feat/live")?.map((p) => p.number)).toEqual([1]);
      // A poll arriving while it still runs joins it rather than spawning another.
      const second = ask(base, ["feat/old"], { cwd: "/" }, { fetch, now: () => 6_000 });
      answer();
      expect((await second).byBranch.get("feat/old")?.map((p) => p.number)).toEqual([5]);
    } finally {
      vi.useRealTimers();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a failed lookup as branchError, caches it for the TTL, and never waits on its retry", async () => {
    const fetch = vi.fn<Fetch>(async () => {
      throw new Error("gh: HTTP 502");
    });
    const base = listing([pr({ number: 1, headRef: "feat/live" })]);
    const failed = await ask(base, ["feat/old"], { cwd: "/" }, { fetch, now: () => 0 });
    expect(failed.branchError).toBe("gh: HTTP 502");
    expect(failed.error).toBeUndefined();
    expect(failed.byBranch).toBe(base.byBranch);
    await ask(base, ["feat/old"], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS - 1 });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Past the TTL the retry runs behind the response — here, one that hangs.
    let answer!: () => void;
    fetch.mockImplementation(
      (_ref, branches) => new Promise((resolvePromise) => (answer = () => resolvePromise(new Map(branches.map((b) => [b, [merged(5, b)]]))))),
    );
    const retrying = await ask(base, ["feat/old"], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(retrying.branchError).toBe("gh: HTTP 502");
    await flush();
    answer();
    for (let i = 0; i < 5; i++) await flush();
    const recovered = await ask(base, ["feat/old"], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 1 });
    expect(recovered.branchError).toBeUndefined();
    expect(recovered.byBranch.get("feat/old")?.map((p) => p.number)).toEqual([5]);
  });

  it("keeps the last good answer beside the error when one branch of a call fails", async () => {
    const fetch = serving({ "feat/old": [merged(5, "feat/old")] });
    await ask(listing([]), ["feat/old"], { cwd: "/" }, { fetch, now: () => 0 });
    fetch.mockImplementation(async (_ref, branches) => new Map(branches.map((b) => [b, { error: "Something went wrong" }])));
    await ask(listing([]), ["feat/old"], { cwd: "/", force: true }, { fetch, now: () => PR_CACHE_TTL_MS });
    const after = await ask(listing([]), ["feat/old"], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS + 1 });
    expect(after.byBranch.get("feat/old")?.map((p) => p.number)).toEqual([5]);
    expect(after.branchError).toBe("Something went wrong");
  });

  it("waits for a forced request past the minimum age, and for an answer older than PR_STALE_MAX_MS", async () => {
    const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>(
      async (_ref, branches) => new Map(branches.map((b) => [b, [merged(5, b, { title: `ask ${fetch.mock.calls.length}` })]])),
    );
    const title = async (force: boolean, now: number) =>
      (await ask(listing([]), ["feat/old"], { cwd: "/", force }, { fetch, now: () => now })).byBranch.get("feat/old")?.[0].title;
    expect(await title(false, 0)).toBe("ask 1");
    expect(await title(true, PR_FORCE_MIN_AGE_MS - 1)).toBe("ask 1");
    expect(await title(true, PR_FORCE_MIN_AGE_MS)).toBe("ask 2");
    expect(await title(false, PR_FORCE_MIN_AGE_MS + PR_STALE_MAX_MS)).toBe("ask 3");
  });

  it("shares one fetch between requests that arrive together", async () => {
    const fetch = serving({ "feat/old": [merged(5, "feat/old")] });
    const all = await Promise.all([1, 2, 3].map(() => ask(listing([]), ["feat/old"], { cwd: "/" }, { fetch, now: () => 0 })));
    expect(all.map((found) => found.byBranch.get("feat/old")?.[0].number)).toEqual([5, 5, 5]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks nothing while the listing itself is failing, but still applies what is cached", async () => {
    const fetch = serving({ "feat/old": [merged(5, "feat/old")] });
    const broken = listing([], { error: "gh is not installed" });
    expect(await ask(broken, ["feat/old"], { cwd: "/" }, { fetch, now: () => 0 })).toBe(broken);
    expect(fetch).not.toHaveBeenCalled();

    await ask(listing([]), ["feat/old"], { cwd: "/" }, { fetch, now: () => 0 });
    const later = await ask(broken, ["feat/old"], { cwd: "/" }, { fetch, now: () => 2 * PR_CACHE_TTL_MS });
    expect(later.byBranch.get("feat/old")?.map((p) => p.number)).toEqual([5]);
    expect(later.error).toBe("gh is not installed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  /**
   * The listing holds the branch: the listing is the answer, and what was
   * cached by branch is dropped rather than merged — a cached "open" that
   * nothing refreshes any more could otherwise outlive the PR's closing.
   */
  it("drops a branch's cached answer once the listing holds the branch, and asks afresh if it loses it again", async () => {
    const fetch = serving({ "feat/reused": [pr({ number: 5, headRef: "feat/reused" })] });
    const first = await ask(listing([]), ["feat/reused"], { cwd: "/" }, { fetch, now: () => 0 });
    expect(first.byBranch.get("feat/reused")?.map((p) => [p.number, p.state])).toEqual([[5, "open"]]);

    const taken = listing([pr({ number: 50, headRef: "feat/reused" })]);
    expect(await ask(taken, ["feat/reused"], { cwd: "/" }, { fetch, now: () => 1 })).toBe(taken);
    expect(fetch).toHaveBeenCalledTimes(1);

    // #5 has merged meanwhile. The listing loses the branch: not the cached "open", a fresh ask.
    fetch.mockImplementation(async (_ref, branches) => new Map(branches.map((b) => [b, [merged(5, b)]])));
    const again = await ask(listing([]), ["feat/reused"], { cwd: "/" }, { fetch, now: () => 2 });
    expect(again.byBranch.get("feat/reused")?.map((p) => [p.number, p.state])).toEqual([[5, "merged"]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops serving an answer's open PR once refreshes have failed for longer than PR_STALE_MAX_MS, and keeps its closed ones", async () => {
    const fetch = serving({ "feat/x": [pr({ number: 6, headRef: "feat/x" }), merged(5, "feat/x")] });
    await ask(listing([]), ["feat/x"], { cwd: "/" }, { fetch, now: () => 0 });
    fetch.mockImplementation(async () => {
      throw new Error("gh: HTTP 502");
    });
    let last: RepoPulls | undefined;
    for (let now = PR_CACHE_TTL_MS; now <= PR_STALE_MAX_MS + PR_CACHE_TTL_MS; now += PR_CACHE_TTL_MS) {
      last = await ask(listing([]), ["feat/x"], { cwd: "/" }, { fetch, now: () => now });
      for (let i = 0; i < 3; i++) await flush();
      if (now < PR_STALE_MAX_MS) expect(last.byBranch.get("feat/x")?.map((p) => p.number)).toEqual([6, 5]);
    }
    expect(last!.byBranch.get("feat/x")?.map((p) => [p.number, p.state])).toEqual([[5, "merged"]]);
    expect(last!.branchError).toBe("gh: HTTP 502");
  });

  it("lets the listing's own copy of a PR win over the one found by branch", async () => {
    const fetch = serving({ "feat/x": [merged(5, "feat/x", { title: "by branch" })] });
    await ask(listing([]), ["feat/x"], { cwd: "/" }, { fetch, now: () => 0 });
    const relisted = listing([merged(5, "feat/x", { title: "listed" })]);
    expect(await ask(relisted, ["feat/x"], { cwd: "/" }, { fetch, now: () => 1 })).toBe(relisted);
  });

  describe("cost: trail branches, the cap, and failures", () => {
    const asTrail = (pulls: RepoPulls, trail: string[], now: number, force = false, live: string[] = [], fetch?: Fetch) =>
      resolveBranchPulls(pulls, { live, trail }, { cwd: "/", force }, { fetch: fetch!, now: () => now });

    it("keeps a trail branch's settled answer for an hour, where a live row's is re-asked every TTL", async () => {
      const fetch = serving({ "trail/merged": [merged(5, "trail/merged")] });
      const poll = (now: number, force = false) => asTrail(listing([]), ["trail/none", "trail/merged"], now, force, ["live/none"], fetch);
      await poll(0);
      expect(fetch.mock.calls.map(([, asked]) => asked)).toEqual([["live/none", "trail/none", "trail/merged"]]);

      // A TTL later: only the live row's branch — it may have gained a PR.
      await poll(PR_CACHE_TTL_MS);
      await flush();
      expect(fetch.mock.calls.slice(1).map(([, asked]) => asked)).toEqual([["live/none"]]);

      // The refresh button means the live rows, not weeks-old trail branches.
      await poll(2 * PR_CACHE_TTL_MS, true);
      expect(fetch.mock.calls.slice(2).map(([, asked]) => asked)).toEqual([["live/none"]]);

      // An hour on, the trail branches are refreshed too — behind the response.
      fetch.mockClear();
      const found = await poll(BRANCH_SETTLED_TTL_MS);
      expect(found.byBranch.get("trail/merged")?.map((p) => p.number)).toEqual([5]);
      await flush();
      expect(fetch.mock.calls.map(([, asked]) => [...asked].sort())).toEqual([["live/none", "trail/merged", "trail/none"]]);
    });

    it("keeps a trail branch on the short TTL while its answer holds an open PR, and a branch that is also a live row's", async () => {
      const fetch = serving({ "trail/open": [pr({ number: 6, headRef: "trail/open" })] });
      const poll = (now: number) => asTrail(listing([]), ["trail/open", "both"], now, false, ["both"], fetch);
      await poll(0);
      await poll(PR_CACHE_TTL_MS);
      await flush();
      expect(fetch.mock.calls.map(([, asked]) => [...asked].sort())).toEqual([
        ["both", "trail/open"],
        ["both", "trail/open"],
      ]);
    });

    it("waits for a settled trail answer only once it is as stale as a listing would have to be", async () => {
      const held: Array<() => void> = [];
      const fetch: ReturnType<typeof vi.fn<Fetch>> = vi.fn<Fetch>((_ref, branches) => {
        const answer = new Map<string, BranchAnswer>(branches.map((b) => [b, [merged(5, b, { title: `ask ${fetch.mock.calls.length}` })]]));
        return fetch.mock.calls.length === 2 ? new Promise((resolvePromise) => held.push(() => resolvePromise(answer))) : Promise.resolve(answer);
      });
      const title = async (now: number) => (await asTrail(listing([]), ["trail/x"], now, false, [], fetch)).byBranch.get("trail/x")?.[0].title;
      expect(await title(0)).toBe("ask 1");
      // Expired: served, the refresh (which hangs) runs behind.
      expect(await title(BRANCH_SETTLED_TTL_MS)).toBe("ask 1");
      await flush();
      held.splice(0).forEach((release) => release());
      for (let i = 0; i < 5; i++) await flush();
      // Days later: waited for.
      expect(await title(3 * BRANCH_SETTLED_TTL_MS)).toBe("ask 3");
    });

    it("asks about at most 200 branches per request — live rows' first — and fills the rest in on later polls", async () => {
      const fetch = serving({ "t/449": [merged(5, "t/449")] });
      const trail = Array.from({ length: 450 }, (_, i) => `t/${i}`);
      const poll = (now: number) => asTrail(listing([]), trail, now, false, ["live/a", "live/b"], fetch);
      const first = await poll(0);
      // Four processes, not ten; what was not asked about is not an error.
      expect(fetch.mock.calls.map(([, asked]) => asked.length)).toEqual([50, 50, 50, 50]);
      expect(fetch.mock.calls[0][1].slice(0, 2)).toEqual(["live/a", "live/b"]);
      expect(first.branchError).toBeUndefined();
      expect(first.byBranch.has("t/449")).toBe(false);

      await poll(1);
      expect(fetch).toHaveBeenCalledTimes(8);
      const third = await poll(2);
      expect(fetch.mock.calls.slice(8).map(([, asked]) => asked.length)).toEqual([50, 2]);
      expect(third.byBranch.get("t/449")?.map((p) => p.number)).toEqual([5]);
      // Every branch asked about exactly once, and nothing more within the TTL.
      expect(new Set(fetch.mock.calls.flatMap(([, asked]) => asked)).size).toBe(452);
      await poll(3);
      expect(fetch).toHaveBeenCalledTimes(10);
    });

    it("runs a repository's batches side by side, not one after the other", async () => {
      const held: Array<() => void> = [];
      const fetch = vi.fn<Fetch>((_ref, branches) => new Promise((resolvePromise) => held.push(() => resolvePromise(new Map(branches.map((b) => [b, []]))))));
      const asking = asTrail(
        listing([]),
        Array.from({ length: 120 }, (_, i) => `b/${i}`),
        0,
        false,
        [],
        fetch,
      );
      for (let i = 0; i < 8; i++) await flush();
      // All three are in flight before any has answered.
      expect(fetch).toHaveBeenCalledTimes(3);
      held.splice(0).forEach((release) => release());
      await asking;
    });

    it("fails only the batch that failed: the batches around it are answered, and it alone is retried", async () => {
      const failing = { on: true };
      const fetch = vi.fn<Fetch>(
        (_ref, branches) =>
          // Answered a few turns later, so all three batches are already running.
          new Promise((resolvePromise, reject) =>
            setTimeout(() => {
              if (failing.on && branches.includes("b/50")) reject(new Error("gh: HTTP 502"));
              else resolvePromise(new Map(branches.map((b) => [b, b === "b/0" || b === "b/119" ? [merged(Number(b.slice(2)) + 1, b)] : []])));
            }, 5),
          ),
      );
      const branches = Array.from({ length: 120 }, (_, i) => `b/${i}`);
      const first = await asTrail(listing([]), [], 0, false, branches, fetch);
      expect(fetch.mock.calls.map(([, asked]) => asked.length)).toEqual([50, 50, 20]);
      expect(first.branchError).toBe("gh: HTTP 502");
      // The first and the last batch's answers are there.
      expect(first.byBranch.get("b/0")?.map((p) => p.number)).toEqual([1]);
      expect(first.byBranch.get("b/119")?.map((p) => p.number)).toEqual([120]);

      // Within the TTL nothing is asked again; past it, only the fifty that failed.
      await asTrail(listing([]), [], PR_CACHE_TTL_MS - 1, false, branches, fetch);
      expect(fetch).toHaveBeenCalledTimes(3);
      failing.on = false;
      fetch.mockClear();
      const retried = await asTrail(listing([]), [], PR_CACHE_TTL_MS, true, branches, fetch);
      expect(retried.branchError).toBeUndefined();
      // Forced, so everything is re-asked — the batch that failed last time first and alone, as a probe.
      expect(fetch.mock.calls[0][1]).toHaveLength(50);
      expect(fetch.mock.calls.flatMap(([, asked]) => asked)).toHaveLength(120);
    });

    /**
     * A `gh` that can list over REST but is refused by GraphQL. The listing
     * is untouched, the failure is marked as the partial one it is, and it
     * costs one process per repository per TTL — not one per batch, and not
     * one per poll.
     */
    it("costs one process per TTL while GraphQL keeps failing, however many branches, and leaves the listing whole", async () => {
      const fetch = vi.fn<Fetch>(async () => {
        throw new Error("Resource not accessible by personal access token");
      });
      const base = listing([pr({ number: 1, headRef: "feat/live" })]);
      const branches = ["feat/live", ...Array.from({ length: 120 }, (_, i) => `b/${i}`)];
      const poll = (now: number, force = false) => asTrail(base, [], now, force, branches, fetch);

      const first = await poll(0);
      expect(first).toMatchObject({ branchError: "Resource not accessible by personal access token" });
      expect(first.error).toBeUndefined();
      expect(first.byBranch).toBe(base.byBranch);
      expect(first.byNumber).toBe(base.byNumber);
      // The first batch failed before the others were started: one process, not three.
      expect(fetch).toHaveBeenCalledTimes(1);

      // Polls inside the TTL: nothing.
      for (const now of [1_000, 30_000, PR_CACHE_TTL_MS - 1]) await poll(now);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Each TTL after: one probe, behind the response.
      for (let n = 1; n <= 3; n++) {
        const again = await poll(n * PR_CACHE_TTL_MS);
        expect(again.branchError).toBe("Resource not accessible by personal access token");
        for (let i = 0; i < 8; i++) await flush();
        expect(fetch).toHaveBeenCalledTimes(1 + n);
      }
      // The refresh button: one more, waited for.
      await poll(3 * PR_CACHE_TTL_MS + PR_FORCE_MIN_AGE_MS, true);
      expect(fetch).toHaveBeenCalledTimes(5);
    });
  });

  describe("what counts as a branch's PR is not loosened", () => {
    it("drops a fork's PR, and one from a deleted head repository, that carry the branch's name", async () => {
      const fetch = serving({
        "feat/x": [merged(8, "feat/x", { headOwner: "fork" }), merged(9, "feat/x", { headOwner: null }), merged(5, "feat/x", { headOwner: "ACME" })],
      });
      const found = await ask(listing([]), ["feat/x"], { cwd: "/" }, { fetch, now: () => 0 });
      expect(found.byBranch.get("feat/x")?.map((p) => p.number)).toEqual([5]);
      // Still reachable by number, as a listed fork's PR is.
      expect([...found.byNumber!.keys()].sort()).toEqual([5, 8, 9]);
    });

    it("never indexes the default branch, even when the listing did not know it when asked", async () => {
      const fetch = serving({ trunk: [merged(5, "trunk")] });
      const unknownDefault = listing([], { defaultBranch: undefined });
      expect((await ask(unknownDefault, ["trunk"], { cwd: "/" }, { fetch, now: () => 0 })).byBranch.has("trunk")).toBe(true);
      const knownDefault = listing([], { defaultBranch: "trunk" });
      expect((await ask(knownDefault, ["trunk"], { cwd: "/" }, { fetch, now: () => 1 })).byBranch.has("trunk")).toBe(false);
    });

    it("gives a live branch a closed PR found by name only at that exact commit (matchPull)", async () => {
      const fetch = serving({ "fix/scroll": [merged(5, "fix/scroll", { headSha: "old-tip" })] });
      const found = await ask(listing([]), ["fix/scroll"], { cwd: "/" }, { fetch, now: () => 0 });
      // The name was reused: today's `fix/scroll` is at another commit.
      expect(matchPull(found.byBranch.get("fix/scroll"), "new-tip")).toBeUndefined();
      expect(matchPull(found.byBranch.get("fix/scroll"), "old-tip")?.number).toBe(5);
    });

    it("gives a trail entry a PR found by name only if it was not closed before the chat got there (pullsForTrailEntry)", async () => {
      const fetch = serving({ "fix/scroll": [merged(5, "fix/scroll")] });
      const found = await ask(listing([]), ["fix/scroll"], { cwd: "/" }, { fetch, now: () => 0 });
      expect(pullsForTrailEntry(found, { branch: "fix/scroll", firstSeen: "2026-02-01T00:00:00Z" }).map((p) => p.number)).toEqual([5]);
      expect(pullsForTrailEntry(found, { branch: "fix/scroll", firstSeen: "2026-04-01T00:00:00Z" })).toEqual([]);
    });
  });
});

describe("runGh", () => {
  it("resolves a non-zero exit that still printed an answer only when partial output is allowed", async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error, out: string, err: string) => void) => {
      queueMicrotask(() => cb(Object.assign(new Error("exit 1"), { code: 1 }), '{"data":{}}', "gh: Could not resolve to a PullRequest"));
      return { stdin: { end() {} } };
    });
    await expect(runGh(["api", "graphql"], "/")).rejects.toThrow("Could not resolve");
    expect(await runGh(["api", "graphql"], "/", true)).toBe('{"data":{}}');
  });
});
