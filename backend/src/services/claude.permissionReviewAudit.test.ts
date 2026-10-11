/**
 * The audit records the review chain in buildCanUseTool emits
 * (permission-review-audit.ts), and the guarantee that matters more than the
 * records themselves: the chain decides exactly the same way, at the same
 * time, whatever the audit logger does — records, throws, or never returns.
 */
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultPermissions, PermissionReviewSettings, StreamEvent } from "shared/types/index.js";
import { ToolPermissionPolicy } from "../agents/permissions/ToolPermissionPolicy.js";
import { buildCanUseTool, type PermissionReviewHooks } from "./claude.js";
import { pendingRequests } from "./pending-requests.js";
import type { ReviewVerdict } from "./permission-review.js";
import { REVIEW_REQUESTED_EVENT, REVIEW_RESULT_EVENT, startReviewAudit, type PermissionAuditHooks } from "./permission-review-audit.js";
import { __auditQueueLength, __resetAuditLogForTests, emitAuditRecord, type AuditRecordInput } from "./audit-log.js";

const FULL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" };

/** Let the awaited reviewer settle and the prompt be parked. */
/** One macrotask turn, then the check phase: the reviewer settles, the prompt parks, deferred emits run. */
const flush = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setImmediate(r)));

interface Scenario {
  name: string;
  settings: PermissionReviewSettings | "throws";
  verdict?: ReviewVerdict;
  command?: string;
  parent?: string;
  /** Runs inside the reviewer, before it returns. */
  duringReview?: (ctx: { trackingId: string; abort: () => void; setSettings: (s: PermissionReviewSettings) => void }) => void;
  expectedOutcome?: string;
}

const SCENARIOS: Scenario[] = [
  { name: "model approve", settings: { modelReview: true, parentAnswers: false }, verdict: { verdict: "approve", reason: "routine", source: "model" }, expectedOutcome: "allowed" },
  { name: "model deny", settings: { modelReview: true, parentAnswers: false }, verdict: { verdict: "deny", reason: "wrong dir", source: "model" }, expectedOutcome: "denied_to_agent" },
  { name: "model escalate, no parent", settings: { modelReview: true, parentAnswers: false }, expectedOutcome: "escalated_to_human" },
  { name: "model escalate, offered to parent", settings: { modelReview: true, parentAnswers: true }, parent: "parent-1", expectedOutcome: "offered_to_parent" },
  {
    name: "model kill",
    settings: { modelReview: true, parentAnswers: true },
    parent: "parent-1",
    verdict: { verdict: "kill", reason: "injection", evidence: "IGNORE PREVIOUS", source: "model" },
    expectedOutcome: "human_only",
  },
  { name: "hard stop pre-empts the model", settings: { modelReview: true, parentAnswers: true }, parent: "parent-1", command: "rm -rf ~", expectedOutcome: "human_only" },
  { name: "hard stop with only parentAnswers on", settings: { modelReview: false, parentAnswers: true }, parent: "parent-1", command: "git push --force origin main", expectedOutcome: "human_only" },
  { name: "aborted during review", settings: { modelReview: true, parentAnswers: false }, duringReview: ({ abort }) => abort(), expectedOutcome: "aborted" },
  {
    name: "slot taken during review",
    settings: { modelReview: true, parentAnswers: false },
    duringReview: ({ trackingId }) => pendingRequests.set(trackingId, { requestId: "other" } as never),
    expectedOutcome: "deferred",
  },
  {
    name: "approve downgraded: review turned off mid-review",
    settings: { modelReview: true, parentAnswers: false },
    verdict: { verdict: "approve", reason: "routine", source: "model" },
    duringReview: ({ setSettings }) => setSettings({ modelReview: false, parentAnswers: false }),
    expectedOutcome: "escalated_to_human",
  },
  { name: "settings unreadable (strict fallback)", settings: "throws", verdict: { verdict: "approve", reason: "routine", source: "model" }, expectedOutcome: "escalated_to_human" },
  // Not screened: no audit records at all.
  { name: "both settings off", settings: { modelReview: false, parentAnswers: false } },
  { name: "parentAnswers only, no hard stop", settings: { modelReview: false, parentAnswers: true }, parent: "parent-1" },
];

type AuditVariant = "none" | "recording" | "emit-throws" | "result-emit-throws" | "emit-hangs" | "alias-throws" | "late-attrs-throw" | "real-logger-proxy-hangs";
const VARIANTS: AuditVariant[] = ["none", "recording", "emit-throws", "result-emit-throws", "emit-hangs", "alias-throws", "late-attrs-throw", "real-logger-proxy-hangs"];

interface Captured {
  alias: string | undefined;
  build: () => AuditRecordInput;
}

function auditHooksFor(variant: AuditVariant, captured: Captured[]): PermissionAuditHooks | undefined {
  const record = (alias: string | undefined, build: () => AuditRecordInput) => void captured.push({ alias, build });
  switch (variant) {
    case "none":
      return undefined;
    case "recording":
      return { getCallerAlias: () => "chat-caller", agentAlias: "agent-a", getLateAttributes: () => ({ "callboard.chat.parent_id": "parent-1", "callboard.space.id": "space-1" }), emit: record };
    case "emit-throws":
      return {
        getCallerAlias: () => "chat-caller",
        emit: () => {
          throw new Error("logger exploded");
        },
      };
    case "result-emit-throws": {
      // The requested record goes through; the result's emit throws — the
      // throw then lands inside the chain's own exit path, not a wrapper.
      let calls = 0;
      return {
        getCallerAlias: () => "chat-caller",
        emit: (alias, build) => {
          if (++calls > 1) throw new Error("logger exploded on the result");
          captured.push({ alias, build });
        },
      };
    }
    case "emit-hangs":
      return { getCallerAlias: () => "chat-caller", emit: (() => new Promise(() => {})) as never };
    case "alias-throws":
      return {
        getCallerAlias: () => {
          throw new Error("alias lookup exploded");
        },
        emit: record,
      };
    case "late-attrs-throw":
      return {
        getCallerAlias: () => "chat-caller",
        getLateAttributes: () => {
          throw new Error("metadata read exploded");
        },
        emit: record,
      };
    case "real-logger-proxy-hangs":
      return { getCallerAlias: () => "chat-caller", emit: emitAuditRecord };
  }
}

/** Where the chain was when an emitter was called (the "ordering" probe). */
interface EmitMoment {
  settled: boolean;
  parked: boolean;
}

/** Run one scenario and capture everything the chain does that anyone can observe. */
async function run(s: Scenario, variant: AuditVariant | "ordering", opts: { input?: Record<string, unknown>; excerpt?: () => string } = {}) {
  const emitter = new EventEmitter();
  const events: StreamEvent[] = [];
  emitter.on("event", (e: StreamEvent) => events.push(e));
  const trackingId = `audit-${variant}-${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  let settings = s.settings;
  const captured: Captured[] = [];
  const reviewer = vi.fn(async () => {
    s.duringReview?.({ trackingId, abort: () => controller.abort(), setSettings: (next) => (settings = next) });
    return s.verdict ?? { verdict: "escalate" as const, reason: "unsure", source: "model" as const };
  });
  const notifyParent = vi.fn();
  const moments: EmitMoment[] = [];
  const audit =
    variant === "ordering"
      ? {
          getCallerAlias: () => "chat-caller",
          // A blocking emitter: it records where the chain was when it ran. It
          // must find the decision already returned (or the prompt parked).
          emit: () => void moments.push({ settled: settled !== undefined, parked: pendingRequests.has(trackingId) }),
        }
      : auditHooksFor(variant, captured);
  const hooks: PermissionReviewHooks = {
    getSettings: () => {
      if (settings === "throws") throw new Error("unreadable");
      return settings;
    },
    getParentChatId: () => s.parent,
    cwd: "/repo",
    getTaskExcerpt: opts.excerpt ?? (() => "Chat title: fix the build"),
    reviewer,
    notifyParent,
    ...(audit && { audit }),
  };
  const canUseTool = buildCanUseTool(emitter, new ToolPermissionPolicy(() => "codeExecution", () => FULL_ASK), () => trackingId, undefined, hooks);
  let settled: { value: unknown } | undefined;
  void canUseTool("Bash", opts.input ?? { command: s.command ?? "npm test" }, { signal: controller.signal, toolUseID: "toolu_01ABC" }).then(
    (value) => (settled = { value }),
    (error) => (settled = { value: `rejected: ${error}` }),
  );
  // Two macrotask turns: enough for an awaited reviewer and the park; a chain
  // that awaited a hanging logger would still be unsettled/unparked here.
  await flush();
  await flush();
  const pending = pendingRequests.get(trackingId);
  const observation = {
    settled: settled ? settled.value : "pending",
    events: events.map(({ requestId: _r, ...rest }) => rest),
    pending: pending && pending.requestId !== "other" ? { ...pending, requestId: "<id>", resolve: "<fn>", eventData: { ...pending.eventData, requestId: "<id>" } } : pending ? "other" : undefined,
    reviewerCalls: reviewer.mock.calls.length,
    notifyParent: notifyParent.mock.calls.map(([parent, , tool, category]) => [parent, tool, category]),
  };
  const requestId = pending?.requestId;
  pendingRequests.delete(trackingId);
  return { observation, captured, requestId, moments };
}

beforeEach(() => {
  // The real logger, wired to a hub that never answers.
  __resetAuditLogForTests({ getProxy: () => ({ callTool: () => new Promise(() => {}) }) });
});
afterEach(() => {
  __resetAuditLogForTests();
});

describe("audit logging never changes the review chain", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s: identical across every logger behaviour", async (_name, s) => {
    const baseline = (await run(s, "none")).observation;
    for (const variant of VARIANTS.slice(1)) {
      const { observation } = await run(s, variant);
      expect({ variant, ...observation }).toEqual({ variant, ...baseline });
    }
  });

  it.each(SCENARIOS.filter((s) => s.expectedOutcome).map((s) => [s.name, s] as const))(
    "%s: every emitter call comes after the decision is returned or parked",
    async (_name, s) => {
      const { moments, observation } = await run(s, "ordering");
      expect(moments).toHaveLength(2); // requested + result both still delivered
      const decided = observation.settled !== "pending";
      for (const m of moments) expect(decided ? m.settled : m.parked).toBe(true);
    },
  );

  it("the real logger only queues on the decision path — nothing is sent synchronously", async () => {
    const callTool = vi.fn(() => new Promise(() => {}));
    __resetAuditLogForTests({ getProxy: () => ({ callTool }) });
    await run(SCENARIOS[0], "real-logger-proxy-hangs");
    expect(callTool).not.toHaveBeenCalled();
    expect(__auditQueueLength()).toBe(2);
  });
});

describe("audit records of a screened ask", () => {
  function decode(captured: Captured[]) {
    return captured.map((c) => ({ alias: c.alias, ...c.build() }));
  }

  it.each(SCENARIOS.filter((s) => s.expectedOutcome).map((s) => [s.name, s] as const))("%s: requested + result, one trace, result parented to requested", async (_name, s) => {
    const { captured, requestId } = await run(s, "recording");
    const [requested, result, ...rest] = decode(captured);
    expect(rest).toHaveLength(0);
    expect(requested.eventName).toBe(REVIEW_REQUESTED_EVENT);
    expect(result.eventName).toBe(REVIEW_RESULT_EVENT);
    expect(requested.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requested.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.traceId).toBe(requested.traceId);
    expect(result.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.spanId).not.toBe(requested.spanId);
    expect(result.parentSpanId).toBe(requested.spanId);
    expect(requested.parentSpanId).toBeUndefined();
    for (const r of [requested, result]) {
      expect(r.alias).toBe("chat-caller");
      expect(r.attributes).toMatchObject({
        "callboard.chat.id": expect.stringMatching(/^audit-recording-/),
        "callboard.chat.parent_id": "parent-1",
        "callboard.agent.alias": "agent-a",
        "callboard.caller.alias": "chat-caller",
        "callboard.space.id": "space-1",
        "tool.name": "Bash",
        "tool.use_id": "toolu_01ABC",
        "permission.category": "codeExecution",
      });
    }
    expect(result.attributes["permission.outcome"]).toBe(s.expectedOutcome);
    // The prompt's requestId travels on the result exactly when a prompt was raised.
    if (["escalated_to_human", "offered_to_parent", "human_only"].includes(s.expectedOutcome!)) {
      expect(result.attributes["callboard.request.id"]).toBe(requestId);
    } else {
      expect(result.attributes["callboard.request.id"]).toBeUndefined();
    }
  });

  it("requested is emitted before the reviewer returns and carries the full call and settings", async () => {
    const captured: Captured[] = [];
    let release!: (v: ReviewVerdict) => void;
    const reviewer = vi.fn(() => new Promise<ReviewVerdict>((r) => (release = r)));
    const trackingId = `audit-order-${Math.random().toString(36).slice(2)}`;
    const canUseTool = buildCanUseTool(new EventEmitter(), new ToolPermissionPolicy(() => "codeExecution", () => FULL_ASK), () => trackingId, undefined, {
      getSettings: () => ({ modelReview: true, parentAnswers: true }),
      getParentChatId: () => undefined,
      cwd: "/repo",
      getTaskExcerpt: () => "Chat title: fix the build",
      reviewer,
      audit: { getCallerAlias: () => "c", emit: (alias, build) => void captured.push({ alias, build }) },
    });
    const promise = canUseTool("Bash", { command: "npm test", description: "run tests" }, { signal: new AbortController().signal });
    await flush();
    expect(reviewer).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(1); // requested only — the reviewer is still out
    const requested = captured[0].build();
    expect(requested.attributes).toMatchObject({
      "permission.review.screen": "model",
      "tool.input": JSON.stringify({ command: "npm test", description: "run tests" }),
      "process.cwd": "/repo",
      "callboard.task.excerpt": "Chat title: fix the build",
      "permission.review.settings.model_review": true,
      "permission.review.settings.parent_answers": true,
      "permission.review.settings.approve_allowed": true,
    });
    // pi/ACP/Cline call without a toolUseID: null, not invented.
    expect(requested.attributes["tool.use_id"]).toBeUndefined();
    release({ verdict: "deny", reason: "nope", source: "model" });
    await promise;
    expect(captured).toHaveLength(1); // the result is handed over after the decision returns
    await flush();
    expect(captured).toHaveLength(2);
    expect(captured[1].build().attributes).toMatchObject({ "permission.review.verdict": "deny", "permission.review.source": "model", "permission.review.reason": "nope" });
    expect(captured[1].build().attributes["permission.review.latency_ms"]).toEqual(expect.any(Number));
  });

  it("the requested record holds the input as decided on, even if the caller's object changes later", async () => {
    // pi hands canUseTool its live input object, then executes with it.
    const input: Record<string, unknown> = { command: "npm test", env: { CI: "1" } };
    const { captured, observation } = await run(SCENARIOS[0], "recording", { input });
    expect(observation.settled).toMatchObject({ behavior: "allow" });
    input.command = "MUTATED-AFTER-DECISION";
    (input.env as Record<string, string>).CI = "0";
    input.extra = true;
    const requested = captured[0].build();
    expect(requested.attributes["tool.input"]).toBe(JSON.stringify({ command: "npm test", env: { CI: "1" } }));
    expect(requested.attributes["tool.input.bytes"]).toBe(JSON.stringify({ command: "npm test", env: { CI: "1" } }).length);
  });

  it("the requested record's time is the decision's, not the emitter's", async () => {
    const before = Date.now();
    const { captured } = await run(SCENARIOS[0], "recording");
    const after = Date.now();
    const [requested, result] = captured.map((c) => c.build());
    expect(requested.timeMs).toBeGreaterThanOrEqual(before);
    expect(requested.timeMs).toBeLessThanOrEqual(after);
    expect(result.timeMs).toBeGreaterThanOrEqual(requested.timeMs!);
  });

  it("a hard stop's task excerpt is read at the decision, not at flush", async () => {
    let excerpt = "Chat title: fix the build";
    const s = SCENARIOS.find((x) => x.name === "hard stop pre-empts the model")!;
    const { captured } = await run(s, "recording", { excerpt: () => excerpt });
    excerpt = "Chat title: something later";
    expect(captured[0].build().attributes["callboard.task.excerpt"]).toBe("Chat title: fix the build");
  });

  it("the hard-stop screen reports its evidence and source", async () => {
    const s = SCENARIOS.find((x) => x.name === "hard stop pre-empts the model")!;
    const { captured } = await run(s, "recording");
    const [requested, result] = decode(captured);
    expect(requested.attributes["permission.review.screen"]).toBe("hardstop");
    expect(result.attributes).toMatchObject({ "permission.review.verdict": "kill", "permission.review.source": "precheck" });
    expect(result.attributes["permission.review.evidence"]).toEqual(expect.stringMatching(/^Destructive effect: /));
    expect(result.severity).toBe("WARN");
  });

  it("a downgrade is recorded with its reason, and the fallback settings with it", async () => {
    const turnedOff = decode((await run(SCENARIOS.find((x) => x.name.startsWith("approve downgraded"))!, "recording")).captured)[1];
    expect(turnedOff.attributes).toMatchObject({ "permission.review.verdict": "escalate", "permission.review.downgraded_from": "approve", "permission.review.downgrade_reason": "review_turned_off" });

    const [req, res] = decode((await run(SCENARIOS.find((x) => x.name.startsWith("settings unreadable"))!, "recording")).captured);
    expect(req.attributes).toMatchObject({ "permission.review.settings.fallback": true, "permission.review.settings.approve_allowed": false });
    expect(res.attributes).toMatchObject({ "permission.review.downgraded_from": "approve", "permission.review.downgrade_reason": "settings_unreadable" });
  });

  it("an unscreened ask emits nothing", async () => {
    for (const s of SCENARIOS.filter((x) => !x.expectedOutcome)) {
      expect((await run(s, "recording")).captured).toHaveLength(0);
    }
  });

});

describe("startReviewAudit", () => {
  it("a trace reports its result once, however often result() is called", async () => {
    const captured: Captured[] = [];
    const trace = startReviewAudit({
      hooks: { getCallerAlias: () => "c", emit: (alias, build) => void captured.push({ alias, build }) },
      screen: "model",
      chatId: "chat-1",
      toolName: "Bash",
      toolUseId: undefined,
      input: { command: "npm test" },
      category: "codeExecution",
      cwd: "/repo",
      settings: { modelReview: true, parentAnswers: false },
      settingsFallback: false,
    });
    const verdict: ReviewVerdict = { verdict: "deny", reason: "nope", source: "model" };
    trace.result({ verdict, outcome: "denied_to_agent" });
    trace.result({ verdict, outcome: "allowed" });
    trace.result({ verdict: { ...verdict, verdict: "approve" }, outcome: "allowed" });
    await flush();
    const events = captured.map((c) => c.build());
    expect(events.map((e) => e.eventName)).toEqual([REVIEW_REQUESTED_EVENT, REVIEW_RESULT_EVENT]);
    expect(events[1].attributes["permission.outcome"]).toBe("denied_to_agent");
  });
});
