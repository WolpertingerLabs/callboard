/**
 * The publish workflow's decisions. The cases that matter most are the re-runs
 * after a partial failure (drawlatch published but callboard not; callboard
 * published but not tagged): a re-run must finish the release, never publish
 * twice, and never fail a run that is otherwise fine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareSemver, distTagError, distTagsOf, isSemverRange, planRelease, publishedVersions, repoGit } from "./release-plan.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OTHER = "c".repeat(40);
const V = "1.0.0-alpha.69";
const CB = "1.0.0-alpha.67";

function plan({ dryRun = false, distTag = "latest", pins, drawlatch = {}, callboard = {}, ancestors = [OLD], drift = [] } = {}) {
  const driftCalls = [];
  const result = planRelease({
    dryRun,
    head: HEAD,
    distTag,
    pins: pins ?? { "package.json": V, "backend/package.json": V },
    drawlatch: { version: V, published: false, tagCommit: null, gitHead: null, ...drawlatch },
    callboard: { version: CB, published: false, tagCommit: null, gitHead: null, ...callboard },
    git: {
      isPublishBase: (sha) => sha === HEAD || ancestors.includes(sha),
      driftFiles: (sha) => {
        driftCalls.push(sha);
        return drift;
      },
    },
  });
  return { ...result, driftCalls };
}

describe("planRelease", () => {
  it("first release: publishes and tags both from HEAD", () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.drawlatch).toMatchObject({ action: "publish", tagCommit: HEAD });
    expect(p.callboard).toEqual({ action: "publish", tagCommit: HEAD });
    expect(p.driftCalls).toEqual([]);
  });

  it("a dry run plans the same actions (the workflow adds --dry-run and skips tagging)", () => {
    const p = plan({ dryRun: true });
    expect(p.errors).toEqual([]);
    expect(p.drawlatch.action).toBe("publish");
    expect(p.callboard.action).toBe("publish");
  });

  describe("lockstep", () => {
    it("fails when a pin is a range", () => {
      const p = plan({ pins: { "package.json": `^${V}`, "backend/package.json": V } });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/package\.json pins .* to "\^1\.0\.0-alpha\.69"/);
    });

    it("fails when the backend pin is missing", () => {
      const p = plan({ pins: { "package.json": V, "backend/package.json": undefined } });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/^backend\/package\.json pins/);
    });
  });

  describe("drawlatch already published (callboard-only release)", () => {
    it("skips drawlatch when nothing that ships changed since its tag", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: OLD, gitHead: OLD } });
      expect(p.errors).toEqual([]);
      expect(p.drawlatch).toEqual({ action: "skip", tagCommit: null, driftBase: OLD });
      expect(p.driftCalls).toEqual([OLD]);
      expect(p.callboard.action).toBe("publish");
    });

    it("fails with 'bump drawlatch' when shipping files changed since its tag", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: OLD }, drift: ["packages/drawlatch/src/remote/server.ts"] });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/Bump drawlatch/);
      expect(p.errors[0]).toMatch(/src\/remote\/server\.ts/);
    });

    it("fails on drift in a dry run too: that is what the rehearsal is for", () => {
      const p = plan({ dryRun: true, drawlatch: { published: true, tagCommit: OLD }, drift: ["packages/drawlatch/package.json"] });
      expect(p.errors).toHaveLength(1);
    });

    it("truncates a long list of changed files", () => {
      const drift = Array.from({ length: 25 }, (_, i) => `packages/drawlatch/src/f${i}.ts`);
      const p = plan({ drawlatch: { published: true, tagCommit: OLD }, drift });
      expect(p.errors[0]).toMatch(/and 5 more$/);
    });

    it("re-run after drawlatch published but its tag push failed: tags the commit npm recorded", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: null, gitHead: OLD } });
      expect(p.errors).toEqual([]);
      expect(p.drawlatch).toEqual({ action: "skip", tagCommit: OLD, driftBase: OLD });
      expect(p.warnings.join("\n")).toMatch(/drawlatch-v1\.0\.0-alpha\.69 is missing/);
    });

    it("fails when it was published from outside this branch (no tag, gitHead not a monorepo ancestor)", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: null, gitHead: OTHER } });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/published from outside this workflow .*Bump drawlatch/);
      expect(p.driftCalls).toEqual([]);
    });

    it("fails when it was published with no gitHead and no tag", () => {
      expect(plan({ drawlatch: { published: true } }).errors).toHaveLength(1);
    });

    it("fails when the tag and the commit npm recorded disagree", () => {
      const OLDER = "d".repeat(40);
      const p = plan({ drawlatch: { published: true, tagCommit: OLD, gitHead: OLDER }, ancestors: [OLD, OLDER] });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/published from d{40}, but drawlatch-v1\.0\.0-alpha\.69 points at b{40}/);
      expect(p.driftCalls).toEqual([]);
    });

    it("trusts the tag when npm's gitHead isn't a monorepo commit (or is missing)", () => {
      for (const gitHead of [OTHER, null]) {
        const p = plan({ drawlatch: { published: true, tagCommit: OLD, gitHead } });
        expect(p.errors).toEqual([]);
        expect(p.driftCalls).toEqual([OLD]);
      }
    });
  });

  describe("drawlatch not published", () => {
    it("publishes without re-tagging when its tag already points at HEAD", () => {
      const p = plan({ drawlatch: { tagCommit: HEAD } });
      expect(p.errors).toEqual([]);
      expect(p.drawlatch).toMatchObject({ action: "publish", tagCommit: null });
    });

    it("fails on a stray tag at another commit", () => {
      const p = plan({ drawlatch: { tagCommit: OTHER } });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/Tag drawlatch-v1\.0\.0-alpha\.69 already exists/);
    });
  });

  describe("callboard already published", () => {
    it("fails a real run: bump callboard", () => {
      const p = plan({ callboard: { published: true, tagCommit: OLD, gitHead: OLD } });
      expect(p.errors).toEqual(["@wolpertingerlabs/callboard@1.0.0-alpha.67 is already on npm. Bump callboard."]);
      expect(p.callboard).toEqual({ action: "skip", tagCommit: null });
    });

    it("a dry run warns and only packs (npm publish --dry-run refuses a published version)", () => {
      const p = plan({ dryRun: true, callboard: { published: true, gitHead: OLD } });
      expect(p.errors).toEqual([]);
      expect(p.callboard).toEqual({ action: "pack", tagCommit: null });
      expect(p.warnings.join("\n")).toMatch(/a real run would fail/);
    });

    it("re-run after callboard published but its tag push failed: tags HEAD, publishes nothing", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: HEAD, gitHead: HEAD }, callboard: { published: true, gitHead: HEAD } });
      expect(p.errors).toEqual([]);
      expect(p.drawlatch).toEqual({ action: "skip", tagCommit: null, driftBase: HEAD });
      expect(p.callboard).toEqual({ action: "skip", tagCommit: HEAD });
    });

    it("re-run of a fully finished release from the same commit is a no-op, not a failure", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: HEAD, gitHead: HEAD }, callboard: { published: true, tagCommit: HEAD, gitHead: HEAD } });
      expect(p.errors).toEqual([]);
      expect(p.drawlatch).toEqual({ action: "skip", tagCommit: null, driftBase: HEAD });
      expect(p.callboard).toEqual({ action: "skip", tagCommit: null });
    });

    it("fails when v<version> and the commit npm recorded disagree, in a dry run too", () => {
      for (const dryRun of [false, true]) {
        const p = plan({ dryRun, callboard: { published: true, tagCommit: OLD, gitHead: OTHER } });
        expect(p.errors).toHaveLength(1);
        expect(p.errors[0]).toMatch(/published from c{40}, but v1\.0\.0-alpha\.67 points at b{40}/);
        expect(p.callboard).toEqual({ action: "skip", tagCommit: null });
      }
    });

    it("published from this commit but tagged elsewhere is a conflict", () => {
      const p = plan({ callboard: { published: true, tagCommit: OTHER, gitHead: HEAD } });
      expect(p.errors).toHaveLength(1);
    });
  });

  it("re-run after drawlatch published but callboard failed: skips drawlatch, publishes callboard", () => {
    const p = plan({ drawlatch: { published: true, tagCommit: HEAD, gitHead: HEAD } });
    expect(p.errors).toEqual([]);
    expect(p.drawlatch.action).toBe("skip");
    expect(p.callboard).toEqual({ action: "publish", tagCommit: HEAD });
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

    it("refuses to move the dist-tag backwards", () => {
      const p = plan({ drawlatch: { distTags: { latest: "1.0.0-alpha.70" } }, callboard: { distTags: { latest: "1.0.0" } } });
      expect(p.errors).toHaveLength(2);
      expect(p.errors[0]).toMatch(/drawlatch@1\.0\.0-alpha\.69 is lower than 1\.0\.0-alpha\.70, which the "latest" dist-tag/);
      expect(p.errors[1]).toMatch(/callboard@1\.0\.0-alpha\.67 is lower than 1\.0\.0/);
    });

    it("allows moving it forwards, a different dist-tag, or a tag that doesn't exist yet", () => {
      expect(plan({ drawlatch: { distTags: { latest: "1.0.0-alpha.68" } }, callboard: { distTags: { latest: "1.0.0-alpha.9" } } }).errors).toEqual([]);
      expect(plan({ distTag: "hotfix", drawlatch: { distTags: { latest: "2.0.0" } } }).errors).toEqual([]);
      expect(plan({ drawlatch: { distTags: {} } }).errors).toEqual([]);
    });

    it("only checks packages it is about to publish", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: OLD, distTags: { latest: "9.0.0" } } });
      expect(p.errors).toEqual([]);
    });
  });

  describe("callboard not published", () => {
    it("publishes without re-tagging when v<version> already points at HEAD", () => {
      expect(plan({ callboard: { tagCommit: HEAD } }).callboard).toEqual({ action: "publish", tagCommit: null });
    });

    it("fails on a stray tag at another commit", () => {
      const p = plan({ callboard: { tagCommit: OTHER } });
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]).toMatch(/Tag v1\.0\.0-alpha\.67 already exists/);
    });
  });
});

// The I/O layer against a real repository: which files count as "ships",
// which commits can be a drift base, and tag lookup.
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
  const changedAfterTouching = (rel) => {
    const base = git("rev-parse", "HEAD");
    write(rel, `changed ${Math.random()}\n`);
    commit(rel);
    return repoGit(repo).driftFiles(base);
  };

  const SHIPS = [
    "packages/drawlatch/src/remote/server.ts",
    "packages/drawlatch/src/remote/ingestors/e2e/setup.ts",
    "packages/drawlatch/src/remote/__fixtures__/helper.ts",
    "packages/drawlatch/src/connections/ai/openai.json",
    "packages/drawlatch/src/connections/ai/__fixtures__/sample.json",
    "packages/drawlatch/src/connections/ai/openai.test.ts",
    "packages/drawlatch/frontend/src/App.tsx",
    "packages/drawlatch/frontend/vite.config.ts",
    "packages/drawlatch/frontend/package.json",
    "packages/drawlatch/bin/drawlatch.js",
    "packages/drawlatch/package.json",
    "packages/drawlatch/tsconfig.json",
    "packages/drawlatch/README.md",
    "packages/drawlatch/CONNECTIONS.md",
    "packages/drawlatch/LICENSE",
    "packages/drawlatch/some-new-unclassified-file.txt",
    "packages/drawlatch/src/remote/x.example.json",
  ];
  const DOES_NOT_SHIP = [
    "packages/drawlatch/src/remote/server.test.ts",
    "packages/drawlatch/src/remote/ingestors/e2e/github.e2e.test.ts",
    "packages/drawlatch/frontend/src/App.test.tsx",
    "packages/drawlatch/src/remote/__fixtures__/suite.json",
    "packages/drawlatch/plans/vault.md",
    "packages/drawlatch/CLAUDE.md",
    "packages/drawlatch/.gitignore",
    "packages/drawlatch/.claude/commands/gsr.md",
    "packages/drawlatch/.claude-plugin/plugin.json",
    "packages/drawlatch/eslint.config.js",
    "packages/drawlatch/vitest.e2e.config.ts",
    "packages/drawlatch/tsconfig.eslint.json",
    "packages/drawlatch/remote.config.example.json",
    "packages/drawlatch/.env.e2e.example",
    "backend/src/index.ts",
    "package-lock.json", // the documented gap: see DRAWLATCH_NON_SHIPPING
  ];

  let standalone, monorepoBase, sideBranch;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "release-plan-test-"));
    git("init", "-q", "-b", "main");
    // A standalone-drawlatch-like commit: package.json at the root, no
    // packages/drawlatch. In callboard such commits are reachable through the
    // subtree import merge.
    write("package.json", "{}\n");
    standalone = commit("standalone drawlatch");
    for (const rel of [...SHIPS, ...DOES_NOT_SHIP]) write(rel);
    monorepoBase = commit("monorepo base");
    git("checkout", "-q", "-b", "side");
    write("side.txt");
    sideBranch = commit("side");
    git("checkout", "-q", "main");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  describe("driftFiles", () => {
    it.each(SHIPS)("counts %s as drift", (rel) => {
      expect(changedAfterTouching(rel)).toEqual([rel]);
    });

    it.each(DOES_NOT_SHIP)("ignores %s", (rel) => {
      expect(changedAfterTouching(rel)).toEqual([]);
    });
  });

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
    git("tag", "-a", "drawlatch-v9.9.9", "-m", "t", monorepoBase);
    expect(repoGit(repo).tagCommit("drawlatch-v9.9.9")).toBe(monorepoBase);
    expect(repoGit(repo).tagCommit("drawlatch-v0.0.0")).toBe(null);
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
