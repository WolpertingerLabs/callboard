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
import { categorizeClaudeTool } from "../agents/adapters/claude-code/permissionAdapter.js";
import { buildCanUseTool, respondToPermission, hasPendingRequest, getPendingRequest, stopSession } from "./claude.js";
import { requestHumanApproval } from "./pending-requests.js";
import { CU_ACTION_TOOL_NAME } from "shared/types/index.js";
import { sessionRegistry } from "./session-registry.js";

const FULL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" };
const FULL_DENY: DefaultPermissions = { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny", computerControl: "deny" };
const FULL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" };

type CanUseTool = ReturnType<typeof buildCanUseTool>;

function makePolicy(perms: DefaultPermissions | null, categorize: (tool: string) => keyof DefaultPermissions | null = () => "fileRead") {
  return new ToolPermissionPolicy(categorize, () => perms);
}

function make(canUseTool: { emitter?: EventEmitter; policy: ToolPermissionPolicy; trackingId?: string; hookAskOverride?: { reason: string } }): {
  emitter: EventEmitter;
  trackingId: string;
  canUseTool: CanUseTool;
} {
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

describe("buildCanUseTool — computerControl reaches the gate", () => {
  // `mcp__computer_use__*` is deliberately NOT in the SDK allow-list (see
  // claude.ts), so these calls do arrive here. Use the real Claude categorizer
  // so the tool name → axis mapping is the production one.
  const withComputerControl = (perms: DefaultPermissions | null) => makePolicy(perms, categorizeClaudeTool);
  const tool = "mcp__computer_use__cu_observe";

  it("denies a managed computer tool when the axis is deny, without interrupting the turn", async () => {
    const { canUseTool } = make({ policy: withComputerControl({ ...FULL_ALLOW, computerControl: "deny" }) });
    const result = await canUseTool(tool, { sessionId: "s", generation: 1 }, unsignaled());
    expect(result).toMatchObject({ behavior: "deny", interrupt: false });
    expect((result as { message: string }).message).toContain("computerControl");
  });

  it("denies when the axis is absent (legacy four-axis record) or there are no permissions at all", async () => {
    const legacy = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as unknown as DefaultPermissions;
    for (const perms of [legacy, null]) {
      const { canUseTool } = make({ policy: withComputerControl(perms) });
      expect(await canUseTool(tool, {}, unsignaled())).toMatchObject({ behavior: "deny", interrupt: false });
    }
  });

  it("admits the transport call under ask and allow so the service can decide scope; never prompts here", async () => {
    for (const level of ["ask", "allow"] as const) {
      const { canUseTool, emitter } = make({ policy: withComputerControl({ ...FULL_ALLOW, computerControl: level }) });
      const seen: StreamEvent[] = [];
      emitter.on("event", (e: StreamEvent) => seen.push(e));
      expect(await canUseTool(tool, { sessionId: "s" }, unsignaled())).toEqual({ behavior: "allow", updatedInput: { sessionId: "s" } });
      expect(seen).toEqual([]);
    }
  });

  it("a denied write still interrupts the turn (unchanged for the other axes)", async () => {
    const { canUseTool } = make({ policy: withComputerControl({ ...FULL_ALLOW, fileWrite: "deny" }) });
    expect(await canUseTool("Write", {}, unsignaled())).toMatchObject({ behavior: "deny", interrupt: true });
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

  it("AskUserQuestion merges answers into the original input, preserving questions", async () => {
    const { canUseTool, trackingId } = make({ policy: makePolicy(FULL_ASK, () => null) });

    const qs = [{ question: "pick one", options: ["a", "b"] }];
    const promise = canUseTool("AskUserQuestion", { questions: qs }, unsignaled());

    respondToPermission(trackingId, true, { answers: { "pick one": "a" } });
    await expect(promise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { questions: qs, answers: { "pick one": "a" } },
      updatedPermissions: undefined,
    });
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

/**
 * A chat has one prompt slot, and the computer-control confirmation is now one
 * of the things that can occupy it. Whoever arrives second must be told to come
 * back, never silently swap the panel out from under the user.
 */
describe("buildCanUseTool — the prompt slot holds one question", () => {
  it("defers a second tool rather than replacing the question the user is reading", async () => {
    const { canUseTool, emitter, trackingId } = make({ policy: makePolicy(FULL_ASK) });
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));

    const first = canUseTool("Write", { path: "/tmp/first" }, unsignaled());
    const second = await canUseTool("Bash", { command: "ls" }, unsignaled());

    expect(second).toMatchObject({ behavior: "deny", interrupt: false, message: expect.stringContaining("already being asked") });
    // The user saw one question, and it is still the first one.
    expect(events).toHaveLength(1);
    expect(getPendingRequest(trackingId)).toMatchObject({ toolName: "Write" });

    respondToPermission(trackingId, true);
    await expect(first).resolves.toMatchObject({ behavior: "allow" });
    // Slot free again: the deferred tool can now be re-requested and parks.
    void canUseTool("Bash", { command: "ls" }, unsignaled());
    expect(getPendingRequest(trackingId)).toMatchObject({ toolName: "Bash" });
    respondToPermission(trackingId, false);
  });

  it("the same rule protects a parked computer-control confirmation", async () => {
    const trackingId = `cu-slot-${Math.random().toString(36).slice(2)}`;
    const emitter = new EventEmitter();
    sessionRegistry.register(trackingId, { type: "web", abortController: new AbortController(), emitter });
    try {
      const approval = requestHumanApproval(trackingId, {
        toolName: CU_ACTION_TOOL_NAME,
        input: { summary: "Click at (1, 2)" },
        timeoutMs: 60_000,
      });
      const { canUseTool } = make({ policy: makePolicy(FULL_ASK), trackingId, emitter });

      expect(await canUseTool("Bash", { command: "ls" }, unsignaled())).toMatchObject({ behavior: "deny", interrupt: false });
      // Still the GUI confirmation, still answerable, still human-only.
      expect(getPendingRequest(trackingId)).toMatchObject({ toolName: CU_ACTION_TOOL_NAME, humanOnly: true });

      respondToPermission(trackingId, false);
      await expect(approval).resolves.toEqual({ approved: false, reason: "denied" });
    } finally {
      sessionRegistry.unregister(trackingId);
    }
  });
});
