/**
 * The publish workflow's decisions. The cases that matter most are the re-runs
 * after a partial failure (drawlatch published but callboard not; both
 * published but not tagged): a re-run of the same commit must finish the
 * release, never publish twice, and never fail a run that is otherwise fine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareSemver, distTagError, distTagsOf, isSemverRange, planRelease, publishedVersions, releaseTag, repoGit } from "./release-plan.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OTHER = "c".repeat(40);
const OLDER = "d".repeat(40);
const V = "1.0.0-alpha.69";

function plan({ dryRun = false, distTag = "latest", versionErrors = [], drawlatch = {}, callboard = {}, tagCommit = null, ancestors = [OLD, OLDER] } = {}) {
  return planRelease({
    dryRun,
    head: HEAD,
    distTag,
    version: V,
    versionErrors,
    drawlatch: { published: false, gitHead: null, ...drawlatch },
    callboard: { published: false, gitHead: null, ...callboard },
    tagCommit,
    git: { isPublishBase: (sha) => sha === HEAD || ancestors.includes(sha) },
  });
}
const both = (action) => ({ drawlatch: { action }, callboard: { action } });
const at = (gitHead) => ({ published: true, gitHead });

describe("planRelease", () => {
  it("first release: publishes both from HEAD and tags HEAD v<version>", () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p).toMatchObject({ ...both("publish"), tag: { name: "v1.0.0-alpha.69", commit: HEAD } });
  });

  it("a dry run plans the same actions (the workflow adds --dry-run and skips tagging)", () => {
    const p = plan({ dryRun: true });
    expect(p.errors).toEqual([]);
    expect(p).toMatchObject({ ...both("publish"), tag: { commit: HEAD } });
  });

  it("passes version drift through as errors, which stop the run", () => {
    const p = plan({
      versionErrors: ['packages/drawlatch/package.json "version" is "1.0.0-alpha.70", but the root version is "1.0.0-alpha.69". Run `npm run version:sync`.'],
    });
    expect(p.errors).toEqual([expect.stringMatching(/^packages\/drawlatch\/package.json "version"/)]);
  });

  describe("neither published", () => {
    it("publishes both without re-tagging when v<version> already points at HEAD", () => {
      const p = plan({ tagCommit: HEAD });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ ...both("publish"), tag: { commit: null } });
    });

    it("fails on a stray tag at another commit", () => {
      const p = plan({ tagCommit: OTHER });
      expect(p.errors).toEqual([expect.stringMatching(/^Tag v1\.0\.0-alpha\.69 already exists at c{40}, but 1\.0\.0-alpha\.69 is not on npm/)]);
    });
  });

  describe("re-run of the same commit (base is HEAD)", () => {
    it("drawlatch published, callboard not: skips drawlatch, publishes callboard, tags HEAD", () => {
      const p = plan({ drawlatch: at(HEAD) });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ drawlatch: { action: "skip" }, callboard: { action: "publish" }, tag: { commit: HEAD } });
    });

    it("both published, no tag: publishes nothing, tags HEAD, with a warning", () => {
      const p = plan({ drawlatch: at(HEAD), callboard: at(HEAD) });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ ...both("skip"), tag: { commit: HEAD } });
      expect(p.warnings).toEqual([expect.stringMatching(/already published from this commit\. Only tagging it v1\.0\.0-alpha\.69/)]);
    });

    it("both published and tagged at HEAD: a no-op, not a failure", () => {
      const p = plan({ drawlatch: at(HEAD), callboard: at(HEAD), tagCommit: HEAD });
      expect(p.errors).toEqual([]);
      expect(p.warnings).toEqual([]);
      expect(p).toMatchObject({ ...both("skip"), tag: { commit: null } });
    });

    it("callboard published, drawlatch not (impossible through the workflow): publishes drawlatch, with a warning", () => {
      const p = plan({ callboard: at(HEAD) });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ drawlatch: { action: "publish" }, callboard: { action: "skip" }, tag: { commit: HEAD } });
      expect(p.warnings).toEqual([expect.stringMatching(/couldn't be installed until now/)]);
    });

    it("trusts the tag when npm recorded no gitHead", () => {
      const p = plan({ drawlatch: at(null), tagCommit: HEAD });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ drawlatch: { action: "skip" }, callboard: { action: "publish" }, tag: { commit: null } });
    });
  });

  describe("released from an older commit (base is not HEAD)", () => {
    it("both published, untagged: tags the base, publishes nothing, warns", () => {
      const p = plan({ drawlatch: at(OLD), callboard: at(OLD) });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ ...both("skip"), tag: { commit: OLD } });
      expect(p.warnings).toEqual([expect.stringMatching(/already released from b{40}; tagging it.*bump the version/)]);
    });

    it("both published and tagged: a real run fails, a dry run warns and only packs", () => {
      const real = plan({ drawlatch: at(OLD), callboard: at(OLD), tagCommit: OLD });
      expect(real.errors).toEqual([expect.stringMatching(/already on npm \(released from b{40}\)\. Bump the version/)]);
      expect(real).toMatchObject({ ...both("skip"), tag: { commit: null } });
      const dry = plan({ dryRun: true, drawlatch: at(OLD), callboard: at(OLD), tagCommit: OLD });
      expect(dry.errors).toEqual([]);
      expect(dry).toMatchObject({ ...both("pack"), tag: { commit: null } });
      expect(dry.warnings).toEqual([expect.stringMatching(/Bump the version\. This dry run only packs; a real run would fail/)]);
    });

    it("only drawlatch published (a partial release, and main moved on): a real run fails with the remedy, a dry run packs", () => {
      const real = plan({ drawlatch: at(OLD) });
      expect(real.errors).toEqual([
        expect.stringMatching(
          /partly released from b{40} \(@wolpertingerlabs\/drawlatch is on npm, @wolpertingerlabs\/callboard is not\).*Re-run failed jobs.*Re-run all jobs.*or bump the version/,
        ),
      ]);
      expect(real).toMatchObject({ ...both("skip"), tag: { commit: null } });
      const dry = plan({ dryRun: true, drawlatch: at(OLD) });
      expect(dry.errors).toEqual([]);
      expect(dry).toMatchObject(both("pack"));
      expect(dry.warnings).toEqual([expect.stringMatching(/partly released/)]);
    });
  });

  describe("only callboard on npm, from an older commit (the reverse partial release)", () => {
    it("a real run fails, naming the packages the right way round, with the remedy", () => {
      const p = plan({ callboard: at(OLD) });
      expect(p.errors).toEqual([
        expect.stringMatching(
          /partly released from b{40} \(@wolpertingerlabs\/callboard is on npm, @wolpertingerlabs\/drawlatch is not\), and main is now at a{40}\..*within 30 days.*or bump the version/,
        ),
      ]);
      expect(p).toMatchObject({ ...both("skip"), tag: { commit: null } });
    });

    it("a dry run warns and only packs both", () => {
      const p = plan({ dryRun: true, callboard: at(OLD) });
      expect(p.errors).toEqual([]);
      expect(p).toMatchObject({ ...both("pack"), tag: { commit: null } });
      expect(p.warnings).toEqual([
        expect.stringMatching(/@wolpertingerlabs\/callboard is on npm, @wolpertingerlabs\/drawlatch is not.*This dry run only packs/),
      ]);
    });
  });

  describe("disagreements", () => {
    it("fails when v<version> and the commit npm recorded disagree, in a dry run too", () => {
      for (const dryRun of [false, true]) {
        const p = plan({ dryRun, drawlatch: at(OLDER), callboard: at(OLDER), tagCommit: OLD });
        expect(p.errors).toEqual([expect.stringMatching(/published from d{40}, but v1\.0\.0-alpha\.69 points at b{40}/)]);
        expect(p).toMatchObject({ ...both("skip"), tag: { commit: null } });
      }
    });

    it("published from this commit but tagged elsewhere is a conflict", () => {
      expect(plan({ callboard: at(HEAD), drawlatch: at(HEAD), tagCommit: OTHER }).errors).toEqual([expect.stringMatching(/points at c{40}/)]);
    });

    it("fails when the two packages were published from different commits", () => {
      const p = plan({ drawlatch: at(OLD), callboard: at(OLDER) });
      expect(p.errors).toEqual([
        expect.stringMatching(
          /drawlatch@1\.0\.0-alpha\.69 was published from b{40} and @wolpertingerlabs\/callboard@1\.0\.0-alpha\.69 from d{40}\. Bump the version/,
        ),
      ]);
      expect(p).toMatchObject(both("skip"));
    });

    it.each([
      ["drawlatch", { drawlatch: at(OTHER) }, /^@wolpertingerlabs\/drawlatch@.* published from c{40}.*published outside this workflow/],
      ["callboard", { callboard: at(OTHER), drawlatch: at(HEAD) }, /^@wolpertingerlabs\/callboard@.* published from c{40}.*published outside this workflow/],
      ["drawlatch, with no gitHead and no tag", { drawlatch: at(null) }, /published from no commit/],
    ])("fails when %s was published from outside this workflow", (_, packages, pattern) => {
      const p = plan(packages);
      expect(p.errors).toEqual([expect.stringMatching(pattern)]);
      expect(p).toMatchObject({ ...both("skip"), tag: { commit: null } });
    });

    it("a gitHead that isn't a monorepo commit fails even when a tag exists (a standalone-repo publish)", () => {
      expect(plan({ drawlatch: at(OTHER), tagCommit: OLD }).errors).toEqual([expect.stringMatching(/published outside this workflow/)]);
    });

    it("trusts the tag for a package npm recorded no gitHead for", () => {
      const p = plan({ drawlatch: at(null), callboard: at(OLD) });
      expect(p.errors).toEqual([expect.stringMatching(/published from no commit/)]);
      const tagged = plan({ drawlatch: at(null), callboard: at(OLD), tagCommit: OLD });
      expect(tagged.errors).toEqual([expect.stringMatching(/already on npm \(released from b{40}\)/)]);
    });
  });

  describe("dist-tag", () => {
    it.each(["", "  ", "1.2.3", "^1.0.0", "v1", "1.x", "*", ">=1 <2", "1 || 2", "next tag"])("rejects dist_tag %j", (distTag) => {
      const p = plan({ distTag });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/^dist_tag /);
    });

    it.each(["latest", "next", "beta", "hotfix-1", "alpha.1"])("accepts dist_tag %j", (distTag) => {
      expect(plan({ distTag }).errors).toEqual([]);
    });

    it("refuses to move the dist-tag backwards, per package", () => {
      const p = plan({ drawlatch: { distTags: { latest: "1.0.0-alpha.70" } }, callboard: { distTags: { latest: "1.0.0" } } });
      expect(p.errors).toHaveLength(2);
      expect(p.errors[0]).toMatch(/drawlatch@1\.0\.0-alpha\.69 is lower than 1\.0\.0-alpha\.70, which the "latest" dist-tag/);
      expect(p.errors[1]).toMatch(/callboard@1\.0\.0-alpha\.69 is lower than 1\.0\.0/);
    });

    it("allows the first one-version release: drawlatch latest alpha.68 and callboard latest alpha.66", () => {
      expect(plan({ drawlatch: { distTags: { latest: "1.0.0-alpha.68" } }, callboard: { distTags: { latest: "1.0.0-alpha.66" } } }).errors).toEqual([]);
    });

    it("allows a different dist-tag, or one that doesn't exist yet", () => {
      expect(plan({ distTag: "hotfix", drawlatch: { distTags: { latest: "2.0.0" } } }).errors).toEqual([]);
      expect(plan({ drawlatch: { distTags: {} } }).errors).toEqual([]);
    });

    it("only checks packages it is about to publish", () => {
      const p = plan({ drawlatch: { ...at(HEAD), distTags: { latest: "9.0.0" } } });
      expect(p.errors).toEqual([]);
    });
  });

  it("releaseTag is v<version>", () => {
    expect(releaseTag(V)).toBe("v1.0.0-alpha.69");
  });
});

// The I/O layer against a real repository: which commits can be a publish
// base, and tag lookup.
describe("repoGit", () => {
  let repo;
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const write = (rel, text = "x\n") => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  const commit = (msg) => {
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };

  let standalone, monorepoBase, sideBranch;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "release-plan-test-"));
    git("init", "-q", "-b", "main");
    // A standalone-drawlatch-like commit: package.json at the root, no
    // packages/drawlatch. In callboard such commits are reachable through the
    // subtree import merge.
    write("package.json", "{}\n");
    standalone = commit("standalone drawlatch");
    write("packages/drawlatch/package.json", "{}\n");
    monorepoBase = commit("monorepo base");
    git("checkout", "-q", "-b", "side");
    write("side.txt");
    sideBranch = commit("side");
    git("checkout", "-q", "main");
    write("README.md");
    commit("main moves on");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  describe("isPublishBase", () => {
    it("accepts HEAD and its monorepo ancestors", () => {
      const g = repoGit(repo);
      expect(g.isPublishBase(git("rev-parse", "HEAD"))).toBe(true);
      expect(g.isPublishBase(monorepoBase)).toBe(true);
    });

    it("rejects an ancestor without packages/drawlatch/package.json (a standalone-repo commit)", () => {
      expect(repoGit(repo).isPublishBase(standalone)).toBe(false);
    });

    it("rejects a commit that isn't an ancestor of HEAD, and one that doesn't exist", () => {
      expect(repoGit(repo).isPublishBase(sideBranch)).toBe(false);
      expect(repoGit(repo).isPublishBase("f".repeat(40))).toBe(false);
    });
  });

  it("tagCommit peels an annotated tag to its commit, and is null for a missing tag", () => {
    git("tag", "-a", "v9.9.9", "-m", "t", monorepoBase);
    expect(repoGit(repo).tagCommit("v9.9.9")).toBe(monorepoBase);
    expect(repoGit(repo).tagCommit("v0.0.0")).toBe(null);
  });
});

describe("registry lookups", () => {
  const fail = (stderr) => () => {
    throw Object.assign(new Error("Command failed"), { stderr, stdout: "" });
  };
  const E404 = "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@x%2fy - Not found\n";

  it("reads a version list, and a lone version that npm prints as a string", () => {
    expect(publishedVersions("p", () => '["1.0.0","1.0.1"]')).toEqual(["1.0.0", "1.0.1"]);
    expect(publishedVersions("p", () => '"1.0.0"')).toEqual(["1.0.0"]);
  });

  it("treats E404 (the package doesn't exist yet) as nothing published", () => {
    expect(publishedVersions("p", fail(E404))).toEqual([]);
    expect(distTagsOf("p", fail(E404))).toEqual({});
  });

  it("throws on any other registry error instead of reporting 'unpublished'", () => {
    const etimedout = "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/p failed\n";
    expect(() => publishedVersions("p", fail(etimedout))).toThrow(/ETIMEDOUT/);
    expect(() => distTagsOf("p", fail("npm error code E401\n"))).toThrow(/E401/);
  });

  it("reads dist-tags", () => {
    expect(distTagsOf("p", () => '{"latest":"1.0.0-alpha.68"}')).toEqual({ latest: "1.0.0-alpha.68" });
  });
});

describe("compareSemver", () => {
  it.each([
    ["1.0.0-alpha.9", "1.0.0-alpha.10"],
    ["1.0.0-alpha.68", "1.0.0-alpha.69"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.99", "1.0.0-beta.2"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0", "1.0.1"],
    ["1.9.0", "1.10.0"],
    ["1.0.0", "2.0.0-alpha.1"],
  ])("%s < %s", (a, b) => {
    expect(compareSemver(a, b)).toBeLessThan(0);
    expect(compareSemver(b, a)).toBeGreaterThan(0);
  });

  it("ignores build metadata and rejects garbage", () => {
    expect(compareSemver("1.0.0+abc", "1.0.0")).toBe(0);
    expect(compareSemver("v1.0.0-alpha.70", "1.0.0-alpha.69")).toBeGreaterThan(0); // a leading v still compares
    expect(() => compareSemver("latest", "1.0.0")).toThrow(/not a semver/);
  });
});

describe("isSemverRange / distTagError", () => {
  // Cross-checked against npm's bundled node-semver (validRange !== null).
  it.each([
    "1.2.3",
    "^1.0.0",
    "~1.2",
    "v1",
    "x",
    "*",
    "1.x",
    "1.2.x",
    "1 - 2",
    ">=1 <2",
    "1 || 2",
    ">= 1.2.3",
    "=1.0.0",
    "1.0.0-alpha.1",
    "",
    "0",
    "1.0.0-rc.1+build",
  ])("%j is a range", (r) => expect(isSemverRange(r)).toBe(true));

  it.each(["latest", "next", "beta", "hotfix", "hotfix-1", "alpha.1", "v-next", "1.2.3.4", "latest2", "x1"])("%j is not a range", (r) => {
    expect(isSemverRange(r)).toBe(false);
  });

  it("explains each rejection", () => {
    expect(distTagError("latest")).toBe(null);
    expect(distTagError("")).toMatch(/empty/);
    expect(distTagError(undefined)).toMatch(/empty/);
    expect(distTagError(" next")).toMatch(/whitespace/);
    expect(distTagError("1.x")).toMatch(/valid semver range/);
  });
});
