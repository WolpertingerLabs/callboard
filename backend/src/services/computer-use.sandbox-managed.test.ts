/**
 * Managed Sandbox desktops through the real host and service, on an
 * in-memory Docker: a container per session, and its removal on every way a
 * session ends — Stop, Revoke, the TTL, a permission change, chat archive or
 * delete, a lost connection, a mode change and daemon shutdown — plus the
 * in-chat consent path, the cap across chats, and the lifecycle fields the
 * Computer view reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import type { SandboxDesktopMode } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal, sandboxTargetDriver, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { SandboxContainerManager, managedSandboxDriver } from "./sandbox-containers.js";
import { resolveSandboxSettings } from "./sandbox-desktop-settings.js";
import { fakeDocker, fakeRemote, type FakeRemoteBehaviour } from "./__fixtures__/sandbox-docker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policyOf = (sandboxControl: string): HostPolicy => ({
  policy: readComputerUsePolicy({ browserControl: "deny", computerControl: "deny", sandboxControl }),
  signature: JSON.stringify({ sandboxControl }),
});

async function fixture(options: { ttlMs?: number; maxConcurrent?: number; remote?: FakeRemoteBehaviour } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cb-sandbox-host-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const docker = fakeDocker();
  const remote = fakeRemote(options.remote);
  const settings = { ...resolveSandboxSettings({}), maxConcurrent: options.maxConcurrent ?? 2 };
  const manager = new SandboxContainerManager({
    docker: docker.run,
    dataDir,
    settings: () => settings,
    createRemoteDriver: remote.factory,
    helloIntervalMs: 5,
    helloTimeoutMs: 5_000,
    preflightCacheMs: 0,
  });
  let mode: SandboxDesktopMode = "managed";
  const unconfigured: Driver = {
    kind: "native-desktop",
    lockDomain: "test:endpoint",
    probe: async () => ({ available: false, kind: "native-desktop", readiness: "setup-required", reason: "no endpoint", capabilities: [] }),
    open: async () => {
      throw new Error("not configured");
    },
  };
  const sandbox = sandboxTargetDriver({
    mode: () => mode,
    managed: managedSandboxDriver(manager),
    endpoint: unconfigured,
    info: () => ({ mode, network: settings.network, running: manager.liveCount(), limit: manager.limit() }),
    containerState: (sessionId) => manager.containerState(sessionId),
  });
  const never: Driver = {
    kind: "browser",
    probe: async () => ({ available: false, kind: "browser", capabilities: [] }),
    open: async () => {
      throw new Error("unused");
    },
  };
  const desktop: Driver = { ...never, kind: "native-desktop", lockDomain: "test:desktop" };
  const policies = new Map<string, HostPolicy | "gone">();
  const readPolicy = (chatId: string): HostPolicy => {
    const policy = policies.get(chatId) ?? policyOf("allow");
    if (policy === "gone") throw Object.assign(new Error("Chat is archived"), { code: "denied" });
    return policy;
  };
  const cards: { input: Record<string, unknown>; answer: (approved: boolean) => unknown; open: boolean }[] = [];
  const raise = vi.fn<RaiseHumanApproval>((_chatId, request, answer) => {
    const card = { input: request.input, answer: answer as (approved: boolean) => unknown, open: true };
    cards.push(card);
    return {
      requestId: `prompt-${cards.length}`,
      isOpen: () => card.open,
      cancel: () => {
        const was = card.open;
        card.open = false;
        return was;
      },
    };
  });
  const notices: string[] = [];
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: never },
      { id: "native-desktop", enabled: true, driver: desktop },
      { id: "sandbox-desktop", enabled: true, driver: sandbox },
    ],
    authorize: (request) => host.authorize(request),
    ...(options.ttlMs ? { sessionTtlMs: options.ttlMs } : {}),
  });
  const host: ComputerUseHost = new ComputerUseHost(service, { browser: never, desktop, sandbox }, readPolicy, raise, (_chatId, text) => notices.push(text));
  let disposed = false;
  cleanups.push(async () => {
    if (!disposed) await host.dispose();
    await manager.dispose();
  });
  const containers = () => [...docker.state.containers.values()];
  const tokenDirs = async () => (existsSync(manager.sessionsDir) ? await readdir(manager.sessionsDir) : []);
  const gone = async () => {
    await vi.waitFor(
      async () => {
        expect(containers()).toEqual([]);
        expect(await tokenDirs()).toEqual([]);
      },
      { timeout: 4_000, interval: 20 },
    );
  };
  return {
    host,
    service,
    manager,
    docker,
    remote,
    policies,
    cards,
    notices,
    containers,
    tokenDirs,
    gone,
    setMode: (next: SandboxDesktopMode) => (mode = next),
    dispose: async () => {
      disposed = true;
      await host.dispose();
    },
  };
}

async function enable(f: Awaited<ReturnType<typeof fixture>>, chatId = "chat-a") {
  const session = (await f.host.open(chatId, "sandbox")) as { id: string; generation: number; state: string };
  expect(session.state).toBe("ready");
  expect(f.containers()).toHaveLength(f.manager.liveCount());
  return session;
}

describe("a container per session, removed however the session ends", () => {
  it("Stop", async () => {
    const f = await fixture();
    const session = await enable(f);
    const [container] = f.containers();
    expect(container.labels["dev.callboard.chat-id"]).toBe("chat-a");
    expect(container.labels["dev.callboard.session-id"]).toBe(session.id);
    expect(await f.tokenDirs()).toEqual([session.id]);
    await f.host.stop("chat-a", session.id);
    await f.gone();
  });

  it("Revoke", async () => {
    const f = await fixture();
    const session = await enable(f);
    await f.host.revoke("chat-a", session.id);
    await f.gone();
  });

  it("the session TTL (15 minutes in production)", async () => {
    const f = await fixture({ ttlMs: 300 });
    await enable(f);
    await f.gone();
  });

  it("a permission change", async () => {
    const f = await fixture();
    await enable(f);
    f.policies.set("chat-a", policyOf("ask"));
    await f.host.status("chat-a");
    await f.gone();
  });

  it("chat archive or delete", async () => {
    const f = await fixture();
    await enable(f);
    f.policies.set("chat-a", "gone");
    // The watchdog, not a status read (status on a gone chat throws).
    await f.gone();
  });

  it("a lost connection to the driver host", async () => {
    const f = await fixture();
    const session = await enable(f);
    f.remote.lost.get(session.id)!();
    await f.gone();
  });

  it("a mode change (revokeTarget)", async () => {
    const f = await fixture();
    await enable(f);
    f.setMode("endpoint");
    expect(await f.host.revokeTarget("sandbox")).toBe(1);
    await f.gone();
  });

  it("daemon shutdown", async () => {
    const f = await fixture();
    await enable(f, "chat-a");
    await enable(f, "chat-b");
    expect(f.containers()).toHaveLength(2);
    await f.dispose();
    // dispose awaits cleanup: nothing to wait for.
    expect(f.containers()).toEqual([]);
    expect(await f.tokenDirs()).toEqual([]);
  });

  it("Stop while the container is still starting", async () => {
    const f = await fixture({ remote: { neverAnswers: true } });
    const opening = f.host.open("chat-a", "sandbox").catch((error: unknown) => error);
    await vi.waitFor(async () => {
      const status = await f.host.status("chat-a");
      const starting = status.sessions.find((s) => s.state === "starting") as { id: string; container?: { phase: string; step?: string } } | undefined;
      expect(starting?.container).toEqual({ phase: "starting", step: "Waiting for the desktop" });
    });
    const [live] = f.service.status(controlPrincipal("chat-a", "human"));
    await f.host.stop("chat-a", live.sessionId);
    expect(await opening).toBeInstanceOf(Error);
    await f.gone();
  });
});

describe("a mode change while a sandbox is still starting (review round 1, finding 1)", () => {
  const held = () => {
    let release!: () => void;
    return { gate: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
  };
  const starting = async (f: Awaited<ReturnType<typeof fixture>>) =>
    vi.waitFor(() => {
      const live = f.service.status(controlPrincipal("chat-a", "human")).find((s) => s.state === "starting");
      expect(f.manager.containerState(live?.sessionId ?? "")?.step).toBe("Waiting for the desktop");
      return live!;
    });

  it("revokeTarget ends a sandbox that is still starting, and removes its container", async () => {
    const hold = held();
    const f = await fixture({ remote: { gate: hold.gate } });
    const opening = f.host.open("chat-a", "sandbox").then(
      () => "opened",
      (error: { code?: string }) => error.code,
    );
    await starting(f);
    expect(f.containers()).toHaveLength(1);
    f.setMode("off");
    await f.host.revokeTarget("sandbox");
    hold.release();
    expect(await opening).not.toBe("opened");
    await f.gone();
    expect(f.service.status(controlPrincipal("chat-a", "agent")).some((s) => s.state === "ready")).toBe(false);
  });

  it("without revokeTarget, a start that finishes under another mode gets no grant and its container is removed", async () => {
    const hold = held();
    const f = await fixture({ remote: { gate: hold.gate } });
    const opening = f.host.open("chat-a", "sandbox").then(
      () => "opened",
      (error: { code?: string }) => error.code,
    );
    await starting(f);
    f.setMode("off");
    hold.release();
    expect(await opening).not.toBe("opened");
    await f.gone();
    expect(f.service.status(controlPrincipal("chat-a", "agent")).some((s) => s.state === "ready")).toBe(false);
  });

  it("a grant opened under one mode stops authorizing, and is revoked, once the mode changes", async () => {
    const f = await fixture();
    const session = await enable(f);
    f.setMode("endpoint");
    await expect(f.service.observe(controlPrincipal("chat-a", "agent"), { sessionId: session.id, generation: session.generation })).rejects.toMatchObject({
      code: "denied",
    });
    await f.gone();
  });
});

describe("the Computer view's lifecycle fields", () => {
  it("shows the container ready, then stopping/removed, and the cap on the capability", async () => {
    const f = await fixture();
    const session = await enable(f);
    let status = await f.host.status("chat-a");
    expect(status.sessions.find((s) => s.id === session.id)).toMatchObject({
      kind: "sandbox",
      container: { phase: "ready" },
      targetLabel: "sandbox (container on this machine)",
    });
    expect(status.capabilities.find((c) => c.kind === "sandbox")).toMatchObject({ available: true, sandbox: { mode: "managed", running: 1, limit: 2 } });
    await f.host.stop("chat-a", session.id);
    await f.gone();
    status = await f.host.status("chat-a");
    expect(status.sessions.find((s) => s.id === session.id)).toMatchObject({ state: "stopped", container: { phase: "removed" } });
  });

  it("an old client sees a managed sandbox session as a native one with a sensible sandbox label, and its Stop removes the container", async () => {
    const f = await fixture();
    const session = await enable(f);
    const status = await f.host.status("chat-a", { sandbox: false });
    expect(status.capabilities.some((c) => c.kind === "sandbox")).toBe(false);
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({ id: session.id, kind: "native", targetLabel: "sandbox (container on this machine)" });
    expect(String(status.sessions[0].targetLabel)).toMatch(/^sandbox /);
    // That tab's emergency Stop finds the session by status, and stops it.
    await f.host.stop("chat-a", status.sessions[0].id);
    await f.gone();
  });

  it("tags both prompts with how the sandbox is run, so the cards describe a fresh managed container", async () => {
    const f = await fixture();
    f.policies.set("chat-a", policyOf("ask"));
    await f.host.requestControl("chat-a", "sandbox", "test", new AbortController().signal);
    expect(f.cards[0].input).toMatchObject({ kind: "sandbox", sandbox: { mode: "managed", network: "internet" } });
    await expect(f.cards[0].answer(true)).resolves.toEqual({ ok: true });
    const [live] = f.service.status(controlPrincipal("chat-a", "agent"));
    const frame = await f.service.observe(controlPrincipal("chat-a", "agent"), { sessionId: live.sessionId, generation: live.generation });
    const pending = await f.host.requestAgentAction("chat-a", live.sessionId, live.generation, frame.frameId, { type: "click", x: 1, y: 1 }, async () => {
      throw new Error("must not run under Ask");
    });
    expect(pending).toMatchObject({ status: "approval_pending" });
    expect(f.cards[1].input).toMatchObject({ kind: "sandbox", sandbox: { mode: "managed", network: "internet" } });
    expect(String(f.cards[1].input.summary)).toContain("disposable container on");
  });
});

describe("the cap across chats", () => {
  it("refuses a third chat with a clear message, and frees the slot when one stops", async () => {
    const f = await fixture({ maxConcurrent: 2 });
    const a = await enable(f, "chat-a");
    await enable(f, "chat-b");
    await expect(f.host.open("chat-c", "sandbox")).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/already running/) });
    const status = await f.host.status("chat-c");
    expect(status.capabilities.find((c) => c.kind === "sandbox")).toMatchObject({ available: false, reason: expect.stringMatching(/already running/) });
    expect(f.containers()).toHaveLength(2);
    await f.host.stop("chat-a", a.id);
    await vi.waitFor(() => expect(f.manager.liveCount()).toBe(1));
    await enable(f, "chat-c");
  });
});

describe("in-chat consent", () => {
  it("is asked before any container exists, binds to a fresh managed container, and opens one on approval", async () => {
    const f = await fixture();
    const pending = await f.host.requestControl("chat-a", "sandbox", "test a download in isolation", new AbortController().signal);
    expect(pending).toMatchObject({ status: "consent_pending", kind: "sandbox" });
    expect(f.containers()).toEqual([]);
    expect(f.cards[0].input).toMatchObject({ kind: "sandbox", target: "sandbox (container on this machine)" });
    await expect(f.cards[0].answer(true)).resolves.toEqual({ ok: true });
    expect(f.containers()).toHaveLength(1);
    expect(f.notices.at(-1)).toMatch(/sandbox desktop control enabled/);
  });

  it("is refused at approval if the mode changed after it was asked", async () => {
    const f = await fixture();
    await f.host.requestControl("chat-a", "sandbox", "test", new AbortController().signal);
    f.setMode("off");
    await expect(f.cards[0].answer(true)).resolves.toMatchObject({ ok: false });
    expect(f.containers()).toEqual([]);
  });
});
