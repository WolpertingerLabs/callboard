/**
 * `services/engine-install.ts` — the gates, and the gap between "npm exited 0"
 * and "this engine is installed".
 *
 * Two things are being pinned down here, and they are different kinds of thing.
 *
 * **The security shape is structural**, so it is asserted structurally: what
 * reaches `spawn` is the frozen argv from the registry, with no shell, for a
 * package in the closed allowlist — and no engine id, however hostile, can make
 * that untrue, because the id is only ever a lookup key. `engine-install-recipes.test.ts`
 * proves the registry side; this proves the call site honours it.
 *
 * **The honesty shape is behavioural.** Nine defects across three phases were
 * all one bug — the UI asserting something nothing checked — and an install
 * button raises the stakes because it changes the machine rather than describing
 * it. So the cases that matter most below are the ones where npm succeeds and
 * Callboard still must not say "Installed": a zero exit with no binary the
 * daemon can find, and a re-probe that failed. Both are refusals with reasons,
 * and both are asserted to *not* produce a success string.
 *
 * The child process is stubbed so the exit codes and the output chunking are
 * exact. Real `npm install -g` runs against a scratch prefix were done by hand
 * on a stripped daemon; a suite that spawns npm would be a network test.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { EngineInstallEvent, EngineStatus } from "shared/types/index.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileAsync: vi.fn(),
  getAgentSettings: vi.fn(),
  refreshEngineStatuses: vi.fn(),
  accessSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the module under test");
  };
  execFile[promisify.custom] = (...args: unknown[]) => mocks.execFileAsync(...args);
  return { ...(await importOriginal<typeof import("node:child_process")>()), spawn: mocks.spawn, execFile };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  accessSync: mocks.accessSync,
}));

vi.mock("./agent-settings.js", () => ({ getAgentSettings: mocks.getAgentSettings }));
vi.mock("./engine-status.js", () => ({ refreshEngineStatuses: mocks.refreshEngineStatuses }));

const {
  getInstallCapability,
  startEngineInstall,
  getInstallRun,
  installRunEvents,
  isInstallRunDone,
  subscribeToInstallRun,
  resetEngineInstallState,
} = await import("./engine-install.js");

// ── Child process double ────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

let child: FakeChild;

/** Wait for the microtask queue plus the stream's own delivery to settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The first event of a given type, narrowed — so an assertion about `refusal` fails to compile on an event that has none. */
function eventOfType<T extends EngineInstallEvent["type"]>(events: EngineInstallEvent[], type: T): Extract<EngineInstallEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<EngineInstallEvent, { type: T }> => e.type === type);
}

/** Every output line, in order, whichever stream it came from. */
const outputLines = (events: EngineInstallEvent[]) => events.filter((e) => e.type === "install_output").map((e) => e.line);

const opencodeInstalled = (path = "/home/u/.npm-global/bin/opencode"): EngineStatus => ({
  id: "opencode",
  label: "OpenCode",
  runtime: { kind: "external", command: "opencode", resolvedPath: path, package: "opencode-ai" },
  installed: true,
  version: "1.2.3",
  credentials: { configured: "unknown" },
});

const opencodeMissing = (): EngineStatus => ({
  id: "opencode",
  label: "OpenCode",
  runtime: { kind: "external", command: "opencode", package: "opencode-ai" },
  installed: false,
  credentials: { configured: "unknown" },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetEngineInstallState();
  child = new FakeChild();
  mocks.spawn.mockReturnValue(child);
  mocks.execFileAsync.mockResolvedValue({ stdout: "/home/u/.npm-global/lib/node_modules\n", stderr: "" });
  mocks.accessSync.mockReturnValue(undefined);
  mocks.getAgentSettings.mockReturnValue({});
  mocks.refreshEngineStatuses.mockResolvedValue({ engines: [opencodeInstalled()], probed: true });
});

afterEach(() => {
  resetEngineInstallState();
});

/** Start an install and collect every event it emits, including the replay buffer. */
async function runInstall(engineId = "opencode"): Promise<{ events: EngineInstallEvent[]; started: ReturnType<typeof startEngineInstall> }> {
  const events: EngineInstallEvent[] = [];
  const started = startEngineInstall({ engineId, capability: { oneClick: true }, clientKey: "127.0.0.1" });
  if (started.ok) {
    const run = getInstallRun(started.installId)!;
    events.push(...installRunEvents(run));
    subscribeToInstallRun(run, (e) => events.push(e));
  }
  await settle();
  return { events, started };
}

// ── Capability ──────────────────────────────────────────────────────

describe("getInstallCapability — every gate, and the sentence it hands the card", () => {
  it("permits a local client on a writable prefix", async () => {
    const capability = await getInstallCapability({ local: true });
    expect(capability.oneClick).toBe(true);
    expect(capability.refusal).toBeUndefined();
  });

  it("refuses a client outside the LAN before it looks at anything else", async () => {
    const capability = await getInstallCapability({ local: false });
    expect(capability).toMatchObject({ oneClick: false, code: "not-local" });
    expect(capability.refusal).toMatch(/local network/);
    // Cheapest and most decisive first: a tunnelled client must not cost this
    // daemon an `npm root -g` spawn per settings-page load.
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it("refuses when the operator has switched the capability off", async () => {
    mocks.getAgentSettings.mockReturnValue({ allowEngineInstalls: false });
    const capability = await getInstallCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "disabled" });
    expect(capability.refusal).toMatch(/switched off/);
  });

  it("treats an absent setting as on, which is the documented default", async () => {
    mocks.getAgentSettings.mockReturnValue({});
    expect((await getInstallCapability({ local: true })).oneClick).toBe(true);
  });

  it("refuses rather than defaulting on when the settings cannot be read", async () => {
    // The default is "on". Falling back to a default from an error would let a
    // box whose operator turned this off quietly turn it back on.
    mocks.getAgentSettings.mockImplementation(() => {
      throw new Error("settings file is corrupt");
    });
    const capability = await getInstallCapability({ local: true });
    expect(capability.oneClick).toBe(false);
    expect(capability.refusal).toMatch(/could not read its own settings/);
  });

  it("refuses when `npm root -g` cannot be run at all", async () => {
    mocks.execFileAsync.mockRejectedValue(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
    const capability = await getInstallCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "npm-unresolvable" });
    expect(capability.refusal).toContain("npm root -g");
  });

  it("refuses a non-writable global prefix, naming it, before anything is spawned", async () => {
    // The common failure on a system-wide Node, and the one the plan singles
    // out: running the command anyway produces an EACCES wall of text and no
    // install. Detected from one `access()` call.
    mocks.accessSync.mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    const capability = await getInstallCapability({ local: true });
    expect(capability).toMatchObject({ oneClick: false, code: "prefix-not-writable" });
    expect(capability.refusal).toContain("/home/u/.npm-global/lib/node_modules");
    expect(capability.refusal).toContain("EACCES");
  });

  it("walks up to the nearest existing directory rather than refusing a prefix npm would create", async () => {
    // A fresh `npm config set prefix ~/.npm-global` leaves lib/node_modules
    // absent until the first global install. Refusing on ENOENT would refuse
    // exactly the users who had just followed the caveat's own advice.
    const seen: string[] = [];
    mocks.accessSync.mockImplementation((dir: string) => {
      seen.push(dir);
      if (dir.includes("node_modules") || dir.endsWith("/lib")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect((await getInstallCapability({ local: true })).oneClick).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("caches `npm root -g` but re-checks writability every time", async () => {
    await getInstallCapability({ local: true });
    await getInstallCapability({ local: true });
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1);
    // A chmod should be believed on the next page load, not the next restart.
    expect(mocks.accessSync.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Refusals at start ───────────────────────────────────────────────

describe("startEngineInstall — refusing without spawning", () => {
  it("refuses when the capability says no, and passes its reason through", () => {
    const result = startEngineInstall({
      engineId: "opencode",
      capability: { oneClick: false, code: "not-local", refusal: "You are on the tunnel." },
    });
    expect(result).toMatchObject({ ok: false, code: "not-local", refusal: "You are on the tunnel.", status: 403 });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("answers a preflight refusal with 422 rather than 403 — it is not a permission problem", () => {
    const result = startEngineInstall({ engineId: "opencode", capability: { oneClick: false, code: "prefix-not-writable", refusal: "not writable" } });
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("refuses a bundled engine, which has no runnable recipe and never will", () => {
    for (const engineId of ["cline", "pi"]) {
      const result = startEngineInstall({ engineId, capability: { oneClick: true } });
      expect(result).toMatchObject({ ok: false, code: "no-recipe", status: 404 });
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("refuses every id that is not an engine, without building a command from it", () => {
    for (const engineId of ["", "..", "opencode-ai", "npm", "opencode; rm -rf /", "$(id)", "../../codex"]) {
      const result = startEngineInstall({ engineId, capability: { oneClick: true } });
      expect(result.ok).toBe(false);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("runs one install at a time", async () => {
    const first = startEngineInstall({ engineId: "opencode", capability: { oneClick: true } });
    expect(first.ok).toBe(true);
    const second = startEngineInstall({ engineId: "codex", capability: { oneClick: true } });
    expect(second).toMatchObject({ ok: false, code: "busy", status: 409 });
    expect(second.ok === false && second.refusal).toContain("opencode-ai");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("accepts a new install once the previous one has finished", async () => {
    await runInstall("opencode");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    await settle();

    child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    expect(startEngineInstall({ engineId: "codex", capability: { oneClick: true } }).ok).toBe(true);
  });
});

// ── What actually gets spawned ──────────────────────────────────────

describe("the spawn itself", () => {
  it("runs the registry's literal argv, with no shell", async () => {
    await runInstall("opencode");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toEqual(["install", "-g", "opencode-ai"]);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("selects each engine's own package and nothing else", async () => {
    for (const [engineId, pkg] of [
      ["opencode", "opencode-ai"],
      ["codex", "@openai/codex"],
      ["claude-code", "@anthropic-ai/claude-code"],
    ] as const) {
      resetEngineInstallState();
      child = new FakeChild();
      mocks.spawn.mockReturnValue(child);
      await runInstall(engineId);
      expect(mocks.spawn.mock.calls.at(-1)![1]).toEqual(["install", "-g", pkg]);
    }
  });

  it("quiets npm's decoration through the environment, never through argv", async () => {
    // Colour codes and a progress spinner replayed as text are unreadable, and
    // argv is not available for tuning — it is the thing being kept literal.
    await runInstall();
    const options = mocks.spawn.mock.calls[0][2];
    expect(options.env.NO_COLOR).toBe("1");
    expect(options.env.npm_config_progress).toBe("false");
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["install", "-g", "opencode-ai"]);
  });

  it("announces what it is about to run before it runs it", async () => {
    const { events, started } = await runInstall();
    expect(started.ok).toBe(true);
    expect(events[0]).toMatchObject({ type: "install_started", engineId: "opencode", package: "opencode-ai", command: "npm install -g opencode-ai" });
  });
});

// ── Output ──────────────────────────────────────────────────────────

describe("output", () => {
  it("splits on newlines across chunk boundaries", async () => {
    const { events } = await runInstall();
    child.stdout.write("added 1 pac");
    await settle();
    child.stdout.write("kage\nin 2s\n");
    await settle();
    expect(outputLines(events)).toEqual(["added 1 package", "in 2s"]);
  });

  it("strips ANSI escapes and carriage returns", async () => {
    const { events } = await runInstall();
    child.stdout.write("[32madded[0m 1 package\r\n");
    await settle();
    expect(outputLines(events)).toEqual(["added 1 package"]);
  });

  it("keeps stderr distinguishable without recolouring it as a failure", async () => {
    // npm writes notices to stderr as a matter of course, so the stream is
    // recorded and the *card* renders both the same. Tagging stderr as a
    // warning would invent a severity npm did not claim.
    const { events } = await runInstall();
    child.stderr.write("npm notice something\n");
    await settle();
    expect(events.filter((e) => e.type === "install_output")).toEqual([{ type: "install_output", stream: "stderr", line: "npm notice something" }]);
  });

  it("flushes a trailing line with no newline when the process ends", async () => {
    const { events } = await runInstall();
    child.stdout.write("no trailing newline");
    await settle();
    child.emit("close", 0, null);
    await settle();
    expect(outputLines(events)).toContain("no trailing newline");
  });

  it("bounds a single runaway line rather than buffering it forever", async () => {
    const { events } = await runInstall();
    child.stdout.write("x".repeat(9_000));
    await settle();
    const line = outputLines(events)[0] ?? "";
    expect(line.length).toBeLessThan(4_000);
    expect(line).toContain("truncated");
  });
});

// ── The verdict ─────────────────────────────────────────────────────

describe("a non-zero exit", () => {
  it("is terminal, carries a reason, and never reaches a verification step", async () => {
    const { events } = await runInstall();
    child.stderr.write("npm ERR! code E404\n");
    await settle();
    child.emit("close", 1, null);
    await settle();

    const exit = eventOfType(events, "install_exit")!;
    expect(exit).toMatchObject({ ok: false, code: 1 });
    expect(exit.refusal).toContain("exited with code 1");
    // The user is sent back to the copy block by name.
    expect(exit.refusal).toContain("npm install -g opencode-ai");
    expect(events.some((e) => e.type === "install_verified")).toBe(false);
    expect(mocks.refreshEngineStatuses).not.toHaveBeenCalled();
  });

  it("says a killed install was killed, rather than reporting a code it does not have", async () => {
    const { events } = await runInstall();
    child.emit("close", null, "SIGKILL");
    await settle();
    const exit = eventOfType(events, "install_exit")!;
    expect(exit.refusal).toContain("SIGKILL");
    expect(exit.refusal).toContain("ten-minute limit");
  });

  it("reports a spawn that never started as a spawn failure, naming npm", async () => {
    const { events } = await runInstall();
    child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
    await settle();
    const exit = eventOfType(events, "install_exit")!;
    expect(exit).toMatchObject({ ok: false, code: null });
    expect(exit.refusal).toContain("could not start `npm`");
    expect(exit.refusal).toContain("PATH the daemon inherited");
    expect(events.some((e) => e.type === "install_verified")).toBe(false);
  });

  it("does not emit a second terminal event when close follows error", async () => {
    const { events } = await runInstall();
    child.emit("error", new Error("boom"));
    await settle();
    child.emit("close", 1, null);
    await settle();
    expect(events.filter((e) => e.type === "install_exit")).toHaveLength(1);
  });
});

describe("a zero exit — which is not, on its own, a success", () => {
  it("says nothing about the engine until it has looked", async () => {
    const { events } = await runInstall();
    child.emit("close", 0, null);
    await settle();

    const exit = eventOfType(events, "install_exit")!;
    expect(exit).toMatchObject({ ok: true, code: 0 });
    // The whole point: an `install_exit` that succeeded carries no verdict,
    // because "npm wrote files" and "this daemon can run it" are different
    // claims and the second one is the one a user cares about.
    expect(exit.refusal).toBeUndefined();
    expect(exit).not.toHaveProperty("summary");
  });

  it("re-probes past the throttle, because a fast install can finish inside it", async () => {
    await runInstall();
    child.emit("close", 0, null);
    await settle();
    expect(mocks.refreshEngineStatuses).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("claims an install only when the re-probe found the binary, and names where", async () => {
    const { events } = await runInstall();
    child.emit("close", 0, null);
    await settle();

    const verified = eventOfType(events, "install_verified")!;
    expect(verified).toMatchObject({ visible: true, engineId: "opencode" });
    expect(verified.refusal).toBeUndefined();
    expect(verified.summary).toContain("/home/u/.npm-global/bin/opencode");
    expect(verified.summary).toContain("1.2.3");
    expect(verified.engines).toHaveLength(1);
  });

  it("refuses to call it installed when the daemon still cannot find it", async () => {
    // The nvm / PATH-inheritance case: npm really did install it, and this
    // process really cannot see it. A tick here would be the worst string this
    // feature could ship — a success message for a machine that did not change
    // in any way the user can use.
    mocks.refreshEngineStatuses.mockResolvedValue({ engines: [opencodeMissing()], probed: true });
    const { events } = await runInstall();
    child.emit("close", 0, null);
    await settle();

    const verified = eventOfType(events, "install_verified")!;
    expect(verified.visible).toBe(false);
    expect(verified.refusal).toBeTruthy();
    expect(verified.summary).toBe(verified.refusal);
    expect(verified.summary).toContain("exited 0");
    expect(verified.summary).toContain("callboard restart");
    expect(verified.summary).not.toMatch(/^Installed/);
  });

  it("counts a user-typeable CLI as visible even when Callboard would not run it", async () => {
    // Codex: chats keep using the bundled binary either way, and the install's
    // entire purpose is making `codex login` a command the user has. Reporting
    // that as "not visible" would deny the thing that just happened.
    mocks.refreshEngineStatuses.mockResolvedValue({
      engines: [
        {
          id: "codex",
          label: "Codex",
          runtime: { kind: "bundled-overridable", package: "@openai/codex-sdk" },
          installed: true,
          userCliPath: "/home/u/.npm-global/bin/codex",
          credentials: { configured: false },
        } satisfies EngineStatus,
      ],
      probed: true,
    });
    const { events } = await runInstall("codex");
    child.emit("close", 0, null);
    await settle();
    const verified = eventOfType(events, "install_verified")!;
    expect(verified.visible).toBe(true);
    expect(verified.summary).toContain("`codex`");
    expect(verified.summary).toContain("/home/u/.npm-global/bin/codex");
  });

  it("admits it when the re-probe itself failed, rather than assuming either way", async () => {
    mocks.refreshEngineStatuses.mockRejectedValue(new Error("probe exploded"));
    const { events } = await runInstall();
    child.emit("close", 0, null);
    await settle();
    const verified = eventOfType(events, "install_verified")!;
    expect(verified.visible).toBe(false);
    expect(verified.refusal).toContain("could not re-check");
    expect(verified.engines).toEqual([]);
  });

  it("admits it when the re-probe answered without this engine in it", async () => {
    mocks.refreshEngineStatuses.mockResolvedValue({ engines: [], probed: true });
    const { events } = await runInstall();
    child.emit("close", 0, null);
    await settle();
    const verified = eventOfType(events, "install_verified")!;
    expect(verified.visible).toBe(false);
    expect(verified.refusal).toContain("could not find this engine");
  });
});

// ── Replay ──────────────────────────────────────────────────────────

describe("replay, so a late or reconnecting stream loses nothing", () => {
  it("keeps the whole transcript and the verdict after the run is done", async () => {
    const started = startEngineInstall({ engineId: "opencode", capability: { oneClick: true } });
    expect(started.ok).toBe(true);
    const installId = started.ok ? started.installId : "";
    child.stdout.write("added 1 package\n");
    await settle();
    child.emit("close", 0, null);
    await settle();

    const run = getInstallRun(installId)!;
    expect(isInstallRunDone(run)).toBe(true);
    const types = installRunEvents(run).map((e) => e.type);
    expect(types).toEqual(["install_started", "install_output", "install_exit", "install_verified"]);
  });

  it("does not hand out a run under the wrong id", async () => {
    const started = startEngineInstall({ engineId: "opencode", capability: { oneClick: true } });
    expect(getInstallRun("not-the-id")).toBeNull();
    expect(started.ok && getInstallRun(started.installId)).toBeTruthy();
  });

  it("caps the buffer while keeping the frame that says what was run", async () => {
    const started = startEngineInstall({ engineId: "opencode", capability: { oneClick: true } });
    const run = getInstallRun(started.ok ? started.installId : "")!;
    child.stdout.write(Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    await settle();

    const events = installRunEvents(run);
    expect(events.length).toBeLessThanOrEqual(900);
    expect(events[0].type).toBe("install_started");
    // The tail is what a user is looking at when something goes wrong.
    expect(outputLines(events).at(-1)).toBe("line 1999");
  });
});
