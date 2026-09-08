/**
 * The invariant: **every GUI action requires an explicit human confirmation,
 * regardless of the chat's permission level.**
 *
 * This is the second of two independent gates, and the danger is that they look
 * like one. The first gate — may the agent call `cu_action` at all — is the
 * ordinary permission path, and for a chat with `computerControl: "allow"` it
 * says yes; production logs read `tool=mcp__computer_use__cu_action,
 * category=computerControl, decision=allow`. The second gate exists *because*
 * the first one passed: a pixel action can transmit data, change files or
 * execute code, so a human confirms each one. Routing the second through the
 * first would delete it silently, and nothing else in the system would notice.
 *
 * So this file exercises the real thing, top to bottom, with the policy pinned
 * to the most permissive setting a chat can have: the real `ComputerUseHost`
 * with its DEFAULT confirmation wiring (no test double injected — that is the
 * point), the real `requestHumanApproval`, the real pending-prompt registry,
 * and the real `respondToPermission` the HTTP route calls. The only fakes are
 * the driver's pixels.
 *
 * If someone re-routes the approval through `ToolPermissionPolicy`, threads the
 * `computerControl` level into the confirmation, or gives
 * `requestHumanApproval` an auto-decide branch, the first assertion here fails:
 * the call returns instead of blocking, and the driver acts with nobody asked.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { CU_ACTION_TOOL_NAME, type StreamEvent } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { getPendingRequest, hasPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "chat-under-allow";

const hosts: ComputerUseHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  sessionRegistry.unregister(CHAT);
  respondToPermission(CHAT, false);
});

/** A chat whose every permission axis is "allow" — the maximum a user can grant. */
function fixture() {
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
  // Third argument only: the policy reader. The fourth — the confirmation — is
  // deliberately left at its production default.
  const host: ComputerUseHost = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => ({
    policy: readComputerUsePolicy({ computerControl: "allow", webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" }),
    signature: "allow-everything",
  }));
  hosts.push(host);

  // A live chat session, as `sendMessage` registers one: the prompt is emitted
  // on this emitter and answered through `POST /api/chats/:id/respond`.
  const emitter = new EventEmitter();
  const events: StreamEvent[] = [];
  emitter.on("event", (event: StreamEvent) => events.push(event));
  sessionRegistry.register(CHAT, { type: "web", abortController: new AbortController(), emitter });
  return { host, service, act, events };
}

async function readyFrame(host: ComputerUseHost, service: ComputerUseService) {
  const opened = await host.open(CHAT, "browser");
  const frame = await service.observe(controlPrincipal(CHAT, "agent"), { sessionId: opened.id, generation: opened.generation });
  return { opened, frameId: frame.frameId };
}

it('a chat with computerControl "allow" still cannot perform a GUI action without an explicit human confirmation', async () => {
  const { host, service, act, events } = fixture();
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
  expect(getPendingRequest(CHAT)).toMatchObject({ toolName: CU_ACTION_TOOL_NAME, eventType: "permission_request" });

  // And it is legible: what will happen and where, not session/frame UUIDs.
  const input = (prompt as unknown as { input: Record<string, unknown> }).input;
  expect(input.summary).toMatch(/^Open https:\/\/example\.com in the managed browser on \S+$/);
  expect(input.action).toEqual({ type: "navigate", url: "https://example.com" });
  expect(JSON.stringify(input)).not.toContain(frameId);
  expect(JSON.stringify(input)).not.toContain(opened.id);

  // Only the human's answer, arriving by the route the UI posts to, releases it.
  expect(respondToPermission(CHAT, true)).toEqual({ ok: true, toolName: CU_ACTION_TOOL_NAME });
  await expect(call).resolves.toEqual({ done: true });
  expect(execute).toHaveBeenCalledOnce();
});

it('a chat with computerControl "allow" reports the human\'s refusal as a refusal, and runs nothing', async () => {
  const { host, service, act } = fixture();
  const { opened, frameId } = await readyFrame(host, service);
  const execute = vi.fn(async () => ({ done: true }));

  const call = host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "click", x: 10, y: 20 }, execute);
  await vi.waitFor(() => expect(hasPendingRequest(CHAT)).toBe(true));
  expect(respondToPermission(CHAT, false)).toMatchObject({ ok: true });

  await expect(call).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("Do not repeat it") });
  expect(execute).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
  // The refusal left nothing parked that a later "yes" could redeem.
  expect(hasPendingRequest(CHAT)).toBe(false);
});

it("a GUI action requested with no live chat session to ask in is refused, never assumed", async () => {
  const { host, service, act } = fixture();
  const { opened, frameId } = await readyFrame(host, service);
  sessionRegistry.unregister(CHAT); // e.g. the run ended while a resident tool closure lingered
  const execute = vi.fn(async () => ({ done: true }));

  await expect(host.requestAgentAction(CHAT, opened.id, opened.generation, frameId, { type: "key", key: "Enter" }, execute)).rejects.toMatchObject({
    code: "approval_unavailable",
  });
  expect(execute).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
});
