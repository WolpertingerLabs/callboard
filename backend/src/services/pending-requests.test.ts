/**
 * `openHumanApproval` — the human-only prompt nothing is suspended on.
 *
 * Covers the one way it can answer "yes", that it never expires on its own,
 * how it sits beside the chat's blocking prompt slot rather than in it, and
 * that a stale or withdrawn identity can never consume another prompt.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { StreamEvent } from "shared/types/index.js";
import {
  clearOpenApprovalsForTest,
  getPendingRequest,
  hasPendingRequest,
  openHumanApproval,
  pendingRequestRequiresHuman,
  pendingRequests,
  recentResolution,
  respondToPermission,
} from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";

const CHAT = "pending-request-chat";
const request = { toolName: "mcp__computer_use__cu_action", input: { summary: "Click at (1, 2)" } };

afterEach(() => {
  vi.useRealTimers();
  clearOpenApprovalsForTest();
  pendingRequests.delete(CHAT);
  sessionRegistry.unregister(CHAT);
});

function liveChat() {
  const emitter = new EventEmitter();
  const events: StreamEvent[] = [];
  emitter.on("event", (event: StreamEvent) => events.push(event));
  sessionRegistry.register(CHAT, { type: "web", abortController: new AbortController(), emitter });
  return events;
}

/** A blocking prompt in the slot, as `buildCanUseTool` parks one. */
function blockingPrompt(eventType: "permission_request" | "user_question" | "plan_review" = "permission_request") {
  const resolve = vi.fn();
  pendingRequests.set(CHAT, { toolName: "Bash", input: { command: "ls" }, eventType, eventData: {}, resolve, requestId: "slot-id" });
  return resolve;
}

it("returns at once, emits the chat's ordinary permission_request marked nonBlocking, and calls back only on the human's answer", () => {
  const events = liveChat();
  const onAnswer = vi.fn();
  const approval = openHumanApproval(CHAT, request, onAnswer);
  expect(events).toEqual([
    {
      type: "permission_request",
      content: "",
      toolName: request.toolName,
      input: request.input,
      requestId: approval.requestId,
      humanOnly: true,
      nonBlocking: true,
    },
  ]);
  expect(hasPendingRequest(CHAT)).toBe(true);
  expect(approval.isOpen()).toBe(true);
  // `/pending` replays it after a page refresh, human-only.
  expect(getPendingRequest(CHAT)).toEqual({
    toolName: request.toolName,
    input: request.input,
    eventType: "permission_request",
    eventData: { ...request, requestId: approval.requestId, humanOnly: true, nonBlocking: true },
    requestId: approval.requestId,
    humanOnly: true,
  });
  expect(pendingRequestRequiresHuman(CHAT, approval.requestId)).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();

  expect(respondToPermission(CHAT, true, undefined, undefined, approval.requestId)).toEqual({ ok: true, toolName: request.toolName });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith(true);
  expect(hasPendingRequest(CHAT)).toBe(false);
  expect(approval.isOpen()).toBe(false);
});

it("a denial is a denial, and the answer callback runs once", () => {
  liveChat();
  const onAnswer = vi.fn();
  const approval = openHumanApproval(CHAT, request, onAnswer);
  expect(respondToPermission(CHAT, false, undefined, undefined, approval.requestId)).toMatchObject({ ok: true });
  expect(respondToPermission(CHAT, true, undefined, undefined, approval.requestId)).toEqual({ ok: false });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
});

it("hands an approval's completion to /respond, and never a denial's", async () => {
  liveChat();
  const completion = Promise.resolve({ ok: false, error: "startup failed" });
  const approved = openHumanApproval(CHAT, request, (yes) => (yes ? completion : undefined));
  expect(respondToPermission(CHAT, true, undefined, undefined, approved.requestId).completion).toBe(completion);
  const denied = openHumanApproval(CHAT, request, () => completion);
  expect(respondToPermission(CHAT, false, undefined, undefined, denied.requestId)).not.toHaveProperty("completion");
});

it("has no timer: it is still open long after the old 300s ceiling", async () => {
  vi.useFakeTimers();
  liveChat();
  const onAnswer = vi.fn();
  const approval = openHumanApproval(CHAT, request, onAnswer);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(approval.isOpen()).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();
  expect(respondToPermission(CHAT, true, undefined, undefined, approval.requestId)).toMatchObject({ ok: true });
});

it("needs no live session: it outlives the turn that raised it", () => {
  const onAnswer = vi.fn();
  const approval = openHumanApproval(CHAT, request, onAnswer);
  expect(getPendingRequest(CHAT)).toMatchObject({ requestId: approval.requestId });
  expect(respondToPermission(CHAT, true, undefined, undefined, approval.requestId)).toMatchObject({ ok: true });
  expect(onAnswer).toHaveBeenCalledWith(true);
});

it("cancel withdraws it: no answer is delivered and its identity answers nothing", () => {
  liveChat();
  const onAnswer = vi.fn();
  const approval = openHumanApproval(CHAT, request, onAnswer);
  expect(approval.cancel()).toBe(true);
  expect(approval.cancel()).toBe(false);
  expect(hasPendingRequest(CHAT)).toBe(false);
  expect(respondToPermission(CHAT, true, undefined, undefined, approval.requestId)).toEqual({ ok: false });
  expect(onAnswer).not.toHaveBeenCalled();
});

it("must be answered by its own identity, never by a bare answer", () => {
  liveChat();
  const onAnswer = vi.fn();
  openHumanApproval(CHAT, request, onAnswer);
  expect(respondToPermission(CHAT, true)).toEqual({ ok: false });
  expect(respondToPermission(CHAT, true, undefined, undefined, "some-other-id")).toEqual({ ok: false });
  expect(onAnswer).not.toHaveBeenCalled();
});

it("sits beside the blocking slot: it never refuses or displaces a prompt the harness is suspended on", () => {
  const events = liveChat();
  const onAnswer = vi.fn();
  const approval = openHumanApproval(CHAT, request, onAnswer);
  // The slot is still free for the harness — `buildCanUseTool` and every
  // other blocking producer check the map, which this did not touch.
  expect(pendingRequests.has(CHAT)).toBe(false);
  const resolve = blockingPrompt();
  // The blocking prompt is what the human is shown first.
  expect(getPendingRequest(CHAT)).toMatchObject({ toolName: "Bash", requestId: "slot-id" });
  expect(pendingRequestRequiresHuman(CHAT, "slot-id")).toBe(false);
  // Each answer reaches only the prompt it names.
  expect(respondToPermission(CHAT, false, undefined, undefined, approval.requestId)).toMatchObject({ ok: true });
  expect(onAnswer).toHaveBeenCalledWith(false);
  expect(resolve).not.toHaveBeenCalled();
  expect(respondToPermission(CHAT, true, undefined, undefined, "slot-id")).toMatchObject({ ok: true, toolName: "Bash" });
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
  expect(events.filter((event) => event.type === "permission_request")).toHaveLength(1);
});

it("is not pushed over a prompt the human is reading; it waits its turn on /pending", () => {
  const events = liveChat();
  blockingPrompt("user_question");
  const first = openHumanApproval(CHAT, request, vi.fn());
  expect(events).toEqual([]);
  pendingRequests.delete(CHAT);
  expect(getPendingRequest(CHAT)).toMatchObject({ requestId: first.requestId });
  // A second open approval queues behind the first, oldest first, silently.
  const second = openHumanApproval(CHAT, request, vi.fn());
  expect(events).toEqual([]);
  respondToPermission(CHAT, false, undefined, undefined, first.requestId);
  expect(getPendingRequest(CHAT)).toMatchObject({ requestId: second.requestId });
});

it("an API key cannot aim an answer past the slot at an open approval", () => {
  liveChat();
  openHumanApproval(CHAT, request, vi.fn());
  blockingPrompt();
  // An answer for the slot is the slot's business (an ordinary prompt here).
  expect(pendingRequestRequiresHuman(CHAT)).toBe(false);
  expect(pendingRequestRequiresHuman(CHAT, "slot-id")).toBe(false);
  // Anything else would fall through to the open approval, so it is human-only.
  expect(pendingRequestRequiresHuman(CHAT, "not-the-slot")).toBe(true);
  pendingRequests.delete(CHAT);
  expect(pendingRequestRequiresHuman(CHAT)).toBe(true);
});

it.each(["permission_request", "user_question", "plan_review"] as const)("stale control replies cannot consume an ordinary %s replacement", (eventType) => {
  for (const disposition of ["approved", "denied", "withdrawn"] as const) {
    liveChat();
    const control = openHumanApproval(CHAT, request, vi.fn());
    const oldId = control.requestId;
    if (disposition === "withdrawn") control.cancel();
    else respondToPermission(CHAT, disposition === "approved", undefined, undefined, oldId);
    const resolve = blockingPrompt(eventType);
    for (const allow of [true, false]) expect(respondToPermission(CHAT, allow, undefined, undefined, oldId)).toEqual({ ok: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(respondToPermission(CHAT, false)).toMatchObject({ ok: true });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
  }
});

it("remembers how a request ended for its own chat only", () => {
  liveChat();
  const withdrawn = openHumanApproval(CHAT, request, vi.fn());
  withdrawn.cancel("you pressed Stop");
  expect(recentResolution(CHAT, withdrawn.requestId)).toBe("it was withdrawn because you pressed Stop");
  // The same id quoted against another chat answers nothing.
  expect(recentResolution("some-other-chat", withdrawn.requestId)).toBeUndefined();
  const answered = openHumanApproval(CHAT, request, vi.fn());
  respondToPermission(CHAT, false, undefined, undefined, answered.requestId);
  expect(recentResolution(CHAT, answered.requestId)).toBe("it was already answered");
});

it("bumps the polled metadata version whenever an open approval opens or closes", () => {
  liveChat();
  const notify = vi.spyOn(sessionRegistry, "notifyMetadata");
  try {
    const approval = openHumanApproval(CHAT, request, vi.fn());
    expect(notify).toHaveBeenLastCalledWith(CHAT, { openApprovals: true });
    approval.cancel();
    expect(notify).toHaveBeenCalledTimes(2);
    respondToPermission(CHAT, true, undefined, undefined, openHumanApproval(CHAT, request, vi.fn()).requestId);
    expect(notify).toHaveBeenCalledTimes(4);
  } finally {
    notify.mockRestore();
  }
});
