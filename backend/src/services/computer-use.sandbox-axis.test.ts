/**
 * Three axes, three targets: Browser Use (`browserControl`) → the managed
 * browser, Computer Use (`computerControl`) → this machine's desktop, Sandbox
 * desktop (`sandboxControl`) → the container desktop. The same `cu_*` tools
 * drive all three, so each call is checked against the axis of the target its
 * grant is for — read off the service's target id, because the sandbox's
 * driver is a `native-desktop` one, exactly like the local desktop's.
 *
 * The sibling `computer-use.split-axes.test.ts` covers browser vs desktop;
 * this one adds the sandbox and checks each axis independently of the other two.
 */
import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver, type Probe } from "@wolpertingerlabs/computer-use";
import { isRideAlongNoticeLine } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy, type ComputerTargetKind } from "./computer-use-policy.js";

const hosts: ComputerUseHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

type Levels = Partial<Record<"browserControl" | "computerControl" | "sandboxControl" | "fileRead" | "fileWrite" | "codeExecution" | "webAccess", string>>;
const OTHERS = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as const;
const ALL_DENIED = { browserControl: "deny", computerControl: "deny", sandboxControl: "deny" } as const;

function fixture(levels: Levels, { withOthers = true } = {}) {
  const policyOf = (value: Levels): HostPolicy => ({
    policy: readComputerUsePolicy({ ...(withOthers ? OTHERS : {}), ...value }),
    signature: JSON.stringify(value),
  });
  let current = policyOf(levels);
  const cards: { open: boolean; input: Record<string, unknown> }[] = [];
  const confirm = vi.fn<RaiseHumanApproval>((_chatId, request) => {
    const card = { open: true, input: request.input };
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
  const notices: { text: string; wake: boolean }[] = [];
  const driver = (kind: "browser" | "native-desktop", lockDomain?: string): Driver => ({
    kind,
    lockDomain,
    probe: vi.fn(async (): Promise<Probe> => ({ kind, available: true, capabilities: ["screenshot"] })),
    open: async () => ({
      observe: async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }),
      act: async () => {},
      close: async () => {},
      releaseInput: async () => {},
    }),
  });
  // The sandbox is a remote driver in production; a remote one needs an identity for consent binding.
  const sandbox = Object.assign(driver("native-desktop", "sandbox-axis-test:sandbox"), {
    endpoint: "127.0.0.1:7801",
    identity: async () => ({ instanceId: "11111111-1111-4111-8111-111111111111" }),
    // As the remote driver records it; consent is checked against this after open.
    openedInstance: () => "11111111-1111-4111-8111-111111111111",
  });
  const drivers = { browser: driver("browser"), desktop: driver("native-desktop", "sandbox-axis-test:desktop"), sandbox };
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: drivers.browser },
      { id: "native-desktop", enabled: true, driver: drivers.desktop },
      { id: "sandbox-desktop", enabled: true, driver: drivers.sandbox },
    ],
    authorize: (request) => host.authorize(request),
  });
  const host: ComputerUseHost = new ComputerUseHost(
    service,
    drivers,
    () => current,
    confirm,
    (_chatId, text, options) => notices.push({ text, wake: options?.wake !== false }),
  );
  hosts.push(host);
  const enable = async (kind: ComputerTargetKind) => {
    const request = await host.open("a", kind);
    return (request.state === "pending_approval" ? await host.approve("a", request.id) : request) as { id: string; generation: number; kind: string };
  };
  const act = async (opened: { id: string; generation: number }) => {
    const frame = await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation });
    return host.requestAgentAction("a", opened.id, opened.generation, frame.frameId, { type: "click", x: 1, y: 1 }, async () => ({ ok: true }));
  };
  const expire = () => (host as unknown as { expire(): Promise<void> }).expire();
  return { host, service, confirm, cards, notices, enable, act, expire, set: (next: Levels) => (current = policyOf(next)) };
}

const KINDS: ComputerTargetKind[] = ["browser", "desktop", "sandbox"];
const AXIS = { browser: "browserControl", desktop: "computerControl", sandbox: "sandboxControl" } as const;

it.each(KINDS)("each axis alone opens only its own target: %s", async (only) => {
  // Every other axis allowed, so the desktop's own requirements are met when it is the one.
  const f = fixture({ ...ALL_DENIED, browserControl: only === "desktop" ? "allow" : "deny", [AXIS[only]]: "allow" });
  await expect(f.enable(only)).resolves.toMatchObject({ kind: only === "desktop" ? "native" : only });
  for (const other of KINDS.filter((kind) => kind !== only && !(only === "desktop" && kind === "browser")))
    await expect(f.host.open("a", other)).rejects.toMatchObject({ code: "denied" });
});

it("the sandbox needs only sandboxControl: every other axis may be deny", async () => {
  const f = fixture({ sandboxControl: "allow" }, { withOthers: false });
  const sandbox = await f.enable("sandbox");
  expect(sandbox.kind).toBe("sandbox");
  await expect(f.act(sandbox)).resolves.toEqual({ ok: true });
  for (const other of ["browser", "desktop"] as const) await expect(f.host.open("a", other)).rejects.toMatchObject({ code: "denied" });
});

it("the desktop does not require sandboxControl", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "allow", sandboxControl: "deny" });
  await expect(f.enable("desktop")).resolves.toMatchObject({ kind: "native" });
  await expect(f.host.open("a", "sandbox")).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("Sandbox desktop is denied") });
});

it("Sandbox desktop Ask prompts for a sandbox action while the other two are Allow", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "allow", sandboxControl: "ask" });
  const sandbox = await f.enable("sandbox");
  await expect(f.act(sandbox)).resolves.toMatchObject({ status: "approval_pending", summary: expect.stringContaining("sandbox desktop at 127.0.0.1:7801") });
  expect(f.cards.at(-1)?.input).toMatchObject({ kind: "sandbox" });
  // …and the local desktop, on Allow, acts unattended: the desktop's kind is not the sandbox's.
  // (One GUI action waits per chat, so the sandbox's is withdrawn first.)
  f.host.withdrawAgentAction("a", sandbox.id);
  const desktop = await f.enable("desktop");
  await expect(f.act(desktop)).resolves.toEqual({ ok: true });
  expect(f.confirm).toHaveBeenCalledTimes(1);
});

it("Sandbox desktop Allow runs sandbox actions unattended while Computer Use Ask still prompts", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "ask", sandboxControl: "allow" });
  const sandbox = await f.enable("sandbox");
  await expect(f.act(sandbox)).resolves.toEqual({ ok: true });
  expect(f.confirm).not.toHaveBeenCalled();
  const desktop = await f.enable("desktop");
  await expect(f.act(desktop)).resolves.toMatchObject({ status: "approval_pending" });
  expect(f.cards.at(-1)?.input).toMatchObject({ kind: "desktop" });
});

it("status reports the sandbox's own level, readiness and kind", async () => {
  const f = fixture({ ...ALL_DENIED, sandboxControl: "ask" });
  const status = await f.host.status("a");
  expect(status.permission).toBe("ask");
  expect(status.capabilities.map((c) => c.kind)).toEqual(["browser", "native", "sandbox"]);
  expect(status.capabilities.find((c) => c.kind === "sandbox")).toMatchObject({ permission: "ask", available: true });
  f.set({ ...ALL_DENIED, browserControl: "allow" });
  expect((await f.host.status("a")).capabilities.find((c) => c.kind === "sandbox")).toMatchObject({
    permission: "deny",
    available: false,
    readiness: "permission-blocked",
    reason: expect.stringContaining("Sandbox desktop is denied"),
  });
});

it("a client without the sandbox capability is never shown the sandbox", async () => {
  const f = fixture({ ...ALL_DENIED, sandboxControl: "allow" });
  const sandbox = await f.enable("sandbox");
  // A pending panel request for the sandbox too (under ask), and the session's events.
  f.set({ ...ALL_DENIED, sandboxControl: "ask" });
  await f.expire();
  await f.host.open("a", "sandbox");
  const full = await f.host.status("a");
  expect(full.sessions.some((s) => s.kind === "sandbox")).toBe(true);

  const old = await f.host.status("a", { sandbox: false });
  expect(old.capabilities.map((c) => c.kind)).toEqual(["browser", "native"]);
  expect(old.sessions).toEqual([]);
  expect(JSON.stringify(old)).not.toContain("sandbox");
  expect((old.events as { sessionId?: string }[]).some((event) => event.sessionId === sandbox.id)).toBe(false);
  // The aggregate covers only the targets it is shown: nothing it can enable.
  expect(old.permission).toBe("deny");
});

it("an old client still sees the browser and desktop, with their own aggregate", async () => {
  const f = fixture({ browserControl: "ask", computerControl: "deny", sandboxControl: "allow" });
  const browser = await f.enable("browser");
  const old = await f.host.status("a", { sandbox: false });
  expect(old.permission).toBe("ask");
  expect(old.sessions.map((s) => s.id)).toEqual([browser.id]);
});

it("changing sandboxControl withdraws a pending sandbox enable request with a strict ride-along notice", async () => {
  const f = fixture({ ...ALL_DENIED, sandboxControl: "ask" });
  const pending = await f.host.requestControl("a", "sandbox", "Open the attachment in a throwaway desktop", new AbortController().signal);
  expect(pending).toMatchObject({ status: "consent_pending", kind: "sandbox" });
  expect(f.cards[0].input).toMatchObject({ kind: "sandbox", target: "sandbox 127.0.0.1:7801", permission: "ask" });
  expect(f.host.agentRequests("a")).toEqual([{ requestId: (pending as { requestId: string }).requestId, type: "enable_control", kind: "sandbox" }]);

  f.set({ ...ALL_DENIED, sandboxControl: "allow" });
  await f.expire();
  expect(f.cards[0].open).toBe(false);
  expect(f.host.agentRequests("a")).toEqual([]);
  expect(f.notices).toHaveLength(1);
  const notice = f.notices[0];
  expect(notice).toMatchObject({ wake: false, text: expect.stringContaining("sandbox desktop control request withdrawn") });
  expect(notice.text).toContain("Sandbox desktop permissions changed");
  // The notice is one of the fixed templates the transcript split recognises.
  expect(isRideAlongNoticeLine(notice.text.replace(/\s*\n+\s*/g, " "))).toBe(true);
});

it("changing sandboxControl revokes a live sandbox grant, and changing another axis does too", async () => {
  for (const change of [{ sandboxControl: "ask" }, { browserControl: "allow" }]) {
    const f = fixture({ ...ALL_DENIED, sandboxControl: "allow" });
    const sandbox = await f.enable("sandbox");
    const frame = await f.service.observe(controlPrincipal("a", "agent"), { sessionId: sandbox.id, generation: sandbox.generation });
    f.set({ ...ALL_DENIED, sandboxControl: "allow", ...change });
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(f.host.requestAgentAction("a", sandbox.id, sandbox.generation, frame.frameId, { type: "click", x: 1, y: 1 }, execute)).rejects.toMatchObject({
      code: "revoked",
    });
    expect(execute).not.toHaveBeenCalled();
  }
});

it("changing sandboxControl withdraws a pending sandbox action", async () => {
  const f = fixture({ ...ALL_DENIED, sandboxControl: "ask" });
  const sandbox = await f.enable("sandbox");
  const pending = await f.act(sandbox);
  expect(pending).toMatchObject({ status: "approval_pending" });
  f.set({ ...ALL_DENIED, sandboxControl: "deny" });
  await f.expire();
  expect(f.cards.at(-1)?.open).toBe(false);
  expect(f.notices.at(-1)?.text).toContain(`Your request ${(pending as { requestId: string }).requestId} (a click action) was withdrawn`);
});

it("the service authorizer reads the sandbox's axis by target id, not by driver kind", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "allow", sandboxControl: "deny" });
  const request = { principal: controlPrincipal("a", "agent"), operation: "observe" as const, kind: "native-desktop" as const };
  expect(f.host.authorize({ ...request, targetId: "sandbox-desktop" })).toBe("deny");
  f.set({ ...ALL_DENIED, sandboxControl: "allow" }); // the desktop's own scope is now denied
  expect(f.host.authorize({ ...request, operation: "open", targetId: "native-desktop" })).toBe("deny");
});
