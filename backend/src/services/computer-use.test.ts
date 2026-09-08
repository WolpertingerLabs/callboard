import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver, type Probe } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, type HostPolicy } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";

const hosts: ComputerUseHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});
function fixture(level = "allow") {
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
  const host: ComputerUseHost = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => current);
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
  it("mutation approval is scoped, one-use, and invalidated by takeover", async () => {
    const { host, service } = fixture();
    const opened = await host.open("a", "browser");
    const execute = vi.fn(async () => ({ done: true }));
    const approval = await host.requestAgentAction(
      "a",
      opened.id,
      opened.generation,
      (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId,
      { type: "click", x: 1, y: 1 },
      execute,
    );
    expect(execute).not.toHaveBeenCalled();
    await host.takeover("a", opened.id, opened.generation);
    await expect(host.approve("a", approval.approvalId)).rejects.toMatchObject({ code: "stale_generation" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not report a failed MCP mutation as a successful human approval", async () => {
    const { host, service } = fixture();
    const opened = await host.open("a", "browser");
    const approval = await host.requestAgentAction(
      "a",
      opened.id,
      opened.generation,
      (await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation })).frameId,
      { type: "click", x: 1, y: 1 },
      async () => ({
        isError: true,
        content: [],
      }),
    );
    await expect(host.approve("a", approval.approvalId)).rejects.toMatchObject({ code: "driver_error" });
    await expect(host.approve("a", approval.approvalId)).rejects.toMatchObject({ code: "denied" });
  });
  it("changed permissions invalidate pending session grants", async () => {
    const { host, change } = fixture("ask");
    const pending = await host.open("a", "browser");
    change("deny");
    await expect(host.approve("a", pending.id)).rejects.toMatchObject({ code: "denied" });
  });
});

for (const level of ["allow", "ask"])
  it(`frame-bound approvals remain visible under ${level} but cannot execute after another capture`, async () => {
    const { host, service } = fixture(level);
    let opened = await host.open("a", "browser");
    if (level === "ask") opened = (await host.approve("a", opened.id)) as typeof opened;
    const ref = { sessionId: opened.id, generation: opened.generation };
    const frame = await service.observe(controlPrincipal("a", "agent"), ref);
    const action = { type: "click", x: 1, y: 2 };
    const execute = vi.fn(async () => ({}));
    const approval = await host.requestAgentAction("a", opened.id, opened.generation, frame.frameId, action, execute);
    action.x = 90;
    expect((await host.status("a")).sessions).toContainEqual(
      expect.objectContaining({
        id: approval.approvalId,
        state: "pending_approval",
        requestedFrameId: frame.frameId,
        requestedAction: { type: "click", x: 1, y: 2 },
        reason: expect.stringContaining(frame.frameId),
      }),
    );
    await service.observe(controlPrincipal("a", "agent"), ref);
    await expect(host.approve("a", approval.approvalId)).rejects.toMatchObject({ code: "stale_frame" });
    expect(execute).not.toHaveBeenCalled();
    await expect(host.approve("a", approval.approvalId)).rejects.toMatchObject({ code: "denied" });
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

it.each(["approve", "expire", "revoke", "stop", "invalidated approval"] as const)(
  "removes an action request on %s without treating its parent session as a request",
  async (operation) => {
    const { host, service, change } = fixture();
    const opened = await host.open("a", "browser");
    const frame = await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation });
    const execute = vi.fn(async () => ({ done: true }));
    const request = await host.requestAgentAction("a", opened.id, opened.generation, frame.frameId, { type: "key", key: "Enter" }, execute);
    expect((await host.status("a")).sessions).toContainEqual(expect.objectContaining({ id: request.approvalId, generation: 0, parentSessionId: opened.id }));
    const now = vi.spyOn(Date, "now");
    try {
      if (operation === "expire") now.mockReturnValue(Date.now() + 120_001);
      else if (operation === "invalidated approval") {
        change("deny");
        await expect(host.approve("a", request.approvalId)).rejects.toMatchObject({ code: "denied" });
      } else await host[operation]("a", request.approvalId);
      const sessions = (await host.status("a")).sessions;
      expect(sessions.some((session) => session.id === request.approvalId)).toBe(false);
      expect(sessions.find((session) => session.id === opened.id)?.generation).toBeGreaterThan(0);
      if (operation !== "invalidated approval") expect(sessions.find((session) => session.id === opened.id)?.state).toBe("ready");
      expect(execute).toHaveBeenCalledTimes(operation === "approve" ? 1 : 0);
      await expect(host.stop("a", request.approvalId)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      now.mockRestore();
    }
  },
);

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
