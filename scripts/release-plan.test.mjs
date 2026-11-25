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
import { drawlatchDriftPathspec, planRelease } from "./release-plan.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OTHER = "c".repeat(40);
const V = "1.0.0-alpha.69";
const CB = "1.0.0-alpha.67";

function plan({ dryRun = false, pins, drawlatch = {}, callboard = {}, ancestors = [OLD], drift = [] } = {}) {
  const driftCalls = [];
  const result = planRelease({
    dryRun,
    head: HEAD,
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

    it("prefers the tag over a disagreeing gitHead, with a warning", () => {
      const p = plan({ drawlatch: { published: true, tagCommit: OLD, gitHead: OTHER } });
      expect(p.errors).toEqual([]);
      expect(p.driftCalls).toEqual([OLD]);
      expect(p.warnings).toHaveLength(1);
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

// The drift pathspec against a real repository: which files count as "ships".
describe("drawlatchDriftPathspec", () => {
  let repo;
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (rel, text = "x\n") => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  const changedAfterTouching = (rel) => {
    const base = git("rev-parse", "HEAD");
    write(rel, `changed ${Math.random()}\n`);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", rel);
    return git("diff", "--name-only", base, "HEAD", "--", ...drawlatchDriftPathspec());
  };

  const SHIPS = [
    "packages/drawlatch/src/remote/server.ts",
    "packages/drawlatch/src/remote/ingestors/e2e/setup.ts",
    "packages/drawlatch/src/connections/ai/openai.json",
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
  ];
  const DOES_NOT_SHIP = [
    "packages/drawlatch/src/remote/server.test.ts",
    "packages/drawlatch/src/remote/ingestors/e2e/github.e2e.test.ts",
    "packages/drawlatch/frontend/src/App.test.tsx",
    "packages/drawlatch/src/remote/__fixtures__/suite.json",
    "packages/drawlatch/plans/vault.md",
    "packages/drawlatch/CLAUDE.md",
    "packages/drawlatch/.claude/commands/gsr.md",
    "packages/drawlatch/.claude-plugin/plugin.json",
    "packages/drawlatch/eslint.config.js",
    "packages/drawlatch/vitest.e2e.config.ts",
    "packages/drawlatch/tsconfig.eslint.json",
    "packages/drawlatch/remote.config.example.json",
    "packages/drawlatch/.env.e2e.example",
    "backend/src/index.ts",
  ];

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "release-plan-test-"));
    git("init", "-q");
    for (const rel of [...SHIPS, ...DOES_NOT_SHIP]) write(rel);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it.each(SHIPS)("counts %s as drift", (rel) => {
    expect(changedAfterTouching(rel)).toBe(rel);
  });

  it.each(DOES_NOT_SHIP)("ignores %s", (rel) => {
    expect(changedAfterTouching(rel)).toBe("");
  });

  it("ignores an example config only at the package root, not under src/", () => {
    expect(changedAfterTouching("packages/drawlatch/src/remote/x.example.json")).toBe("packages/drawlatch/src/remote/x.example.json");
  });
});
