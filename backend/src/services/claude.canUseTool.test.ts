/**
 * Unit tests for the buildCanUseTool() wiring — the glue between the neutral
 * ToolPermissionPolicy (Phase 3) and the SDK's canUseTool shape.
 *
 * Exercises three concerns:
 *   1. Auto-allow / auto-deny return the right PermissionResult synchronously.
 *   2. Fall-through to user prompt emits the correct StreamEvent (permission_request,
 *      user_question for AskUserQuestion, plan_review for ExitPlanMode) and parks
 *      a pending request keyed on the tracking id.
 *   3. Abort + hook-ask-override paths behave as specified.
 */
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamEvent, DefaultPermissions } from "shared/types/index.js";
import { ToolPermissionPolicy } from "../agents/permissions/ToolPermissionPolicy.js";
import { buildCanUseTool, respondToPermission, hasPendingRequest, getPendingRequest, stopSession } from "./claude.js";
import { sessionRegistry } from "./session-registry.js";

const FULL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };
const FULL_DENY: DefaultPermissions = { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny" };
const FULL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" };

type CanUseTool = ReturnType<typeof buildCanUseTool>;

function makePolicy(perms: DefaultPermissions | null, categorize: (tool: string) => keyof DefaultPermissions | null = () => "fileRead") {
  return new ToolPermissionPolicy(categorize, () => perms);
}

function make(canUseTool: {
  emitter?: EventEmitter;
  policy: ToolPermissionPolicy;
  trackingId?: string;
  hookAskOverride?: { reason: string };
}): { emitter: EventEmitter; trackingId: string; canUseTool: CanUseTool } {
  const emitter = canUseTool.emitter ?? new EventEmitter();
  const trackingId = canUseTool.trackingId ?? `test-${Math.random().toString(36).slice(2)}`;
  const fn = buildCanUseTool(emitter, canUseTool.policy, () => trackingId, canUseTool.hookAskOverride);
  return { emitter, trackingId, canUseTool: fn };
}

// Fresh abort signal per call — the default AbortController is ok.
function unsignaled(): { signal: AbortSignal; suggestions?: unknown[] } {
  return { signal: new AbortController().signal };
}

afterEach(() => {
  // Nothing to reset at module scope; individual tests clean pending state they create.
});

describe("buildCanUseTool — auto-decide paths", () => {
  it("auto-allows when policy resolves to allow", async () => {
    const { canUseTool } = make({ policy: makePolicy(FULL_ALLOW) });
    const result = await canUseTool("Read", { path: "/tmp/x" }, unsignaled());
    expect(result).toEqual({ behavior: "allow", updatedInput: { path: "/tmp/x" } });
  });

  it("auto-denies with interrupt when policy resolves to deny", async () => {
    const { canUseTool } = make({ policy: makePolicy(FULL_DENY) });
    const result = await canUseTool("Read", {}, unsignaled());
    expect(result).toMatchObject({ behavior: "deny", interrupt: true });
    expect((result as { message: string }).message).toContain("fileRead");
  });

  it("null category from categorizer falls through to 'ask' (user prompt path)", async () => {
    const policy = makePolicy(FULL_ALLOW, () => null);
    const { canUseTool, emitter, trackingId } = make({ policy });

    const seen: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => seen.push(e));

    // Kick off the call, it should emit a permission_request and park.
    const promise = canUseTool("TodoWrite", { todos: [] }, unsignaled());
    // Resolve via respondToPermission to drain the pending state.
    expect(hasPendingRequest(trackingId)).toBe(true);
    expect(seen.some((e) => e.type === "permission_request")).toBe(true);
    expect(respondToPermission(trackingId, true).ok).toBe(true);
    await expect(promise).resolves.toMatchObject({ behavior: "allow" });
  });
});

describe("buildCanUseTool — user-prompt path", () => {
  it("emits permission_request, parks pending, resolves via respondToPermission(allow)", async () => {
    const { canUseTool, emitter, trackingId } = make({ policy: makePolicy(FULL_ASK) });
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));

    const promise = canUseTool("Write", { path: "/tmp/x", content: "hi" }, unsignaled());

    // One permission_request event, one pending request
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "permission_request", toolName: "Write", input: { path: "/tmp/x", content: "hi" } });
    expect(hasPendingRequest(trackingId)).toBe(true);

    const responded = respondToPermission(trackingId, true, { path: "/tmp/x", content: "hi" });
    expect(responded).toEqual({ ok: true, toolName: "Write" });
    await expect(promise).resolves.toEqual({ behavior: "allow", updatedInput: { path: "/tmp/x", content: "hi" }, updatedPermissions: undefined });
    expect(hasPendingRequest(trackingId)).toBe(false);
  });

  it("respondToPermission(deny) resolves with deny+interrupt", async () => {
    const { canUseTool, trackingId } = make({ policy: makePolicy(FULL_ASK) });
    const promise = canUseTool("Write", {}, unsignaled());
    expect(respondToPermission(trackingId, false).ok).toBe(true);
    await expect(promise).resolves.toMatchObject({ behavior: "deny", interrupt: true, message: "User denied" });
  });

  it("AskUserQuestion tool emits user_question event with the questions payload", async () => {
    const { canUseTool, emitter, trackingId } = make({ policy: makePolicy(FULL_ASK, () => null) });
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));

    const qs = [{ question: "pick one", options: ["a", "b"] }];
    const promise = canUseTool("AskUserQuestion", { questions: qs }, unsignaled());
    expect(events[0]).toMatchObject({ type: "user_question", questions: qs });
    const parked = getPendingRequest(trackingId);
    expect(parked?.eventType).toBe("user_question");

    respondToPermission(trackingId, true);
    await promise;
  });

  it("ExitPlanMode emits plan_review event with stringified input", async () => {
    const { canUseTool, emitter, trackingId } = make({ policy: makePolicy(FULL_ASK, () => null) });
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));

    const input = { plan: "step one\nstep two" };
    const promise = canUseTool("ExitPlanMode", input, unsignaled());
    expect(events[0]).toMatchObject({ type: "plan_review", content: JSON.stringify(input) });
    const parked = getPendingRequest(trackingId);
    expect(parked?.eventType).toBe("plan_review");

    respondToPermission(trackingId, true);
    await promise;
  });
});

describe("buildCanUseTool — hook override + abort", () => {
  it("hook-ask override bypasses auto-allow and routes to the prompt path", async () => {
    const hookAskOverride = { reason: "" };
    const { canUseTool, emitter, trackingId } = make({ policy: makePolicy(FULL_ALLOW), hookAskOverride });
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));

    // Arrange: hook flagged ask on this call
    hookAskOverride.reason = "policy demands explicit approval";

    const promise = canUseTool("Read", {}, unsignaled());

    // Would have auto-allowed under FULL_ALLOW, but hook override forced a prompt
    expect(events[0]?.type).toBe("permission_request");
    expect(hasPendingRequest(trackingId)).toBe(true);
    // Override flag is reset for the next call
    expect(hookAskOverride.reason).toBe("");

    respondToPermission(trackingId, true);
    await promise;
  });

  it("abort signal drops the pending request and resolves with deny", async () => {
    const { canUseTool, trackingId } = make({ policy: makePolicy(FULL_ASK) });
    const controller = new AbortController();
    const promise = canUseTool("Write", {}, { signal: controller.signal });
    expect(hasPendingRequest(trackingId)).toBe(true);

    controller.abort();

    await expect(promise).resolves.toMatchObject({ behavior: "deny", message: "Aborted" });
    expect(hasPendingRequest(trackingId)).toBe(false);
  });
});

describe("buildCanUseTool — OpenRouter SDK arity (2-arg call)", () => {
  // The Claude Code SDK calls canUseTool with 3 args (name, input, { signal, suggestions }).
  // The OpenRouter SDK calls it with only 2 (name, input). Before the default-arg fix,
  // the destructure of the missing 3rd arg threw "Cannot destructure property 'signal'
  // of 'undefined'", which OR's wrapToolWithPermission rewrapped as
  // {error, denied: true} — making every tool call appear denied in OR-backed chats.
  it("auto-allow path survives a 2-arg call (no 3rd-arg destructure crash)", async () => {
    const { canUseTool } = make({ policy: makePolicy(FULL_ALLOW) });
    const result = await canUseTool("Read", { path: "/tmp/x" });
    expect(result).toEqual({ behavior: "allow", updatedInput: { path: "/tmp/x" } });
  });

  it("auto-deny path survives a 2-arg call", async () => {
    const { canUseTool } = make({ policy: makePolicy(FULL_DENY) });
    const result = await canUseTool("Read", {});
    expect(result).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("user-prompt path works without a signal — respondToPermission still resolves", async () => {
    const { canUseTool, emitter, trackingId } = make({ policy: makePolicy(FULL_ASK) });
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));

    const promise = canUseTool("Write", { path: "/tmp/x", content: "hi" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "permission_request", toolName: "Write" });
    expect(hasPendingRequest(trackingId)).toBe(true);

    respondToPermission(trackingId, true, { path: "/tmp/x", content: "hi" });
    await expect(promise).resolves.toMatchObject({ behavior: "allow" });
  });
});

describe("buildCanUseTool — registry integration", () => {
  beforeEach(() => {
    // Ensure no stale registry state leaks across tests.
  });

  it("stopSession clears pending requests for the same tracking id", async () => {
    const trackingId = `stop-${Math.random()}`;
    // Register a no-op session so stopSession finds something to abort.
    const ac = new AbortController();
    sessionRegistry.register(trackingId, { type: "web", abortController: ac, emitter: new EventEmitter() });

    const { canUseTool } = make({ policy: makePolicy(FULL_ASK), trackingId });
    const promise = canUseTool("Write", {}, { signal: ac.signal });
    expect(hasPendingRequest(trackingId)).toBe(true);

    expect(stopSession(trackingId)).toBe(true);
    expect(hasPendingRequest(trackingId)).toBe(false);
    await expect(promise).resolves.toMatchObject({ behavior: "deny" });
  });
});
