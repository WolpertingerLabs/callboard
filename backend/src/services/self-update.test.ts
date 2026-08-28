/**
 * `services/self-update.ts` — the two gates that decide whether the button is
 * honest, and the one that decides whether the restart is safe.
 *
 * Three properties are being pinned down, and only the first is shared with the
 * engine installer next door:
 *
 * **The argv is structural.** What reaches `spawn` is `["npm", "install", "-g",
 * <this package>]` with no shell, and the package name comes from the daemon's
 * own manifest. Nothing in a request can change any of it — there is no
 * parameter to change.
 *
 * **The install-source gate is the whole feature.** `npm install -g` upgrades
 * whatever is under `npm root -g`. If that is not this daemon, the install
 * succeeds, the restart happens, and nothing changes — which reads to a user as
 * a broken button rather than as the wrong machine being upgraded. So the
 * positive and negative cases are both driven here against a real directory
 * tree, with only `realpathSync` stubbed to stand in for the one thing a test
 * cannot arrange: a package directory that genuinely *is* this checkout.
 *
 * **A restart is destructive.** `gracefulShutdown` aborts in-flight agent turns,
 * so a streaming chat or a mid-step job run has to stop the restart — after the
 * install, which is harmless, and with a sentence naming what is busy.
 *
 * The child process is stubbed so exit codes and output chunking are exact, and
 * so that a regression cannot install a package onto the machine running the
 * suite. The restart helper is the same stub, which is what lets the "did it
 * spawn a detached helper, from the *new* path" assertion exist at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { SelfUpdateEvent } from "shared/types/index.js";

// Must be set before anything imports `utils/paths.js`, which reads it at
// module scope.
const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-self-update-data-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

/** A fake npm prefix, laid out the way npm lays one out. */
const PREFIX = mkdtempSync(join(tmpdir(), "callboard-self-update-prefix-"));
const GLOBAL_ROOT = join(PREFIX, "lib", "node_modules");
const PACKAGE_NAME = "@wolpertingerlabs/callboard";
const GLOBAL_PACKAGE_ROOT = join(GLOBAL_ROOT, "@wolpertingerlabs", "callboard");
const HELPER = join(GLOBAL_PACKAGE_ROOT, "bin", "callboard.js");
const PID_FILE = join(DATA_DIR, "callboard.pid");

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileAsync: vi.fn(),
  realpathSync: vi.fn(),
  readAgentSettings: vi.fn(),
  isInstallRunning: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the module under test");
  };
  execFile[promisify.custom] = (...args: unknown[]) => mocks.execFileAsync(...args);
  return { ...(await importOriginal<typeof import("node:child_process")>()), spawn: mocks.spawn, execFile };
});

// Only `realpathSync`, and only so that the global package directory can be
// made to *be* this checkout — the one fact the install-source gate turns on and
// the one a test cannot arrange with real files. Everything else below is a real
// read of a real file.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  realpathSync: (...args: unknown[]) => mocks.realpathSync(...args),
}));

vi.mock("./agent-settings.js", () => ({ readAgentSettings: mocks.readAgentSettings }));
vi.mock("./engine-install.js", () => ({ isInstallRunning: mocks.isInstallRunning }));
vi.mock("./job-store.js", () => ({ listRuns: mocks.listRuns }));

const {
  assertSelfUpdateArgv,
  describeWorkInFlight,
  getSelfUpdateCapability,
  getSelfUpdateRun,
  isSelfUpdateRunning,
  resolveInstallSource,
  resolveRestartHelper,
  resetSelfUpdateState,
  selfPackage,
  selfUpdateCommand,
  selfUpdateRunEvents,
  startSelfUpdate,
  subscribeToSelfUpdateRun,
} = await import("./self-update.js");
const { sessionRegistry } = await import("./session-registry.js");

/**
 * This repository — the same `../../..` the module under test resolves from its
 * own location, and therefore the directory its install-source gate compares
 * against.
 */
const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF_VERSION = JSON.parse(readFileSync(join(SELF_ROOT, "package.json"), "utf-8")).version as string;

// ── Child process double ────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  unref = vi.fn();
  pid = 4242;
}

let child: FakeChild;

/** Wait for the microtask queue plus the stream's own delivery to settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write the global package's manifest — this is what npm is pretending to have installed. */
function writeGlobalPackage(version: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(GLOBAL_PACKAGE_ROOT, "bin"), { recursive: true });
  writeFileSync(HELPER, "#!/usr/bin/env node\n");
  writeFileSync(join(GLOBAL_PACKAGE_ROOT, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version, bin: { callboard: "bin/callboard.js" }, ...extra }));
}

/**
 * Make the global package directory resolve to this checkout — i.e. "Callboard
 * *is* the global install".
 *
 * Identity for every other path, which is what `realpathSync` would return here
 * anyway: nothing else in this suite goes through a symlink, and an identity
 * stub keeps the comparison the gate makes visible in one line.
 */
function pretendGloballyInstalled(yes: boolean): void {
  mocks.realpathSync.mockImplementation((p: string) => (String(p) === GLOBAL_PACKAGE_ROOT && yes ? SELF_ROOT : String(p)));
}

beforeAll(() => {
  writeGlobalPackage("9.9.9");
});

afterAll(() => {
  rmSync(PREFIX, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSelfUpdateState();
  child = new FakeChild();
  mocks.spawn.mockReturnValue(child);
  mocks.execFileAsync.mockResolvedValue({ stdout: `${GLOBAL_ROOT}\n`, stderr: "" });
  mocks.readAgentSettings.mockReturnValue({ settings: {}, state: "ok" });
  mocks.isInstallRunning.mockReturnValue(false);
  mocks.listRuns.mockReturnValue([]);
  pretendGloballyInstalled(true);
  writeGlobalPackage("9.9.9");
  writeFileSync(PID_FILE, `${process.pid}\n`);
});

afterEach(() => {
  resetSelfUpdateState();
  for (const chatId of Object.keys(sessionRegistry.getAll())) sessionRegistry.unregister(chatId);
});

/** Start an update and collect every event it emits, including the replay buffer. */
async function runUpdate(): Promise<{ events: SelfUpdateEvent[]; started: ReturnType<typeof startSelfUpdate> }> {
  const events: SelfUpdateEvent[] = [];
  const started = startSelfUpdate({
    capability: { oneClick: true },
    source: { packageName: PACKAGE_NAME, fromVersion: SELF_VERSION, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    clientKey: "127.0.0.1",
  });
  if (started.ok) {
    const run = getSelfUpdateRun(started.updateId)!;
    events.push(...selfUpdateRunEvents(run));
    subscribeToSelfUpdateRun(run, (e) => events.push(e));
  }
  await settle();
  return { events, started };
}

function eventOfType<T extends SelfUpdateEvent["type"]>(events: SelfUpdateEvent[], type: T): Extract<SelfUpdateEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<SelfUpdateEvent, { type: T }> => e.type === type);
}

/** Finish the child process the way npm would. */
async function exitNpm(code: number, signal: NodeJS.Signals | null = null): Promise<void> {
  child.emit("close", code, signal);
  await settle();
}

// ── The install-source gate ─────────────────────────────────────────

describe("the install-source gate — is this daemon the copy npm would replace?", () => {
  it("permits an update when the global package directory is this daemon", async () => {
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability.oneClick).toBe(true);
    expect(capability.refusal).toBeUndefined();
  });

  it("refuses from a checkout, and names both directories", async () => {
    pretendGloballyInstalled(false);
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "not-global-install" });
    // The two facts a developer needs to understand why there is no button:
    // where Callboard is running from, and where npm would have installed.
    expect(capability.refusal).toContain(SELF_ROOT);
    expect(capability.refusal).toContain(GLOBAL_PACKAGE_ROOT);
    expect(capability.refusal).toContain(`npm install -g ${PACKAGE_NAME}`);
  });

  it("refuses when npm's global root cannot be resolved at all", async () => {
    // The shared preflight refuses this first — the point of the assertion is
    // that the install-source check never gets to guess in its absence.
    mocks.execFileAsync.mockRejectedValue(new Error("spawn npm ENOENT"));
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "npm-unresolvable" });
  });

  it("reports the resolved pair without deciding anything", async () => {
    const source = await resolveInstallSource(PACKAGE_NAME);
    expect(source).toMatchObject({ globalPackageRoot: GLOBAL_PACKAGE_ROOT, runningFrom: SELF_ROOT, isGlobalInstall: true });
  });
});

describe("the restart gate — is there anything to restart?", () => {
  it("refuses when no PID file exists", async () => {
    rmSync(PID_FILE, { force: true });
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "no-pid-file" });
    expect(capability.refusal).toContain(PID_FILE);
  });

  it("refuses when the PID file names some other process", async () => {
    // A stale file from a previous daemon, or a second Callboard sharing this
    // data directory. `callboard stop` would SIGTERM that pid, and this process
    // would carry on running the old code.
    writeFileSync(PID_FILE, `${process.pid + 1}\n`);
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "no-pid-file" });
  });

  it("refuses on an unparseable PID file rather than assuming it is ours", async () => {
    writeFileSync(PID_FILE, "not-a-pid\n");
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "no-pid-file" });
  });
});

// ── Inherited capability refusals ───────────────────────────────────

describe("the shared preflight, inherited whole", () => {
  it("refuses a client outside the LAN before it looks at anything else", async () => {
    const capability = await getSelfUpdateCapability({ local: false });
    expect(capability).toMatchObject({ oneClick: false, code: "not-local" });
    expect(capability.refusal).toMatch(/connected directly to it/);
    // A tunnelled client must not cost this daemon an `npm root -g` spawn.
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it("honours the one-click install kill switch rather than inventing a second setting", async () => {
    mocks.readAgentSettings.mockReturnValue({ settings: { allowEngineInstalls: false }, state: "ok" });
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "disabled" });
    expect(capability.refusal).toMatch(/switched off/);
  });

  it("refuses when the settings file exists and cannot be read", async () => {
    mocks.readAgentSettings.mockReturnValue({ settings: {}, state: "unreadable", error: "EACCES" });
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "disabled" });
    expect(capability.refusal).toContain("EACCES");
  });
});

// ── The argv ────────────────────────────────────────────────────────

describe("what actually reaches spawn", () => {
  it("accepts only the four-element global-install argv for this package", () => {
    expect(assertSelfUpdateArgv(["npm", "install", "-g", PACKAGE_NAME], PACKAGE_NAME)).toBe(true);
    expect(assertSelfUpdateArgv(["npm", "install", "-g", "something-else"], PACKAGE_NAME)).toBe(false);
    expect(assertSelfUpdateArgv(["npm", "install", "-g", PACKAGE_NAME, "--force"], PACKAGE_NAME)).toBe(false);
    expect(assertSelfUpdateArgv(["npm", "exec", "-g", PACKAGE_NAME], PACKAGE_NAME)).toBe(false);
    expect(assertSelfUpdateArgv(["npm", "install", "-g", ""], "")).toBe(false);
    // A package.json whose `name` is not a package name at all never reaches npm.
    expect(assertSelfUpdateArgv(["npm", "install", "-g", "; rm -rf /"], "; rm -rf /")).toBe(false);
  });

  it("spawns npm with the frozen argv and no shell", async () => {
    await runUpdate();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toEqual(["install", "-g", PACKAGE_NAME]);
    expect(options).toMatchObject({ shell: false });
  });

  it("names the package from the daemon's own manifest, never from a caller", () => {
    const pkg = selfPackage();
    expect(pkg).toMatchObject({ name: PACKAGE_NAME, version: SELF_VERSION });
    expect(selfUpdateCommand(pkg!.name)).toBe(`npm install -g ${PACKAGE_NAME}`);
  });
});

// ── Starting one ────────────────────────────────────────────────────

describe("startSelfUpdate refusals", () => {
  it("passes a capability refusal straight through, with a permission code as 403", () => {
    const result = startSelfUpdate({
      capability: { oneClick: false, code: "not-local", refusal: "You are on the tunnel." },
      source: { packageName: PACKAGE_NAME, fromVersion: SELF_VERSION, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(result).toMatchObject({ ok: false, code: "not-local", refusal: "You are on the tunnel.", status: 403 });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("answers a machine-state refusal with 422 rather than 403", () => {
    const result = startSelfUpdate({
      capability: { oneClick: false, code: "not-global-install", refusal: "running from a checkout" },
      source: { packageName: PACKAGE_NAME, fromVersion: SELF_VERSION, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("runs one update at a time", async () => {
    await runUpdate();
    expect(isSelfUpdateRunning()).toBe(true);
    const second = startSelfUpdate({
      capability: { oneClick: true },
      source: { packageName: PACKAGE_NAME, fromVersion: SELF_VERSION, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(second).toMatchObject({ ok: false, code: "busy", status: 409 });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("defers to an engine install already holding npm's global tree", () => {
    mocks.isInstallRunning.mockReturnValue(true);
    const result = startSelfUpdate({
      capability: { oneClick: true },
      source: { packageName: PACKAGE_NAME, fromVersion: SELF_VERSION, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(result).toMatchObject({ ok: false, code: "busy", status: 409 });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

// ── The transcript ──────────────────────────────────────────────────

describe("the run", () => {
  it("opens with a frame naming what is running and what it replaces", async () => {
    const { events } = await runUpdate();
    expect(events[0]).toMatchObject({
      type: "update_started",
      package: PACKAGE_NAME,
      command: `npm install -g ${PACKAGE_NAME}`,
      fromVersion: SELF_VERSION,
    });
  });

  it("emits npm's output one line at a time", async () => {
    const { events } = await runUpdate();
    child.stdout.write("added 1 package\nchanged 2 packages\n");
    await settle();
    expect(events.filter((e) => e.type === "update_output").map((e) => e.line)).toEqual(["added 1 package", "changed 2 packages"]);
  });

  it("ends at update_exit on a non-zero exit, and restarts nothing", async () => {
    const { events } = await runUpdate();
    await exitNpm(1);
    const exit = eventOfType(events, "update_exit")!;
    expect(exit).toMatchObject({ ok: false, code: 1 });
    expect(exit.refusal).toContain("exited with code 1");
    expect(exit.refusal).toContain(`still running v${SELF_VERSION}`);
    expect(eventOfType(events, "update_verified")).toBeUndefined();
    // One spawn, npm's — no restart helper.
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("says a killed run installed nothing, rather than nothing at all", async () => {
    const { events } = await runUpdate();
    await exitNpm(null as unknown as number, "SIGKILL");
    const exit = eventOfType(events, "update_exit")!;
    expect(exit.refusal).toContain("SIGKILL");
    expect(exit.refusal).toContain("ten-minute limit");
  });

  it("claims nothing from a zero exit — the version is read off disk", async () => {
    const { events } = await runUpdate();
    await exitNpm(0);
    const exit = eventOfType(events, "update_exit")!;
    expect(exit).toMatchObject({ ok: true, code: 0 });
    expect(exit.refusal).toBeUndefined();
    // The claim lives in the *next* event, and it names the version npm wrote.
    expect(eventOfType(events, "update_verified")).toMatchObject({ installedVersion: "9.9.9", changed: true, restart: "pending" });
  });

  it("does not restart when npm had nothing newer to install", async () => {
    writeGlobalPackage(SELF_VERSION);
    const { events } = await runUpdate();
    await exitNpm(0);
    const verified = eventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ changed: false, restart: "skipped", installedVersion: SELF_VERSION });
    expect(verified.summary).toContain("nothing newer");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses to restart into a version it could not read", async () => {
    writeFileSync(join(GLOBAL_PACKAGE_ROOT, "package.json"), "{ this is not json");
    const { events } = await runUpdate();
    await exitNpm(0);
    const verified = eventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ restart: "refused", changed: false });
    expect(verified.restartRefusal).toContain("package.json");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("carries the way back on every verdict", async () => {
    const { events } = await runUpdate();
    await exitNpm(0);
    expect(eventOfType(events, "update_verified")!.rollbackCommand).toBe(`npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`);
  });
});

// ── Work in flight ──────────────────────────────────────────────────

describe("the restart waits for work to finish", () => {
  it("reports an idle daemon as idle", () => {
    expect(describeWorkInFlight()).toMatchObject({ busy: false });
  });

  it("refuses the restart while a chat is streaming, and names it", async () => {
    sessionRegistry.register("chat-abc", { type: "web" });
    const { events } = await runUpdate();
    await exitNpm(0);

    const verified = eventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ restart: "refused", changed: true, installedVersion: "9.9.9" });
    expect(verified.restartRefusal).toContain("chat-abc");
    // The install still happened and is still worth having — the sentence says
    // so, because the alternative reads as "the update failed".
    expect(verified.restartRefusal).toContain("v9.9.9 is installed");
    expect(verified.restartRefusal).toContain("callboard restart");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("counts a running job run with no web session behind it", async () => {
    mocks.listRuns.mockReturnValue([{ runId: "run-1", jobName: "nightly-sweep", status: "running" }]);
    const { events } = await runUpdate();
    await exitNpm(0);
    const verified = eventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ restart: "refused" });
    expect(verified.restartRefusal).toContain("nightly-sweep");
  });

  it("ignores CLI sessions, which a restart does not touch", async () => {
    sessionRegistry.register("chat-cli", { type: "cli" });
    expect(describeWorkInFlight()).toMatchObject({ busy: false });
  });

  it("refuses rather than guessing when the job store cannot be listed", () => {
    mocks.listRuns.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(describeWorkInFlight()).toMatchObject({ busy: true });
  });

  it("asks only for runs that are actually mid-step", () => {
    describeWorkInFlight();
    expect(mocks.listRuns).toHaveBeenCalledWith({ status: "running" });
  });
});

// ── The restart ─────────────────────────────────────────────────────

describe("handing the machine to a detached helper", () => {
  it("resolves the helper from the newly installed package, via its own bin field", () => {
    expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBe(HELPER);
  });

  it("refuses a bin that points outside its own package", () => {
    writeGlobalPackage("9.9.9", { bin: { callboard: "../../../../etc/passwd" } });
    expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBeNull();
  });

  it("refuses a package with no bin at all", () => {
    mkdirSync(GLOBAL_PACKAGE_ROOT, { recursive: true });
    writeFileSync(join(GLOBAL_PACKAGE_ROOT, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "9.9.9" }));
    expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBeNull();
  });

  it("spawns the new package's CLI, detached, and says so before it does", async () => {
    process.env.PORT = "8123";
    try {
      const { events } = await runUpdate();
      await exitNpm(0);

      // The client is told *first* — the socket dies with the process, so a
      // frame written after the helper starts may never be flushed.
      const restarting = eventOfType(events, "update_restarting")!;
      expect(restarting).toMatchObject({ helper: HELPER, installedVersion: "9.9.9", fromVersion: SELF_VERSION });
      expect(restarting.rollbackCommand).toBe(`npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`);
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      await sleep(700);
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      const [command, args, options] = mocks.spawn.mock.calls[1];
      expect(command).toBe(process.execPath);
      // The helper comes from `npm root -g`, not from this process's own package
      // root — npm replaced that directory in place moments ago.
      expect(args).toEqual([HELPER, "restart", "--port", "8123"]);
      // Its own process group, no inherited descriptors, and not holding this
      // event loop open: the helper's entire job runs after this process dies.
      expect(options).toMatchObject({ detached: true, stdio: "ignore" });
      expect(child.unref).toHaveBeenCalled();
    } finally {
      delete process.env.PORT;
    }
  });

  it("leaves the port to the CLI's own config when this daemon has none in its environment", async () => {
    delete process.env.PORT;
    await runUpdate();
    await exitNpm(0);
    await sleep(700);
    expect(mocks.spawn.mock.calls[1][1]).toEqual([HELPER, "restart"]);
  });

  it("records the version it is replacing, for a daemon that does not come back", async () => {
    await runUpdate();
    await exitNpm(0);
    const state = JSON.parse(readFileSync(join(DATA_DIR, "self-update.json"), "utf-8"));
    expect(state).toMatchObject({
      package: PACKAGE_NAME,
      previousVersion: SELF_VERSION,
      installedVersion: "9.9.9",
      rollbackCommand: `npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`,
    });
  });

  it("says so, and stays alive, when the helper cannot be spawned", async () => {
    const { events } = await runUpdate();
    // npm's spawn succeeded; the helper's does not.
    mocks.spawn.mockImplementation(() => {
      throw new Error("EPERM");
    });
    await exitNpm(0);
    await sleep(700);
    const failed = eventOfType(events, "update_restart_failed")!;
    expect(failed).toBeTruthy();
    expect(failed.refusal).toContain("callboard restart");
    expect(failed.rollbackCommand).toBe(`npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`);
  });
});

// ── Replay ──────────────────────────────────────────────────────────

describe("the retained run", () => {
  it("replays the whole transcript to a stream that connects late", async () => {
    const { started } = await runUpdate();
    child.stdout.write("added 1 package\n");
    await settle();
    await exitNpm(1);

    const run = getSelfUpdateRun(started.ok ? started.updateId : "")!;
    const types = selfUpdateRunEvents(run).map((e) => e.type);
    expect(types).toEqual(["update_started", "update_output", "update_exit"]);
  });

  it("does not hand out a run under someone else's id", async () => {
    const { started } = await runUpdate();
    expect(getSelfUpdateRun("not-the-id")).toBeNull();
    expect(started.ok && getSelfUpdateRun(started.updateId)).toBeTruthy();
  });

  it("keeps the helper's own existence check honest", () => {
    rmSync(HELPER, { force: true });
    expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBeNull();
    expect(existsSync(HELPER)).toBe(false);
  });
});
