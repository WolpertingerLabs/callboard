/**
 * The one `claude` resolver, and the merge it came from.
 *
 * There were two. `agent-settings.ts` honoured `pathToClaudeCodeExecutable` and
 * `which claude` and answered for chats; `utils/paths.ts` read `$CLAUDE_BINARY`
 * and four well-known directories, fell back to the bare string `"claude"`, and
 * answered for `/api/auth/claude-status` and the About page. The cases below
 * that carry a `MERGED:` note are the ones where those two used to give
 * different answers to the same question, and each was reproduced against a
 * real daemon before it was written down.
 *
 * ## What is mocked, and what deliberately is not
 *
 * `which` is mocked, because it is the one step that reaches outside the
 * process. Nothing else is: settings are written for real into the worker's
 * scratch data dir, the candidate paths are real files, and `$HOME` is moved to
 * a scratch directory so the well-known list points somewhere this suite owns.
 * The questions under test are "is there a file there" and "may this process
 * execute it", and a mocked `fs` answers both with whatever the test author
 * assumed — which is exactly how `existsSync` survived as the check for so long.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ which: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (...args: unknown[]) => mocks.which(...args),
}));

import { updateAgentSettings } from "./agent-settings.js";
import { getClaudeCodeExecutableOverride, getClaudeCodeExecutablePath, resetClaudeBinaryCache, resolveClaudeBinary, wellKnownClaudePaths } from "./claude-binary.js";

/**
 * Three of the well-known candidates are absolute system paths this suite
 * cannot move out of the way. `/usr/local/bin/claude` is a perfectly ordinary
 * place to have installed the CLI, so on a machine that has one, "nothing
 * resolves" is not a state that can be produced and the cases asserting it are
 * unaskable rather than failing. Same shape as the `notRoot` guard in
 * `engine-install.settings-failure.test.ts`.
 */
const SYSTEM_CLAUDE = ["/usr/local/bin/claude", "/usr/bin/claude", "/opt/homebrew/bin/claude"].find((p) => existsSync(p));

let scratch: string;
let realHome: string | undefined;

function executable(name: string): string {
  const path = join(scratch, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-claude-binary-"));
  // `homedir()` reads $HOME first on POSIX, and the well-known list is built
  // per call precisely so this works — see `wellKnownClaudePaths`.
  realHome = process.env.HOME;
  process.env.HOME = join(scratch, "home");
  mkdirSync(process.env.HOME, { recursive: true });

  // `DATA_DIR` is captured when `utils/paths.ts` is imported, so re-pointing the
  // env var per test would do nothing — the settings file is shared for the
  // whole worker (`vitest.setup.node.ts` puts it in a scratch dir, not the
  // developer's `~/.callboard`). So the isolation that matters is clearing the
  // field under test, not moving the file.
  updateAgentSettings({ pathToClaudeCodeExecutable: undefined });
  delete process.env.CLAUDE_BINARY;
  mocks.which.mockImplementation(() => {
    throw new Error("which: not found");
  });
  resetClaudeBinaryCache();
});

afterEach(() => {
  updateAgentSettings({ pathToClaudeCodeExecutable: undefined });
  delete process.env.CLAUDE_BINARY;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(scratch, { recursive: true, force: true });
  vi.clearAllMocks();
  resetClaudeBinaryCache();
});

describe("the resolution order", () => {
  it("prefers an executable override over a `claude` on PATH", () => {
    const bin = executable("my-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: bin });

    expect(resolveClaudeBinary()).toMatchObject({ path: bin, source: "setting" });
  });

  it("MERGED: prefers the settings override over $CLAUDE_BINARY", () => {
    // The two resolvers disagreed here by construction. `$CLAUDE_BINARY` was
    // step 1 of the lookup behind the login prompt and the About page's version,
    // and was invisible to the one behind chats — so with both set, a user was
    // shown the version of one binary while running another. One order now, and
    // the settings field wins because it is the one the UI claims decides this.
    const fromSetting = executable("setting-claude");
    const fromEnv = executable("env-claude");
    process.env.CLAUDE_BINARY = fromEnv;
    updateAgentSettings({ pathToClaudeCodeExecutable: fromSetting });

    expect(resolveClaudeBinary()).toMatchObject({ path: fromSetting, source: "setting" });
  });

  it("MERGED: $CLAUDE_BINARY now decides which binary chats spawn, not just which one About reports", () => {
    const fromEnv = executable("env-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    process.env.CLAUDE_BINARY = fromEnv;

    expect(getClaudeCodeExecutablePath()).toBe(fromEnv);
  });

  it("MERGED: a well-known directory now decides it too", () => {
    // `~/.local/bin` is where `claude.ai/install.sh` — the script this feature's
    // own install card offers — puts the binary, and a daemon that started
    // before that directory was on its PATH never sees it through `which`. The
    // status card had to carry a whole extra field (`otherLookupPath`) to say
    // "the About page found one here and your chats are not running it".
    const home = process.env.HOME!;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const inLocalBin = join(home, ".local", "bin", "claude");
    writeFileSync(inLocalBin, "#!/bin/sh\nexit 0\n");
    chmodSync(inLocalBin, 0o755);

    expect(resolveClaudeBinary()).toMatchObject({ path: inLocalBin, source: "well-known" });
  });

  it("prefers PATH over a well-known directory", () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const inLocalBin = join(home, ".local", "bin", "claude");
    writeFileSync(inLocalBin, "#!/bin/sh\nexit 0\n");
    chmodSync(inLocalBin, 0o755);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);

    expect(resolveClaudeBinary()).toMatchObject({ path: onPath, source: "path" });
  });
});

describe("what is not accepted", () => {
  it("falls through to PATH when the override is not executable", () => {
    // `existsSync` alone accepted this path, the SDK spawned it, and every
    // Claude chat died at the first turn with EACCES against a path Settings was
    // simultaneously calling configured.
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

  it("MERGED: rejects a $CLAUDE_BINARY that cannot be spawned, rather than passing it on", () => {
    // The old lookup took `$CLAUDE_BINARY` entirely on trust — no stat, no
    // execute bit, not even an absolute-path check — and handed it to a shell.
    const notExecutable = join(scratch, "env-claude");
    writeFileSync(notExecutable, "");
    chmodSync(notExecutable, 0o644);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    process.env.CLAUDE_BINARY = notExecutable;

    expect(resolveClaudeBinary()).toMatchObject({ path: onPath, source: "path" });
  });

  it("rejects a relative override rather than resolving it against the daemon's cwd", () => {
    // The engine spawns with the chat's folder as cwd, so a path that works
    // from here works nowhere that matters.
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: "relwrap" });

    expect(getClaudeCodeExecutableOverride()?.state).toBe("not-absolute");
    expect(getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it.skipIf(SYSTEM_CLAUDE)("MERGED: returns undefined when this machine has no native claude, instead of the bare name", () => {
    // The whole of the login-modal bug in one assertion. The old lookup returned
    // the literal string `"claude"` here, `/api/auth/claude-status` ran
    // `claude auth status` through a shell, the shell could not find it, and a
    // machine running perfectly on the Agent SDK's bundled binary was told
    // "Claude Code Login Required" every session. Measured against a real
    // daemon: `{"loggedIn": false, "error": "CLI error: Command failed:
    // claude auth status … claude: not found"}`.
    updateAgentSettings({ pathToClaudeCodeExecutable: join(scratch, "gone") });
    expect(resolveClaudeBinary().path).toBeUndefined();
    expect(getClaudeCodeExecutablePath()).toBeUndefined();
  });
});

describe("the resolver and the card cannot drift apart", () => {
  /**
   * Both directions of the memoisation finding, which review reproduced live.
   *
   * The first cut memoized the whole decision while the override check —
   * what the status card renders — re-`stat`ed on every call. Two functions, one
   * module, one question, two clocks. The assertions below pair them
   * deliberately: it is not enough that each is individually reasonable, they
   * have to *agree*, because the card's central claim is "this is the binary
   * Callboard runs".
   */
  it("stops using an override whose binary disappears after it resolved", () => {
    // Direction A. Reproduced as: card reads "Native `claude` at X · Ready"
    // beside "⚠ Nothing at X", while every chat dies with `native binary not
    // found`. The reassuring line was the false one.
    const bin = executable("vanishing-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: bin });

    expect(getClaudeCodeExecutablePath()).toBe(bin);
    expect(getClaudeCodeExecutableOverride()?.state).toBe("active");

    rmSync(bin, { force: true });

    // No cache reset in between — that is the point.
    expect(getClaudeCodeExecutableOverride()?.state).toBe("missing");
    expect(getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it("starts using an override whose binary appears after it was rejected", () => {
    // Direction B. Reproduced as: card says "Override in effect", chats ignore
    // it. The resolver had cached its answer at a moment the path did not exist
    // and never looked again.
    const target = join(scratch, "later-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: target });

    expect(getClaudeCodeExecutablePath()).toBe(onPath);
    expect(getClaudeCodeExecutableOverride()?.state).toBe("missing");

    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);

    expect(getClaudeCodeExecutableOverride()?.state).toBe("active");
    expect(getClaudeCodeExecutablePath()).toBe(target);
  });

  it("carries the checked override alongside the resolved path, even when it lost", () => {
    // What lets the card distinguish a typo from a blank field: resolution falls
    // through to exactly where it would have gone with the field empty, so from
    // `path` alone the two states are identical.
    const typo = join(scratch, "nope");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: typo });

    expect(resolveClaudeBinary()).toMatchObject({ path: onPath, source: "path", override: { path: typo, state: "missing" } });
  });

  it("still memoizes the expensive half — `which` runs once", () => {
    // The guard on the fix. Reading the override fresh is one `stat`; re-running
    // `which claude` on every resolution would be a spawn per chat start.
    mocks.which.mockReturnValue(`${executable("path-claude")}\n`);

    getClaudeCodeExecutablePath();
    getClaudeCodeExecutablePath();
    getClaudeCodeExecutablePath();
    expect(mocks.which).toHaveBeenCalledTimes(1);
  });

  it("looks again after a reset, so a freshly installed CLI is found", () => {
    // `POST /api/engines/refresh`'s reason for existing.
    expect(getClaudeCodeExecutablePath()).toBe(SYSTEM_CLAUDE);

    const installed = executable("path-claude");
    mocks.which.mockReturnValue(`${installed}\n`);
    resetClaudeBinaryCache();

    expect(getClaudeCodeExecutablePath()).toBe(installed);
  });
});

describe("wellKnownClaudePaths", () => {
  it("follows $HOME rather than a value captured at import", () => {
    expect(wellKnownClaudePaths()[0]).toBe(join(process.env.HOME!, ".local", "bin", "claude"));
  });
});
