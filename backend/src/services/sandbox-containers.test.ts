/**
 * Managed Sandbox desktops against an in-memory Docker CLI: the argument
 * vectors and their order, labels, owner isolation, the reaper, the cap,
 * timeouts, and the token file's permissions and removal. The host-level
 * test (computer-use.sandbox-managed.test.ts) covers every way a session ends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOX_INTERNAL_NETWORK, SANDBOX_NETWORK } from "@wolpertingerlabs/computer-use";
import { CHAT_LABEL, MANAGED_LABEL, OWNER_LABEL, SESSION_LABEL, SandboxContainerManager, managedSandboxDriver, sandboxOwnerId } from "./sandbox-containers.js";
import { resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { fakeDocker, fakeRemote, type FakeRemoteBehaviour } from "./__fixtures__/sandbox-docker.js";

const logged = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (message: string) => void logged.warn.push(message),
  }),
}));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(
  options: {
    settings?: Partial<ResolvedSandboxSettings>;
    remote?: FakeRemoteBehaviour;
    /** Share one fake remote between managers, as one container's host instance is the same to both. */
    remoteFake?: ReturnType<typeof fakeRemote>;
    expectedContent?: string;
    docker?: ReturnType<typeof fakeDocker>;
    dataDir?: string;
    helloTimeoutMs?: number;
    drainTimeoutMs?: number;
    onReady?: ConstructorParameters<typeof SandboxContainerManager>[0]["onReady"];
    adoptPaused?: ConstructorParameters<typeof SandboxContainerManager>[0]["adoptPaused"];
  } = {},
) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "cb-sandbox-mgr-")));
  dirs.push(dataDir);
  const docker = options.docker ?? fakeDocker();
  const remote = options.remoteFake ?? fakeRemote(options.remote);
  const settings: ResolvedSandboxSettings = { ...resolveSandboxSettings({}), ...options.settings };
  const manager = new SandboxContainerManager({
    docker: docker.run,
    dataDir,
    settings: () => settings,
    createRemoteDriver: remote.factory,
    helloTimeoutMs: options.helloTimeoutMs ?? 2_000,
    helloIntervalMs: 5,
    preflightCacheMs: 0,
    drainTimeoutMs: options.drainTimeoutMs,
    onReady: options.onReady,
    adoptPaused: options.adoptPaused,
    ...(options.expectedContent ? { expectedContent: () => options.expectedContent! } : {}),
    chatContext: (chatId) =>
      chatId === "chat-ws" ? { workspaceId: "ws-opaque-1", folder: "/work/repo" } : chatId === "chat-folder" ? { folder: "/work/plain" } : undefined,
  });
  return { manager, docker, remote, settings, dataDir };
}
const sid = () => randomUUID();
const commands = (docker: ReturnType<typeof fakeDocker>) => docker.state.calls.map((args) => args.slice(0, 2).join(" "));

describe("owner identity", () => {
  it("is stable per data directory, and differs between dev and production", () => {
    expect(sandboxOwnerId("/home/u/.callboard")).toBe(sandboxOwnerId("/home/u/.callboard"));
    expect(sandboxOwnerId("/home/u/.callboard")).toBe(sandboxOwnerId("/home/u/./.callboard/"));
    expect(sandboxOwnerId("/home/u/.callboard")).not.toBe(sandboxOwnerId("/home/u/.callboard-dev"));
    expect(sandboxOwnerId("/home/u/.callboard")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("start", () => {
  it("runs the steps in order with fixed argument vectors, hardened flags and our labels", async () => {
    const { manager, docker, remote, settings } = await setup({ settings: { cpus: 1.5, memoryMb: 2048 } });
    const sessionId = sid();
    const box = await manager.start({ sessionId, chatId: "chat-1", signal: new AbortController().signal });
    expect(commands(docker)).toEqual([
      "version --format",
      "network inspect",
      "network create",
      "network inspect",
      "image inspect",
      "run --detach",
      "port callboard-sandbox-" + manager.owner.slice(0, 8) + "-" + sessionId,
    ]);
    const runArgs = docker.state.calls.find((args) => args[0] === "run")!;
    for (const flag of [
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--rm",
      `--network=${SANDBOX_NETWORK}`,
      "--cpus=1.5",
      "--memory=2048m",
      "--memory-swap=2048m",
    ])
      expect(runArgs).toContain(flag);
    expect(runArgs[runArgs.indexOf("--publish") + 1]).toBe("127.0.0.1::7801");
    expect(runArgs.at(-1)).toBe("callboard/computer-use-desktop:local");
    const container = docker.state.containers.get(box.name)!;
    expect(container.labels).toEqual({ [MANAGED_LABEL]: "1", [OWNER_LABEL]: manager.owner, [CHAT_LABEL]: "chat-1", [SESSION_LABEL]: sessionId });
    // The network is ours: bridge, inter-container traffic off, labelled.
    expect(docker.state.networks.get(SANDBOX_NETWORK)).toMatchObject({ Internal: false, Options: { "com.docker.network.bridge.enable_icc": "false" } });
    // The remote driver gets the published loopback port and the token file, never the token.
    expect(remote.created).toHaveLength(1);
    expect(remote.created[0].url).toBe("http://127.0.0.1:40000");
    expect(remote.created[0].tokenFile).toBe(box.tokenFile);
    expect(remote.created[0].token).toBeUndefined();
    expect(remote.created[0].localDockerBridge).toBeUndefined();
    expect(runArgs.join(" ")).not.toContain(remote.created[0].tokenAtCreation.trim());
    expect(box.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(settings.maxConcurrent).toBe(2);
  });

  it("writes a fresh 0444 token in 0700 directories, one per session, and removes it with the container", async () => {
    const { manager, docker, remote, dataDir } = await setup();
    const a = await manager.start({ sessionId: sid(), chatId: "c", signal: new AbortController().signal });
    const b = await manager.start({ sessionId: sid(), chatId: "c", signal: new AbortController().signal });
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(join(dataDir, "sandbox-desktop"))).toBe(0o700);
    expect(mode(manager.sessionsDir)).toBe(0o700);
    expect(mode(a.dir)).toBe(0o700);
    expect(mode(a.tokenFile)).toBe(0o444);
    expect(remote.created[0].tokenAtCreation).toMatch(/^[0-9a-f]{64}\n$/);
    expect(remote.created[0].tokenAtCreation).not.toBe(remote.created[1].tokenAtCreation);
    // Mounted read-only at the image's token path.
    const runArgs = docker.state.containers.get(a.name)!.args;
    expect(runArgs[runArgs.indexOf("--mount") + 1]).toBe(`type=bind,source=${a.tokenFile},target=/run/computer-use/token,readonly`);
    await manager.destroy(a.sessionId);
    expect(existsSync(a.dir)).toBe(false);
    expect(docker.state.containers.has(a.name)).toBe(false);
    expect(existsSync(b.tokenFile)).toBe(true);
    expect(docker.state.containers.has(b.name)).toBe(true);
    expect(docker.state.calls.at(-1)).toEqual(["rm", "--force", a.name]);
  });

  it("network none: an --internal network, no published port, reached at the container's bridge address", async () => {
    const { manager, docker, remote } = await setup({ settings: { network: "none" } });
    const box = await manager.start({ sessionId: sid(), chatId: "c", signal: new AbortController().signal });
    const runArgs = docker.state.containers.get(box.name)!.args;
    expect(runArgs).not.toContain("--publish");
    expect(runArgs).toContain(`--network=${SANDBOX_INTERNAL_NETWORK}`);
    expect(docker.state.networks.get(SANDBOX_INTERNAL_NETWORK)).toMatchObject({ Internal: true, Options: { "com.docker.network.bridge.enable_icc": "false" } });
    expect(remote.created[0]).toMatchObject({ url: "http://172.30.0.5:7801", localDockerBridge: true });
  });

  it("refuses a misconfigured network of our name rather than using it, creating nothing", async () => {
    const docker = fakeDocker();
    docker.state.networks.set(SANDBOX_NETWORK, { Driver: "bridge", Internal: false, Options: {}, Labels: {} });
    const { manager } = await setup({ docker });
    await expect(manager.start({ sessionId: sid(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported", problem: "network" });
    expect(docker.state.calls.some((args) => args[0] === "run")).toBe(false);
    expect(manager.liveCount()).toBe(0);
  });

  it.each([
    ["Docker unreachable", (d: ReturnType<typeof fakeDocker>) => (d.state.reachable = false), "docker-unreachable"],
    ["image missing", (d: ReturnType<typeof fakeDocker>) => (d.state.imageLabels = null), "image-missing"],
    [
      "image of another protocol",
      (d: ReturnType<typeof fakeDocker>) => (d.state.imageLabels = { "dev.callboard.computer-use.protocol": "1.0" }),
      "image-incompatible",
    ],
    ["image without a protocol label", (d: ReturnType<typeof fakeDocker>) => (d.state.imageLabels = {}), "image-incompatible"],
  ])("%s: refused with a classified problem before anything is created", async (_name, breakIt, problem) => {
    const docker = fakeDocker();
    breakIt(docker);
    const { manager, dataDir } = await setup({ docker });
    const error = await manager.start({ sessionId: sid(), signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unsupported", problem });
    expect((error as Error).message).toMatch(problem.startsWith("image") ? /callboard sandbox build/ : /Docker/);
    expect(docker.state.calls.some((args) => args[0] === "run")).toBe(false);
    expect(existsSync(join(dataDir, "sandbox-desktop", "sessions")) ? await readdir(join(dataDir, "sandbox-desktop", "sessions")) : []).toEqual([]);
    expect(manager.liveCount()).toBe(0);
    // The probe says the same, for the Computer view.
    expect(await manager.probe()).toMatchObject({ available: false, reason: (error as Error).message });
    expect(manager.currentProblem()?.problem).toBe(problem);
  });

  it("times out a container that never answers /hello, and removes it and its token", async () => {
    const { manager, docker } = await setup({ remote: { neverAnswers: true }, helloTimeoutMs: 150 });
    const sessionId = sid();
    const error = await manager.start({ sessionId, signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "timeout" });
    expect(docker.state.containers.size).toBe(0);
    expect(existsSync(join(manager.sessionsDir, sessionId))).toBe(false);
    expect(manager.liveCount()).toBe(0);
  });

  it("waits through a few refused hellos while the desktop boots", async () => {
    const { manager } = await setup({ remote: { helloFailures: 5 } });
    const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    expect(box.instanceId).toBeTruthy();
  });

  it("never waits out a host that fails the proof (not our container)", async () => {
    const { manager, docker } = await setup({ remote: { denies: true }, helloTimeoutMs: 10_000 });
    const started = Date.now();
    await expect(manager.start({ sessionId: sid(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "denied" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(docker.state.containers.size).toBe(0);
  });

  it("notices a container that exited while starting", async () => {
    const docker = fakeDocker();
    const { manager } = await setup({ docker, remote: { helloFailures: 1000 } });
    const sessionId = sid();
    const starting = manager.start({ sessionId, signal: new AbortController().signal });
    // Let it get as far as waiting for the desktop, then the container dies (and --rm removes it).
    await vi.waitFor(() => expect(manager.containerState(sessionId)?.step).toBe("Waiting for the desktop"));
    docker.state.containers.clear();
    await expect(starting).rejects.toMatchObject({ code: "driver_error", message: expect.stringMatching(/exited while starting/) });
    expect(existsSync(join(manager.sessionsDir, sessionId))).toBe(false);
  });

  it("a cancelled start removes what it created", async () => {
    const { manager, docker } = await setup({ remote: { neverAnswers: true }, helloTimeoutMs: 10_000 });
    const controller = new AbortController();
    const sessionId = sid();
    const starting = manager.start({ sessionId, signal: controller.signal });
    await vi.waitFor(() => expect(manager.containerState(sessionId)?.step).toBe("Waiting for the desktop"));
    expect(docker.state.containers.size).toBe(1);
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: "cancelled" });
    expect(docker.state.containers.size).toBe(0);
    expect(existsSync(join(manager.sessionsDir, sessionId))).toBe(false);
    expect(manager.containerState(sessionId)).toEqual({ phase: "removed" });
  });

  it("a failed docker run leaves no token behind", async () => {
    const docker = fakeDocker();
    docker.state.runFailure = "port is already allocated";
    const { manager } = await setup({ docker });
    const sessionId = sid();
    await expect(manager.start({ sessionId, signal: new AbortController().signal })).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringMatching(/port is already allocated/),
    });
    expect(existsSync(join(manager.sessionsDir, sessionId))).toBe(false);
  });

  it("rejects a session id that is not a UUID before touching the disk or Docker", async () => {
    const { manager, docker } = await setup();
    await expect(manager.start({ sessionId: "../../etc", signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_request" });
    expect(docker.state.calls).toEqual([]);
  });

  it("labels an unusable chat id as unknown rather than passing it to Docker", async () => {
    const { manager, docker } = await setup();
    const box = await manager.start({ sessionId: sid(), chatId: "bad id,with=chars", signal: new AbortController().signal });
    expect(docker.state.containers.get(box.name)!.labels[CHAT_LABEL]).toBe("unknown");
  });
});

describe("concurrency cap", () => {
  it("refuses past the cap with a clear message, and frees the slot on removal", async () => {
    const { manager } = await setup({ settings: { maxConcurrent: 2 } });
    const a = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    const error = await manager.start({ sessionId: sid(), signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unsupported", problem: "cap-reached", message: expect.stringMatching(/2 sandbox desktops are already running/) });
    expect(await manager.probe()).toMatchObject({ available: false, reason: expect.stringMatching(/already running/) });
    expect((await manager.probe()).readiness).toBeUndefined();
    await manager.destroy(a.sessionId);
    await expect(manager.start({ sessionId: sid(), signal: new AbortController().signal })).resolves.toBeTruthy();
  });

  it("reserves the slot before the first await: concurrent starts cannot overshoot", async () => {
    const { manager, docker } = await setup({ settings: { maxConcurrent: 2 } });
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => manager.start({ sessionId: sid(), signal: new AbortController().signal })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.problem)).toEqual(["cap-reached", "cap-reached"]);
    expect(docker.state.containers.size).toBe(2);
  });
});

describe("destroy and the drain hook", () => {
  it("calls the drain hook just before removal, only for a sandbox that was ready, and removes even if it fails", async () => {
    const { manager, docker } = await setup();
    const order: string[] = [];
    manager.drainBeforeDestroy = vi.fn(async ({ sessionId }) => {
      order.push(`drain:${docker.state.containers.size}`);
      expect(manager.containerState(sessionId)).toEqual({ phase: "stopping" });
      throw new Error("outbox unreachable");
    });
    const ready = await manager.start({ sessionId: sid(), chatId: "chat-9", signal: new AbortController().signal });
    manager.ready(ready.sessionId);
    const notReady = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    await manager.destroy(ready.sessionId);
    order.push(`after:${docker.state.containers.size}`);
    expect(order).toEqual(["drain:2", "after:1"]);
    expect(manager.drainBeforeDestroy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: ready.sessionId, chatId: "chat-9" }), expect.any(AbortSignal));
    expect(vi.mocked(manager.drainBeforeDestroy).mock.calls[0][0]).not.toHaveProperty("workspaceId");
    await manager.destroy(notReady.sessionId);
    expect(manager.drainBeforeDestroy).toHaveBeenCalledTimes(1);
    expect(docker.state.containers.size).toBe(0);
  });

  it("hands the drain everything an outbox sync needs: the live driver (list/get with expectedSha256), chat, workspace or folder, instance, and a signal", async () => {
    const { manager, docker } = await setup();
    const seen: unknown[] = [];
    manager.drainBeforeDestroy = async (sandbox, signal) => {
      // The container is still there, and the driver can still reach the outbox.
      expect(docker.state.containers.size).toBe(1);
      expect(await sandbox.driver.listOutbox(signal)).toEqual([]);
      await expect(sandbox.driver.downloadOutboxFile("report.pdf", signal, { expectedSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "not_found" });
      expect(signal.aborted).toBe(false);
      seen.push({ ...sandbox, driver: typeof sandbox.driver.downloadOutboxFile });
    };
    for (const chatId of ["chat-ws", "chat-folder"]) {
      const box = await manager.start({ sessionId: sid(), chatId, signal: new AbortController().signal });
      manager.ready(box.sessionId);
      await manager.destroy(box.sessionId);
    }
    expect(seen).toEqual([
      {
        sessionId: expect.any(String),
        chatId: "chat-ws",
        workspaceId: "ws-opaque-1",
        folder: "/work/repo",
        driver: "function",
        instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        cause: "session-end",
      },
      {
        sessionId: expect.any(String),
        chatId: "chat-folder",
        folder: "/work/plain",
        driver: "function",
        instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        cause: "session-end",
      },
    ]);
  });

  it("aborts a drain that overruns its bound and removes the container anyway", async () => {
    const { manager, docker } = await setup({ drainTimeoutMs: 50 });
    let aborted = false;
    manager.drainBeforeDestroy = (_sandbox, signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => (aborted = true));
      });
    const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    manager.ready(box.sessionId);
    await manager.destroy(box.sessionId);
    expect(aborted).toBe(true);
    expect(docker.state.containers.size).toBe(0);
  });

  it("is idempotent and tolerates a container that is already gone", async () => {
    const { manager, docker } = await setup();
    const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    docker.state.containers.clear();
    await Promise.all([manager.destroy(box.sessionId), manager.destroy(box.sessionId)]);
    expect(docker.state.calls.filter((args) => args[0] === "rm")).toHaveLength(1);
    expect(existsSync(box.dir)).toBe(false);
    await manager.destroy(box.sessionId);
  });

  it("dispose removes every sandbox and refuses new ones", async () => {
    const { manager, docker } = await setup();
    await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    await manager.dispose();
    expect(docker.state.containers.size).toBe(0);
    await expect(manager.start({ sessionId: sid(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("reaper", () => {
  it("removes only this owner's orphans: never another owner's, never unlabelled, never a live session's", async () => {
    const docker = fakeDocker();
    const prod = await setup({ docker });
    const dev = await setup({ docker });
    expect(prod.manager.owner).not.toBe(dev.manager.owner);
    const live = await prod.manager.start({ sessionId: sid(), signal: new AbortController().signal });
    const devLive = await dev.manager.start({ sessionId: sid(), signal: new AbortController().signal });
    // A previous prod run's orphans: one with a session label, one without.
    const orphan = docker.foreign("orphan-1", { [MANAGED_LABEL]: "1", [OWNER_LABEL]: prod.manager.owner, [SESSION_LABEL]: randomUUID() });
    const unlabelledSession = docker.foreign("orphan-2", { [MANAGED_LABEL]: "1", [OWNER_LABEL]: prod.manager.owner });
    // Not ours, in every way that matters.
    docker.foreign("dev-orphan", { [MANAGED_LABEL]: "1", [OWNER_LABEL]: dev.manager.owner, [SESSION_LABEL]: randomUUID() });
    docker.foreign("someone-else", { "com.example.app": "db" });
    docker.foreign("unmanaged-but-owner", { [OWNER_LABEL]: prod.manager.owner });
    docker.foreign("managed-0", { [MANAGED_LABEL]: "0", [OWNER_LABEL]: prod.manager.owner });
    const removed = await prod.manager.reap();
    expect(removed.sort()).toEqual([orphan.id, unlabelledSession.id].sort());
    expect([...docker.state.containers.keys()].sort()).toEqual(
      [devLive.name, live.name, "dev-orphan", "managed-0", "someone-else", "unmanaged-but-owner"].sort(),
    );
    // The dev daemon reaps its own orphan, and leaves prod's live one.
    expect(await dev.manager.reap()).toHaveLength(1);
    expect(docker.state.containers.has(live.name)).toBe(true);
    expect(docker.state.containers.has("dev-orphan")).toBe(false);
  });

  it("checks labels itself even if Docker ignores the filters", async () => {
    const docker = fakeDocker({ ignoreFilters: true });
    const { manager } = await setup({ docker });
    docker.foreign("other-owner", { [MANAGED_LABEL]: "1", [OWNER_LABEL]: "0123456789abcdef", [SESSION_LABEL]: randomUUID() });
    docker.foreign("plain", {});
    const mine = docker.foreign("mine", { [MANAGED_LABEL]: "1", [OWNER_LABEL]: manager.owner });
    expect(await manager.reap()).toEqual([mine.id]);
    expect([...docker.state.containers.keys()].sort()).toEqual(["other-owner", "plain"]);
  });

  it("never sees a starting sandbox as an orphan", async () => {
    const { manager, docker } = await setup({ remote: { neverAnswers: true }, helloTimeoutMs: 10_000 });
    const controller = new AbortController();
    const sessionId = sid();
    const starting = manager.start({ sessionId, signal: controller.signal });
    await vi.waitFor(() => expect(manager.containerState(sessionId)?.step).toBe("Waiting for the desktop"));
    expect(await manager.reap()).toEqual([]);
    expect(docker.state.containers.size).toBe(1);
    controller.abort();
    await starting.catch(() => {});
  });

  it("removes token directories of sessions that are not live, and nothing else in that directory", async () => {
    const { manager } = await setup();
    const live = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    const stale = join(manager.sessionsDir, randomUUID());
    await mkdir(stale, { recursive: true });
    const unrelated = join(manager.sessionsDir, "notes");
    await mkdir(unrelated);
    await manager.reap();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(live.dir)).toBe(true);
  });

  it("after a daemon crash (a new manager on the same data directory), reaps the old run's containers", async () => {
    const docker = fakeDocker();
    const first = await setup({ docker });
    const box = await first.manager.start({ sessionId: sid(), signal: new AbortController().signal });
    // The process dies: its in-memory state is gone, the container is not.
    const second = await setup({ docker, dataDir: first.dataDir });
    expect(second.manager.owner).toBe(first.manager.owner);
    const id = docker.state.containers.get(box.name)!.id;
    expect(await second.manager.reap()).toEqual([id]);
    expect(docker.state.containers.size).toBe(0);
    expect(existsSync(box.dir)).toBe(false);
  });
});

describe("managedSandboxDriver", () => {
  it("opens on the container it started, binds consent to that instance, and removes the container on close", async () => {
    const { manager, docker, remote } = await setup();
    const driver = managedSandboxDriver(manager);
    expect(driver.lockScope).toBe("session");
    expect(await driver.identity()).toEqual({ instanceId: "managed-container" });
    const sessionId = sid();
    const session = await driver.open({ sessionId, ownerId: "chat-1", signal: new AbortController().signal });
    expect(manager.containerState(sessionId)).toEqual({ phase: "ready" });
    expect(driver.openedInstance(sessionId)).toBe("managed-container");
    expect(driver.openedInstance(sid())).toBeUndefined();
    expect([...docker.state.containers.values()][0].labels[CHAT_LABEL]).toBe("chat-1");
    await session.close();
    expect(remote.closed).toEqual([sessionId]);
    expect(docker.state.containers.size).toBe(0);
    expect(driver.openedInstance(sessionId)).toBeUndefined();
  });

  it("fails closed when the session opens on another instance than the one that proved the token", async () => {
    const { manager, docker } = await setup({ remote: { openOn: randomUUID() } });
    const driver = managedSandboxDriver(manager);
    await expect(driver.open({ sessionId: sid(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported" });
    expect(docker.state.containers.size).toBe(0);
  });
});

describe("image freshness (review round 1, finding 2)", () => {
  it("an image without the current content digest still starts, with an out-of-date warning; another protocol major is refused", async () => {
    const docker = fakeDocker({
      imageLabels: {
        "dev.callboard.computer-use.protocol": "2.0",
        "dev.callboard.computer-use.content": "old",
        "dev.callboard.computer-use.security-floor": "1",
      },
    });
    const { manager } = await setup({ docker, expectedContent: "new" });
    expect(await manager.probe()).toMatchObject({ available: true });
    expect(manager.currentWarning()).toMatchObject({ warning: "image-outdated", hint: expect.stringMatching(/callboard sandbox build/) });
    await expect(manager.start({ sessionId: sid(), signal: new AbortController().signal })).resolves.toBeTruthy();
    expect((await manager.diagnostics()).image).toMatchObject({ present: true, compatible: true, current: false, content: "old", expectedContent: "new" });
    docker.state.imageLabels = {
      "dev.callboard.computer-use.protocol": "2.0",
      "dev.callboard.computer-use.content": "new",
      "dev.callboard.computer-use.security-floor": "1",
    };
    await manager.probe();
    expect(manager.currentWarning()).toBeUndefined();
    expect((await manager.diagnostics()).image.current).toBe(true);
    docker.state.imageLabels = { "dev.callboard.computer-use.protocol": "3.0", "dev.callboard.computer-use.content": "new" };
    expect(await manager.probe()).toMatchObject({ available: false, readiness: "unsupported" });
  });

  it("an image from before the content label reads as out of date, not current", async () => {
    const { manager } = await setup({ expectedContent: "new" });
    await manager.probe();
    expect(manager.currentWarning()?.hint).toMatch(/an older/);
  });
});

describe("drains that survive a crash (review round 1, finding 3)", () => {
  const readMeta = async (dir: string) => JSON.parse(await readFile(join(dir, "session.json"), "utf8"));

  it("persists the session's metadata beside its token, 0600, completed once the container answers", async () => {
    const { manager } = await setup({ settings: { network: "none" } });
    const box = await manager.start({ sessionId: sid(), chatId: "chat-ws", signal: new AbortController().signal });
    const meta = await readMeta(box.dir);
    expect(meta).toEqual({
      version: 1,
      sessionId: box.sessionId,
      chatId: "chat-ws",
      workspaceId: "ws-opaque-1",
      folder: "/work/repo",
      name: box.name,
      network: SANDBOX_INTERNAL_NETWORK,
      internal: true,
      url: "http://172.30.0.5:7801",
      instanceId: box.instanceId,
      createdAt: expect.any(Number),
    });
    expect(statSync(join(box.dir, "session.json")).mode & 0o777).toBe(0o600);
    expect((await readdir(box.dir)).sort()).toEqual(["session.json", "token"]);
    await manager.destroy(box.sessionId);
    expect(existsSync(box.dir)).toBe(false);
  });

  it("a new daemon's reaper drains a crashed run's sandbox from its metadata, then removes it", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const first = await setup({ docker, remoteFake: remote });
    const box = await first.manager.start({ sessionId: sid(), chatId: "chat-ws", signal: new AbortController().signal });
    first.manager.ready(box.sessionId);
    // The daemon is killed: no destroy, no drain. A new one starts on the same data directory.
    const second = await setup({ docker, remoteFake: remote, dataDir: first.dataDir });
    const drained: unknown[] = [];
    second.manager.drainBeforeDestroy = async (sandbox, signal) => {
      expect(docker.state.containers.size).toBe(1);
      await sandbox.driver.listOutbox(signal);
      drained.push({ ...sandbox, driver: undefined });
    };
    expect(await second.manager.reap()).toHaveLength(1);
    expect(drained).toEqual([
      {
        sessionId: box.sessionId,
        chatId: "chat-ws",
        workspaceId: "ws-opaque-1",
        folder: "/work/repo",
        driver: undefined,
        instanceId: box.instanceId,
        cause: "orphan",
      },
    ]);
    // Rebuilt from what was on disk: the persisted URL and the session's own token file.
    expect(remote.created.at(-1)).toMatchObject({ url: box.url, tokenFile: box.tokenFile });
    expect(docker.state.containers.size).toBe(0);
    expect(existsSync(box.dir)).toBe(false);
  });

  it.each([
    ["never finished starting (no URL or instance)", "unstarted"],
    ["answers as another instance", "replaced"],
    ["was already drained", "drained"],
    ["has exited", "exited"],
  ] as const)("does not drain an orphan that %s, and still removes it", async (_name, how) => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const first = await setup({ docker, remoteFake: remote });
    const box = await first.manager.start({ sessionId: sid(), chatId: "c", signal: new AbortController().signal });
    first.manager.ready(box.sessionId);
    const metaFile = join(box.dir, "session.json");
    const meta = await readMeta(box.dir);
    if (how === "unstarted") await writeFile(metaFile, JSON.stringify({ ...meta, url: undefined, instanceId: undefined }));
    if (how === "replaced") remote.instances.set(box.url!, randomUUID());
    if (how === "drained") await writeFile(metaFile, JSON.stringify({ ...meta, drainedAt: Date.now() }));
    if (how === "exited") docker.state.containers.get(box.name)!.running = false;
    const second = await setup({ docker, remoteFake: remote, dataDir: first.dataDir });
    second.manager.drainBeforeDestroy = vi.fn(async () => {});
    expect(await second.manager.reap()).toHaveLength(1);
    expect(second.manager.drainBeforeDestroy).not.toHaveBeenCalled();
    expect(docker.state.containers.size).toBe(0);
    expect(existsSync(box.dir)).toBe(false);
  });

  it("keeps a session's directory while Docker will not remove its container, and drains it only once", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const { manager, dataDir } = await setup({ docker, remoteFake: remote });
    const drains: string[] = [];
    manager.drainBeforeDestroy = async (sandbox) => void drains.push(sandbox.cause);
    const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    manager.ready(box.sessionId);
    docker.state.rmFailure = "device or resource busy";
    await manager.destroy(box.sessionId);
    expect(existsSync(join(box.dir, "token"))).toBe(true);
    expect((await readMeta(box.dir)).drainedAt).toEqual(expect.any(Number));
    expect(await manager.hasLeftovers()).toBe(true);
    // Later the reaper gets it removed, without draining it again.
    docker.state.rmFailure = undefined;
    const next = await setup({ docker, remoteFake: remote, dataDir });
    next.manager.drainBeforeDestroy = vi.fn(async () => {});
    expect(await next.manager.reap()).toHaveLength(1);
    expect(next.manager.drainBeforeDestroy).not.toHaveBeenCalled();
    expect(drains).toEqual(["session-end"]);
    expect(existsSync(box.dir)).toBe(false);
    expect(await next.manager.hasLeftovers()).toBe(false);
  });

  it("tells the drain it is a shutdown once shutdown has begun", async () => {
    const { manager } = await setup();
    const causes: string[] = [];
    manager.drainBeforeDestroy = async (sandbox) => void causes.push(sandbox.cause);
    const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    manager.ready(box.sessionId);
    manager.beginShutdown();
    await manager.dispose();
    expect(causes).toEqual(["shutdown"]);
  });
});

describe("review round 2", () => {
  const readMeta = async (dir: string) => JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
  /** A sandbox started, made ready and then abandoned by a "crashed" daemon; returns a new manager on the same data directory. */
  async function orphaned(options: { remoteFake?: ReturnType<typeof fakeRemote>; docker?: ReturnType<typeof fakeDocker> } = {}) {
    const docker = options.docker ?? fakeDocker();
    const remote = options.remoteFake ?? fakeRemote();
    const first = await setup({ docker, remoteFake: remote });
    const box = await first.manager.start({ sessionId: sid(), chatId: "chat-ws", signal: new AbortController().signal });
    first.manager.ready(box.sessionId);
    const next = await setup({ docker, remoteFake: remote, dataDir: first.dataDir });
    return { docker, remote, box, next: next.manager, dataDir: first.dataDir };
  }

  it("item 1: an orphan whose removal keeps failing is drained once over three reaper passes", async () => {
    const { docker, box, next } = await orphaned();
    const drains = vi.fn(async () => {});
    next.drainBeforeDestroy = drains;
    docker.state.rmFailure = "device or resource busy";
    for (let pass = 0; pass < 3; pass++) expect(await next.reap()).toEqual([]);
    expect(drains).toHaveBeenCalledTimes(1);
    expect((await readMeta(box.dir)).drainedAt).toEqual(expect.any(Number));
    expect(existsSync(join(box.dir, "token"))).toBe(true);
    docker.state.rmFailure = undefined;
    expect(await next.reap()).toHaveLength(1);
    expect(drains).toHaveBeenCalledTimes(1);
    expect(existsSync(box.dir)).toBe(false);
  });

  describe("item 2: a hook may keep the container for recovery", () => {
    it("on session end: nothing is removed, the keep is recorded, no reaper touches it, and release removes it", async () => {
      const { manager, docker, dataDir } = await setup();
      manager.drainBeforeDestroy = async () => ({ keep: true });
      const box = await manager.start({ sessionId: sid(), chatId: "chat-ws", signal: new AbortController().signal });
      manager.ready(box.sessionId);
      await manager.destroy(box.sessionId);
      expect(docker.state.containers.has(box.name)).toBe(true);
      expect(existsSync(box.tokenFile)).toBe(true);
      expect(await readMeta(box.dir)).toMatchObject({ keptAt: expect.any(Number), keptCause: "session-end" });
      expect(manager.containerState(box.sessionId)).toEqual({ phase: "kept" });
      expect(manager.liveCount()).toBe(0);
      // Neither this run's reaper nor a later run's touches it, nor counts it as a leftover.
      const later = await setup({ docker, dataDir });
      later.manager.drainBeforeDestroy = vi.fn(async () => {});
      for (const reaper of [manager, later.manager]) {
        expect(await reaper.reap()).toEqual([]);
        expect(await reaper.hasLeftovers()).toBe(false);
      }
      expect(later.manager.drainBeforeDestroy).not.toHaveBeenCalled();
      expect(docker.state.containers.has(box.name)).toBe(true);
      expect(await later.manager.keptSandboxes()).toEqual([
        {
          sessionId: box.sessionId,
          chatId: "chat-ws",
          workspaceId: "ws-opaque-1",
          folder: "/work/repo",
          name: box.name,
          keptAt: expect.any(Number),
          cause: "session-end",
        },
      ]);
      expect(await later.manager.release(randomUUID())).toBe(false);
      expect(await later.manager.release(box.sessionId)).toBe(true);
      expect(docker.state.containers.has(box.name)).toBe(false);
      expect(existsSync(box.dir)).toBe(false);
      expect(await later.manager.keptSandboxes()).toEqual([]);
    });

    it("on shutdown and for an orphan too", async () => {
      const shut = await setup();
      shut.manager.drainBeforeDestroy = async (sandbox) => (sandbox.cause === "shutdown" ? { keep: true } : undefined);
      const box = await shut.manager.start({ sessionId: sid(), signal: new AbortController().signal });
      shut.manager.ready(box.sessionId);
      shut.manager.beginShutdown();
      await shut.manager.dispose();
      expect(shut.docker.state.containers.has(box.name)).toBe(true);
      expect((await readMeta(box.dir)).keptCause).toBe("shutdown");

      const { docker, box: orphan, next } = await orphaned();
      next.drainBeforeDestroy = async () => ({ keep: true });
      expect(await next.reap()).toEqual([]);
      expect(docker.state.containers.has(orphan.name)).toBe(true);
      expect((await readMeta(orphan.dir)).keptCause).toBe("orphan");
      next.drainBeforeDestroy = vi.fn(async () => {});
      expect(await next.reap()).toEqual([]);
      expect(next.drainBeforeDestroy).not.toHaveBeenCalled();
    });

    it("returning nothing, {} or a non-object keeps the default; a throwing or timed-out hook never keeps", async () => {
      for (const hook of [async () => undefined, async () => ({}), async () => "keep" as never, async () => ({ keep: "yes" }) as never]) {
        const { manager, docker } = await setup();
        manager.drainBeforeDestroy = hook;
        const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
        manager.ready(box.sessionId);
        await manager.destroy(box.sessionId);
        expect(docker.state.containers.size).toBe(0);
      }
      const { manager, docker } = await setup({ drainTimeoutMs: 30 });
      manager.drainBeforeDestroy = () => new Promise(() => {});
      const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
      manager.ready(box.sessionId);
      await manager.destroy(box.sessionId);
      expect(docker.state.containers.size).toBe(0);
    });
  });

  describe("item 3: the security floor", () => {
    it.each([
      ["no security-floor label", undefined],
      ["a floor below the minimum", "0"],
      ["a malformed floor", "one"],
    ])("refuses an image with %s, as a known security issue distinct from out of date", async (_name, floor) => {
      const docker = fakeDocker({
        imageLabels: { "dev.callboard.computer-use.protocol": "2.0", ...(floor !== undefined ? { "dev.callboard.computer-use.security-floor": floor } : {}) },
      });
      const { manager } = await setup({ docker });
      expect(await manager.probe()).toMatchObject({
        available: false,
        readiness: "setup-required",
        reason: expect.stringMatching(/known security issue.*callboard sandbox build/),
      });
      expect(manager.currentProblem()?.problem).toBe("image-insecure");
      expect(manager.currentWarning()).toBeUndefined();
      await expect(manager.start({ sessionId: sid(), signal: new AbortController().signal })).rejects.toMatchObject({
        code: "unsupported",
        problem: "image-insecure",
      });
      expect(docker.state.calls.some((args) => args[0] === "run")).toBe(false);
      expect((await manager.diagnostics()).image).toMatchObject({ present: true, compatible: true, secure: false, requiredSecurityFloor: 1 });
    });

    it("accepts an image at or above the floor", async () => {
      const docker = fakeDocker({ imageLabels: { "dev.callboard.computer-use.protocol": "2.0", "dev.callboard.computer-use.security-floor": "2" } });
      const { manager } = await setup({ docker });
      expect(await manager.probe()).toMatchObject({ available: true });
      expect((await manager.diagnostics()).image).toMatchObject({ secure: true, securityFloor: 2 });
    });
  });

  describe("item 4: an orphan's endpoint comes from Docker, not session.json", () => {
    it("ignores a rewritten URL and drains at the address Docker reports for the listed container", async () => {
      const { remote, box, next } = await orphaned();
      await writeFile(join(box.dir, "session.json"), JSON.stringify({ ...(await readMeta(box.dir)), url: "http://evil.example:80" }));
      next.drainBeforeDestroy = vi.fn(async () => {});
      expect(await next.reap()).toHaveLength(1);
      expect(next.drainBeforeDestroy).toHaveBeenCalledTimes(1);
      expect(remote.created.at(-1)?.url).toBe(box.url);
      expect(remote.created.map((c) => c.url)).not.toContain("http://evil.example:80");
    });

    it.each([
      ["a network that is not ours", { network: "some-other-net" }],
      ["internal on the internet network", { internal: true }],
      ["a non-boolean internal", { internal: "yes" }],
    ])("does not drain an orphan whose metadata names %s", async (_name, patch) => {
      const { remote, box, next } = await orphaned();
      await writeFile(join(box.dir, "session.json"), JSON.stringify({ ...(await readMeta(box.dir)), ...patch }));
      const before = remote.created.length;
      next.drainBeforeDestroy = vi.fn(async () => {});
      expect(await next.reap()).toHaveLength(1);
      expect(next.drainBeforeDestroy).not.toHaveBeenCalled();
      expect(remote.created.length).toBe(before);
    });
  });

  it("item 5: warns when a drainable orphan is found before any drain hook is installed", async () => {
    const { next } = await orphaned();
    logged.warn.length = 0;
    expect(await next.reap()).toHaveLength(1);
    expect(logged.warn.filter((message) => /no drain hook is installed/.test(message))).toHaveLength(1);
  });
});

describe("hooks for the outbox sync and keep-for-recovery (PR 4)", () => {
  const readMeta = async (dir: string) => JSON.parse(await readFile(join(dir, "session.json"), "utf8"));

  it("onReady fires once, when a sandbox is ready, with what a live sync needs", async () => {
    const seen: unknown[] = [];
    const { manager } = await setup({ onReady: (sandbox) => seen.push({ ...sandbox, driver: typeof sandbox.driver.listOutbox }) });
    const box = await manager.start({ sessionId: sid(), chatId: "chat-ws", signal: new AbortController().signal });
    expect(seen).toEqual([]);
    manager.ready(box.sessionId);
    manager.ready(box.sessionId);
    expect(seen).toEqual([
      { sessionId: box.sessionId, chatId: "chat-ws", workspaceId: "ws-opaque-1", folder: "/work/repo", driver: "function", instanceId: box.instanceId },
    ]);
    expect(manager.nameOf(box.sessionId)).toBe(box.name);
  });

  it("settled resolves once a removal, or a keep, has finished", async () => {
    const { manager } = await setup();
    let release!: () => void;
    manager.drainBeforeDestroy = () => new Promise((resolve) => (release = () => resolve({ keep: true })));
    const box = await manager.start({ sessionId: sid(), signal: new AbortController().signal });
    manager.ready(box.sessionId);
    const destroying = manager.destroy(box.sessionId);
    let settled = false;
    void manager.settled(box.sessionId).then(() => (settled = true));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(settled).toBe(false);
    release();
    await destroying;
    await vi.waitFor(() => expect(settled).toBe(true));
    await expect(manager.settled(randomUUID())).resolves.toBeUndefined();
  });

  it("connectKept reaches a kept sandbox at Docker's address with its token, proves the instance, and refuses another one", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const { manager } = await setup({ docker, remoteFake: remote });
    manager.drainBeforeDestroy = async () => ({ keep: true });
    const box = await manager.start({ sessionId: sid(), chatId: "chat-ws", signal: new AbortController().signal });
    manager.ready(box.sessionId);
    await manager.destroy(box.sessionId);
    const connected = await manager.connectKept(box.sessionId);
    expect(connected).toMatchObject({ sessionId: box.sessionId, chatId: "chat-ws", workspaceId: "ws-opaque-1", instanceId: box.instanceId });
    expect(remote.created.at(-1)).toMatchObject({ tokenFile: box.tokenFile, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
    // The address came from `docker port`, not from session.json.
    expect(docker.state.calls.filter((args) => args[0] === "port").length).toBeGreaterThanOrEqual(2);
    remote.instances.set(remote.created.at(-1)!.url, randomUUID());
    await expect(manager.connectKept(box.sessionId)).rejects.toMatchObject({ code: "stale_frame" });
    await expect(manager.connectKept(randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("adoptPaused: a paused orphan with complete metadata is recorded kept when the policy says so, and removed otherwise", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const first = await setup({ docker, remoteFake: remote });
    const yes = await first.manager.start({ sessionId: sid(), chatId: "adopt", signal: new AbortController().signal });
    const no = await first.manager.start({ sessionId: sid(), chatId: "refuse", signal: new AbortController().signal });
    for (const box of [yes, no]) {
      first.manager.ready(box.sessionId);
      docker.state.containers.get(box.name)!.paused = true;
    }
    const asked: string[] = [];
    const second = await setup({ docker, remoteFake: remote, dataDir: first.dataDir, adoptPaused: ({ chatId }) => (asked.push(chatId), chatId === "adopt") });
    second.manager.drainBeforeDestroy = vi.fn(async () => {});
    expect(await second.manager.reap()).toHaveLength(1);
    expect(asked.sort()).toEqual(["adopt", "refuse"]);
    expect(second.manager.drainBeforeDestroy).not.toHaveBeenCalled();
    expect(docker.state.containers.has(yes.name)).toBe(true);
    expect(docker.state.containers.has(no.name)).toBe(false);
    expect(await readMeta(yes.dir)).toMatchObject({ keptAt: expect.any(Number), keptCause: "orphan" });
    // Without the option, a paused orphan is removed like any orphan that is not running.
    const third = await setup({ docker, remoteFake: remote, dataDir: first.dataDir });
    expect(await third.manager.reap()).toEqual([]);
  });
});
