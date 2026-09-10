/**
 * The publish gate is only as good as vitest's exit code.
 *
 * `prepublishOnly` ends with `npm test`, so a `vitest run` that prints red and
 * exits 0 would publish a broken tarball silently. Two things have to hold for
 * that not to happen, and neither is visible by reading the config:
 *
 * 1. **vitest itself must fail the run on an error raised outside any test.**
 *    The dangerous shape is not a failed assertion — that is obviously red — it
 *    is an unhandled rejection or an uncaught exception in a stray timer, which
 *    vitest reports as `Errors  1 error` next to `Tests  1 passed`. Whether
 *    that sets a non-zero exit code is vitest's behaviour, not ours, so it is
 *    pinned here by actually running vitest and reading `status`.
 * 2. **this repo must not switch that behaviour off.** `dangerouslyIgnoreUnhandledErrors`
 *    and the `onUnhandledError` hook both suppress exactly the errors in (1),
 *    and either can be set at the root or on a single project. The assertion
 *    below reads the *resolved* value for every project through vitest's own
 *    config resolution rather than the config file's text, so a knob inherited
 *    from anywhere still trips it.
 *
 * The subprocess runs against a scratch root with its own empty config, not
 * against this repo's, so a full-suite run globbing at the wrong moment can
 * never pick the fixtures up. (2) is what covers this repo's own config.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

const scratchDirs = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Run `vitest run` over a single fixture in an isolated root. */
function runFixture(source) {
  const root = mkdtempSync(join(tmpdir(), "cb-exitcode-"));
  scratchDirs.push(root);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "vitest.config.js"), "export default {};\n");
  writeFileSync(join(root, "fixture.test.js"), source);
  const result = spawnSync(process.execPath, [VITEST_BIN, "run", "--root", root, "--config", join(root, "vitest.config.js")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CI: "true", VITEST: undefined, TEST: undefined, VITEST_POOL_ID: undefined, VITEST_WORKER_ID: undefined },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// Each fixture is a distinct way for a run to be red. The out-of-test ones are
// the point of the file; the assertion failure is the control that proves the
// harness would notice if the subprocess never ran.
const RED_RUNS = [
  {
    name: "a failed assertion",
    source: `import { it, expect } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n`,
  },
  {
    name: "an unhandled rejection raised while a test is running",
    source:
      `import { it, expect } from "vitest";\n` +
      `it("passes but leaks a rejection", async () => {\n` +
      `  setTimeout(() => { void Promise.reject(new Error("out-of-test rejection")); }, 5);\n` +
      `  await new Promise((r) => setTimeout(r, 200));\n` +
      `  expect(1).toBe(1);\n` +
      `});\n`,
  },
  {
    name: "an uncaught exception raised while a test is running",
    source:
      `import { it, expect } from "vitest";\n` +
      `it("passes but throws from a timer", async () => {\n` +
      `  setTimeout(() => { throw new Error("out-of-test exception"); }, 5);\n` +
      `  await new Promise((r) => setTimeout(r, 200));\n` +
      `  expect(1).toBe(1);\n` +
      `});\n`,
  },
  {
    name: "a throw at module scope during collection",
    source: `throw new Error("collection failure");\n`,
  },
  {
    name: "a hook that throws after every test passed",
    source: `import { it, expect, afterAll } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\nafterAll(() => { throw new Error("teardown failure"); });\n`,
  },
];

describe("vitest exit code", () => {
  it.each(RED_RUNS)("is non-zero for $name", ({ source }) => {
    const { status, output, error } = runFixture(source);
    expect(error, output).toBeUndefined();
    expect(status, output).not.toBe(0);
  });

  it("is non-zero even when no test failed and only the out-of-test error is red", () => {
    const { status, output } = runFixture(RED_RUNS[1].source);
    // The distinguishing signature: vitest counts the error separately from the
    // tests, so this run reports a passing test *and* a non-zero exit code.
    expect(output).toMatch(/Tests\s+1 passed/);
    expect(output).toMatch(/Errors\s+1 error/);
    expect(status, output).not.toBe(0);
  });
});

describe("this repo's resolved vitest config", () => {
  it("does not suppress out-of-test errors in any project", async () => {
    const { createVitest } = await import("vitest/node");
    const vitest = await createVitest("test", { watch: false, root: REPO_ROOT });
    try {
      expect(vitest.projects.length).toBeGreaterThan(0);
      for (const project of vitest.projects) {
        expect(project.config.dangerouslyIgnoreUnhandledErrors, `project ${project.name}`).toBe(false);
        expect(project.config.onUnhandledError, `project ${project.name}`).toBeUndefined();
      }
    } finally {
      await vitest.close();
    }
  }, 60_000);
});
