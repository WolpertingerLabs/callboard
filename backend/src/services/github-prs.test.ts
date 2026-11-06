import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const remoteUrl = vi.fn<(dir: string) => Promise<string | null>>();
vi.mock("../utils/git.js", () => ({ getRemoteUrlAsync: (dir: string) => remoteUrl(dir) }));

import {
  clearRepoPullsCache,
  fetchRepoPulls,
  getRepoPulls,
  indexPullsByBranch,
  matchPull,
  parseGitHubRemote,
  PR_CACHE_TTL_MS,
  PR_FORCE_WAIT_MS,
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
      ["gh", "api", "repos/acme/app/pulls?state=open&per_page=100"],
      ["gh", "api", "repos/acme/app/pulls?state=closed&sort=updated&direction=desc&per_page=50"],
    ]);
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
    expect(await fetchRepoPulls("/r")).toEqual({ byBranch: new Map(), error: "gh is not installed" });
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
