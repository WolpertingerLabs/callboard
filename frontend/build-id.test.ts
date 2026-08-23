/**
 * The minting rules, against real git repositories.
 *
 * The first test here is the one the whole design rests on. `shared/types/
 * build.ts` promises that rebuilding an unchanged checkout does *not* mint a
 * new id — because if it did, every `npm run build` would tell every open tab
 * to reload for nothing, which is precisely the false positive the drift rule
 * elsewhere goes to such lengths to avoid. That promise was previously carried
 * by a comment and nothing else: a mutation making a clean tree take the
 * dirty-tree timestamp path left all 43 tests green.
 *
 * Real `git`, real temp repos, real `package.json`. A mocked `execFileSync`
 * would only assert that the author imagined git's output correctly, and the
 * distinction being tested — clean tree versus dirty tree — is exactly the one
 * a mock would have to invent.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBuildId, emitBuildId } from "./build-id";

// Importing the config for the wiring tests at the bottom would otherwise drag
// in `@vitejs/plugin-react` and therefore esbuild, which refuses to load under
// jsdom ("new TextEncoder().encode('') instanceof Uint8Array is incorrectly
// false"). Neither is under test here: `defineConfig` is identity for a
// function, and the react plugin is nothing to do with build identity.
vi.mock("vite", () => ({ defineConfig: (c: unknown) => c }));
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({ name: "react-stub" }) }));

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A throwaway checkout with one commit and a package.json. */
function repo(version = "1.0.0-alpha.49", withGit = true): string {
  const root = mkdtempSync(join(tmpdir(), "callboard-build-id-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version }));
  if (!withGit) return root;

  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

/** `Date.now()` has millisecond resolution; two calls can land in one tick. */
function tick() {
  const until = Date.now() + 2;
  while (Date.now() < until) {
    /* spin */
  }
}

describe("a clean tree", () => {
  it("mints the same id twice", () => {
    // THE property. If this fails, every build prompts every tab.
    const root = repo();
    const first = computeBuildId(root);
    tick();
    expect(computeBuildId(root)).toBe(first);
  });

  it("carries the version and the sha, and no timestamp", () => {
    const id = computeBuildId(repo("1.0.0-alpha.49"));
    expect(id).toMatch(/^1\.0\.0-alpha\.49\+g[0-9a-f]{12}$/);
  });

  it("mints a different id after a commit", () => {
    // The sha is the identity of the source, so moving the source moves it.
    const root = repo();
    const before = computeBuildId(root);

    writeFileSync(join(root, "feature.txt"), "new work");
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "second"], { cwd: root, stdio: "ignore" });

    expect(computeBuildId(root)).not.toBe(before);
  });
});

describe("a dirty tree", () => {
  it("mints a different id every time", () => {
    // Two builds of one commit with different uncommitted edits genuinely are
    // different bundles, and a sha cannot tell them apart.
    const root = repo();
    writeFileSync(join(root, "scratch.txt"), "uncommitted");

    const first = computeBuildId(root);
    tick();
    expect(computeBuildId(root)).not.toBe(first);
  });

  it("keeps the sha and appends a timestamp", () => {
    const root = repo();
    const clean = computeBuildId(root);
    writeFileSync(join(root, "scratch.txt"), "uncommitted");

    const dirty = computeBuildId(root);
    expect(dirty).toMatch(/^1\.0\.0-alpha\.49\+g[0-9a-f]{12}\.d[0-9a-z]+$/);
    expect(dirty.startsWith(`${clean}.d`)).toBe(true);
  });

  it("counts an untracked file as dirty", () => {
    // `git status --porcelain` reports untracked files; a `diff`-based check
    // would not, and a brand-new source file is the commonest local edit there
    // is.
    const root = repo();
    expect(computeBuildId(root)).not.toContain(".d");
    writeFileSync(join(root, "untracked.ts"), "export {};");
    expect(computeBuildId(root)).toContain(".d");
  });
});

describe("without git", () => {
  it("falls back to the build clock", () => {
    const root = repo("1.0.0-alpha.49", false);
    const id = computeBuildId(root);
    expect(id).toMatch(/^1\.0\.0-alpha\.49\+t[0-9a-z]+$/);
  });

  it("still mints a distinct id per build", () => {
    // Over-reporting change is the safe direction for a prompt the user can
    // dismiss; silently under-reporting it is not.
    const root = repo("1.0.0-alpha.49", false);
    const first = computeBuildId(root);
    tick();
    expect(computeBuildId(root)).not.toBe(first);
  });
});

describe("an unreadable package.json", () => {
  it("does not fail the build", () => {
    const root = mkdtempSync(join(tmpdir(), "callboard-build-id-noversion-"));
    roots.push(root);
    mkdirSync(join(root, "sub"));
    expect(computeBuildId(root)).toMatch(/^0\.0\.0\+t[0-9a-z]+$/);
  });
});

describe("the emitting plugin", () => {
  it("writes the id where the daemon reads it", () => {
    // `backend/src/services/build-identity.ts` reads `build-id.json` out of the
    // served directory. If this filename or shape drifts, the daemon silently
    // reports "unknown" forever and the feature is inert.
    const emitted: any[] = [];
    const plugin = emitBuildId("1.0.0-alpha.49+gabcabcabcabc");
    expect(plugin.name).toBe("callboard-build-id");

    (plugin.generateBundle as any).call({ emitFile: (f: unknown) => emitted.push(f) });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe("build-id.json");
    expect(JSON.parse(emitted[0].source)).toEqual({ buildId: "1.0.0-alpha.49+gabcabcabcabc" });
  });
});

describe("the config wires both halves", () => {
  /** `defineConfig(fn)` is identity for a function, so this is the callback itself. */
  async function resolveConfig(command: "build" | "serve"): Promise<any> {
    const config = (await import("./vite.config")).default as any;
    return await config({ command, mode: command === "build" ? "production" : "development" });
  }

  const named = (config: any, name: string) => config.plugins.flat().find((p: any) => p?.name === name);

  it("defines an id into the bundle and emits the same one beside it", async () => {
    // The wiring is what fails silently. Drop the `define` and the bundle
    // carries no id; drop the plugin and there is nothing for the daemon to
    // read. Either way the two sides can never agree, one of them reports a
    // sentinel forever, and the feature is inert rather than broken — nothing
    // throws, nothing turns red.
    const config = await resolveConfig("build");

    const defined = JSON.parse(config.define.__CALLBOARD_BUILD_ID__);
    expect(defined).toMatch(/^\d+\.\d+\.\d+.*\+[gt][0-9a-z.]+$/);

    const plugin = named(config, "callboard-build-id");
    expect(plugin).toBeTruthy();

    const emitted: any[] = [];
    plugin.generateBundle.call({ emitFile: (f: unknown) => emitted.push(f) });

    // The pairing, asserted directly: one token, both places.
    expect(JSON.parse(emitted[0].source).buildId).toBe(defined);
  });

  it("declares no identity and emits nothing on serve", async () => {
    const config = await resolveConfig("serve");
    expect(JSON.parse(config.define.__CALLBOARD_BUILD_ID__)).toBe("dev");
    expect(named(config, "callboard-build-id")).toBeUndefined();
  });
});
