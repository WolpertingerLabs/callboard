/**
 * The ignore list matches at a path boundary — in all three places it matches.
 *
 * ## What it was
 *
 * `isIgnoredProjectDir` was a bare `startsWith`, so an entry for `/home/scratch`
 * (`-home-scratch`) also hid `/home/scratchpad-repo` (`-home-scratchpad-repo`).
 * The user never named that folder and could not un-hide it without deleting
 * the entry hiding the one they did name. While the list only fed chat
 * *listings* the folder was still reachable through search; since #366 made
 * search honour the same list, an over-matched folder has no in-app route at
 * all.
 *
 * ## Why the fixture is a real `find`
 *
 * The list has three matchers, not one, and they used to disagree:
 *
 *  1. `isIgnoredProjectDir` — encoded project-dir names (Claude discovery's JS
 *     re-filter, `listClaudeProjectDirs`, `chat-search.discoverProjectDirs`);
 *  2. `isIgnoredProjectFolder` — raw `cwd` paths, which Codex, ACP, Cline and
 *     Pi hand it; it encodes first, so it lands on (1);
 *  3. `find -path <dir>/<prefix>*` — the prune in
 *     `ClaudeCodeSessionProvider._discoverPaginated`, evaluated by `find`
 *     rather than by any of this code.
 *
 * A prune that hides more than the JS filter is its own bug, so the third gets
 * two tests, and they guard different things:
 *
 *  - "the find prune agrees with the JS filter" runs a real `find` over the
 *    fixture with globs from `ignoredPrefixGlobs`. It pins the *translation* —
 *    that those globs mean to `find` what `matchesIgnoredPrefix` means in JS.
 *    It builds its own argv, so it says nothing about the provider.
 *  - "discovery uses the boundary-aware prune" drives the real
 *    `ClaudeCodeSessionProvider.discoverSessions`. It pins the *call site* —
 *    that `_discoverPaginated` actually reaches for `ignoredPrefixGlobs`
 *    instead of inlining a `prefix*` of its own.
 *
 * The second exists because the first passed while the provider still inlined
 * the old glob: guarding the helper and leaving the one call site that has to
 * use it unguarded is the drift this file is about, one level up. And the
 * failure it admits is unrecoverable — `find` prunes before the JS re-filter in
 * `_discoverPaginated` ever runs, and that filter can only remove, never
 * restore, so an over-broad prune silently drops the folder from the Claude
 * listing while `chat-search` (JS-only) still returns it.
 *
 * Asserting on the glob *strings* instead would pass for any pair of
 * implementations that were wrong in the same way.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Discovery resolves every dir it keeps to a main repo, which shells out to
// git once per distinct folder. None of the fixture dirs are repos.
vi.mock("./git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder, isWorktree: false }),
}));

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-ignore-boundary-"));
// `paths.js` reads both at module load: CLAUDE_PROJECTS_DIR from homedir(),
// which honours $HOME on POSIX, and the config file from CALLBOARD_DATA_DIR.
process.env.HOME = tmpRoot;
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const projectsDir = join(tmpRoot, ".claude", "projects");
mkdirSync(projectsDir, { recursive: true });

/**
 * Every case, as the encoded dir name plus the folder it encodes.
 *
 * `ignored` is the expectation under the two configured entries below —
 * `-home-scratch` (no trailing separator) and `-private-` (with one).
 */
const CASES: { dir: string; folder: string; ignored: boolean; why: string }[] = [
  { dir: "-home-scratch", folder: "/home/scratch", ignored: true, why: "the entry itself" },
  { dir: "-home-scratch-notes", folder: "/home/scratch/notes", ignored: true, why: "a proper child" },
  { dir: "-home-scratch-a-b-c", folder: "/home/scratch/a/b/c", ignored: true, why: "a deeper descendant" },
  { dir: "-home-scratchpad-repo", folder: "/home/scratchpad-repo", ignored: false, why: "shares leading characters only — the bug" },
  { dir: "-home-scratchy", folder: "/home/scratchy", ignored: false, why: "one extra character, same parent" },
  { dir: "-home-scratc", folder: "/home/scratc", ignored: false, why: "shorter than the entry" },
  { dir: "-home-other", folder: "/home/other", ignored: false, why: "unrelated" },
  { dir: "-private-", folder: "/private/", ignored: true, why: "trailing-separator entry, exactly" },
  { dir: "-private-tmp-x", folder: "/private/tmp/x", ignored: true, why: "under a trailing-separator entry" },
  { dir: "-privateer", folder: "/privateer", ignored: false, why: "the trailing separator is what stops this" },
];

const PREFIXES = ["-home-scratch", "-private-"];

// One transcript per dir, named after the dir, so a discovered session id
// identifies the project dir it came from.
for (const { dir } of CASES) {
  mkdirSync(join(projectsDir, dir), { recursive: true });
  writeFileSync(join(projectsDir, dir, `${dir}.jsonl`), "{}\n");
}
writeFileSync(join(tmpRoot, "ignored-project-dirs.json"), JSON.stringify({ prefixes: PREFIXES }));

const { CLAUDE_PROJECTS_DIR, getIgnoredProjectDirPrefixes, ignoredPrefixGlobs, isIgnoredProjectDir, isIgnoredProjectFolder, listClaudeProjectDirs } =
  await import("./paths.js");
const { ClaudeCodeSessionProvider } = await import("../agents/adapters/claude-code/ClaudeCodeSessionProvider.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("the fixture is live", () => {
  it("loaded the configured entries rather than the built-in defaults", () => {
    // Every "not ignored" assertion below would pass vacuously against an
    // empty or defaulted list.
    expect(getIgnoredProjectDirPrefixes()).toEqual(PREFIXES);
    expect(CLAUDE_PROJECTS_DIR).toBe(projectsDir);
  });
});

describe("isIgnoredProjectDir — encoded project-dir names", () => {
  it.each(CASES)("$dir → $ignored ($why)", ({ dir, ignored }) => {
    expect(isIgnoredProjectDir(dir)).toBe(ignored);
  });
});

describe("isIgnoredProjectFolder — raw cwd paths", () => {
  it.each(CASES)("$folder → $ignored ($why)", ({ folder, ignored }) => {
    expect(isIgnoredProjectFolder(folder)).toBe(ignored);
  });

  // The acknowledged imprecision of matching in encoded space, pinned so it
  // reads as a decision rather than an oversight. The encoding maps every
  // non-alphanumeric character to `-`, so none of these siblings of
  // `/home/scratch` can be told apart from a child of it — they all encode to
  // `-home-scratch-…`. It is not one edge case about dots; it is every
  // separator the encoding collapses.
  it.each(["/home/scratch.bak", "/home/scratch-pad", "/home/scratch_pad", "/home/scratch pad"])(
    "ignores %s, which encodes the same as a child of /home/scratch",
    (folder) => {
      expect(isIgnoredProjectFolder(folder)).toBe(true);
    },
  );

  it("returns false for empty input", () => {
    expect(isIgnoredProjectFolder("")).toBe(false);
  });
});

describe("listClaudeProjectDirs", () => {
  it("keeps exactly the dirs the matcher does not ignore", () => {
    expect(listClaudeProjectDirs().sort()).toEqual(
      CASES.filter((c) => !c.ignored)
        .map((c) => c.dir)
        .sort(),
    );
  });
});

describe("the find prune agrees with the JS filter", () => {
  /**
   * `find` driven with `ignoredPrefixGlobs`, over the fixture tree.
   *
   * This argv is built here rather than taken from the provider, so this suite
   * pins the glob *translation* only — whether `_discoverPaginated` uses these
   * globs is a separate question, asked by "discovery uses the boundary-aware
   * prune" below.
   */
  function dirsSurvivingFind(): string[] {
    const pruneArgs = getIgnoredProjectDirPrefixes().flatMap((d) =>
      ignoredPrefixGlobs(d).flatMap((glob) => ["-path", `${CLAUDE_PROJECTS_DIR}/${glob}`, "-prune", "-o"]),
    );
    const output = execFileSync("find", [CLAUDE_PROJECTS_DIR, ...pruneArgs, "-maxdepth", "2", "-name", "*.jsonl", "-type", "f", "-print0"], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\0")
      .filter((p) => p.endsWith(".jsonl"))
      .map((p) => p.split("/").slice(0, -1).pop()!)
      .sort();
  }

  it("prunes neither more nor less than isIgnoredProjectDir", () => {
    // Against the live JS matcher, not against the CASES table — a comparison
    // with the table would stay green while `find` and the JS filter drifted
    // apart, which is the only thing this test exists to catch. The table is
    // the separate anchor below, so mutating *either* implementation alone
    // fails one of the two.
    const keptByJs = CASES.filter((c) => !isIgnoredProjectDir(c.dir))
      .map((c) => c.dir)
      .sort();
    expect(dirsSurvivingFind()).toEqual(keptByJs);
  });

  it("and both of them agree with the hand-written expectations", () => {
    const expected = CASES.filter((c) => !c.ignored)
      .map((c) => c.dir)
      .sort();
    expect(dirsSurvivingFind()).toEqual(expected);
  });

  it("does not prune a sibling that merely shares leading characters", () => {
    // The specific disagreement `-path .../-home-scratch*` had: it pruned this
    // directory, while the JS re-filter behind it would have kept it. Called
    // out on its own because the equality above would still hold if both sides
    // regressed together.
    expect(dirsSurvivingFind()).toContain("-home-scratchpad-repo");
  });
});

describe("discovery uses the boundary-aware prune", () => {
  /**
   * Session ids `GET /api/chats` would get, through the real provider.
   *
   * Nothing above this describe touches `_discoverPaginated`, so nothing above
   * it notices if that method stops calling `ignoredPrefixGlobs` and inlines a
   * `prefix*` again — the local-argv test would keep passing on the helper it
   * still exercises. This is the assertion that fires.
   */
  function discoveredDirs(): { dirs: string[]; usedFallback: boolean } {
    const provider = new ClaudeCodeSessionProvider();
    // `discoverSessions` swallows a throw from the `find` path and retries with
    // a readdir walk that uses the JS matcher directly. That walk is correctly
    // boundary-aware, so it would satisfy every assertion below while proving
    // nothing at all about the prune — hence the spy.
    const fallback = vi.spyOn(provider as unknown as { _discoverFallback: () => unknown }, "_discoverFallback");
    const { sessions } = provider.discoverSessions({ limit: 100, offset: 0 });
    return { dirs: sessions.map((s) => s.sessionId).sort(), usedFallback: fallback.mock.calls.length > 0 };
  }

  it("discovers a sibling that merely shares leading characters", () => {
    // The unrecoverable direction. `-path .../-home-scratch*` prunes this dir
    // before the JS re-filter sees it, and that filter can only remove.
    const { dirs, usedFallback } = discoveredDirs();
    expect(usedFallback, "the find path threw; these assertions prove nothing").toBe(false);
    expect(dirs).toContain("-home-scratchpad-repo");
  });

  it("still does not discover a real path-child of an ignored dir", () => {
    // The other direction, so the test above cannot be satisfied by a prune
    // that simply stopped working.
    const { dirs } = discoveredDirs();
    expect(dirs).not.toContain("-home-scratch-notes");
    expect(dirs).not.toContain("-home-scratch");
    expect(dirs).not.toContain("-private-tmp-x");
  });

  it("discovers exactly the dirs the matcher keeps", () => {
    const { dirs } = discoveredDirs();
    expect(dirs).toEqual(
      CASES.filter((c) => !isIgnoredProjectDir(c.dir))
        .map((c) => c.dir)
        .sort(),
    );
  });
});

describe("the built-in defaults", () => {
  // `-tmp` is load-bearing on developer machines and in several suites, and
  // `-private-` only works at all because a trailing separator is honoured.
  it.each([
    ["-tmp", "-tmp", true],
    ["-tmp", "-tmp-callboard-plugin-load-x-cwd", true],
    ["-tmp", "-tmpish", false],
    ["-private-", "-private-", true],
    ["-private-", "-private-tmp-x", true],
    ["-private-", "-privateer", false],
  ] as const)("%s vs %s → %s", async (prefix, dir, expected) => {
    const { matchesIgnoredPrefix } = await import("./paths.js");
    expect(matchesIgnoredPrefix(dir, prefix)).toBe(expected);
  });
});
