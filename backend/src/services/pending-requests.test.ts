/**
 * `requestHumanApproval` — the blocking prompt that is not a harness callback.
 *
 * Covers the ways it must NOT wedge a parked tool call, and the one way it can
 * answer "yes".
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { StreamEvent } from "shared/types/index.js";
import { getPendingRequest, hasPendingRequest, requestHumanApproval, respondToPermission, HUMAN_APPROVAL_TIMEOUT_MS } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "pending-request-chat";
const request = { toolName: "mcp__computer_use__cu_action", input: { summary: "Click at (1, 2)" } };

afterEach(() => {
  respondToPermission(CHAT, false);
  sessionRegistry.unregister(CHAT);
});

function liveChat() {
  const emitter = new EventEmitter();
  const events: StreamEvent[] = [];
  emitter.on("event", (event: StreamEvent) => events.push(event));
  sessionRegistry.register(CHAT, { type: "web", abortController: new AbortController(), emitter });
  return events;
}

it("parks the call, emits the chat's ordinary permission_request, and resolves only on the human's answer", async () => {
  const events = liveChat();
  const pending = requestHumanApproval(CHAT, request);
  expect(events).toEqual([{ type: "permission_request", content: "", toolName: request.toolName, input: request.input }]);
  expect(hasPendingRequest(CHAT)).toBe(true);
  // `/pending` replays it verbatim after a page refresh.
  expect(getPendingRequest(CHAT)).toEqual({ toolName: request.toolName, input: request.input, eventType: "permission_request", eventData: request });
  respondToPermission(CHAT, true);
  await expect(pending).resolves.toEqual({ approved: true, reason: "human" });
  expect(hasPendingRequest(CHAT)).toBe(false);
});

it("a denial is a denial", async () => {
  liveChat();
  const pending = requestHumanApproval(CHAT, request);
  respondToPermission(CHAT, false);
  await expect(pending).resolves.toEqual({ approved: false, reason: "denied" });
});

it("expiry cannot wedge the call: the timer denies and clears the prompt", async () => {
  liveChat();
  await expect(requestHumanApproval(CHAT, { ...request, timeoutMs: 5 })).resolves.toEqual({ approved: false, reason: "timeout" });
  expect(hasPendingRequest(CHAT)).toBe(false);
});

it("an abort — the turn stopping, or the harness giving up on the tool call — denies", async () => {
  liveChat();
  const controller = new AbortController();
  const pending = requestHumanApproval(CHAT, { ...request, signal: controller.signal });
  controller.abort();
  await expect(pending).resolves.toEqual({ approved: false, reason: "aborted" });
  expect(hasPendingRequest(CHAT)).toBe(false);
  // Already-aborted is the same answer, without ever raising a prompt.
  await expect(requestHumanApproval(CHAT, { ...request, signal: controller.signal })).resolves.toEqual({ approved: false, reason: "aborted" });
  expect(hasPendingRequest(CHAT)).toBe(false);
});

it("fails closed with no live session, and never clobbers a prompt the human is already reading", async () => {
  await expect(requestHumanApproval(CHAT, request)).resolves.toEqual({ approved: false, reason: "no_session" });
  liveChat();
  const first = requestHumanApproval(CHAT, request);
  await expect(requestHumanApproval(CHAT, request)).resolves.toEqual({ approved: false, reason: "prompt_busy" });
  // The first question survived the second's arrival and is still answerable.
  expect(respondToPermission(CHAT, true)).toEqual({ ok: true, toolName: request.toolName });
  await expect(first).resolves.toEqual({ approved: true, reason: "human" });
});

it("a settled prompt never removes the entry that replaced it", async () => {
  liveChat();
  const timedOut = requestHumanApproval(CHAT, { ...request, timeoutMs: 5 });
  await expect(timedOut).resolves.toMatchObject({ reason: "timeout" });
  const replacement = requestHumanApproval(CHAT, { ...request, toolName: "Bash", input: { command: "ls" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(getPendingRequest(CHAT)).toMatchObject({ toolName: "Bash" });
  respondToPermission(CHAT, true);
  await expect(replacement).resolves.toMatchObject({ approved: true });
});

it("defaults to a bound below the longest tool block this codebase already ships", () => {
  // `wait` (callboard-tools.ts) parks an in-process MCP call for up to 300s on
  // every engine. Going past that risks the harness abandoning the call while
  // the human is still deciding.
  expect(HUMAN_APPROVAL_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  expect(HUMAN_APPROVAL_TIMEOUT_MS).toBeGreaterThan(120_000);
});

it("does not hold the process open while it waits", () => {
  liveChat();
  const unref = vi.spyOn(globalThis, "setTimeout");
  void requestHumanApproval(CHAT, request);
  expect(unref.mock.results.at(-1)!.value.hasRef()).toBe(false);
  unref.mockRestore();
});
