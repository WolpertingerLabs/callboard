/**
 * One version for the whole repo (scripts/versions.mjs): the drift rules that
 * `deps:check` and the release plan enforce, the sync that `npm version`
 * runs, and the real repo staying in step.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCKER_LOCK, DRAWLATCH, readVersionState, syncVersions, versionDriftErrors } from "./versions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "versions.mjs");
const V = "1.0.0-alpha.69";
const CU = "@wolpertingerlabs/computer-use";

/** A consistent state shaped like this repo's: two private workspaces, drawlatch and computer-use. */
function state(version = V) {
  return {
    version,
    workspaces: [
      { dir: "shared", name: "shared", private: true, version: undefined },
      { dir: "backend", name: "callboard-backend", private: true, version: undefined },
      { dir: "packages/computer-use", name: CU, private: false, version },
      { dir: "packages/drawlatch", name: DRAWLATCH, private: false, version },
    ],
    manifests: {
      "package.json": { version, dependencies: { [DRAWLATCH]: version } },
      "shared/package.json": { name: "shared", private: true },
      "backend/package.json": { name: "callboard-backend", private: true, dependencies: { [CU]: "*", [DRAWLATCH]: version, shared: "*" } },
      "packages/computer-use/package.json": { name: CU, version },
      "packages/drawlatch/package.json": { name: DRAWLATCH, version },
    },
    lock: {
      version,
      packages: {
        "": { version, dependencies: { [DRAWLATCH]: version } },
        backend: { dependencies: { [CU]: "*", [DRAWLATCH]: version, shared: "*" } },
        "packages/computer-use": { version },
        "packages/drawlatch": { version },
      },
    },
    dockerLock: { version, packages: { "": { version } } },
  };
}
const ws = (s, dir) => s.workspaces.find((w) => w.dir === dir);

describe("versionDriftErrors", () => {
  it("passes a consistent state", () => {
    expect(versionDriftErrors(state())).toEqual([]);
  });

  it("requires a semver root version", () => {
    const s = state();
    s.version = undefined;
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(/package.json "version" is undefined, which isn't a semver version/)]);
  });

  it("names a workspace at another version, and every message says how to fix it", () => {
    const s = state();
    ws(s, "packages/drawlatch").version = "1.0.0-alpha.70";
    const errors = versionDriftErrors(s);
    expect(errors).toEqual([
      expect.stringMatching(
        /^packages\/drawlatch\/package.json "version" is "1.0.0-alpha.70", but the root version is "1.0.0-alpha.69"\. Run `npm run version:sync`\.$/,
      ),
    ]);
  });

  it("catches computer-use left at its old version", () => {
    const s = state();
    ws(s, "packages/computer-use").version = "0.1.0";
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(/packages\/computer-use\/package.json "version" is "0.1.0"/)]);
  });

  it("fails a published (non-private) workspace with no version, but not a private one", () => {
    const s = state();
    s.workspaces.push({ dir: "packages/new", name: "@wolpertingerlabs/new", private: false, version: undefined });
    s.workspaces.push({ dir: "packages/tool", name: "tool", private: true, version: undefined });
    expect(versionDriftErrors(s)).toEqual([
      expect.stringMatching(/^packages\/new\/package.json \(@wolpertingerlabs\/new\) is not private but has no "version"/),
    ]);
  });

  it("fails a caret drawlatch pin, even one that would match", () => {
    const s = state();
    s.manifests["package.json"].dependencies[DRAWLATCH] = `^${V}`;
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(/^package.json dependencies\["@wolpertingerlabs\/drawlatch"\] is "\^1.0.0-alpha.69"/)]);
  });

  it("fails a stale pin in both manifests", () => {
    const s = state();
    s.manifests["package.json"].dependencies[DRAWLATCH] = "1.0.0-alpha.68";
    s.manifests["backend/package.json"].dependencies[DRAWLATCH] = "1.0.0-alpha.68";
    expect(versionDriftErrors(s)).toHaveLength(2);
  });

  it("fails a missing backend pin", () => {
    const s = state();
    delete s.manifests["backend/package.json"].dependencies[DRAWLATCH];
    delete s.lock.packages.backend.dependencies[DRAWLATCH];
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(/^backend\/package.json does not depend on @wolpertingerlabs\/drawlatch/)]);
  });

  it('allows "*" or the exact version for any other workspace dependency, and nothing else', () => {
    const s = state();
    expect(versionDriftErrors(s)).toEqual([]); // backend → computer-use "*"
    s.manifests["backend/package.json"].dependencies[CU] = V;
    expect(versionDriftErrors(s)).toEqual([]);
    s.manifests["backend/package.json"].dependencies[CU] = "0.1.0";
    expect(versionDriftErrors(s)).toEqual([
      expect.stringMatching(/^backend\/package.json dependencies\["@wolpertingerlabs\/computer-use"\] is "0.1.0"; a workspace package must be "\*" or exactly/),
    ]);
    s.manifests["backend/package.json"].dependencies[CU] = "*";
    s.manifests["packages/computer-use/package.json"].devDependencies = { [DRAWLATCH]: "^1.0.0-alpha.1" };
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(/^packages\/computer-use\/package.json devDependencies\["@wolpertingerlabs\/drawlatch"\]/)]);
  });

  it.each([
    ["the root version", (s) => (s.lock.version = "1.0.0-alpha.67"), /package-lock.json "version"/],
    ["the root package entry", (s) => (s.lock.packages[""].version = "1.0.0-alpha.67"), /package-lock.json packages\[""\]\.version/],
    [
      "a workspace entry",
      (s) => (s.lock.packages["packages/computer-use"].version = "0.1.0"),
      /package-lock.json packages\["packages\/computer-use"\]\.version is "0.1.0"/,
    ],
    ["a pin", (s) => (s.lock.packages.backend.dependencies[DRAWLATCH] = "1.0.0-alpha.68"), /package-lock.json packages\["backend"\]\.dependencies/],
  ])("fails a stale root lockfile: %s", (_, edit, pattern) => {
    const s = state();
    edit(s);
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(pattern)]);
  });

  it("fails a stale computer-use Docker lockfile", () => {
    const s = state();
    s.dockerLock.packages[""].version = "0.1.0";
    expect(versionDriftErrors(s)).toEqual([expect.stringMatching(/^packages\/computer-use\/docker\/package-lock.json packages\[""\]\.version is "0.1.0"/)]);
    s.dockerLock = undefined;
    expect(versionDriftErrors(s)).toEqual([`${DOCKER_LOCK} is missing.`]);
  });
});

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A tiny repo with this one's shape, every package at `from`. No external dependencies, so npm never needs the network. */
function fixtureRepo(from = "1.0.0") {
  const root = mkdtempSync(join(tmpdir(), "cb-versions-"));
  dirs.push(root);
  const files = {
    "package.json": {
      name: "@wolpertingerlabs/callboard",
      version: from,
      private: true,
      workspaces: ["shared", "backend", "packages/computer-use", "packages/drawlatch"],
      scripts: { version: `node ${JSON.stringify(SCRIPT)} --root . --lock-only` },
      dependencies: { [DRAWLATCH]: from },
    },
    "backend/package.json": { name: "callboard-backend", private: true, dependencies: { [CU]: "*", [DRAWLATCH]: from, shared: "*" } },
    "packages/computer-use/package.json": { name: CU, version: from },
    "packages/drawlatch/package.json": { name: DRAWLATCH, version: from },
    [DOCKER_LOCK]: { name: CU, version: from, lockfileVersion: 3, requires: true, packages: { "": { name: CU, version: from } } },
  };
  for (const [path, json] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(json, null, 2)}\n`);
  }
  // Not JSON.stringify's layout, on purpose: a private manifest the sync must not touch.
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared/package.json"), '{ "name": "shared", "private": true, "files": ["a", "b"] }\n');
  return root;
}
const read = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("syncVersions", () => {
  it("writes the root version into every target, leaves private manifests alone, and is idempotent", () => {
    const root = fixtureRepo();
    const pkg = read(root, "package.json");
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ ...pkg, version: "2.0.0" }, null, 2)}\n`);
    const shared = readFileSync(join(root, "shared/package.json"), "utf8");

    const first = syncVersions(root, { lockfile: "none" });
    expect(first.changed.sort()).toEqual(
      ["backend/package.json", DOCKER_LOCK, "package.json", "packages/computer-use/package.json", "packages/drawlatch/package.json"].sort(),
    );
    expect(read(root, "package.json").dependencies[DRAWLATCH]).toBe("2.0.0");
    expect(read(root, "backend/package.json").dependencies).toEqual({ [CU]: "*", [DRAWLATCH]: "2.0.0", shared: "*" });
    expect(read(root, "packages/computer-use/package.json").version).toBe("2.0.0");
    expect(read(root, "packages/drawlatch/package.json").version).toBe("2.0.0");
    expect(read(root, DOCKER_LOCK).version).toBe("2.0.0");
    expect(read(root, DOCKER_LOCK).packages[""].version).toBe("2.0.0");
    expect(readFileSync(join(root, "shared/package.json"), "utf8")).toBe(shared);
    // No lockfile in "none" mode, so the check still reports it.
    expect(first.errors).toEqual([expect.stringMatching(/package-lock.json is missing/)]);

    expect(syncVersions(root, { lockfile: "none" }).changed).toEqual([]);
  });

  it("refuses a root version that isn't semver", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...read(root, "package.json"), version: "next" }));
    expect(() => syncVersions(root, { lockfile: "none" })).toThrow(/isn't a semver version/);
  });

  it("is what `npm version <v>` runs: everything moves, nothing is committed or tagged", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, ".npmrc"), "git-tag-version=false\n");
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "ignore" });
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD");

    execFileSync("npm", ["version", "9.9.9"], { cwd: root, stdio: "ignore" });

    const after = readVersionState(root);
    expect(versionDriftErrors(after)).toEqual([]);
    expect(after.version).toBe("9.9.9");
    expect(after.lock.packages["packages/drawlatch"].version).toBe("9.9.9");
    expect(after.lock.packages.backend.dependencies[DRAWLATCH]).toBe("9.9.9");
    expect(after.dockerLock.version).toBe("9.9.9");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag")).toBe("");
    expect(git("status", "--porcelain").split("\n").length).toBeGreaterThanOrEqual(6);
  }, 60_000);
});

describe("this repo", () => {
  it("has every package, pin and lockfile at the root version", () => {
    expect(versionDriftErrors(readVersionState(ROOT))).toEqual([]);
  });

  it("stops `npm version` from committing or tagging (.npmrc)", () => {
    expect(readFileSync(join(ROOT, ".npmrc"), "utf8")).toMatch(/^git-tag-version=false$/m);
    expect(read(ROOT, "package.json").scripts.version).toBe("node scripts/versions.mjs");
  });
});
