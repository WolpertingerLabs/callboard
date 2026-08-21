/**
 * The two binary-override resolvers — the functions that decide which binary a
 * chat spawns.
 *
 * These are the load-bearing half of Phase 4. The status card's honesty is
 * derived from them (`engine-status.ts` calls the same functions), so a bug
 * here does not produce a wrong row — it produces a *consistent* wrong answer on
 * both sides, which is the failure mode nothing catches.
 *
 * Real files on disk again, and for the reason spelled out in
 * `utils/binary-path.test.ts`: the interesting condition is a permission bit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ which: vi.fn() }));

// The only mock in this file, and it stands in for `which claude` — the one
// step in the Claude resolver that reaches outside the process. Settings are
// written for real (into the worker's scratch data dir) and the paths are real
// files, because the questions under test are "does this file exist" and "may
// this process execute it", and a mocked `fs` would answer both with whatever
// the test author assumed.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (...args: unknown[]) => mocks.which(...args),
}));

import { getClaudeCodeExecutableOverride, getClaudeCodeExecutablePath, getCodexExecutableOverride, getCodexExecutablePath, resetClaudeCodeExecutablePathCache, updateAgentSettings } from "./agent-settings.js";

let scratch: string;

function executable(name: string): string {
  const path = join(scratch, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-overrides-"));
  // `DATA_DIR` is captured when `utils/paths.ts` is imported, so re-pointing
  // the env var per test would do nothing — the settings file is shared for the
  // whole worker (`vitest.setup.node.ts` puts it in a scratch dir, not the
  // developer's `~/.callboard`). So the isolation that matters here is clearing
  // the two fields under test, not moving the file.
  updateAgentSettings({ pathToClaudeCodeExecutable: undefined, codexPathOverride: undefined });
  mocks.which.mockImplementation(() => {
    throw new Error("which: not found");
  });
  resetClaudeCodeExecutablePathCache();
});

afterEach(() => {
  updateAgentSettings({ pathToClaudeCodeExecutable: undefined, codexPathOverride: undefined });
  rmSync(scratch, { recursive: true, force: true });
  vi.clearAllMocks();
  resetClaudeCodeExecutablePathCache();
});

describe("getCodexExecutablePath", () => {
  it("returns an executable override, so the SDK spawns the user's binary", () => {
    const bin = executable("codex");
    updateAgentSettings({ codexPathOverride: bin });
    expect(getCodexExecutablePath()).toBe(bin);
  });

  it("returns undefined when nothing is configured — the SDK finds its own bundled binary", () => {
    expect(getCodexExecutablePath()).toBeUndefined();
    updateAgentSettings({ codexPathOverride: "   " });
    expect(getCodexExecutablePath()).toBeUndefined();
  });

  it("falls back to the bundled binary rather than handing over an unspawnable path", () => {
    // A typo in a settings field must not break every Codex chat. The card is
    // where the user finds out — see getCodexExecutableOverride below, which is
    // what makes this fallback loud rather than silent.
    const notExecutable = join(scratch, "downloaded");
    writeFileSync(notExecutable, "binary");
    chmodSync(notExecutable, 0o644);

    updateAgentSettings({ codexPathOverride: notExecutable });
    expect(getCodexExecutablePath()).toBeUndefined();

    updateAgentSettings({ codexPathOverride: join(scratch, "typo") });
    expect(getCodexExecutablePath()).toBeUndefined();
  });

  it("never probes PATH — an override or the bundled copy, nothing in between", () => {
    // A PATH search here would silently change which binary ran for everyone who
    // followed Settings → API's `npm i -g @openai/codex` recipe, whose own copy
    // promises it does not do that.
    updateAgentSettings({ codexPathOverride: join(scratch, "missing") });
    getCodexExecutablePath();
    expect(mocks.which).not.toHaveBeenCalled();
  });

  it("reports the rejected state, which is the only place the user can see it", () => {
    const dir = join(scratch, "a-dir");
    mkdirSync(dir);
    updateAgentSettings({ codexPathOverride: dir });

    expect(getCodexExecutableOverride()).toMatchObject({ path: dir, state: "not-a-file" });
    expect(getCodexExecutableOverride()?.detail).toContain("@openai/codex-sdk");
  });
});

describe("getClaudeCodeExecutablePath", () => {
  it("prefers an executable override over a `claude` on PATH", () => {
    const bin = executable("my-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: bin });

    expect(getClaudeCodeExecutablePath()).toBe(bin);
  });

  it("falls through to PATH when the override is not executable", () => {
    // The behaviour change Phase 4 makes, and the reason for it: `existsSync`
    // alone accepted this path, the SDK spawned it, and every Claude chat died
    // at the first turn with EACCES against a path Settings called configured.
    const notExecutable = join(scratch, "claude");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);

    updateAgentSettings({ pathToClaudeCodeExecutable: notExecutable });
    expect(getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it("falls through to PATH when the override is a directory", () => {
    const dir = join(scratch, "claude-dir");
    mkdirSync(dir);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);

    updateAgentSettings({ pathToClaudeCodeExecutable: dir });
    expect(getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it("returns undefined — the SDK's bundled binary — when neither works", () => {
    updateAgentSettings({ pathToClaudeCodeExecutable: join(scratch, "gone") });
    expect(getClaudeCodeExecutablePath()).toBeUndefined();
  });

  it("takes effect on the next call once the cache is dropped, without a restart", () => {
    // The standing papercut this phase closes: the resolved path is memoized for
    // the process lifetime, so editing the setting used to need `callboard
    // restart`. The settings route now drops this cache on a write.
    const first = executable("claude-a");
    const second = executable("claude-b");
    updateAgentSettings({ pathToClaudeCodeExecutable: first });
    expect(getClaudeCodeExecutablePath()).toBe(first);

    updateAgentSettings({ pathToClaudeCodeExecutable: second });
    // Still the old answer until the cache is invalidated — asserted rather than
    // glossed over, because it is exactly what made the field feel broken.
    expect(getClaudeCodeExecutablePath()).toBe(first);

    resetClaudeCodeExecutablePathCache();
    expect(getClaudeCodeExecutablePath()).toBe(second);
  });

  it("reports the rejected override separately from the resolved path", () => {
    // The two answers differ on purpose. `getClaudeCodeExecutablePath` says what
    // the SDK gets; the override says what the user asked for and why it was not
    // honoured. Collapsing them would make a typo indistinguishable from a blank
    // field on every row of the card.
    const notExecutable = join(scratch, "claude");
    writeFileSync(notExecutable, "");
    chmodSync(notExecutable, 0o600);
    updateAgentSettings({ pathToClaudeCodeExecutable: notExecutable });

    expect(getClaudeCodeExecutablePath()).toBeUndefined();
    expect(getClaudeCodeExecutableOverride()).toMatchObject({ path: notExecutable, state: "not-executable" });
  });

  it("reports no override at all when the field is blank", () => {
    expect(getClaudeCodeExecutableOverride()).toBeUndefined();
    updateAgentSettings({ pathToClaudeCodeExecutable: "" });
    expect(getClaudeCodeExecutableOverride()).toBeUndefined();
  });
});
