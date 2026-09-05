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
 *
 * ## What this harness gets wrong if it is not careful
 *
 * `npm install -g` rewrites the package directory **this daemon is running out
 * of**, in place. Production therefore cannot hold two independent versions:
 * before an install, "what this process is running" and "what is in the package
 * directory" are one file with one value, and after it they diverge in exactly
 * one way — disk moves, the process does not.
 *
 * The first version of this suite modelled neither. It passed `fromVersion:
 * SELF_VERSION` into `startSelfUpdate` while the global manifest said `9.9.9`
 * from the very first line, so the two were decoupled by construction and
 * *always* unequal. Every assertion about `changed` therefore passed for the
 * wrong reason, and the bug that lived in that decoupling — a second press
 * reading the same overwritten file on both sides and reporting "nothing to
 * restart into" — was structurally unreachable from here.
 *
 * Two things fix it, and the first is not in this file: `startSelfUpdate` has no
 * `fromVersion` parameter any more, so no test can supply one. The second is
 * {@link seedInstalled} — the global manifest starts at the version this process
 * is running, and only {@link npmInstalls} moves it, which is the one event that
 * moves it in production.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  activeSelfUpdateId,
  assertSelfUpdateArgv,
  describeRestartPending,
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
const { npmInstallInFlight, selfRestartPending } = await import("./npm-global-install.js");
const { sessionRegistry } = await import("./session-registry.js");

/**
 * This repository — the same `../../..` the module under test resolves from its
 * own location, and therefore the directory its install-source gate compares
 * against.
 */
const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF_VERSION = JSON.parse(readFileSync(join(SELF_ROOT, "package.json"), "utf-8")).version as string;

/**
 * A package directory to play "npm rewrote this underneath us" against.
 *
 * `describeRestartPending` defaults to the real `__pkgRoot`, and the state it
 * detects is a *changed manifest* there — so the obvious test writes to this
 * repository's own `package.json` and restores it. That is a trap twice over:
 * vitest runs files concurrently and `BOOT_MANIFEST` is read at module load by
 * everything that imports `self-update.ts` or `index.ts`, so a sibling suite
 * starting inside the write window boots with an unreadable manifest and refuses
 * with `package-unreadable` for no visible reason; and a run interrupted between
 * the write and the `finally` leaves `{ not json` in the checkout. The parameter
 * exists so neither can happen.
 */
const REPLACED_ROOT = mkdtempSync(join(tmpdir(), "callboard-self-update-replaced-"));

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
 * The state every daemon starts in: the package directory holds the version the
 * process is running out of it.
 *
 * Not a detail. This is a *constraint* production cannot violate — it is one
 * file — and a suite that seeds a different version there has quietly arranged
 * a state no daemon can boot into, and is asserting against it.
 */
function seedInstalled(): void {
  writeGlobalPackage(SELF_VERSION);
}

/**
 * npm exits 0, having written `version` into the global package directory.
 *
 * The only thing in this suite that may move that version, because it is the
 * only thing in production that moves it. `extra` is for the manifest-shape
 * cases (a `bin` that points outside the package, and so on).
 */
async function npmInstalls(version: string, extra: Record<string, unknown> = {}): Promise<void> {
  writeGlobalPackage(version, extra);
  await exitNpm(0);
}

/** A plausible next release. Newer than anything this repo has been tagged. */
const NEXT_VERSION = "9.9.9";

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
  seedInstalled();
});

afterAll(() => {
  rmSync(PREFIX, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPLACED_ROOT, { recursive: true, force: true });
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
  seedInstalled();
  writeFileSync(PID_FILE, `${process.pid}\n`);
});

afterEach(() => {
  resetSelfUpdateState();
  for (const chatId of Object.keys(sessionRegistry.getAll())) sessionRegistry.unregister(chatId);
});

/**
 * Start an update and collect every event it emits, including the replay buffer.
 *
 * Note what is *not* here: a `fromVersion`. The service has no parameter for it
 * — the version being replaced is the one this process booted on, and a test
 * that could state a different one would be testing a machine that cannot exist.
 */
async function runUpdate(): Promise<{ events: SelfUpdateEvent[]; started: ReturnType<typeof startSelfUpdate> }> {
  const events: SelfUpdateEvent[] = [];
  const started = startSelfUpdate({
    capability: { oneClick: true },
    source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
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

/**
 * The *last* frame of a type.
 *
 * `update_verified` is emitted twice on the deferred path — once as `pending`
 * before the restart beat, once as `refused` when the work-in-flight re-check
 * inside it says no — and the second one is the verdict.
 */
function lastEventOfType<T extends SelfUpdateEvent["type"]>(events: SelfUpdateEvent[], type: T): Extract<SelfUpdateEvent, { type: T }> | undefined {
  return events.filter((e): e is Extract<SelfUpdateEvent, { type: T }> => e.type === type).pop();
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
    expect(source).toMatchObject({ globalPackageRoot: GLOBAL_PACKAGE_ROOT, runningFrom: SELF_ROOT, isGlobalInstall: true, isLinked: false });
  });

  it("refuses an `npm link`ed checkout, which the realpath comparison lets through", async () => {
    // The one way a checkout passes the gate: `npm link` makes the global entry
    // a symlink *into* the working tree, so both sides resolve to the same
    // directory. Pressing the button would delete that link, install a
    // published package over it, and restart from somewhere else entirely.
    const linkedRoot = join(GLOBAL_ROOT, "@wolpertingerlabs", "linked-callboard");
    rmSync(linkedRoot, { force: true, recursive: true });
    symlinkSync(SELF_ROOT, linkedRoot);
    mocks.realpathSync.mockImplementation((p: string) => (String(p) === linkedRoot ? SELF_ROOT : String(p)));
    mocks.execFileAsync.mockResolvedValue({ stdout: `${GLOBAL_ROOT}\n`, stderr: "" });
    try {
      const source = await resolveInstallSource("@wolpertingerlabs/linked-callboard");
      expect(source).toMatchObject({ isGlobalInstall: true, isLinked: true });

      // And the capability refuses on it, with a sentence that says what
      // happened rather than the "you are running from a checkout" one, which
      // would be describing a directory comparison that passed.
      const pkg = selfPackage()!;
      mocks.realpathSync.mockImplementation((p: string) => (String(p) === GLOBAL_PACKAGE_ROOT ? SELF_ROOT : String(p)));
      symlinkSync(SELF_ROOT, `${GLOBAL_PACKAGE_ROOT}.link`);
      rmSync(GLOBAL_PACKAGE_ROOT, { force: true, recursive: true });
      renameSync(`${GLOBAL_PACKAGE_ROOT}.link`, GLOBAL_PACKAGE_ROOT);

      const capability = await getSelfUpdateCapability({ local: true });
      expect(capability).toMatchObject({ oneClick: false, code: "not-global-install" });
      expect(capability.refusal).toContain("symlink");
      expect(capability.refusal).toContain(`npm link`);
      expect(capability.refusal).toContain(pkg.name);
    } finally {
      rmSync(linkedRoot, { force: true, recursive: true });
      rmSync(GLOBAL_PACKAGE_ROOT, { force: true, recursive: true });
      writeGlobalPackage("9.9.9");
    }
  });
});

/**
 * A missing PID file is a **restart** gate, not a capability gate.
 *
 * It used to refuse the button outright, with a sentence that said "it can
 * install the new version, but" and then offered no way to do that — to
 * systemd, pm2, Docker and every `--foreground` run. Callboard already has a
 * first-class "installed, did not restart" outcome, and this is that situation
 * known in advance, so it is now declared up front and honoured at the end.
 */
describe("the restart gate — a daemon that cannot restart itself can still install", () => {
  it("still offers the button when no PID file exists, and says the restart is not included", async () => {
    rmSync(PID_FILE, { force: true });
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability.oneClick).toBe(true);
    expect(capability.restart).toBe("unavailable");
    expect(capability.refusal).toBeUndefined();
    // The note names the file it looked for, so "why is it saying this" is
    // answerable without reading the source.
    expect(capability.note).toContain(PID_FILE);
    expect(capability.note).toContain("callboard restart");
  });

  it("declares it for a PID file naming some other process", async () => {
    // A stale file from a previous daemon, or a second Callboard sharing this
    // data directory. `callboard stop` would SIGTERM that pid, and this process
    // would carry on running the old code.
    writeFileSync(PID_FILE, `${process.pid + 1}\n`);
    expect(await getSelfUpdateCapability({ local: true })).toMatchObject({ oneClick: true, restart: "unavailable" });
  });

  it("declares it on an unparseable PID file rather than assuming it is ours", async () => {
    writeFileSync(PID_FILE, "not-a-pid\n");
    expect(await getSelfUpdateCapability({ local: true })).toMatchObject({ oneClick: true, restart: "unavailable" });
  });

  it("says nothing about the restart when the PID file does name this process", async () => {
    const capability = await getSelfUpdateCapability({ local: true });
    expect(capability.restart).toBeUndefined();
    // The shared preflight's own PATH note is still here — this fixture's prefix
    // is a temp directory that is not on PATH — and that is the point of the
    // assertion below: only the *restart* half is absent.
    expect(capability.note ?? "").not.toContain(PID_FILE);
  });

  it("keeps the shared preflight's note as well as its own", async () => {
    // Two true-but-survivable things at once. They are joined rather than one
    // overwriting the other: the banner renders this as a sentence, and the nvm
    // or PATH warning is not less true because the restart is also unavailable.
    rmSync(PID_FILE, { force: true });
    const note = (await getSelfUpdateCapability({ local: true })).note ?? "";
    expect(note).toContain("not on the PATH this Callboard daemon inherited");
    expect(note).toContain(PID_FILE);
  });

  it("installs, then refuses the restart with the sentence it promised", async () => {
    rmSync(PID_FILE, { force: true });
    const { events } = await runUpdate();
    await npmInstalls(NEXT_VERSION);
    await sleep(700);

    const verified = lastEventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ restart: "refused", changed: true, installedVersion: NEXT_VERSION });
    // The install is real and is worth having — leading with the failure would
    // read as "the update did not work".
    expect(verified.restartRefusal).toContain(`v${NEXT_VERSION} is installed`);
    expect(verified.restartRefusal).toContain(PID_FILE);
    // And nothing was signalled: no helper spawn, so npm's is the only one.
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(eventOfType(events, "update_restarting")).toBeUndefined();
  });

  it("re-checks at the end rather than trusting the declaration it made at the start", async () => {
    // The pid file was there when the button rendered and is gone by the time
    // npm finishes. A promise made up front is not a licence for the code that
    // follows it to skip the check.
    await runUpdate();
    rmSync(PID_FILE, { force: true });
    await npmInstalls(NEXT_VERSION);
    await sleep(700);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
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

  it("refuses a package name that would read as a flag", () => {
    // The check's own comment says the name "is checked rather than trusted",
    // and the pattern used to admit a leading `-` — npm's grammar does, but an
    // argv does not care about npm's grammar. Not a live vulnerability (the
    // value comes from this daemon's own manifest), and exactly the kind of hole
    // that makes the sentence above false.
    for (const name of ["--force", "-g", "--registry=http://example.invalid", "@scope/-x", "-x"]) {
      expect(assertSelfUpdateArgv(["npm", "install", "-g", name], name)).toBe(false);
    }
    // And the grammar it must keep: hyphens anywhere but the front, scopes, dots.
    for (const name of ["@wolpertingerlabs/callboard", "my-fork", "a.b-c_d", "@scope/pkg-name"]) {
      expect(assertSelfUpdateArgv(["npm", "install", "-g", name], name)).toBe(true);
    }
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
      source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(result).toMatchObject({ ok: false, code: "not-local", refusal: "You are on the tunnel.", status: 403 });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("answers a machine-state refusal with 422 rather than 403", () => {
    const result = startSelfUpdate({
      capability: { oneClick: false, code: "not-global-install", refusal: "running from a checkout" },
      source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("runs one update at a time", async () => {
    await runUpdate();
    expect(isSelfUpdateRunning()).toBe(true);
    const second = startSelfUpdate({
      capability: { oneClick: true },
      source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(second).toMatchObject({ ok: false, code: "busy", status: 409 });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("defers to an engine install already holding npm's global tree", () => {
    mocks.isInstallRunning.mockReturnValue(true);
    const result = startSelfUpdate({
      capability: { oneClick: true },
      source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
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
    await npmInstalls(NEXT_VERSION);
    const exit = eventOfType(events, "update_exit")!;
    expect(exit).toMatchObject({ ok: true, code: 0 });
    expect(exit.refusal).toBeUndefined();
    // The claim lives in the *next* event, and it names the version npm wrote.
    expect(eventOfType(events, "update_verified")).toMatchObject({ installedVersion: NEXT_VERSION, changed: true, restart: "pending" });
  });

  it("does not restart when npm had nothing newer to install", async () => {
    // npm exits 0 having changed nothing, which is the ordinary shape of "you
    // are already on latest": the manifest still says what this process booted
    // on.
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
    await npmInstalls(NEXT_VERSION);
    await sleep(700);

    const verified = lastEventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ restart: "refused", changed: true, installedVersion: NEXT_VERSION });
    expect(verified.restartRefusal).toContain("chat-abc");
    // The install still happened and is still worth having — the sentence says
    // so, because the alternative reads as "the update failed".
    expect(verified.restartRefusal).toContain(`v${NEXT_VERSION} is installed`);
    expect(verified.restartRefusal).toContain("callboard restart");
    // And the thing that is easy to leave out of that sentence: npm replaced
    // `frontend/dist` in place, so this daemon is already serving the new
    // interface out of the old backend.
    expect(verified.restartRefusal).toContain("already being served");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    // Nothing announced a restart it then declined.
    expect(eventOfType(events, "update_restarting")).toBeUndefined();
  });

  it("re-checks for work inside the restart beat, not before it", async () => {
    // The gap this closes: the check used to run before the 500ms delay, and
    // the helper then paid its own Node boot before signalling — a second or
    // so in which a chat could start and be killed mid-turn. Nothing is busy
    // when npm exits here; something is by the time the timer fires.
    const { events } = await runUpdate();
    await npmInstalls(NEXT_VERSION);

    expect(eventOfType(events, "update_verified")).toMatchObject({ restart: "pending" });
    sessionRegistry.register("chat-late", { type: "web" });
    await sleep(700);

    expect(lastEventOfType(events, "update_verified")).toMatchObject({ restart: "refused" });
    expect(lastEventOfType(events, "update_verified")!.restartRefusal).toContain("chat-late");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("counts a running job run with no web session behind it", async () => {
    mocks.listRuns.mockReturnValue([{ runId: "run-1", jobName: "nightly-sweep", status: "running" }]);
    const { events } = await runUpdate();
    await npmInstalls(NEXT_VERSION);
    await sleep(700);
    const verified = lastEventOfType(events, "update_verified")!;
    expect(verified).toMatchObject({ restart: "refused" });
    expect(verified.restartRefusal).toContain("nightly-sweep");
  });

  it("names a streaming chat by its title rather than its uuid", async () => {
    // `describeWorkInFlight` reads the title out of the record's metadata blob,
    // the same reading `chat-lineage.ts` makes. A summary that names a raw
    // UUID does not tell the user which of their chats to wait for.
    const chatId = "11111111-2222-3333-4444-555555555555";
    mkdirSync(join(DATA_DIR, "chats"), { recursive: true });
    writeFileSync(
      join(DATA_DIR, "chats", `${chatId}.json`),
      JSON.stringify({ id: chatId, session_id: chatId, folder: "/tmp", metadata: JSON.stringify({ title: "Reticulating splines" }) }),
    );
    try {
      sessionRegistry.register(chatId, { type: "web" });
      const work = describeWorkInFlight();
      expect(work.busy).toBe(true);
      expect(work.summary).toContain("Reticulating splines");
      expect(work.summary).not.toContain(chatId);
    } finally {
      rmSync(join(DATA_DIR, "chats", `${chatId}.json`), { force: true });
    }
  });

  it("falls back to the id for a chat it cannot name", () => {
    sessionRegistry.register("no-such-chat", { type: "web" });
    expect(describeWorkInFlight().summary).toContain("no-such-chat");
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
    writeGlobalPackage(NEXT_VERSION, { bin: { callboard: "../../../../etc/passwd" } });
    expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBeNull();
  });

  it("refuses a bin that resolves to the package root itself", () => {
    // `"."` resolves to a directory that exists, so the existence check passes
    // it — and `node <packageRoot>` runs the package's own main entry, which
    // is a second Callboard server, in the foreground, holding the port the
    // restart was meant to free. Strictly inside the root, or nothing.
    for (const bin of [".", "./", ""]) {
      writeGlobalPackage(NEXT_VERSION, { bin: { callboard: bin } });
      expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBeNull();
    }
  });

  it("refuses a package with no bin at all", () => {
    mkdirSync(GLOBAL_PACKAGE_ROOT, { recursive: true });
    writeFileSync(join(GLOBAL_PACKAGE_ROOT, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: NEXT_VERSION }));
    expect(resolveRestartHelper(GLOBAL_PACKAGE_ROOT)).toBeNull();
  });

  it("spawns the new package's CLI, detached, and says so before it does", async () => {
    process.env.PORT = "8123";
    try {
      const { events } = await runUpdate();

      // What the client had been told at the moment the helper's spawn was
      // called. The frame has to be *in* the transcript before the spawn — the
      // helper's first act is to signal this pid, and an SSE frame written
      // after that is a client left waiting on a stream that never speaks
      // again.
      let typesAtSpawn: string[] = [];
      mocks.spawn.mockImplementation(() => {
        typesAtSpawn = events.map((e) => e.type);
        return child;
      });

      await npmInstalls(NEXT_VERSION);
      // Nothing announced yet: the restart is not committed to until the beat
      // below has re-checked for work in flight.
      expect(eventOfType(events, "update_restarting")).toBeUndefined();
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      await sleep(700);
      expect(typesAtSpawn).toContain("update_restarting");

      const restarting = eventOfType(events, "update_restarting")!;
      expect(restarting).toMatchObject({ helper: HELPER, installedVersion: NEXT_VERSION, fromVersion: SELF_VERSION });
      expect(restarting.rollbackCommand).toBe(`npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`);

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
    await npmInstalls(NEXT_VERSION);
    await sleep(700);
    expect(mocks.spawn.mock.calls[1][1]).toEqual([HELPER, "restart"]);
  });

  it("records the version it is replacing, for a daemon that does not come back", async () => {
    await runUpdate();
    await npmInstalls(NEXT_VERSION);
    const state = JSON.parse(readFileSync(join(DATA_DIR, "self-update.json"), "utf-8"));
    expect(state).toMatchObject({
      package: PACKAGE_NAME,
      previousVersion: SELF_VERSION,
      installedVersion: NEXT_VERSION,
      rollbackCommand: `npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`,
    });
  });

  it("says so, and stays alive, when the helper cannot be spawned", async () => {
    const { events } = await runUpdate();
    // npm's spawn succeeded; the helper's does not.
    mocks.spawn.mockImplementation(() => {
      throw new Error("EPERM");
    });
    await npmInstalls(NEXT_VERSION);
    await sleep(700);
    const failed = eventOfType(events, "update_restart_failed")!;
    expect(failed).toBeTruthy();
    expect(failed.refusal).toContain("callboard restart");
    expect(failed.rollbackCommand).toBe(`npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`);
  });

  it("says so when the helper fails *after* the spawn returned", async () => {
    // The failure that actually happens. `spawn` throws synchronously only for
    // a bad argument; EACCES on the cwd, ENOENT, EAGAIN and EMFILE under fork
    // pressure all arrive later as an `error` event on the child. Without a
    // listener Node rethrows that as an uncaught exception, the process guards
    // call `process.exit(1)`, and the outcome is the worst this feature has:
    // the daemon gone, no helper running, and the client never told, because
    // the spawn had already been reported as a success.
    const { events } = await runUpdate();
    const helperChild = new FakeChild();
    mocks.spawn.mockReturnValue(helperChild);
    await npmInstalls(NEXT_VERSION);
    await sleep(700);

    expect(eventOfType(events, "update_restart_failed")).toBeUndefined();
    expect(helperChild.listenerCount("error")).toBe(1);

    helperChild.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    await settle();

    const failed = eventOfType(events, "update_restart_failed")!;
    expect(failed).toBeTruthy();
    expect(failed.refusal).toContain("EACCES");
    expect(failed.refusal).toContain("callboard restart");
    expect(failed.rollbackCommand).toBe(`npm install -g ${PACKAGE_NAME}@${SELF_VERSION}`);
  });
});

// ── The hand-over window ────────────────────────────────────────────

describe("the 500ms between npm finishing and the daemon being stopped", () => {
  it("is still busy, so a second POST cannot spawn npm underneath the pending restart", async () => {
    await runUpdate();
    await npmInstalls(NEXT_VERSION);

    // npm is over — `run.done` is set — but the restart timer is armed. A
    // second update accepted here would spawn its own npm while the first
    // run's timer SIGTERMed the daemon in the middle of its writes.
    expect(isSelfUpdateRunning()).toBe(true);
    const second = startSelfUpdate({
      capability: { oneClick: true },
      source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(second).toMatchObject({ ok: false, code: "busy", status: 409 });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    // And the restart the first run scheduled still happens.
    await sleep(700);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("still names the run in flight, so a second tab attaches to it", async () => {
    const { started } = await runUpdate();
    await npmInstalls(NEXT_VERSION);
    expect(activeSelfUpdateId()).toBe(started.ok ? started.updateId : undefined);
  });

  it("refuses a second update while it cools down, rather than looping npm", async () => {
    await runUpdate();
    await exitNpm(1);
    const second = startSelfUpdate({
      capability: { oneClick: true },
      source: { packageName: PACKAGE_NAME, globalPackageRoot: GLOBAL_PACKAGE_ROOT },
    });
    expect(second).toMatchObject({ ok: false, code: "cooling-down", status: 429 });
    expect(second.ok === false && second.refusal).toContain("second");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});

// ── The retry ───────────────────────────────────────────────────────

/**
 * "Press this again when things are idle" — the escape hatch the deferred
 * restart tells every user about, and which could not work.
 *
 * `changed` compared a freshly-read `fromVersion` against a freshly-read
 * `installedVersion`. On the second press both reads hit the same file, which
 * npm had already rewritten on the *first* press, so they agreed, `changed` came
 * out false, and the run reported `restart: "skipped"` — "there is nothing to
 * restart into" — after a thirty-second npm run, while the daemon carried on
 * executing the old code. The only way out was `callboard restart` in a
 * terminal, which is the thing this feature exists to remove.
 *
 * The old suite could not have caught it: `runUpdate()` passed `fromVersion:
 * SELF_VERSION` while the global manifest said `9.9.9`, so the two sides were
 * decoupled in a way production cannot be. They are one value here.
 */
describe("pressing the button again after a deferred restart", () => {
  it("restarts, rather than reporting there is nothing to restart into", async () => {
    // First press: a chat is streaming, so the install lands and the restart is
    // declined by name.
    sessionRegistry.register("chat-busy", { type: "web" });
    const first = await runUpdate();
    await npmInstalls(NEXT_VERSION);
    await sleep(700);
    expect(lastEventOfType(first.events, "update_verified")).toMatchObject({ restart: "refused", changed: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    // The chat ends. The user takes the advice in the sentence they were given.
    sessionRegistry.unregister("chat-busy");
    // Past the cooldown, which exists for loops and not for this retry.
    resetSelfUpdateState();
    child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    // Second press. npm has nothing left to do — the new version is already on
    // disk — and that is precisely the state the bug lived in.
    const second = await runUpdate();
    await exitNpm(0);

    const verified = lastEventOfType(second.events, "update_verified")!;
    expect(verified).toMatchObject({ installedVersion: NEXT_VERSION, changed: true, restart: "pending" });
    expect(verified.summary).not.toContain("nothing to restart into");

    await sleep(700);
    // The helper actually ran. This is the assertion the whole finding is about.
    expect(eventOfType(second.events, "update_restarting")).toMatchObject({ installedVersion: NEXT_VERSION, helper: HELPER });
    const helperCall = mocks.spawn.mock.calls.find((c) => c[0] === process.execPath);
    expect(helperCall?.[1]).toEqual([HELPER, "restart"]);
  });

  it("still says nothing changed when nothing has, on disk or in this process", async () => {
    // The other half of the same comparison, and the reason it cannot simply be
    // deleted: an install that genuinely fetched nothing must not restart.
    const { events } = await runUpdate();
    await exitNpm(0);
    await sleep(700);
    expect(lastEventOfType(events, "update_verified")).toMatchObject({ changed: false, restart: "skipped" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});

// ── New code on disk that this process is not running ───────────────

describe("describeRestartPending", () => {
  it("is quiet when the package directory holds the version this process booted on", () => {
    expect(describeRestartPending()).toMatchObject({ pending: false, runningVersion: SELF_VERSION, installedVersion: SELF_VERSION });
  });

  it("notices files replaced underneath a daemon that never asked for them", () => {
    // The second-daemon case: one global install, two `CALLBOARD_DATA_DIR`s,
    // two ports. Its sibling updates, npm rewrites the tree under both, and
    // nothing restarts this one. Every other gate in the module is about *this*
    // process and passes; this is the only check that can see it at all.
    //
    // Driven against {@link REPLACED_ROOT} rather than the real `__pkgRoot` —
    // see that constant. The running side is still genuinely this process's.
    writeFileSync(join(REPLACED_ROOT, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: NEXT_VERSION }));
    expect(describeRestartPending(REPLACED_ROOT)).toMatchObject({ pending: true, runningVersion: SELF_VERSION, installedVersion: NEXT_VERSION });
  });

  it("claims nothing when the manifest cannot be read at all", () => {
    writeFileSync(join(REPLACED_ROOT, "package.json"), "{ not json");
    // Not `pending: true`. "Could not read it" is not evidence that it moved.
    expect(describeRestartPending(REPLACED_ROOT)).toMatchObject({ pending: false });
  });
});

// ── The lock, in the window where npm is not running ────────────────

describe("an engine install must not start inside the hand-over", () => {
  it("is refused between npm finishing and the SIGTERM landing", async () => {
    await runUpdate();
    await npmInstalls(NEXT_VERSION);

    // npm has exited, so the marker it held is clear and `isInstallRunning()`
    // is false — the two questions `startEngineInstall` used to ask. The
    // restart is still coming, and `gracefulShutdown` would orphan an install
    // accepted here mid-write of the global tree.
    expect(npmInstallInFlight()).toBeNull();
    expect(selfRestartPending()).toContain("self-update");

    await sleep(700);
    // And it stays set through the spawn: the correct answer for the seconds
    // before this process is killed is still "do not start writing".
    expect(selfRestartPending()).not.toBeNull();
  });

  it("is released when the restart is declined, because the tree is free again", async () => {
    sessionRegistry.register("chat-busy", { type: "web" });
    await runUpdate();
    await npmInstalls(NEXT_VERSION);
    expect(selfRestartPending()).not.toBeNull();
    await sleep(700);
    expect(selfRestartPending()).toBeNull();
  });

  it("is released when the helper could not be spawned", async () => {
    await runUpdate();
    mocks.spawn.mockImplementation(() => {
      throw new Error("EPERM");
    });
    await npmInstalls(NEXT_VERSION);
    await sleep(700);
    expect(selfRestartPending()).toBeNull();
  });

  it("is released by the grace timer when the helper spawns and the daemon lives on", async () => {
    // The gap the two tests above leave: `spawn` succeeded, so there is no
    // failure path, and this process was not killed, so the "seconds before we
    // die" argument for holding the marker has quietly stopped being true. The
    // helper ran the *new* `bin/callboard.js` and it threw at import, or its
    // `cmdStop` failed before it signalled this pid — Node reports neither.
    // Without the timer the marker is held for the life of the process, and
    // every later engine install is refused for a restart that never comes.
    //
    // Only `setTimeout` is faked, so `settle()`'s `setImmediate` still works and
    // the update runs for real up to the spawn.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await runUpdate();
      await npmInstalls(NEXT_VERSION);
      expect(selfRestartPending()).not.toBeNull();

      // The restart beat (500ms), then the grace (60s) — the same two constants
      // the module holds privately, spelled out here the way `sleep(700)` is
      // everywhere else in this file.
      await vi.advanceTimersByTimeAsync(700);
      expect(mocks.spawn.mock.calls.some((c) => c[0] === process.execPath)).toBe(true);
      // Still held immediately after the spawn: the ordinary hand-over is a
      // second or two, and this must not open a window inside it.
      expect(selfRestartPending()).not.toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(selfRestartPending()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a running engine install as work a restart would destroy", () => {
    // The other direction of the same hazard: a restart kills an engine install
    // as surely as it kills a chat turn, so `describeWorkInFlight` has to say so.
    mocks.isInstallRunning.mockReturnValue(true);
    const work = describeWorkInFlight();
    expect(work.busy).toBe(true);
    expect(work.summary).toContain("engine install");
  });
});

// ── Sentences that are rendered, not just logged ────────────────────

describe("titles interpolated into a refusal", () => {
  it("strips backticks, which the banner splits on to render code spans", async () => {
    // `UpdateBanner.tsx` splits the sentence on backticks and wraps the odd
    // segments in `<code>`. One stray backtick from a chat title — routine in a
    // coding tool — flips the parity of everything after it, so the rest of the
    // refusal renders as a single code span.
    const chatId = "22222222-3333-4444-5555-666666666666";
    mkdirSync(join(DATA_DIR, "chats"), { recursive: true });
    writeFileSync(
      join(DATA_DIR, "chats", `${chatId}.json`),
      JSON.stringify({ id: chatId, session_id: chatId, folder: "/tmp", metadata: JSON.stringify({ title: "fix the `useEffect deps" }) }),
    );
    try {
      sessionRegistry.register(chatId, { type: "web" });
      const summary = describeWorkInFlight().summary;
      expect(summary).toContain("fix the useEffect deps");
      // The invariant, stated as the renderer sees it: an even number of
      // backticks, so every code span the sentence opens is one it closed.
      expect(summary.split("`").length % 2).toBe(1);
    } finally {
      rmSync(join(DATA_DIR, "chats", `${chatId}.json`), { force: true });
    }
  });

  it("collapses a multi-line preview into one line before clipping it", async () => {
    // The fallback for a chat with no title is `preview`, which is a whole first
    // user message. `card-rollup.ts` normalises the same reading; this took the
    // reading and not the normalisation.
    const chatId = "33333333-4444-5555-6666-777777777777";
    mkdirSync(join(DATA_DIR, "chats"), { recursive: true });
    writeFileSync(
      join(DATA_DIR, "chats", `${chatId}.json`),
      JSON.stringify({ id: chatId, session_id: chatId, folder: "/tmp", metadata: JSON.stringify({ preview: "please fix\n\n  the build\n" }) }),
    );
    try {
      sessionRegistry.register(chatId, { type: "web" });
      const summary = describeWorkInFlight().summary;
      expect(summary).toContain("please fix the build");
      expect(summary).not.toContain("\n");
    } finally {
      rmSync(join(DATA_DIR, "chats", `${chatId}.json`), { force: true });
    }
  });

  it("normalises a job run's title too — same sentence, same renderer", () => {
    mocks.listRuns.mockReturnValue([{ runId: "run-1", title: "rebuild `frontend", status: "running" }]);
    const summary = describeWorkInFlight().summary;
    expect(summary).toContain("rebuild frontend");
    expect(summary.split("`").length % 2).toBe(1);
  });

  it("falls back to the id when a title normalises away to nothing", () => {
    mocks.listRuns.mockReturnValue([{ runId: "run-blank", title: "  ``  ", status: "running" }]);
    expect(describeWorkInFlight().summary).toContain("run-blank");
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
