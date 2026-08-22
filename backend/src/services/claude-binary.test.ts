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

// `promisify.custom` rather than a bare `execFile`: the module under test
// captures `promisify(execFile)` at load, and without the custom symbol
// promisify falls back to the callback convention and resolves with a bare
// stdout string, which the `{ stdout }` destructuring would read as undefined.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the module under test");
  };
  const real = await importOriginal<typeof import("node:child_process")>();
  const realExecFileAsync = promisify(real.execFile);
  execFile[promisify.custom] = async (file: string, ...rest: unknown[]) => {
    // Only `which` is stubbed. The `--version` sanity probe has to reach a real
    // spawn, because what it is testing is whether a real candidate answers —
    // stubbing it would assert that the test's own string is a version.
    if (file !== "which") return (realExecFileAsync as any)(file, ...rest);
    const out = mocks.which(file, ...rest);
    // `mocks.which` may return a promise (the slow-PATH cases below); awaiting
    // it here is what lets a test hold the lookup open.
    return { stdout: await out, stderr: "" };
  };
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

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

/**
 * A stand-in that answers `--version` the way the real CLI does.
 *
 * The body matters now: `env` and `well-known` candidates are sanity-probed
 * with `--version` before being adopted, so a script that prints nothing is
 * *correctly* ignored on those paths. {@link inertExecutable} is the other half.
 */
function executable(name: string): string {
  const path = join(scratch, name);
  writeFileSync(path, '#!/bin/sh\necho "2.1.238 (Claude Code)"\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

/** Executable, and not a Claude Code CLI — the shape that took the daemon down. */
function inertExecutable(name: string): string {
  const path = join(scratch, name);
  writeFileSync(path, '#!/bin/sh\necho "not really claude"\nexit 0\n');
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
  it("prefers an executable override over a `claude` on PATH", async () => {
    const bin = executable("my-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: bin });

    expect(await resolveClaudeBinary()).toMatchObject({ path: bin, source: "setting" });
  });

  it("MERGED: prefers the settings override over $CLAUDE_BINARY", async () => {
    // The two resolvers disagreed here by construction. `$CLAUDE_BINARY` was
    // step 1 of the lookup behind the login prompt and the About page's version,
    // and was invisible to the one behind chats — so with both set, a user was
    // shown the version of one binary while running another. One order now, and
    // the settings field wins because it is the one the UI claims decides this.
    const fromSetting = executable("setting-claude");
    const fromEnv = executable("env-claude");
    process.env.CLAUDE_BINARY = fromEnv;
    updateAgentSettings({ pathToClaudeCodeExecutable: fromSetting });

    expect(await resolveClaudeBinary()).toMatchObject({ path: fromSetting, source: "setting" });
  });

  it("MERGED: $CLAUDE_BINARY now decides which binary chats spawn, not just which one About reports", async () => {
    const fromEnv = executable("env-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    process.env.CLAUDE_BINARY = fromEnv;

    expect(await getClaudeCodeExecutablePath()).toBe(fromEnv);
  });

  it("MERGED: a well-known directory now decides it too", async () => {
    // `~/.local/bin` is where `claude.ai/install.sh` — the script this feature's
    // own install card offers — puts the binary, and a daemon that started
    // before that directory was on its PATH never sees it through `which`. The
    // status card had to carry a whole extra field (`otherLookupPath`) to say
    // "the About page found one here and your chats are not running it".
    const home = process.env.HOME!;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const inLocalBin = join(home, ".local", "bin", "claude");
    writeFileSync(inLocalBin, '#!/bin/sh\necho "2.1.238 (Claude Code)"\nexit 0\n');
    chmodSync(inLocalBin, 0o755);

    expect(await resolveClaudeBinary()).toMatchObject({ path: inLocalBin, source: "well-known" });
  });

  it("prefers PATH over a well-known directory", async () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const inLocalBin = join(home, ".local", "bin", "claude");
    writeFileSync(inLocalBin, '#!/bin/sh\necho "2.1.238 (Claude Code)"\nexit 0\n');
    chmodSync(inLocalBin, 0o755);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);

    expect(await resolveClaudeBinary()).toMatchObject({ path: onPath, source: "path" });
  });
});

describe("what is not accepted", () => {
  it("falls through to PATH when the override is not executable", async () => {
    // `existsSync` alone accepted this path, the SDK spawned it, and every
    // Claude chat died at the first turn with EACCES against a path Settings was
    // simultaneously calling configured.
    const notExecutable = join(scratch, "claude");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);

    updateAgentSettings({ pathToClaudeCodeExecutable: notExecutable });
    expect(await getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it("falls through to PATH when the override is a directory", async () => {
    const dir = join(scratch, "claude-dir");
    mkdirSync(dir);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);

    updateAgentSettings({ pathToClaudeCodeExecutable: dir });
    expect(await getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it("MERGED: rejects a $CLAUDE_BINARY that cannot be spawned, rather than passing it on", async () => {
    // The old lookup took `$CLAUDE_BINARY` entirely on trust — no stat, no
    // execute bit, not even an absolute-path check — and handed it to a shell.
    const notExecutable = join(scratch, "env-claude");
    writeFileSync(notExecutable, "");
    chmodSync(notExecutable, 0o644);
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    process.env.CLAUDE_BINARY = notExecutable;

    expect(await resolveClaudeBinary()).toMatchObject({ path: onPath, source: "path" });
  });

  it("rejects a relative override rather than resolving it against the daemon's cwd", async () => {
    // The engine spawns with the chat's folder as cwd, so a path that works
    // from here works nowhere that matters.
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: "relwrap" });

    expect((await getClaudeCodeExecutableOverride())?.state).toBe("not-absolute");
    expect(await getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it.skipIf(SYSTEM_CLAUDE)("MERGED: returns undefined when this machine has no native claude, instead of the bare name", async () => {
    // The whole of the login-modal bug in one assertion. The old lookup returned
    // the literal string `"claude"` here, `/api/auth/claude-status` ran
    // `claude auth status` through a shell, the shell could not find it, and a
    // machine running perfectly on the Agent SDK's bundled binary was told
    // "Claude Code Login Required" every session. Measured against a real
    // daemon: `{"loggedIn": false, "error": "CLI error: Command failed:
    // claude auth status … claude: not found"}`.
    updateAgentSettings({ pathToClaudeCodeExecutable: join(scratch, "gone") });
    expect((await resolveClaudeBinary()).path).toBeUndefined();
    expect(await getClaudeCodeExecutablePath()).toBeUndefined();
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
  it("stops using an override whose binary disappears after it resolved", async () => {
    // Direction A. Reproduced as: card reads "Native `claude` at X · Ready"
    // beside "⚠ Nothing at X", while every chat dies with `native binary not
    // found`. The reassuring line was the false one.
    const bin = executable("vanishing-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: bin });

    expect(await getClaudeCodeExecutablePath()).toBe(bin);
    expect((await getClaudeCodeExecutableOverride())?.state).toBe("active");

    rmSync(bin, { force: true });

    // No cache reset in between — that is the point.
    expect((await getClaudeCodeExecutableOverride())?.state).toBe("missing");
    expect(await getClaudeCodeExecutablePath()).toBe(onPath);
  });

  it("starts using an override whose binary appears after it was rejected", async () => {
    // Direction B. Reproduced as: card says "Override in effect", chats ignore
    // it. The resolver had cached its answer at a moment the path did not exist
    // and never looked again.
    const target = join(scratch, "later-claude");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: target });

    expect(await getClaudeCodeExecutablePath()).toBe(onPath);
    expect((await getClaudeCodeExecutableOverride())?.state).toBe("missing");

    writeFileSync(target, '#!/bin/sh\necho "2.1.238 (Claude Code)"\nexit 0\n');
    chmodSync(target, 0o755);

    expect((await getClaudeCodeExecutableOverride())?.state).toBe("active");
    expect(await getClaudeCodeExecutablePath()).toBe(target);
  });

  it("carries the checked override alongside the resolved path, even when it lost", async () => {
    // What lets the card distinguish a typo from a blank field: resolution falls
    // through to exactly where it would have gone with the field empty, so from
    // `path` alone the two states are identical.
    const typo = join(scratch, "nope");
    const onPath = executable("path-claude");
    mocks.which.mockReturnValue(`${onPath}\n`);
    updateAgentSettings({ pathToClaudeCodeExecutable: typo });

    expect(await resolveClaudeBinary()).toMatchObject({ path: onPath, source: "path", override: { path: typo, state: "missing" } });
  });

  it("still memoizes the expensive half — `which` runs once", async () => {
    // The guard on the fix. Reading the override fresh is one `stat`; re-running
    // `which claude` on every resolution would be a spawn per chat start.
    mocks.which.mockReturnValue(`${executable("path-claude")}\n`);

    await getClaudeCodeExecutablePath();
    await getClaudeCodeExecutablePath();
    await getClaudeCodeExecutablePath();
    expect(mocks.which).toHaveBeenCalledTimes(1);
  });

  it("looks again after a reset, so a freshly installed CLI is found", async () => {
    // `POST /api/engines/refresh`'s reason for existing.
    expect(await getClaudeCodeExecutablePath()).toBe(SYSTEM_CLAUDE);

    const installed = executable("path-claude");
    mocks.which.mockReturnValue(`${installed}\n`);
    resetClaudeBinaryCache();

    expect(await getClaudeCodeExecutablePath()).toBe(installed);
  });
});

describe("wellKnownClaudePaths", () => {
  it("follows $HOME rather than a value captured at import", async () => {
    expect(wellKnownClaudePaths()[0]).toBe(join(process.env.HOME!, ".local", "bin", "claude"));
  });
});

describe("off the event loop", () => {
  /**
   * The property item 4 exists for, asserted rather than described.
   *
   * A `which` is only fast while every entry on `PATH` is; one autofs mount or
   * one dead NFS export makes it arbitrarily slow. While this was
   * `execFileSync`, that cost did not land on the caller — it landed on the
   * whole process, because the server is single-threaded. Measured against a
   * daemon with a deliberately slow `which` (2.5s, under the 3s timeout, so this
   * is the stall the daemon *accepts* rather than the kill path): an unrelated
   * `/api/auth/check` took 2.42s and 2.70s on two of three samples, against a
   * 2ms baseline.
   *
   * The `timeout` was never a fix for that. It bounds a hung child, not a slow
   * one — and a bare `timeout` does not even bound a hung one, since Node sends
   * SIGTERM at the deadline and then waits indefinitely, which is why
   * `killSignal: "SIGKILL"` is there. Being async is the part that keeps the
   * cost on the caller.
   */
  it("lets other work run while the lookup is in flight", async () => {
    let released!: (path: string) => void;
    mocks.which.mockReturnValue(new Promise<string>((resolve) => (released = resolve)));

    const order: string[] = [];
    const resolution = resolveClaudeBinary().then((r) => {
      order.push("lookup");
      return r;
    });

    // A timer queued *after* the lookup started. Under `execFileSync` the
    // lookup would have completed before this line ever ran.
    await new Promise((r) => setTimeout(r, 0));
    order.push("other work");
    released(`${executable("path-claude")}\n`);

    await resolution;
    expect(order).toEqual(["other work", "lookup"]);
  });

  it("shares one probe between concurrent callers rather than racing several", async () => {
    // Three chats starting at once must not become three `which` spawns.
    let released!: (path: string) => void;
    mocks.which.mockReturnValue(new Promise<string>((resolve) => (released = resolve)));

    const all = Promise.all([getClaudeCodeExecutablePath(), getClaudeCodeExecutablePath(), getClaudeCodeExecutablePath()]);
    await new Promise((r) => setTimeout(r, 0));
    const bin = executable("path-claude");
    released(`${bin}\n`);

    expect(await all).toEqual([bin, bin, bin]);
    expect(mocks.which).toHaveBeenCalledTimes(1);
  });

  it("does not let a probe started before a reset write its answer afterwards", async () => {
    // Clearing a variable cannot cancel a promise already in flight, and the
    // ordering that loses is the likely one: a slow probe is the usual reason
    // someone pressed Recheck, so the stale answer tends to settle last and
    // would win for the rest of the process's life.
    const stale = executable("stale-claude");
    const fresh = executable("fresh-claude");

    let releaseStale!: (path: string) => void;
    mocks.which.mockReturnValue(new Promise<string>((resolve) => (releaseStale = resolve)));
    const first = resolveClaudeBinary();
    await new Promise((r) => setTimeout(r, 0));

    // The user presses Recheck mid-probe.
    resetClaudeBinaryCache();
    mocks.which.mockResolvedValue(`${fresh}\n`);
    expect((await resolveClaudeBinary()).path).toBe(fresh);

    // The pre-reset probe finally lands — and must not overwrite the answer.
    releaseStale(`${stale}\n`);
    await first;
    expect((await resolveClaudeBinary()).path).toBe(fresh);
  });
});

describe("adopting a stray `claude` must not take the daemon down", () => {
  /**
   * The regression this suite exists for, and the reason the probe is narrow.
   *
   * Widening the resolver to `$CLAUDE_BINARY` and the well-known directories
   * widened what gets handed to the Agent SDK as `pathToClaudeCodeExecutable` —
   * at boot (`sdk-info.ts`) and per chat (`claude.ts`). `checkBinaryPathAsync`
   * cannot tell "an executable named claude" from "a working Claude Code CLI",
   * and when the SDK writes to a child that has already exited the EPIPE is
   * uncaught, which `installProcessGuards` turns into process exit.
   *
   * Measured against an isolated daemon with a stub that echoes one line and
   * exits — `main` survived both, the widened resolver died on both:
   *
   *   stub in ~/.local/bin, not on PATH   3 uncaught, EXIT=1
   *   CLAUDE_BINARY=<stub>                3 uncaught, EXIT=1
   */
  it("ignores an inert executable in a well-known directory", async () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const stub = join(home, ".local", "bin", "claude");
    writeFileSync(stub, '#!/bin/sh\necho "not really claude"\nexit 0\n');
    chmodSync(stub, 0o755);

    // Nothing adopted — the SDK falls back to its bundled binary, which is
    // exactly what this daemon did before the resolvers were merged.
    expect((await resolveClaudeBinary()).path).toBe(SYSTEM_CLAUDE);
  });

  it("ignores an inert $CLAUDE_BINARY", async () => {
    process.env.CLAUDE_BINARY = inertExecutable("env-claude");
    expect((await resolveClaudeBinary()).path).toBe(SYSTEM_CLAUDE);
  });

  it("still adopts a real CLI in a well-known directory — the case the merge exists for", async () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const real = join(home, ".local", "bin", "claude");
    writeFileSync(real, '#!/bin/sh\necho "2.1.238 (Claude Code)"\nexit 0\n');
    chmodSync(real, 0o755);

    expect(await resolveClaudeBinary()).toMatchObject({ path: real, source: "well-known" });
  });

  it("still adopts a real $CLAUDE_BINARY", async () => {
    const real = executable("env-claude");
    process.env.CLAUDE_BINARY = real;
    expect(await resolveClaudeBinary()).toMatchObject({ path: real, source: "env" });
  });

  it("does NOT probe the two candidate kinds that predate the merge", async () => {
    // The asymmetry, asserted so it cannot be "tidied" into symmetry later.
    // Falling through would take away a binary the daemon used before this
    // change, which is a behaviour change in the opposite direction and is not
    // this commit's to make. A stray `claude` on PATH still takes the daemon
    // down; that is pre-existing and reported rather than half-fixed.
    const inertOnPath = inertExecutable("path-claude");
    mocks.which.mockReturnValue(`${inertOnPath}\n`);
    expect((await resolveClaudeBinary()).path).toBe(inertOnPath);

    resetClaudeBinaryCache();
    const inertOverride = inertExecutable("override-claude");
    updateAgentSettings({ pathToClaudeCodeExecutable: inertOverride });
    expect((await resolveClaudeBinary()).path).toBe(inertOverride);
  });
});
