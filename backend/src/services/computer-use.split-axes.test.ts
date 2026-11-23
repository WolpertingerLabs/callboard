/**
 * Browser Use (`browserControl`) and Computer Use (`computerControl`) are two
 * axes, one per target. The same `cu_*` tools drive both, so the per-target
 * decision is the host's: each call is checked against the axis of the target
 * its grant is for, never the other one.
 */
import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver, type Probe } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";

const hosts: ComputerUseHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

const OTHERS = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as const;

function fixture(levels: { browserControl: string; computerControl: string }) {
  const policyOf = (value: typeof levels): HostPolicy => ({ policy: readComputerUsePolicy({ ...OTHERS, ...value }), signature: JSON.stringify(value) });
  let current = policyOf(levels);
  // Records each question raised; nothing waits on it (approvals are non-blocking).
  const cards: { open: boolean }[] = [];
  const confirm = vi.fn<RaiseHumanApproval>(() => {
    const card = { open: true };
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
  const driver = (kind: "browser" | "native-desktop"): Driver => ({
    kind,
    lockDomain: kind === "native-desktop" ? "split-axes-test" : undefined,
    probe: vi.fn(async (): Promise<Probe> => ({ kind, available: true, capabilities: ["screenshot"] })),
    open: async () => ({
      observe: async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }),
      act: async () => {},
      close: async () => {},
      releaseInput: async () => {},
    }),
  });
  const drivers = { browser: driver("browser"), desktop: driver("native-desktop") };
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: drivers.browser },
      { id: "native-desktop", enabled: true, driver: drivers.desktop },
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
  /** Enable as the human does: one click under allow, click plus panel confirmation under ask. */
  const enable = async (kind: "browser" | "desktop") => {
    const request = await host.open("a", kind);
    return (request.state === "pending_approval" ? await host.approve("a", request.id) : request) as { id: string; generation: number };
  };
  const act = async (opened: { id: string; generation: number }) => {
    const frame = await service.observe(controlPrincipal("a", "agent"), { sessionId: opened.id, generation: opened.generation });
    return host.requestAgentAction("a", opened.id, opened.generation, frame.frameId, { type: "click", x: 1, y: 1 }, async () => ({ ok: true }));
  };
  return { host, service, confirm, cards, notices, enable, act, set: (next: typeof levels) => (current = policyOf(next)) };
}

it("Browser Use: Ask prompts for a browser action even when Computer Use is Allow", async () => {
  const f = fixture({ browserControl: "ask", computerControl: "allow" });
  const browser = await f.enable("browser");
  await expect(f.act(browser)).resolves.toMatchObject({ status: "approval_pending" });
  expect(f.confirm).toHaveBeenCalledTimes(1);
  // …and the desktop is refused outright: it needs Browser Use on allow too.
  await expect(f.host.open("a", "desktop")).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("browserControl") });
});

it("Browser Use Allow runs browser actions unattended while Computer Use Ask still prompts on the desktop", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "ask" });
  const browser = await f.enable("browser");
  await expect(f.act(browser)).resolves.toEqual({ ok: true });
  expect(f.confirm).not.toHaveBeenCalled();
  const desktop = await f.enable("desktop");
  await expect(f.act(desktop)).resolves.toMatchObject({ status: "approval_pending" });
  expect(f.confirm).toHaveBeenCalledTimes(1);
});

it("each target is enabled by its own axis: Browser Use alone opens the browser, never the desktop", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "deny" });
  await expect(f.enable("browser")).resolves.toBeDefined();
  await expect(f.host.open("a", "desktop")).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("Computer Use is denied") });

  const g = fixture({ browserControl: "deny", computerControl: "allow" });
  await expect(g.host.open("a", "browser")).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("Browser Use is denied") });
});

it("status reports each target's own level and the most permissive one at the top", async () => {
  const f = fixture({ browserControl: "ask", computerControl: "deny" });
  const status = await f.host.status("a");
  expect(status.permission).toBe("ask");
  expect(status.capabilities.find((c) => c.kind === "browser")).toMatchObject({ permission: "ask", available: true });
  const native = status.capabilities.find((c) => c.kind === "native");
  expect(native).toMatchObject({ permission: "deny", available: false, readiness: "permission-blocked" });
  // A refused browser keeps its reason but never borrows the desktop's readiness label.
  f.set({ browserControl: "deny", computerControl: "allow" });
  const denied = (await f.host.status("a")).capabilities.find((c) => c.kind === "browser");
  expect(denied).toMatchObject({ permission: "deny", available: false, reason: expect.stringContaining("Browser Use is denied") });
  expect(denied).not.toHaveProperty("readiness");
});

it("changing Browser Use revokes a live desktop grant (the signature covers both axes)", async () => {
  const f = fixture({ browserControl: "allow", computerControl: "allow" });
  const desktop = await f.enable("desktop");
  const frame = await f.service.observe(controlPrincipal("a", "agent"), { sessionId: desktop.id, generation: desktop.generation });
  f.set({ browserControl: "ask", computerControl: "allow" });
  const execute = vi.fn(async () => ({ ok: true }));
  await expect(f.host.requestAgentAction("a", desktop.id, desktop.generation, frame.frameId, { type: "click", x: 1, y: 1 }, execute)).rejects.toMatchObject({
    code: "revoked",
  });
  expect(execute).not.toHaveBeenCalled();
});

it("flipping Computer Use withdraws a pending browser action under Browser Use Ask, with a withdrawal notice", async () => {
  const f = fixture({ browserControl: "ask", computerControl: "allow" });
  const browser = await f.enable("browser");
  const pending = await f.act(browser);
  expect(pending).toMatchObject({ status: "approval_pending" });
  expect(f.cards[0].open).toBe(true);
  // The other axis changes: the signature covers both, so the grant the card was raised under no longer holds.
  f.set({ browserControl: "ask", computerControl: "deny" });
  await (f.host as unknown as { expire(): Promise<void> }).expire();
  expect(f.cards[0].open).toBe(false);
  expect(f.host.agentRequests("a")).toEqual([]);
  // Queued for the agent's next turn (ride-along), naming the request and the fixed reason.
  expect(f.notices).toEqual([
    {
      wake: false,
      text: expect.stringContaining(`Your request ${(pending as { requestId: string }).requestId} (a click action) was withdrawn before the human answered`),
    },
  ]);
  expect(f.notices[0].text).toContain("permissions changed");
});
