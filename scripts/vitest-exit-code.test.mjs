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
 *
 * ## Environment
 *
 * The child inherits the parent's env, and the parent's env is not the same on a
 * developer's machine as on a runner. That difference took this file red in CI
 * once already: vitest calls `disableDefaultColors()` when std-env reports an
 * agent, std-env reports one when `AI_AGENT` / `CLAUDECODE` is present, and
 * Claude Code sets both — so locally the child's report was plain text and
 * `/Tests\s+1 passed/` matched, while on the runner the child colourised and the
 * same line arrived as `Tests` + CSI codes + `1 passed`.
 *
 * So `childEnv()` pins everything that changes the child's *output shape*, and
 * matching happens on ANSI-stripped text. Two independent defences, because the
 * failure mode is silent in exactly one direction: it passes locally.
 *
 * Note there is nothing coverage-specific to scrub. `@vitest/coverage-v8` drives
 * the inspector in-process and injects no environment variable, so a child of a
 * `--coverage` run sees the same env as a child of a plain one — verified by
 * dumping a worker's env under both.
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

// CSI escape sequences. The assertions below match on the child's report text,
// which must not depend on whether the child decided to colourise it.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text) => text.replace(ANSI, "");

/**
 * The child's environment, pinned so its output is byte-identical on a
 * developer's machine and on a CI runner. See "Environment" in the header —
 * every entry here is load-bearing, and the ones set to `undefined` are dropped
 * by `child_process` rather than passed as the string "undefined".
 */
function childEnv() {
  return {
    ...process.env,
    CI: "true",
    // The decisive switch: tinyrainbow checks NO_COLOR before anything else.
    // Without it the child colourises whenever no agent is detected, and the
    // report regexes below stop matching. FORCE_COLOR has to go or Node warns
    // that NO_COLOR is being ignored.
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    // std-env reads these to decide `isAgent`, and vitest calls
    // `disableDefaultColors()` when it is true. Leaving them in is what made
    // this file pass locally and fail in CI.
    AI_AGENT: undefined,
    CLAUDECODE: undefined,
    CLAUDE_CODE: undefined,
    // Otherwise the child emits `::error` workflow annotations for fixtures
    // that are *supposed* to fail, attaching them to the real CI run.
    GITHUB_ACTIONS: undefined,
    // Leaked from the outer vitest's own worker env.
    VITEST: undefined,
    TEST: undefined,
    VITEST_MODE: undefined,
    VITEST_POOL_ID: undefined,
    VITEST_WORKER_ID: undefined,
    FORCE_TTY: undefined,
  };
}

/** A failure message that says what the child actually did. */
function describeRun({ status, signal, error, stdout, stderr }) {
  return [
    `status: ${status}`,
    `signal: ${signal}`,
    `error: ${error ? `${error.name}: ${error.message}` : "none"}`,
    `--- child stdout ---\n${stdout ?? ""}`,
    `--- child stderr ---\n${stderr ?? ""}`,
  ].join("\n");
}

/**
 * Run `vitest run` over a set of fixture files in an isolated scratch root.
 * `files` maps filename to contents; `fixture.test.js` is the usual entry.
 * `output` is ANSI-stripped for matching; `detail` carries the raw streams.
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
    env: childEnv(),
  });
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ...result, raw, output: stripAnsi(raw), detail: describeRun(result) };
}

/**
 * Every assertion about a child run goes through here first: a child killed by
 * a signal, or one that never started, produces `status: null`, which would
 * otherwise surface as a baffling "expected null to be 0".
 */
function expectRanToCompletion({ signal, error, detail }) {
  expect(error, detail).toBeUndefined();
  expect(signal, detail).toBeNull();
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
    const run = runFixture(files);
    expectRanToCompletion(run);
    // Proves vitest actually ran and reached the failure. Without this the
    // status assertion below would pass for a missing binary or a bad flag.
    expect(run.output, run.detail).toMatch(marker);
    expect(run.status, run.detail).not.toBe(0);
  });

  it("is non-zero even when no test failed and only the out-of-test error is red", () => {
    const run = runFixture({ "fixture.test.js": outOfTestRejection });
    expectRanToCompletion(run);
    // The distinguishing signature: vitest counts the error separately from the
    // tests, so this run reports a passing test *and* a non-zero exit code.
    expect(run.output, run.detail).toMatch(/Tests\s+1 passed/);
    expect(run.output, run.detail).toMatch(/Errors\s+1 error/);
    expect(run.status, run.detail).not.toBe(0);
  });

  it("is zero once the suppression flag is passed — the direction of the knob", () => {
    // Positive control. This is the whole reason the config and package.json
    // assertions below exist: the same red run goes green on this one flag.
    //
    // It is the one assertion here that requires a *zero* exit, so unlike its
    // neighbours no environmental death can satisfy it. That asymmetry is worth
    // knowing about — but it is not what broke this file in CI. That was the
    // report regexes above matching against colourised output; the status
    // assertion was never reached. `expectRanToCompletion` now separates the
    // two cases, so a killed child says so instead of reporting `null`.
    const run = runFixture({ "fixture.test.js": outOfTestRejection }, ["--dangerouslyIgnoreUnhandledErrors"]);
    expectRanToCompletion(run);
    expect(run.output, run.detail).toMatch(/Tests\s+1 passed/);
    expect(run.status, run.detail).toBe(0);
  });

  it("reports identically regardless of the environment it inherits", () => {
    // The regression that took this file red in CI: locally the child inherited
    // Claude Code's `AI_AGENT`, vitest detected an agent and disabled colour, so
    // the report was plain text and the regexes matched. A CI runner sets no
    // agent variable, the child colourised, and `Tests  1 passed` came back as
    // `Tests` + CSI codes + `1 passed`.
    //
    // `childEnv` pins NO_COLOR so this cannot recur, and the assertions match on
    // stripped output so they would survive it anyway. If this fails, colour
    // handling has changed and the strip is doing the work alone.
    const run = runFixture({ "fixture.test.js": outOfTestRejection });
    expect(run.raw, run.detail).not.toMatch(ANSI);
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
    const run = runFixture({
      "vitest.config.js": `export default { test: { globalSetup: ["./gs.js"] } };\n`,
      "gs.js": `export function setup() {}\nexport function teardown() { throw new Error("MARKER_global_teardown"); }\n`,
      "fixture.test.js": `import { it, expect } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`,
    });
    expectRanToCompletion(run);
    expect(run.output, run.detail).toMatch(/MARKER_global_teardown/);
    expect(run.output, run.detail).toMatch(/error during close/);
    expect(run.status, run.detail).toBe(0);
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
