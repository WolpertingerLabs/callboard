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
  clearRepoPullsCache,
  fetchPullsByNumber,
  fetchRepoPulls,
  getRepoPulls,
  indexPullsByBranch,
  isLinkOf,
  isPullOf,
  matchPull,
  parseGitHubRemote,
  PR_CACHE_TTL_MS,
  PR_FORCE_WAIT_MS,
  PR_STALE_MAX_MS,
  pullsForTrailEntry,
  recordedPullForBranch,
  resolveLinkedPulls,
  runGh,
  toChatPr,
  toPullSummary,
  type PullSummary,
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

  it("degrades to no data when gh is missing, without trying the second listing", async () => {
    remoteUrl.mockResolvedValue("https://github.com/acme/app");
    ghServes({ open: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
    expect(await fetchRepoPulls("/r")).toEqual({
      byBranch: new Map(),
      byNumber: new Map(),
      github: { owner: "acme", repo: "app" },
      error: "gh is not installed",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
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

/** Settle every queued microtask and zero-delay timer. */
const flush = () => new Promise((r) => setTimeout(r, 0));

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
    let release!: () => void;
    execFileMock.mockImplementation((_c: string, args: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      const body = args[1].includes("state=open") ? [rawPull(2, "feat/new")] : [];
      release = () => cb(null, JSON.stringify(body), "");
      return { stdin: { end() {} } };
    });
    const stale = await getRepoPulls("/r", false, PR_CACHE_TTL_MS);
    expect(stale).toBe(first);
    // A second poll during the refresh shares it rather than spawning again.
    expect(await getRepoPulls("/r", false, PR_CACHE_TTL_MS + 1)).toBe(first);
    await flush();
    expect(execFileMock).toHaveBeenCalledTimes(3);

    release(); // open listing
    await flush();
    release(); // closed listing
    await flush();
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
    ghServes({ open: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
    await getRepoPulls("/r", false, 0);
    await getRepoPulls("/r", false, 5000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
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

  it("runs at most two gh processes at once", async () => {
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
    const all = Promise.all(["/a", "/b", "/c", "/d", "/e"].map((repo) => getRepoPulls(repo, false, 0)));
    // Drain: release whatever is running until every repo's two listings ran.
    // Several ticks between releases, so every fetch the limiter would admit
    // has had time to reach gh before one finishes.
    for (let released = 0; released < 10; ) {
      for (let i = 0; i < 5; i++) await flush();
      expect(inFlight).toBeLessThanOrEqual(2);
      const next = callbacks.shift();
      if (next) {
        next();
        released++;
      }
    }
    await all;
    expect(execFileMock).toHaveBeenCalledTimes(10);
    expect(peak).toBe(2);
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
  const pulls = (list: PullSummary[]) => ({ github: { owner: "acme", repo: "app" }, defaultBranch: "main", byBranch: indexPullsByBranch(list, "acme", "main") });
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
    expect(recordedPullForBranch([september, january, pr({ number: 12, headRef: "feat/x", updatedAt: "2025-01-01T00:00:00Z" })], "feat/x", here)?.number).toBe(12);
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
    ghAnswers({ error: exit1(), stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }) });
    await expect(fetchPullsByNumber({ owner: "acme", repo: "nope" }, [1], "/")).rejects.toThrow("Could not resolve to a Repository");
    // A 401 prints its JSON body on stdout: the reason is there, not "Unexpected response".
    ghAnswers({ error: exit1(), stdout: JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }), stderr: "gh: Bad credentials (HTTP 401)" });
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
    expect(await resolveLinkedPulls([link(2, "acme/lib")], [], { cwd: "/" }, { fetch, now: () => 0 })).toEqual({ pulls: [expect.objectContaining({ number: 2 })] });
  });

  it("keeps the last good answer beside the error when a later ask fails", async () => {
    const fetch = vi.fn<Fetch>(async (_ref, numbers) => new Map(numbers.map((n) => [n, open(n)])));
    await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => 0 });
    fetch.mockRejectedValueOnce(new Error("gh timed out"));
    const { pulls, error } = await resolveLinkedPulls([link(20)], [], { cwd: "/" }, { fetch, now: () => PR_CACHE_TTL_MS });
    expect(pulls.map((p) => [p?.number, p?.state])).toEqual([[20, "open"]]);
    expect(error).toBe("gh timed out");
  });

  it("serves unknown once the wait cap passes, and the fetch lands for the next poll", async () => {
    let answer!: () => void;
    const fetch = vi.fn<Fetch>(
      (_ref, numbers) => new Promise((resolvePromise) => (answer = () => resolvePromise(new Map(numbers.map((n) => [n, open(n)]))))),
    );
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
    const fetch = vi.fn<Fetch>(async (_ref, numbers) => new Map(numbers.map((n) => [n, n === 71 ? { error: "Something went wrong" } : n === 72 ? null : open(n)])));
    const { pulls, error } = await resolveLinkedPulls([link(70), link(71), link(72)], [], { cwd: "/" }, { fetch, now: () => 0 });
    expect(pulls.map((p) => [p?.number, p?.state])).toEqual([[70, "open"], [71, "unknown"], [undefined, undefined]]);
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
