import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver, type Probe } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, describeAgentAction, type ActionConfirmationRequest, type ConfirmAgentAction, type HostPolicy } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";

const hosts: ComputerUseHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

/** A stand-in human whose answer the test controls, and whose question it can read. */
function human() {
  const asked: ActionConfirmationRequest[] = [];
  let announce!: (request: ActionConfirmationRequest) => void;
  const questioned = new Promise<ActionConfirmationRequest>((resolve) => {
    announce = resolve;
  });
  let answer!: (outcome: { approved: boolean; reason: "human" | "denied" }) => void;
  const answered = new Promise<{ approved: boolean; reason: "human" | "denied" }>((resolve) => {
    answer = resolve;
  });
  const confirm: ConfirmAgentAction = vi.fn(async (request) => {
    asked.push(request);
    announce(request);
    return answered;
  });
  return {
    confirm,
    asked,
    questioned,
    approve: () => answer({ approved: true, reason: "human" }),
    deny: () => answer({ approved: false, reason: "denied" }),
  };
}
/** The impatient human: says yes without the test having to drive them. */
const alwaysApproves: ConfirmAgentAction = async () => ({ approved: true, reason: "human" });

function fixture(level = "allow", confirm: ConfirmAgentAction = alwaysApproves) {
  let current: HostPolicy = {
    policy: readComputerUsePolicy({ computerControl: level, webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" }),
    signature: level,
  };
  const observe = vi.fn(async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }));
  const act = vi.fn(async () => {});
  const probe = vi.fn(async (): Promise<Probe> => ({ kind: "browser", available: true, capabilities: ["screenshot"] }));
  const driver: Driver = {
    kind: "browser",
    probe,
    open: async () => ({ observe, act, close: async () => {}, releaseInput: async () => {} }),
  };
  const service = new ComputerUseService({ targets: [{ id: "managed-browser", enabled: true, driver }], authorize: (request) => host.authorize(request) });
  const host: ComputerUseHost = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => current, confirm);
  hosts.push(host);
  return {
    host,
    service,
    act,
    observe,
    probe,
    change: (level: string) => {
      current = { policy: readComputerUsePolicy({ ...current.policy, computerControl: level }), signature: level };
    },
  };
}
describe("computer-use human grants", () => {
  it("MCP/service callers cannot open targets by forging a human role or knowing its ID", async () => {
    const { service } = fixture();
    await expect(service.open(controlPrincipal("a", "agent"), "managed-browser")).rejects.toMatchObject({ code: "denied" });
    await expect(service.open(controlPrincipal("a", "human"), "managed-browser")).rejects.toMatchObject({ code: "denied" });
  });
  it("ask launches nothing before scoped approval and wrong-owner approval cannot consume it", async () => {
    const { host, service } = fixture("ask");
    const pending = await host.open("a", "browser");
    expect(pending.state).toBe("pending_approval");
    expect(service.status(controlPrincipal("a", "agent"))).toHaveLength(0);
    await expect(host.approve("b", pending.id)).rejects.toMatchObject({ code: "not_found" });
    const opened = (await host.approve("a", pending.id)) as { id: string; state: string };
    expect(opened.state).toBe("ready");
    await expect(host.approve("a", pending.id)).rejects.toMatchObject({ code: "denied" });
    await expect(host.observe("b", opened.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("a mid-session permission change blocks capture before driver execution", async () => {
    const { host, observe, change } = fixture();
    const opened = await host.open("a", "browser");
    change("deny");
    await expect(host.observe("a", opened.id)).rejects.toMatchObject({ code: "revoked" });
    expect(observe).not.toHaveBeenCalled();
    expect((await host.stop("a", opened.id)).state).toBe("revoked");
  });
  it("manual input requires human takeover and a matching generation", async () => {
    const { host, act } = fixture();
    const opened = await host.open("a", "browser");
    const preview = await host.observe("a", opened.id);
    await expect(host.action("a", opened.id, { type: "click", x: 1, y: 1 }, opened.generation, preview.frameId)).rejects.toMatchObject({
      code: "lease_conflict",
    });
    const taken = await host.takeover("a", opened.id, opened.generation);
    await expect(host.action("a", opened.id, { type: "click", x: 1, y: 1 }, opened.generation, preview.frameId)).rejects.toMatchObject({
      code: "stale_generation",
    });
    await host.action("a", opened.id, { type: "click", x: 1, y: 1 }, taken.generation, (await host.observe("a", opened.id)).frameId);
    expect(act).toHaveBeenCalledOnce();
    const resumed = await host.resume("a", opened.id, taken.generation);
    expect(resumed.controller).toBe("agent");
  });
  it("mutation approval is scoped, blocks until answered, and is invalidated by takeover", async () => {
    const person = human();
    const { host, service } = fixture("allow", person.confirm);
    const opened = await host.open("a", "browser");
    const execute = vi.fn(async () => ({ done: true }));
    const call = host.requestAgentAction(
      "a",
      opened.id,
      opened.generation,
      (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId,
      { type: "click", x: 1, y: 1 },
      execute,
    );
    const rejection = expect(call).rejects.toMatchObject({ code: "stale_generation" });
    await person.questioned;
    expect(execute).not.toHaveBeenCalled();
    // The world moved while the human was reading: their answer is scoped to
    // the generation they saw, and cannot execute against the one that replaced it.
    await host.takeover("a", opened.id, opened.generation);
    person.approve();
    await rejection;
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not report a failed MCP mutation as a successful human approval, and re-asks for the retry", async () => {
    const { host, service } = fixture();
    const opened = await host.open("a", "browser");
    const attempt = async () =>
      host.requestAgentAction(
        "a",
        opened.id,
        opened.generation,
        (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId,
        { type: "click", x: 1, y: 1 },
        async () => ({ isError: true, content: [] }),
      );
    await expect(attempt()).rejects.toMatchObject({ code: "driver_error" });
    // No approval survives the failure to be redeemed a second time: the retry
    // is a fresh request that asks the human again.
    await expect(attempt()).rejects.toMatchObject({ code: "driver_error" });
  });
  it("reports a refusal as a refusal and never as something to retry", async () => {
    const person = human();
    const { host, service } = fixture("allow", person.confirm);
    const opened = await host.open("a", "browser");
    const execute = vi.fn(async () => ({ done: true }));
    const call = host.requestAgentAction(
      "a",
      opened.id,
      opened.generation,
      (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId,
      { type: "navigate", url: "https://example.com" },
      execute,
    );
    await person.questioned;
    person.deny();
    await expect(call).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("NOT performed") });
    await expect(call).rejects.toMatchObject({ message: expect.stringContaining("Do not repeat it") });
    expect(execute).not.toHaveBeenCalled();
  });
  it("asks in readable terms — the action and its target, not session and frame UUIDs", async () => {
    const person = human();
    const { host, service } = fixture("allow", person.confirm);
    const opened = await host.open("a", "browser");
    const frameId = (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId;
    const action = { type: "navigate", url: "https://example.com" };
    const call = host.requestAgentAction("a", opened.id, opened.generation, frameId, action, async () => ({}));
    const question = await person.questioned;
    expect(question.summary).toContain("Open https://example.com in the managed browser");
    expect(question.action).toEqual({ type: "navigate", url: "https://example.com" });
    expect(JSON.stringify(question)).not.toContain(frameId);
    expect(JSON.stringify(question)).not.toContain(opened.id);
    // The snapshot the human was shown is the one that runs.
    action.url = "https://evil.example";
    expect(question.action).toEqual({ type: "navigate", url: "https://example.com" });
    person.approve();
    await call;
  });
  it("refuses a second concurrent GUI action rather than replacing the question the human is reading", async () => {
    const person = human();
    const { host, service } = fixture("allow", person.confirm);
    const opened = await host.open("a", "browser");
    const frameId = (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId;
    const first = host.requestAgentAction("a", opened.id, opened.generation, frameId, { type: "key", key: "Enter" }, async () => ({ done: true }));
    await person.questioned;
    await expect(
      host.requestAgentAction("a", opened.id, opened.generation, frameId, { type: "key", key: "Escape" }, async () => ({ done: true })),
    ).rejects.toMatchObject({ code: "queue_full" });
    person.approve();
    await first;
  });
  it("changed permissions invalidate pending session grants", async () => {
    const { host, change } = fixture("ask");
    const pending = await host.open("a", "browser");
    change("deny");
    await expect(host.approve("a", pending.id)).rejects.toMatchObject({ code: "denied" });
  });
});

for (const level of ["allow", "ask"])
  it(`a ${level} chat's confirmed action still cannot execute after another capture`, async () => {
    const person = human();
    const { host, service } = fixture(level, person.confirm);
    let opened = await host.open("a", "browser");
    if (level === "ask") opened = (await host.approve("a", opened.id)) as typeof opened;
    const ref = { sessionId: opened.id, generation: opened.generation };
    const frame = await service.observe(controlPrincipal("a", "agent"), ref);
    const execute = vi.fn(async () => ({}));
    const call = host.requestAgentAction("a", opened.id, opened.generation, frame.frameId, { type: "click", x: 1, y: 2 }, execute);
    const rejection = expect(call).rejects.toMatchObject({ code: "stale_frame" });
    await person.questioned;
    // Coordinates mean nothing once the pixels under them may have changed.
    await service.observe(controlPrincipal("a", "agent"), ref);
    person.approve();
    await rejection;
    expect(execute).not.toHaveBeenCalled();
  });

// Viewer ledger contract: pending DTOs are consumable request IDs, not sessions.
// Exercise the real host/package with only driver I/O faked.
it("approval replaces the generation-zero target request with a different real session ID", async () => {
  const { host } = fixture("ask");
  const request = await host.open("a", "browser");
  expect(request).toMatchObject({ generation: 0, state: "pending_approval" });
  const opened = (await host.approve("a", request.id)) as { id: string; generation: number };
  expect(opened.id).not.toBe(request.id);
  expect(opened.generation).toBeGreaterThan(0);
  expect((await host.status("a")).sessions.map((session) => session.id)).toEqual([opened.id]);
  await expect(host.stop("a", request.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(host.stop("a", opened.id, opened.generation)).resolves.toMatchObject({ id: opened.id, state: "stopped" });
});

it("an awaited GUI action is not a session: it never appears in the viewer's ledger", async () => {
  // It used to. A parked approval was presented as a generation-zero
  // pending_approval "session" so the panel could offer Confirm/Deny for it,
  // which is exactly the UI this refactor removed. The parent session must
  // still read as the live one throughout.
  const person = human();
  const { host, service } = fixture("allow", person.confirm);
  const opened = await host.open("a", "browser");
  const frame = await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation });
  const execute = vi.fn(async () => ({ done: true }));
  const call = host.requestAgentAction("a", opened.id, opened.generation, frame.frameId, { type: "key", key: "Enter" }, execute);
  await person.questioned;
  const sessions = (await host.status("a")).sessions;
  expect(sessions.map((session) => session.id)).toEqual([opened.id]);
  expect(sessions[0]).toMatchObject({ state: "ready" });
  person.approve();
  await call;
  expect(execute).toHaveBeenCalledOnce();
  expect((await host.status("a")).sessions.map((session) => session.id)).toEqual([opened.id]);
});

it("a target request under ask is still a request the panel can confirm, expire or revoke", async () => {
  // The Enable flow is untouched: it is the human's own click, confirmed in
  // the panel where they clicked it.
  const { host } = fixture("ask");
  const request = await host.open("a", "browser");
  expect((await host.status("a")).sessions).toContainEqual(expect.objectContaining({ id: request.id, state: "pending_approval" }));
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(Date.now() + 120_001);
    expect((await host.status("a")).sessions.some((session) => session.id === request.id)).toBe(false);
  } finally {
    now.mockRestore();
  }
  const second = await host.open("a", "browser");
  expect((await host.revoke("a", second.id)).state).toBe("revoked");
  expect((await host.status("a")).sessions).toEqual([]);
});

it("describes every action type in words a human can act on", () => {
  const target = "managed browser on workshop";
  const said = (action: Record<string, unknown>) => describeAgentAction(action, target);
  expect(said({ type: "navigate", url: "https://example.com/login" })).toBe("Open https://example.com/login in the managed browser on workshop");
  expect(said({ type: "click", x: 412, y: 233 })).toBe("Click at (412, 233) in the managed browser on workshop");
  expect(said({ type: "click", x: 1, y: 2, button: "right" })).toBe("Right-click at (1, 2) in the managed browser on workshop");
  expect(said({ type: "move", x: 3, y: 4 })).toBe("Move the pointer to (3, 4) in the managed browser on workshop");
  expect(said({ type: "drag", x: 1, y: 2, toX: 9, toY: 8 })).toBe("Drag from (1, 2) to (9, 8) in the managed browser on workshop");
  expect(said({ type: "scroll", deltaX: 0, deltaY: -400 })).toBe("Scroll by (0, -400) in the managed browser on workshop");
  expect(said({ type: "key", key: "Control+a" })).toBe("Press Control+a in the managed browser on workshop");
  expect(said({ type: "type", text: "hello" })).toBe("Type “hello” into the managed browser on workshop");
  expect(said({ type: "wait", durationMs: 500 })).toBe("Wait 500ms on the managed browser on workshop");
  // A 4096-character `type` is legal; a prompt the human has to scroll past is not.
  expect(said({ type: "type", text: "x".repeat(4096) })).toBe(`Type “${"x".repeat(160)}…” into the managed browser on workshop`);
});

it("resume hands the viewer control state, not the screenshot the service captured for the agent", async () => {
  const { host } = fixture();
  const opened = await host.open("a", "browser");
  const taken = await host.takeover("a", opened.id, opened.generation);
  const resumed = await host.resume("a", opened.id, taken.generation);
  expect(resumed.controller).toBe("agent");
  expect(resumed).not.toHaveProperty("observation");
  // Nor may the grant retain it: the next presentation of the lease is clean too.
  const again = await host.takeover("a", opened.id, resumed.generation);
  expect(again).not.toHaveProperty("observation");
});

it("caches driver probes across status polls instead of re-executing them every second", async () => {
  const { host, probe } = fixture();
  await host.status("a");
  await host.status("a");
  await host.status("a");
  // Both drivers in the fixture share this probe (browser + the native stand-in).
  expect(probe).toHaveBeenCalledTimes(2);
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(Date.now() + 10_000);
    await host.status("a");
    expect(probe).toHaveBeenCalledTimes(4);
  } finally {
    now.mockRestore();
  }
});

it("does not cache a failed probe, so a fixed prerequisite is seen on the next poll", async () => {
  const { host, probe } = fixture();
  probe.mockRejectedValueOnce(new Error("no display"));
  const first = await host.status("a");
  expect(first.capabilities.find((c) => c.kind === "browser")?.available).toBe(false);
  const second = await host.status("a");
  expect(second.capabilities.find((c) => c.kind === "browser")?.available).toBe(true);
});

it("shows the human control plane the driver's operator diagnostics, which no agent surface carries", async () => {
  const { host, probe } = fixture();
  probe.mockResolvedValueOnce({
    kind: "browser",
    available: false,
    capabilities: [],
    reason: "Chromium executable not found; run \"npx playwright install chromium\"",
    operatorDetail: "Checked /home/operator/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  });
  const capability = (await host.status("a")).capabilities.find((c) => c.kind === "browser");
  expect(capability?.reason).toContain("/home/operator/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
  expect(capability?.reason).toContain("Chromium executable not found");
  expect(capability).not.toHaveProperty("operatorDetail");
});

it("does not cache an unavailable probe either: the shipped drivers resolve their failures, not reject them", async () => {
  const { host, probe } = fixture();
  // Both real drivers catch everything and resolve `{ available: false, reason }`.
  probe.mockResolvedValueOnce({ kind: "browser", available: false, capabilities: [], reason: "Install xdotool" });
  const first = await host.status("a");
  expect(first.capabilities.find((c) => c.kind === "browser")).toMatchObject({ available: false, reason: "Install xdotool" });
  const calls = probe.mock.calls.length;
  const second = await host.status("a");
  expect(second.capabilities.find((c) => c.kind === "browser")?.available).toBe(true);
  // The browser probe re-ran; the (available) native stand-in was served from cache.
  expect(probe.mock.calls.length).toBe(calls + 1);
});
