/**
 * The publish gate is only as good as vitest's exit code.
 *
 * `prepublishOnly` ends with `npm test`, and CI's `build-test-coverage` job
 * gates on `test:coverage`; both reduce to `vitest run`. A run that prints red
 * and exits 0 would publish a broken tarball silently.
 *
 * The dangerous shape is not a failed assertion — that is obviously red — it is
 * an error raised outside any test: an unhandled rejection or an uncaught
 * exception in a stray timer, which vitest reports as `Errors  1 error` next to
 * `Tests  1 passed`. Today that exits 1. Three separate things have to stay true
 * for it to keep doing so, and none of them is visible by reading the config:
 *
 * 1. **vitest must keep failing the run on those errors.** That is vitest's
 *    behaviour, not ours, so it is pinned by actually running vitest and reading
 *    `status` — with one documented exception, see `globalSetup` below.
 * 2. **the root config must not switch it off.** `dangerouslyIgnoreUnhandledErrors`
 *    and the `onUnhandledError` hook both suppress exactly these errors.
 * 3. **no npm script may pass the equivalent CLI flag.** A flag in `package.json`
 *    leaves the config file pristine and un-gates the publish anyway.
 *
 * ## Root, not project
 *
 * Both knobs are read from the **root** resolved config only. The exit code is
 * decided by `Vitest._checkUnhandledErrors`, which tests `this.config.dangerouslyIgnoreUnhandledErrors`
 * on the root; the hook is wired once at construction from the root's
 * `resolved.onUnhandledError`. Setting either on a single project is **inert** —
 * verified: a project-level knob still exits 1 and still prints the error.
 *
 * That matters because this repo's projects use `extends: true`, which copies
 * the root value down. A guard that only walked `vitest.projects` would pass
 * while the mechanism was disabled, as soon as anyone dropped `extends`. So the
 * root is asserted directly; the per-project assertions are kept as a smell
 * check — they flag a setting that does nothing, which is worth knowing about
 * either way, but they are not what closes the hole.
 *
 * ## The subprocess fixtures
 *
 * They run against a scratch root with their own empty config, never this
 * repo's, so a concurrent full-suite glob can never pick them up. Each asserts
 * its own distinctive marker string in the output: `status !== 0` alone passes
 * vacuously for *any* non-zero exit, including one where the vitest binary was
 * never found.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

const scratchDirs = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Run `vitest run` over a set of fixture files in an isolated scratch root.
 * `files` maps filename to contents; `fixture.test.js` is the usual entry.
 */
function runFixture(files, args = []) {
  const root = mkdtempSync(join(tmpdir(), "cb-exitcode-"));
  scratchDirs.push(root);
  writeFileSync(join(root, "vitest.config.js"), files["vitest.config.js"] ?? "export default {};\n");
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  const result = spawnSync(process.execPath, [VITEST_BIN, "run", "--root", root, "--config", join(root, "vitest.config.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CI: "true", VITEST: undefined, TEST: undefined, VITEST_POOL_ID: undefined, VITEST_WORKER_ID: undefined },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const outOfTestRejection =
  `import { it, expect } from "vitest";\n` +
  `it("passes but leaks a rejection", async () => {\n` +
  `  setTimeout(() => { void Promise.reject(new Error("MARKER_oot_rejection")); }, 5);\n` +
  `  await new Promise((r) => setTimeout(r, 200));\n` +
  `  expect(1).toBe(1);\n` +
  `});\n`;

// Five ways for a run to be red. They exercise two mechanisms, not five: the
// assertion / collection / afterAll cases land on the failed-module path, while
// the rejection and the exception reach `_checkUnhandledErrors` through two
// distinct process handlers. Both mechanisms are what matters; the redundancy
// is cheap.
const RED_RUNS = [
  {
    name: "a failed assertion",
    files: { "fixture.test.js": `import { it, expect } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n` },
    marker: /expected 1 to be 2/,
  },
  {
    name: "an unhandled rejection raised while a test is running",
    files: { "fixture.test.js": outOfTestRejection },
    marker: /MARKER_oot_rejection/,
  },
  {
    name: "an uncaught exception raised while a test is running",
    files: {
      "fixture.test.js":
        `import { it, expect } from "vitest";\n` +
        `it("passes but throws from a timer", async () => {\n` +
        `  setTimeout(() => { throw new Error("MARKER_oot_exception"); }, 5);\n` +
        `  await new Promise((r) => setTimeout(r, 200));\n` +
        `  expect(1).toBe(1);\n` +
        `});\n`,
    },
    marker: /MARKER_oot_exception/,
  },
  {
    name: "a throw at module scope during collection",
    files: { "fixture.test.js": `throw new Error("MARKER_collection_failure");\n` },
    marker: /MARKER_collection_failure/,
  },
  {
    name: "a hook that throws after every test passed",
    files: {
      "fixture.test.js": `import { it, expect, afterAll } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\nafterAll(() => { throw new Error("MARKER_teardown_failure"); });\n`,
    },
    marker: /MARKER_teardown_failure/,
  },
];

describe("vitest exit code", () => {
  it.each(RED_RUNS)("is non-zero for $name", ({ files, marker }) => {
    const { status, output, error } = runFixture(files);
    expect(error, output).toBeUndefined();
    // Proves vitest actually ran and reached the failure. Without this the
    // status assertion below would pass for a missing binary or a bad flag.
    expect(output).toMatch(marker);
    expect(status, output).not.toBe(0);
  });

  it("is non-zero even when no test failed and only the out-of-test error is red", () => {
    const { status, output } = runFixture({ "fixture.test.js": outOfTestRejection });
    // The distinguishing signature: vitest counts the error separately from the
    // tests, so this run reports a passing test *and* a non-zero exit code.
    expect(output).toMatch(/Tests\s+1 passed/);
    expect(output).toMatch(/Errors\s+1 error/);
    expect(status, output).not.toBe(0);
  });

  it("is zero once the suppression flag is passed — the direction of the knob", () => {
    // Positive control. This is the whole reason the config and package.json
    // assertions below exist: the same red run goes green on this one flag.
    const { status, output } = runFixture({ "fixture.test.js": outOfTestRejection }, ["--dangerouslyIgnoreUnhandledErrors"]);
    expect(output).toMatch(/Tests\s+1 passed/);
    expect(status, output).toBe(0);
  });

  it("is zero when a globalSetup teardown throws — a known hole, pinned deliberately", () => {
    // `Vitest.close()` collects teardown rejections into `teardownErrors`, logs
    // them via `logger.error("error during close", ...)`, and never touches
    // `process.exitCode`. So claim (1) at the top of this file has one
    // exception, and it is this one. (A `globalSetup` *setup* that throws does
    // exit 1 — it propagates into `startVitest`'s catch.)
    //
    // This asserts the broken behaviour on purpose, so that if vitest ever
    // fixes it this test fails and we find out. When that happens: delete this
    // test and the globalSetup ban below.
    const { status, output } = runFixture({
      "vitest.config.js": `export default { test: { globalSetup: ["./gs.js"] } };\n`,
      "gs.js": `export function setup() {}\nexport function teardown() { throw new Error("MARKER_global_teardown"); }\n`,
      "fixture.test.js": `import { it, expect } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`,
    });
    expect(output).toMatch(/MARKER_global_teardown/);
    expect(output).toMatch(/error during close/);
    expect(status, output).toBe(0);
  });
});

describe("this repo's resolved vitest config", () => {
  it("does not suppress out-of-test errors, and defines no globalSetup", async () => {
    const { createVitest } = await import("vitest/node");
    // A private cacheDir keeps this from sharing Vite's dep-optimizer cache
    // under node_modules/.vite with the outer run that is executing this test.
    const cacheDir = mkdtempSync(join(tmpdir(), "cb-exitcode-cache-"));
    scratchDirs.push(cacheDir);
    const vitest = await createVitest("test", { watch: false, root: REPO_ROOT }, { cacheDir });
    try {
      // The root is the mechanism — see the header. These two are the assertions
      // that actually close the hole.
      expect(vitest.config.dangerouslyIgnoreUnhandledErrors, "root config").toBe(false);
      expect(vitest.config.onUnhandledError, "root config").toBeUndefined();

      // A globalSetup teardown that throws does not fail the run (see the pinned
      // test above), so adding one opens a hole nothing else here can see.
      expect(vitest.config.globalSetup, "root config").toEqual([]);

      // Smell check only: a project-level knob is inert, but nobody writes one
      // on purpose, so it almost certainly means the root was meant.
      expect(vitest.projects.length).toBeGreaterThan(0);
      for (const project of vitest.projects) {
        expect(project.config.dangerouslyIgnoreUnhandledErrors, `project ${project.name} (inert here, but a sign the root was meant)`).toBe(false);
        expect(project.config.onUnhandledError, `project ${project.name} (inert here, but a sign the root was meant)`).toBeUndefined();
        expect(project.config.globalSetup, `project ${project.name}`).toEqual([]);
      }
    } finally {
      await vitest.close();
    }
  }, 60_000);
});

// A CLI flag in package.json leaves vitest.config.ts pristine, so the resolved
// config above cannot see it — `createVitest` is called with no argv. This is
// the realistic regression: someone adds the flag to `"test"` to quiet a flake
// and silently un-gates both `prepublishOnly` and CI.
const GATE_BREAKING_FLAGS = [
  {
    flag: "--dangerouslyIgnoreUnhandledErrors",
    why: "makes vitest exit 0 on errors raised outside a test, so `npm test` goes green on a red run",
  },
  {
    flag: "--passWithNoTests",
    why: "makes vitest exit 0 when the globs match nothing, so a broken include pattern publishes green",
  },
];

describe("this repo's npm scripts", () => {
  const { scripts = {} } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const vitestScripts = Object.entries(scripts).filter(([, command]) => /\bvitest\b/.test(command));

  it("has vitest-running scripts to check", () => {
    // Guards against the filter silently matching nothing after a rename.
    expect(vitestScripts.map(([name]) => name)).toEqual(expect.arrayContaining(["test", "test:coverage"]));
  });

  it.each(GATE_BREAKING_FLAGS)("passes $flag in no vitest script", ({ flag, why }) => {
    const offenders = vitestScripts.filter(([, command]) => command.includes(flag)).map(([name, command]) => `${name}: ${command}`);
    expect(
      offenders,
      `${flag} ${why}. \`prepublishOnly\` ends with \`npm test\` and CI's build-test-coverage job runs \`test:coverage\`, so this flag turns the publish gate into a no-op. Remove it and fix the underlying flake instead.`,
    ).toEqual([]);
  });
});
