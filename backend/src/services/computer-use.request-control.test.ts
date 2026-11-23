/**
 * `cu_request_control` — in-chat consent to enable a target, non-blocking.
 *
 * The call returns `consent_pending` as soon as the card is up. The card has
 * no timer; the human's answer drives the rest — re-check, probe, open — and
 * the outcome reaches the agent as a chat notice and the human through
 * `/respond`'s completion.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, WITHDRAW_TEXT, WITHDRAWN } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { clearOpenApprovalsForTest, getPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "enable-control-test";
let host: ComputerUseHost;
afterEach(async () => {
  await host?.dispose();
  sessionRegistry.unregister(CHAT);
  clearOpenApprovalsForTest();
});
function fixture(level: "ask" | "allow" | "deny" = "ask", kind: "browser" | "desktop" = "browser") {
  const driverKind = kind === "browser" ? ("browser" as const) : ("native-desktop" as const);
  const controller = new AbortController();
  const turnController = new AbortController();
  const emitter = new EventEmitter();
  const events: Record<string, unknown>[] = [];
  emitter.on("event", (event) => events.push(event));
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
  const notices: string[] = [];
  /** Ride-along notices (`wake: false`): told on the agent's next turn, never starting one. */
  const rides: string[] = [];
  const service = new ComputerUseService({
    targets: [{ id: kind === "browser" ? "managed-browser" : "native-desktop", enabled: true, driver }],
    authorize: (request) => host.authorize(request),
  });
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: driver },
    () => ({
      // The desktop also requires Browser Use on allow; the browser target reads only Browser Use.
      policy: readComputerUsePolicy({
        browserControl: kind === "desktop" ? "allow" : level,
        computerControl: level,
        webAccess: "allow",
        fileRead: "allow",
        fileWrite: "allow",
        codeExecution: "allow",
      }),
      signature,
    }),
    undefined,
    (_chatId, text, options) => (options?.wake === false ? rides : notices).push(text),
  );
  const request = () => host.requestControl(CHAT, kind, "Check the requested page", AbortSignal.any([controller.signal, turnController.signal]));
  /** Answer the card as `/respond` does; resolves to the completion the route would await. */
  const answer = (allow = true) => {
    const result = respondToPermission(CHAT, allow, { kind: "desktop", approved: true }, [], getPendingRequest(CHAT)?.requestId);
    expect(result.ok).toBe(true);
    return result.completion;
  };
  const enabledSession = () => f.service.status(controlPrincipal(CHAT, "agent")).find((s) => s.state === "ready");
  const f = {
    service,
    driver,
    controller,
    turnController,
    close,
    observe,
    handle,
    events,
    notices,
    rides,
    request,
    answer,
    enabledSession,
    changePolicy: () => {
      signature = "changed";
    },
  };
  return f;
}
const liveSessions = (f: ReturnType<typeof fixture>) => f.service.status(controlPrincipal(CHAT, "human")).some((s) => ["ready", "starting"].includes(s.state));

it.each(["ask", "allow"] as const)("%s returns consent_pending at once, opens nothing before consent, and reports the real session after", async (level) => {
  const f = fixture(level);
  const pending = await f.request();
  expect(pending).toMatchObject({ status: "consent_pending", state: "pending_approval", kind: "browser", requestId: expect.any(String) });
  expect((pending as { message: string }).message).toMatch(/does not wait/);
  expect(f.driver.open).not.toHaveBeenCalled();
  expect(f.service.status(controlPrincipal(CHAT, "human"))).toEqual([]);
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "browser", permission: level, durationMinutes: 15 });
  expect(getPendingRequest(CHAT)?.eventData).toMatchObject({ controlRequest: true, humanOnly: true, nonBlocking: true });
  // The agent's id is the host's, not the prompt identity /respond needs.
  expect(getPendingRequest(CHAT)?.requestId).not.toBe((pending as { requestId: string }).requestId);
  expect(host.agentRequests(CHAT)).toEqual([{ requestId: (pending as { requestId: string }).requestId, type: "enable_control", kind: "browser" }]);

  await expect(f.answer()).resolves.toEqual({ ok: true });
  const session = f.enabledSession()!;
  expect(session).toMatchObject({ state: "ready", controller: "agent", generation: 1 });
  expect(session.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(f.notices).toEqual([expect.stringContaining(`Session ${session.sessionId} (generation 1) is ready`)]);
  expect(f.events).toContainEqual(expect.objectContaining({ controlRequestResult: expect.objectContaining({ message: "Browser control enabled." }) }));
  expect(f.driver.open).toHaveBeenCalledTimes(1);
  expect(f.observe).not.toHaveBeenCalled();
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(host.agentRequests(CHAT)).toEqual([]);
  // Asking again once enabled hands back the live session; nothing reopens.
  expect(await f.request()).toMatchObject({ id: session.sessionId });
  expect(f.driver.open).toHaveBeenCalledTimes(1);
});
it("the card has no timer: consent given a day later still opens the target", async () => {
  const f = fixture();
  await f.request();
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    // The watchdog sweep must not retire it on age.
    await host.status(CHAT);
    expect(getPendingRequest(CHAT)?.eventData.controlRequest).toBe(true);
  } finally {
    now.mockRestore();
  }
  await expect(f.answer()).resolves.toEqual({ ok: true });
  expect(f.enabledSession()).toBeDefined();
});
it("denial and duplicate requests cannot grant, and the refusal is reported as final", async () => {
  const f = fixture();
  const first = (await f.request()) as { requestId: string };
  // A duplicate is told what is already waiting, rather than refused.
  expect(await f.request()).toMatchObject({
    status: "consent_pending",
    requestId: first.requestId,
    message: expect.stringContaining("Nothing new was requested"),
  });
  expect(f.answer(false)).toBeUndefined();
  expect(f.notices).toEqual([expect.stringMatching(/refused.*Do not request it again/s)]);
  expect(f.driver.open).not.toHaveBeenCalled();
  expect(host.agentRequests(CHAT)).toEqual([]);
});
it("deny refuses even the initial prompt", async () => {
  const f = fixture("deny");
  await expect(f.request()).rejects.toMatchObject({ code: "denied" });
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(f.driver.open).not.toHaveBeenCalled();
});
it.each(["policy", "readiness"])("revalidates %s after human consent", async (change) => {
  const f = fixture();
  await f.request();
  if (change === "policy") f.changePolicy();
  if (change === "readiness") vi.mocked(f.driver.probe).mockResolvedValue({ kind: "browser", available: false, capabilities: [], reason: "Setup required" });
  await expect(f.answer()).resolves.toMatchObject({ ok: false });
  expect(f.driver.open).not.toHaveBeenCalled();
  expect(f.notices).toEqual([expect.stringContaining("NOT enabled")]);
});
it("a permission change withdraws the unanswered card", async () => {
  const f = fixture();
  await f.request();
  f.changePolicy();
  await host.status(CHAT); // the watchdog's sweep
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(f.events).toContainEqual(
    expect.objectContaining({ controlRequestResult: expect.objectContaining({ message: expect.stringContaining("withdrawn") }) }),
  );
  // No turn is started, but the agent is told on its next one.
  expect(f.notices).toEqual([]);
  expect(f.rides).toEqual([expect.stringContaining(WITHDRAW_TEXT[WITHDRAWN.scope].agent)]);
});
it("a forgotten panel Enable request is reported, not refused forever", async () => {
  const f = fixture();
  const panel = await host.open(CHAT, "browser"); // the human's own click, never confirmed
  expect(await f.request()).toMatchObject({ status: "consent_pending", requestId: panel.id, message: expect.stringContaining("Computer view") });
  expect(getPendingRequest(CHAT)).toBeNull();
});
it("archiving the chat withdraws the card and refuses an approval that raced it", async () => {
  const f = fixture();
  await f.request();
  const promptId = getPendingRequest(CHAT)!.requestId;
  f.changePolicy(); // what an archived chat reads as: readPolicy no longer holds
  await host.status(CHAT);
  expect(getPendingRequest(CHAT)).toBeNull();
  expect(respondToPermission(CHAT, true, undefined, undefined, promptId)).toEqual({ ok: false });
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
  await f.request();
  const pending = (await host.status(CHAT)).sessions[0];
  await expect(host.stop("other-chat", pending.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(host.approve(CHAT, pending.id)).rejects.toMatchObject({ code: "denied" });
  await host.stop(CHAT, pending.id);
  expect(getPendingRequest(CHAT)).toBeNull();
  expect((await host.status(CHAT)).sessions).toEqual([]);
  expect(f.driver.open).not.toHaveBeenCalled();
  // Stopped by the human: nothing wakes the agent, but its next turn is told.
  expect(f.notices).toEqual([]);
  expect(f.rides).toEqual([expect.stringContaining(WITHDRAW_TEXT[WITHDRAWN.panelStop].agent)]);
});
it("the chat's Stop withdraws the card, and the agent's next turn is told why", async () => {
  const f = fixture();
  await f.request();
  host.withdrawChatRequests(CHAT, WITHDRAWN.stopped);
  expect(getPendingRequest(CHAT)).toBeNull();
  expect((await host.status(CHAT)).sessions).toEqual([]);
  expect(f.notices).toEqual([]);
  expect(f.rides).toEqual([expect.stringMatching(/withdrawn, and control was NOT enabled: the human pressed Stop/)]);
});
it("the turn ending does not withdraw it: the request outlives the call", async () => {
  const f = fixture();
  await f.request();
  // The tool call's own signals ending is not a Stop.
  f.controller.abort();
  f.turnController.abort();
  sessionRegistry.unregister(CHAT);
  await host.status(CHAT);
  await expect(f.answer()).resolves.toEqual({ ok: true });
  expect(f.enabledSession()).toBeDefined();
});
it.each(["stop", "run-stop"])("%s during slow startup fences and closes a late driver", async (cancellation) => {
  const f = fixture();
  let finish!: (value: typeof f.handle) => void;
  vi.mocked(f.driver.open).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.request();
  const pending = (await host.status(CHAT)).sessions[0];
  const completion = f.answer();
  await vi.waitFor(() => expect(finish).toBeDefined());
  if (cancellation === "stop") await host.stop(CHAT, pending.id);
  else host.withdrawChatRequests(CHAT, WITHDRAWN.stopped);
  finish(f.handle);
  await expect(completion).resolves.toMatchObject({ ok: false });
  await vi.waitFor(() => expect(f.close).toHaveBeenCalled());
  expect(liveSessions(f)).toBe(false);
  expect(f.notices).toEqual([]);
  expect(f.rides).toEqual([expect.stringContaining(WITHDRAW_TEXT[cancellation === "stop" ? WITHDRAWN.panelStop : WITHDRAWN.stopped].agent)]);
});
it("a Stop using the old pending ledger ID also stops a just-completed open", async () => {
  const f = fixture();
  await f.request();
  const pending = (await host.status(CHAT)).sessions[0];
  await f.answer();
  const session = f.enabledSession()!;
  await host.stop(CHAT, pending.id);
  expect(f.service.status(controlPrincipal(CHAT, "human")).find((s) => s.sessionId === session.sessionId)?.state).toBe("stopped");
});
it("never resumes a human-controlled target", async () => {
  const f = fixture();
  await f.request();
  await f.answer();
  const session = f.enabledSession()!;
  await host.takeover(CHAT, session.sessionId, session.generation);
  await expect(f.request()).rejects.toMatchObject({ code: "lease_conflict" });
  expect(f.driver.open).toHaveBeenCalledTimes(1);
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

it.each(["ask", "allow"] as const)("native desktop under %s also waits for consent and then reports its real session", async (level) => {
  const f = fixture(level, "desktop");
  expect(await f.request()).toMatchObject({ status: "consent_pending", kind: "native" });
  expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "desktop", permission: level });
  expect(f.driver.open).not.toHaveBeenCalled();
  await expect(f.answer()).resolves.toEqual({ ok: true });
  expect(f.enabledSession()).toMatchObject({ kind: "native-desktop", state: "ready", controller: "agent" });
  expect(f.notices).toEqual([expect.stringContaining("desktop control enabled")]);
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

it.each(["stop", "run-stop", "policy"])("%s in the final startup handoff cannot publish an untracked session", async (cancellation) => {
  const f = fixture();
  await f.request();
  const pendingId = (await host.status(CHAT)).sessions[0].id;
  const open = f.service.open.bind(f.service);
  vi.spyOn(f.service, "open").mockImplementation(async (...args) => {
    const lease = await open(...args);
    // Let openApproved register the grant, then cancel before the approval
    // handler resumes to publish its result and pending-ledger alias.
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (cancellation === "stop") void host.stop(CHAT, pendingId);
        else if (cancellation === "policy") f.changePolicy();
        else host.withdrawChatRequests(CHAT, WITHDRAWN.stopped);
      }),
    );
    return lease;
  });
  await expect(f.answer()).resolves.toMatchObject({ ok: false });
  expect(liveSessions(f)).toBe(false);
});

it.each(["stop", "revoke", "takeover", "expiry"])("actual session ID %s during handoff refuses HTTP and agent success", async (change) => {
  const f = fixture();
  await f.request();
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
  const completion = f.answer();
  try {
    await expect(completion).resolves.toMatchObject({ ok: false });
    await mutation;
    expect(liveSessions(f)).toBe(false);
    expect(f.notices).toEqual([expect.stringContaining("NOT enabled")]);
  } finally {
    clock?.mockRestore();
  }
});

it("initial readiness probes settle promptly on transport cancellation, a stopped turn, Stop and deadline", async () => {
  const { CONTROL_PROBE_TIMEOUT_MS } = await import("./computer-use.js");
  for (const cancellation of ["abort", "turn", "stop", "timeout"]) {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: Awaited<ReturnType<Driver["probe"]>>) => void;
    vi.mocked(f.driver.probe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = f.request();
    const rejected = expect(result).rejects.toBeDefined();
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      if (cancellation === "abort") f.controller.abort();
      if (cancellation === "turn") f.turnController.abort();
      if (cancellation === "stop") {
        const pending = (await host.status(CHAT)).sessions.find((s) => s.generation === 0)!;
        await host.stop(CHAT, pending.id);
      }
      if (cancellation === "timeout") await vi.advanceTimersByTimeAsync(CONTROL_PROBE_TIMEOUT_MS + 1);
      await rejected;
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

it("the post-consent readiness probe settles promptly on Stop and deadline", async () => {
  const { CONTROL_PROBE_TIMEOUT_MS } = await import("./computer-use.js");
  for (const cancellation of ["stop", "run-stop", "timeout"]) {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.request();
      // Read the ledger first: a status read runs probes of its own.
      const pendingId = (await host.status(CHAT)).sessions.find((s) => s.generation === 0)!.id;
      let release!: (value: Awaited<ReturnType<Driver["probe"]>>) => void;
      vi.mocked(f.driver.probe).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const completion = f.answer();
      await vi.waitFor(() => expect(release).toBeDefined());
      if (cancellation === "stop") await host.stop(CHAT, pendingId);
      if (cancellation === "run-stop") host.withdrawChatRequests(CHAT, WITHDRAWN.stopped);
      if (cancellation === "timeout") await vi.advanceTimersByTimeAsync(CONTROL_PROBE_TIMEOUT_MS + 1);
      await expect(completion).resolves.toMatchObject({ ok: false });
      release({ kind: "browser", available: true, capabilities: [] });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.driver.open).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      sessionRegistry.unregister(CHAT);
      clearOpenApprovalsForTest();
      vi.useRealTimers();
    }
  }
});
