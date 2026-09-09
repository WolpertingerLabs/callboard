import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { getPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "enable-control-test";
let host: ComputerUseHost;
afterEach(async () => {
  await host?.dispose();
  sessionRegistry.unregister(CHAT);
});
function fixture(level: "ask" | "allow" | "deny" = "ask", kind: "browser" | "desktop" = "browser") {
  const driverKind = kind === "browser" ? ("browser" as const) : ("native-desktop" as const);
  const controller = new AbortController();
  const turnController = new AbortController();
  const emitter = new EventEmitter();
  sessionRegistry.register(CHAT, { type: "web", emitter, abortController: turnController });
  const close = vi.fn(async () => {});
  const observe = vi.fn(async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }));
  const handle = { close, observe, releaseInput: async () => {}, act: async () => {} };
  const driver: Driver = {
    kind: driverKind,
    lockDomain: kind === "desktop" ? "enable-native-test" : undefined,
    probe: vi.fn(async () => ({ kind: driverKind, available: true, capabilities: [] })),
    open: vi.fn(async () => handle),
  };
  let signature = "initial";
  const service = new ComputerUseService({
    targets: [{ id: kind === "browser" ? "managed-browser" : "native-desktop", enabled: true, driver }],
    authorize: (request) => host.authorize(request),
  });
  host = new ComputerUseHost(service, { browser: driver, desktop: driver }, () => ({
    policy: readComputerUsePolicy({ computerControl: level, webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" }),
    signature,
  }));
  const request = () => host.requestControl(CHAT, kind, "Check the requested page", AbortSignal.any([controller.signal, turnController.signal]));
  const answer = (allow = true) => respondToPermission(CHAT, allow, { kind: "desktop", approved: true }, [], getPendingRequest(CHAT)?.requestId);
  const prompt = () => vi.waitFor(() => expect(getPendingRequest(CHAT)?.eventData.controlRequest).toBe(true));
  return {
    service,
    driver,
    controller,
    turnController,
    close,
    observe,
    handle,
    request,
    answer,
    prompt,
    changePolicy: () => {
      signature = "changed";
    },
  };
}
it.each(["ask", "allow"] as const)("%s never opens before consent; returns real session without second approval or screenshots", async (level) => {
  const f = fixture(level);
  const result = f.request();
  await f.prompt();
  expect(f.driver.open).not.toHaveBeenCalled();
  expect(f.service.status(controlPrincipal(CHAT, "human"))).toEqual([]);
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "browser", permission: level, durationMinutes: 15 });
  f.answer();
  const session = await result;
  expect(session).toMatchObject({ kind: "browser", state: "ready", controller: "agent", generation: 1 });
  expect(session.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(f.driver.open).toHaveBeenCalledTimes(1);
  expect(f.observe).not.toHaveBeenCalled();
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(await f.request()).toMatchObject({ id: session.id });
  expect(f.driver.open).toHaveBeenCalledTimes(1);
});
it("denial and duplicate requests cannot grant", async () => {
  const f = fixture();
  const result = f.request();
  const rejected = expect(result).rejects.toMatchObject({ code: "denied" });
  await f.prompt();
  await expect(f.request()).rejects.toMatchObject({ code: "queue_full" });
  f.answer(false);
  await rejected;
  expect(f.driver.open).not.toHaveBeenCalled();
});
it("deny refuses even the initial prompt", async () => {
  const f = fixture("deny");
  await expect(f.request()).rejects.toMatchObject({ code: "denied" });
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(f.driver.open).not.toHaveBeenCalled();
});
it.each(["policy", "readiness", "cancel"])("revalidates %s after human consent", async (change) => {
  const f = fixture();
  const result = f.request();
  const rejected = expect(result).rejects.toBeDefined();
  await f.prompt();
  if (change === "policy") f.changePolicy();
  if (change === "readiness") vi.mocked(f.driver.probe).mockResolvedValue({ kind: "browser", available: false, capabilities: [], reason: "Setup required" });
  f.answer();
  if (change === "cancel") f.controller.abort();
  await rejected;
  expect(f.driver.open).not.toHaveBeenCalled();
});
it("unavailable setup fails without opening or prompting", async () => {
  const f = fixture();
  vi.mocked(f.driver.probe).mockResolvedValue({ kind: "browser", available: false, capabilities: [], reason: "Setup required" });
  await expect(f.request()).rejects.toThrow("Setup required");
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(f.driver.open).not.toHaveBeenCalled();
});
it("Stop cancels a pending card; cross-chat and old approve endpoints cannot redeem it", async () => {
  const f = fixture();
  const result = f.request();
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  await f.prompt();
  const pending = (await host.status(CHAT)).sessions[0];
  await expect(host.stop("other-chat", pending.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(host.approve(CHAT, pending.id)).rejects.toMatchObject({ code: "denied" });
  await host.stop(CHAT, pending.id);
  await rejected;
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(f.driver.open).not.toHaveBeenCalled();
});
it.each(["stop", "transport"])("%s during slow startup fences and closes a late driver", async (cancellation) => {
  const f = fixture();
  let finish!: (value: typeof f.handle) => void;
  vi.mocked(f.driver.open).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = f.request();
  const rejected = expect(result).rejects.toBeDefined();
  await f.prompt();
  const pending = (await host.status(CHAT)).sessions[0];
  f.answer();
  await vi.waitFor(() => expect(finish).toBeDefined());
  if (cancellation === "stop") await host.stop(CHAT, pending.id);
  else f.controller.abort();
  await rejected;
  finish(f.handle);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalled());
  expect(f.service.status(controlPrincipal(CHAT, "human")).some((s) => ["ready", "starting"].includes(s.state))).toBe(false);
});
it("a Stop using the old pending ledger ID also stops a just-completed open", async () => {
  const f = fixture();
  const result = f.request();
  await f.prompt();
  const pending = (await host.status(CHAT)).sessions[0];
  f.answer();
  const session = await result;
  await host.stop(CHAT, pending.id);
  expect(f.service.status(controlPrincipal(CHAT, "human")).find((s) => s.sessionId === session.id)?.state).toBe("stopped");
});
it("never resumes a human-controlled target", async () => {
  const f = fixture();
  const result = f.request();
  await f.prompt();
  f.answer();
  const session = await result;
  await host.takeover(CHAT, session.id, session.generation);
  await expect(f.request()).rejects.toMatchObject({ code: "lease_conflict" });
  expect(f.driver.open).toHaveBeenCalledTimes(1);
});
it("consent expiry while the human is thinking cannot open a target", async () => {
  const f = fixture();
  const result = f.request();
  const rejected = expect(result).rejects.toMatchObject({ code: "denied" });
  await f.prompt();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 301_000);
    f.answer();
    await rejected;
    expect(f.driver.open).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("Stop while readiness is probing prevents a late prompt and open", async () => {
  const f = fixture();
  let ready!: () => void;
  vi.mocked(f.driver.probe).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        ready = () => resolve({ kind: "browser", available: true, capabilities: [] });
      }),
  );
  const result = f.request();
  const rejected = expect(result).rejects.toBeDefined();
  const pending = (await host.status(CHAT)).sessions[0];
  await host.stop(CHAT, pending.id);
  ready();
  await rejected;
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(f.driver.open).not.toHaveBeenCalled();
});

it.each(["ask", "allow"] as const)("native desktop under %s also waits for consent and returns its real session", async (level) => {
  const f = fixture(level, "desktop");
  const result = f.request();
  await f.prompt();
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "desktop", permission: level });
  expect(f.driver.open).not.toHaveBeenCalled();
  f.answer();
  expect(await result).toMatchObject({ kind: "native", state: "ready", controller: "agent" });
  expect(f.observe).not.toHaveBeenCalled();
});
it("unavailable native setup is actionable and never creates a target or consent card", async () => {
  const f = fixture("allow", "desktop");
  vi.mocked(f.driver.probe).mockResolvedValue({
    kind: "native-desktop",
    available: false,
    capabilities: [],
    reason: "Set up the native driver on the service host",
  });
  await expect(f.request()).rejects.toThrow("Set up the native driver");
  expect(f.driver.open).not.toHaveBeenCalled();
  expect(getPendingRequest(CHAT)).toBeNull();
});

it.each(["stop", "transport", "policy"])("%s in the final startup handoff cannot publish an untracked session", async (cancellation) => {
  const f = fixture();
  const result = f.request();
  const rejected = expect(result).rejects.toBeDefined();
  await f.prompt();
  const pendingId = (await host.status(CHAT)).sessions[0].id;
  const open = f.service.open.bind(f.service);
  vi.spyOn(f.service, "open").mockImplementation(async (...args) => {
    const lease = await open(...args);
    // Let openApproved register the grant, then cancel before requestControl
    // resumes to publish its result and pending-ledger alias.
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (cancellation === "stop") void host.stop(CHAT, pendingId);
        else if (cancellation === "policy") f.changePolicy();
        else f.controller.abort();
      }),
    );
    return lease;
  });
  f.answer();
  await rejected;
  expect(f.service.status(controlPrincipal(CHAT, "human")).some((s) => ["ready", "starting"].includes(s.state))).toBe(false);
});

it.each(["stop", "revoke", "takeover", "expiry"])("actual session ID %s during handoff refuses HTTP and tool success", async (change) => {
  const f = fixture();
  const result = f.request();
  const rejected = expect(result).rejects.toBeDefined();
  await f.prompt();
  const open = f.service.open.bind(f.service);
  let mutation: Promise<unknown> | undefined;
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(f.service, "open").mockImplementation(async (...args) => {
    const lease = await open(...args);
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (change === "expiry") clock = vi.spyOn(Date, "now").mockReturnValue(lease.expiresAt + 1);
        else if (change === "takeover") {
          /* tested at the completed transition below */
        } else mutation = host[change as "stop" | "revoke"](CHAT, lease.sessionId);
      }),
    );
    return lease;
  });
  if (change === "takeover") {
    // Takeover itself awaits authorization. Hold the outer handoff until the
    // real service/controller transition has completed, rather than testing a
    // takeover that has only been requested and is not yet authoritative.
    const internal = host as unknown as { openApproved: (...args: unknown[]) => Promise<{ id: string; generation: number }> };
    const approved = internal.openApproved.bind(host);
    vi.spyOn(internal, "openApproved").mockImplementation(async (...args) => {
      const session = await approved(...args);
      await host.takeover(CHAT, session.id, session.generation);
      return session;
    });
  }
  const completion = f.answer().completion;
  try {
    await rejected;
    await expect(completion).resolves.toMatchObject({ ok: false });
    await mutation;
    expect(f.service.status(controlPrincipal(CHAT, "human")).some((s) => ["ready", "starting"].includes(s.state))).toBe(false);
  } finally {
    clock?.mockRestore();
  }
});

it.each(["initial", "post-consent"])("%s readiness probes settle promptly on cancellation, Stop and deadline", async (phase) => {
  const { CONTROL_PROBE_TIMEOUT_MS } = await import("./computer-use.js");
  for (const cancellation of ["abort", "turn", "stop", "timeout"]) {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: Awaited<ReturnType<Driver["probe"]>>) => void;
    const held = () =>
      new Promise<Awaited<ReturnType<Driver["probe"]>>>((resolve) => {
        release = resolve;
      });
    if (phase === "initial") vi.mocked(f.driver.probe).mockImplementationOnce(held);
    const result = f.request();
    const rejected = expect(result).rejects.toBeDefined();
    let completion: Promise<unknown> | undefined;
    try {
      if (phase === "post-consent") {
        await f.prompt();
        vi.mocked(f.driver.probe).mockImplementationOnce(held);
        completion = f.answer().completion;
      }
      await vi.waitFor(() => expect(release).toBeDefined());
      if (cancellation === "abort") f.controller.abort();
      if (cancellation === "turn") f.turnController.abort();
      if (cancellation === "stop") {
        const pending = (await host.status(CHAT)).sessions.find((s) => s.generation === 0)!;
        await host.stop(CHAT, pending.id);
      }
      if (cancellation === "timeout") await vi.advanceTimersByTimeAsync(CONTROL_PROBE_TIMEOUT_MS + 1);
      await rejected;
      if (completion) await expect(completion).resolves.toMatchObject({ ok: false });
      expect(getPendingRequest(CHAT)).toBeNull();
      release({ kind: "browser", available: true, capabilities: [] });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.driver.open).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      sessionRegistry.unregister(CHAT);
      vi.useRealTimers();
    }
  }
});
