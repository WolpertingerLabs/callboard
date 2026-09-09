/**
 * The invariant: **a chat set to `computerControl: "ask"` cannot have a GUI
 * action performed without an explicit human confirmation.** No policy value,
 * hook, allow-list entry, adapter, subagent or API key can satisfy it — only a
 * signed-in human answering the prompt in that chat.
 *
 * `ask` and `allow` are now two different contracts, and the danger is that
 * they blur. `allow` deliberately performs GUI actions unattended: that is the
 * user's informed choice, and this file asserts it works rather than pretending
 * otherwise. What must not happen is `ask` quietly acquiring the same
 * behaviour — through a second policy read, an "effective level", a
 * confirmation with a configurable default, or a test double that says yes.
 * Both branches are pinned here, in one place, so the difference between them
 * stays a single readable decision.
 *
 * So this file exercises the real thing, top to bottom: the real
 * `ComputerUseHost` with its DEFAULT confirmation wiring (no test double
 * injected — that is the point), the real `requestHumanApproval`, the real
 * pending-prompt registry, and the real `respondToPermission` the HTTP route
 * calls. The only fakes are the driver's pixels.
 *
 * If someone re-routes the `ask` approval through `ToolPermissionPolicy`,
 * widens the `allow` branch to cover `ask`, or gives `requestHumanApproval` an
 * auto-decide branch, the first assertion here fails: the call returns instead
 * of blocking, and the driver acts with nobody asked.
 *
 * The boundary both levels share — a human, and only a human, enables a
 * target — is pinned at the bottom.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { CU_ACTION_TOOL_NAME, type PermissionLevel, type StreamEvent } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { getPendingRequest, hasPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "chat-under-test";

const hosts: ComputerUseHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  sessionRegistry.unregister(CHAT);
  respondToPermission(CHAT, false, undefined, undefined, getPendingRequest(CHAT)?.requestId);
});

/** A chat whose every other permission axis is "allow" — the maximum a user can grant. */
function fixture(computerControl: PermissionLevel) {
  const act = vi.fn(async () => {});
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({
      act,
      close: async () => {},
      releaseInput: async () => {},
      observe: async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }),
    }),
  };
  const service = new ComputerUseService({ targets: [{ id: "managed-browser", enabled: true, driver }], authorize: (request) => host.authorize(request) });
  let level = computerControl;
  // Third argument only: the policy reader. The fourth — the confirmation — is
  // deliberately left at its production default. The signature is pinned so a
  // level change is visible to the branch under test rather than short-circuited
  // by the grant revocation a real signature change would trigger first.
  const host: ComputerUseHost = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => ({
    policy: readComputerUsePolicy({ computerControl: level, webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" }),
    signature: "pinned",
  }));
  hosts.push(host);

  // A live chat session, as `sendMessage` registers one: the prompt is emitted
  // on this emitter and answered through `POST /api/chats/:id/respond`.
  const emitter = new EventEmitter();
  const events: StreamEvent[] = [];
  emitter.on("event", (event: StreamEvent) => events.push(event));
  sessionRegistry.register(CHAT, { type: "web", abortController: new AbortController(), emitter });
  return {
    host,
    service,
    act,
    events,
    setLevel: (next: PermissionLevel) => {
      level = next;
    },
  };
}

/**
 * Enable a target the way the product does: a human's own click, through the
 * host's `open`/`approve` — the pair the agent has no route to.
 */
async function readyFrame(host: ComputerUseHost, service: ComputerUseService) {
  const request = await host.open(CHAT, "browser");
  const opened = (request.state === "pending_approval" ? await host.approve(CHAT, request.id) : request) as { id: string; generation: number };
  const frame = await service.observe(controlPrincipal(CHAT, "agent"), { sessionId: opened.id, generation: opened.generation });
  return { opened, frameId: frame.frameId };
}

it('a chat with computerControl "ask" cannot perform a GUI action without an explicit human confirmation', async () => {
  const { host, service, act, events } = fixture("ask");
  const { opened, frameId } = await readyFrame(host, service);
  const execute = vi.fn(async () => ({ done: true }));

  const call = host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "navigate", url: "https://example.com" }, execute);

  // Nothing happens on its own. Not on the next tick, not on the one after.
  const raced = await Promise.race([call.then(() => "resolved").catch(() => "rejected"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 25))]);
  expect(raced).toBe("blocked");
  expect(execute).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();

  // What happened instead: the chat is blocked on a prompt for the human,
  // carried by the same event and the same registry a tool permission request
  // or an AskUserQuestion uses.
  expect(hasPendingRequest(CHAT)).toBe(true);
  const prompt = events.find((event) => event.type === "permission_request");
  expect(prompt).toMatchObject({ type: "permission_request", toolName: CU_ACTION_TOOL_NAME });
  // `humanOnly` is what makes `POST /api/chats/:id/respond` refuse a bearer
  // `cbk_` key and a cross-origin actor: an agent holding a key must not be
  // able to confirm its own action. See `pendingRequestRequiresHuman`.
  expect(getPendingRequest(CHAT)).toMatchObject({ toolName: CU_ACTION_TOOL_NAME, eventType: "permission_request", humanOnly: true });

  // And it is legible: what will happen and where, not session/frame UUIDs.
  const input = (prompt as unknown as { input: Record<string, unknown> }).input;
  expect(input.summary).toMatch(/^Open https:\/\/example\.com in the managed browser on \S+$/);
  expect(input.action).toEqual({ type: "navigate", url: "https://example.com" });
  expect(JSON.stringify(input)).not.toContain(frameId);
  expect(JSON.stringify(input)).not.toContain(opened.id);

  // Only the human's answer, arriving by the route the UI posts to, releases it.
  expect(respondToPermission(CHAT, true, undefined, undefined, getPendingRequest(CHAT)?.requestId)).toEqual({ ok: true, toolName: CU_ACTION_TOOL_NAME });
  await expect(call).resolves.toEqual({ done: true });
  expect(execute).toHaveBeenCalledOnce();
});

it('a chat with computerControl "ask" reports the human\'s refusal as a refusal, and runs nothing', async () => {
  const { host, service, act } = fixture("ask");
  const { opened, frameId } = await readyFrame(host, service);
  const execute = vi.fn(async () => ({ done: true }));

  const call = host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "click", x: 10, y: 20 }, execute);
  await vi.waitFor(() => expect(hasPendingRequest(CHAT)).toBe(true));
  expect(respondToPermission(CHAT, false, undefined, undefined, getPendingRequest(CHAT)?.requestId)).toMatchObject({ ok: true });

  await expect(call).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("Do not repeat it") });
  expect(execute).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
  // The refusal left nothing parked that a later "yes" could redeem.
  expect(hasPendingRequest(CHAT)).toBe(false);
});

it('a GUI action requested under "ask" with no live chat session to ask in is refused, never assumed', async () => {
  const { host, service, act } = fixture("ask");
  const { opened, frameId } = await readyFrame(host, service);
  sessionRegistry.unregister(CHAT); // e.g. the run ended while a resident tool closure lingered
  const execute = vi.fn(async () => ({ done: true }));

  await expect(host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "key", key: "Enter" }, execute)).rejects.toMatchObject({
    code: "approval_unavailable",
  });
  expect(execute).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
});

/**
 * The other half of the contract, and the reason the tests above have to be
 * this explicit: `allow` really does mean allow. The control now says what it
 * does, so a change that made `allow` prompt would be as much a defect as one
 * that made `ask` silent.
 */
it('a chat with computerControl "allow" performs the action with no prompt at all', async () => {
  const { host, service, events } = fixture("allow");
  const { opened, frameId } = await readyFrame(host, service);
  const execute = vi.fn(async () => ({ done: true }));

  await expect(host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "click", x: 10, y: 20 }, execute)).resolves.toEqual({ done: true });

  expect(execute).toHaveBeenCalledOnce();
  // Nobody was asked, and nothing is left parked waiting for an answer.
  expect(events.filter((event) => event.type === "permission_request")).toEqual([]);
  expect(hasPendingRequest(CHAT)).toBe(false);
  // The operator's log gets a redacted description of it instead — the
  // unattended action's only record. See `logUnattendedAction`.
  expect(execute).toHaveBeenCalledWith(expect.any(String), { type: "click", x: 10, y: 20 }, { confirmedByHuman: false });
});

it('a chat with computerControl "deny" refuses the action outright, prompting nobody', async () => {
  // A denied chat cannot normally hold a grant at all — the scope check refuses
  // `open`, and in production a level change revokes a live session through the
  // signature. This asserts the floor underneath both: with the session still
  // in hand, the action is refused rather than turned into a question someone
  // might answer yes to.
  const { host, service, events, setLevel } = fixture("allow");
  const { opened, frameId } = await readyFrame(host, service);
  const execute = vi.fn(async () => ({ done: true }));
  setLevel("deny");

  await expect(host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "click", x: 1, y: 2 }, execute)).rejects.toMatchObject({
    code: "denied",
  });
  expect(execute).not.toHaveBeenCalled();
  expect(events.filter((event) => event.type === "permission_request")).toEqual([]);
  expect(hasPendingRequest(CHAT)).toBe(false);
});

/**
 * The boundary that keeps `allow` sane, and the one thing the level never
 * governs. `cu_open` resolves to
 * `host.status`, which lists what a human already started and grants nothing.
 * `cu_request_control` requires separate human consent. `open`/`approve` are reachable only through `routes/computer-use.ts`, which
 * is `requireSessionAuth` + same-origin.
 */
it.each(["allow", "ask", "deny"] as const)('an agent cannot enable a target under computerControl "%s"', async (level) => {
  const { host, service } = fixture(level);

  // The service refuses the agent principal directly, whatever role it claims.
  await expect(service.open(controlPrincipal(CHAT, "agent"), "managed-browser")).rejects.toMatchObject({ code: "denied" });
  await expect(service.open(controlPrincipal(CHAT, "human"), "managed-browser")).rejects.toMatchObject({ code: "denied" });

  // And the agent's own tool surface reports sessions rather than creating one.
  const before = (await host.status(CHAT)).sessions.length;
  expect(before).toBe(0);
});
