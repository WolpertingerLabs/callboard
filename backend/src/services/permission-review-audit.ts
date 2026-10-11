/**
 * The two audit events of one screened permission ask (see audit-log.ts):
 *
 *   permission.review.requested — a screen (model reviewer or hard-stop
 *     pre-check) is about to decide this call. Emitted before the reviewer is
 *     awaited, or when `detectHardStop` pre-empts it.
 *   permission.review.result    — the verdict and what the chain did with it.
 *
 * Both share a trace id; the result's `parentSpanId` is the requested event's
 * span id.
 *
 * Every method here is a no-throw, no-await wrapper around `emitAuditRecord`:
 * the chain in `buildCanUseTool` calls them inline and must behave exactly as
 * if they were not there.
 *
 * What is captured, and when:
 *  - At decision time, synchronously: ids, timestamps, and a SNAPSHOT of the
 *    tool input (JSON, truncated like every record string). The input object
 *    is not ours — pi hands over the live object it then executes with — and
 *    the record must show what the screen decided on, not what the object
 *    holds a second later.
 *  - After the decision, on `setImmediate`: the emitter itself (alias lookup,
 *    `emitAuditRecord` or an injected double). However slow or blocking an
 *    emitter is, the decision has already been returned or parked.
 *  - At flush time: the metadata reads (`getLateAttributes`).
 */
import type { PermissionCategory } from "../agents/permissions/ToolPermissionPolicy.js";
import { createLogger } from "../utils/logger.js";
import { emitAuditRecord, MAX_STRING_BYTES, newSpanId, newTraceId, truncateUtf8, type AttrValue, type AuditRecordInput } from "./audit-log.js";
import type { ReviewVerdict } from "./permission-review.js";

const log = createLogger("permission-review-audit");

export const REVIEW_REQUESTED_EVENT = "permission.review.requested";
export const REVIEW_RESULT_EVENT = "permission.review.result";

/** Which screen decides: the model reviewer, or the pre-check pre-empting it. */
export type ReviewScreen = "model" | "hardstop";

/**
 * What the chain did after the verdict. The spec's six, plus `deferred`: the
 * chat's one prompt slot was taken by the time the screen finished, so the
 * call went back to the agent as "ask again later" rather than to a person.
 */
export type ReviewChainOutcome = "allowed" | "denied_to_agent" | "escalated_to_human" | "offered_to_parent" | "human_only" | "aborted" | "deferred";

/**
 * Session wiring for the audit records. Absent = no audit records (tests that
 * don't care, and any caller that has not opted in).
 */
export interface PermissionAuditHooks {
  /** The drawlatch caller the records are sent as. No alias = not sent. */
  getCallerAlias: () => string | undefined;
  /** The Callboard agent this session runs as, if any. */
  agentAlias?: string;
  /**
   * Correlation attributes that cost a read (parent chat, space). Called at
   * FLUSH time, never on the decision path; may throw.
   */
  getLateAttributes?: () => Record<string, AttrValue>;
  /** Injected in tests; defaults to {@link emitAuditRecord}. */
  emit?: (alias: string | undefined, build: () => AuditRecordInput) => void;
}

export interface ReviewAuditStart {
  hooks: PermissionAuditHooks;
  screen: ReviewScreen;
  chatId: string;
  toolName: string;
  toolUseId: string | undefined;
  input: Record<string, unknown>;
  category: PermissionCategory | null;
  cwd: string;
  /** Read by the caller at decision time — the excerpt the screen saw. */
  taskExcerpt?: string;
  settings: { modelReview: boolean; parentAnswers: boolean; approveAllowed?: false };
  settingsFallback: boolean;
}

export interface ReviewAuditResult {
  verdict: ReviewVerdict;
  outcome: ReviewChainOutcome;
  requestId?: string;
  /** Set when an `approve` was turned into `escalate` after the review. */
  downgrade?: { from: "approve"; reason: "review_turned_off" | "settings_unreadable" };
}

/** A started trace. `result` emits at most once; later calls are ignored. */
export interface ReviewAuditTrace {
  result(r: ReviewAuditResult): void;
}

const NOOP_TRACE: ReviewAuditTrace = { result: () => {} };

/**
 * Hand a record to the emitter after the current decision has run its course:
 * `setImmediate` runs once the chain's synchronous code and its promise
 * resolutions are done, so no emitter — blocking, slow or throwing — can sit
 * between an ask and its answer.
 */
function safeEmit(hooks: PermissionAuditHooks, build: () => AuditRecordInput): void {
  try {
    setImmediate(() => {
      try {
        const alias = hooks.getCallerAlias();
        const emit = hooks.emit ?? emitAuditRecord;
        const ret: unknown = emit(alias, build);
        // A test double (or a future emitter) might be async: never await it, never let it reject unhandled.
        if (ret && typeof (ret as Promise<unknown>).then === "function") (ret as Promise<unknown>).then(undefined, () => {});
      } catch (err) {
        warn(`[PERM-DIAG] audit emit failed (decision unaffected): ${err}`);
      }
    });
  } catch (err) {
    warn(`[PERM-DIAG] audit emit could not be scheduled (decision unaffected): ${err}`);
  }
}

function warn(message: string): void {
  try {
    log.warn(message);
  } catch {
    /* ignore */
  }
}

function lateAttributes(hooks: PermissionAuditHooks): Record<string, AttrValue> {
  try {
    return hooks.getLateAttributes?.() ?? {};
  } catch {
    return {};
  }
}

/** Nesting kept in a copied input; deeper values become a marker. */
export const MAX_INPUT_DEPTH = 8;
/** Array items / object keys kept per level of a copied input. */
export const MAX_INPUT_ENTRIES = 256;

/**
 * Copy `input` to at most ~MAX_STRING_BYTES of JSON without serializing the
 * whole of it. This runs on the decision path, so its cost must not grow with
 * the input: strings are sliced to the remaining budget, arrays and objects
 * stop at MAX_INPUT_ENTRIES or when the budget runs out, nesting stops at
 * MAX_INPUT_DEPTH. Anything cut sets `truncated`; then `bytes` (the full size)
 * is unknown and omitted rather than paid for.
 */
export function serializeInput(input: unknown): { json: string; bytes?: number; truncated: boolean } {
  // Headroom under the hard limit for JSON punctuation and the cut marker, so
  // the final byte guard rarely has to cut (and so the marker survives).
  const budget = { left: MAX_STRING_BYTES - 1024, truncated: false };
  let json: string;
  try {
    json = JSON.stringify(boundedCopy(input, budget, 0)) ?? "null";
  } catch (err) {
    json = JSON.stringify({ unserializable: String(err) });
  }
  // Escaping and multi-byte characters can still push past the byte limit.
  const { value, truncated } = truncateUtf8(json);
  const cut = budget.truncated || truncated;
  return { json: value, truncated: cut, ...(!cut && { bytes: Buffer.byteLength(value, "utf8") }) };
}

const CUT = "…[truncated]";

function boundedCopy(value: unknown, budget: { left: number; truncated: boolean }, depth: number): unknown {
  if (budget.left <= 0) {
    budget.truncated = true;
    return CUT;
  }
  switch (typeof value) {
    case "string": {
      if (value.length <= budget.left) {
        budget.left -= value.length + 2;
        return value;
      }
      budget.truncated = true;
      const kept = value.slice(0, budget.left);
      budget.left = 0;
      return kept + CUT;
    }
    case "number":
    case "boolean":
      budget.left -= 8;
      return value;
    case "bigint":
      budget.left -= 8;
      return String(value);
    case "undefined":
    case "function":
    case "symbol":
      return undefined; // as JSON.stringify drops them
  }
  if (value === null) {
    budget.left -= 4;
    return null;
  }
  if (depth >= MAX_INPUT_DEPTH) {
    budget.truncated = true;
    return CUT;
  }
  const obj = value as { toJSON?: () => unknown };
  if (typeof obj.toJSON === "function") {
    try {
      return boundedCopy(obj.toJSON(), budget, depth + 1);
    } catch {
      return "[unreadable]";
    }
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const n = Math.min(value.length, MAX_INPUT_ENTRIES);
    for (let i = 0; i < n && budget.left > 0; i++) {
      budget.left -= 1;
      out.push(boundedCopy(value[i], budget, depth + 1) ?? null);
    }
    if (out.length < value.length) {
      budget.truncated = true;
      out.push(CUT);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  let kept = 0;
  // for..in, not Object.keys: stops early on a huge object instead of listing every key first.
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (kept >= MAX_INPUT_ENTRIES || budget.left <= 0) {
      budget.truncated = true;
      out[CUT] = true;
      break;
    }
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      child = "[unreadable]";
    }
    budget.left -= key.length + 4;
    const copied = boundedCopy(child, budget, depth + 1);
    if (copied !== undefined) out[key] = copied;
    kept++;
  }
  return out;
}

/**
 * Emit `permission.review.requested` and return the trace for the result.
 * Never throws; on any failure returns a no-op trace.
 */
export function startReviewAudit(start: ReviewAuditStart): ReviewAuditTrace {
  try {
    const traceId = newTraceId();
    const requestedSpanId = newSpanId();
    const startedMs = Date.now();
    const { hooks } = start;
    // Snapshot now: what the screen decides on is the input as it is NOW.
    const input = serializeInput(start.input);
    const common = (): Record<string, AttrValue> => ({
      "callboard.chat.id": start.chatId,
      "callboard.agent.alias": hooks.agentAlias,
      "callboard.caller.alias": safeAlias(hooks),
      "tool.name": start.toolName,
      "tool.use_id": start.toolUseId,
      "permission.category": start.category,
      ...lateAttributes(hooks),
    });

    safeEmit(hooks, () => {
      return {
        timeMs: startedMs,
        eventName: REVIEW_REQUESTED_EVENT,
        severity: "INFO",
        body: `permission review requested: ${start.toolName} (${start.screen})`,
        traceId,
        spanId: requestedSpanId,
        attributes: {
          ...common(),
          "permission.review.screen": start.screen,
          "tool.input": input.json,
          // The full serialized size, when the copy is whole; absent when cut.
          "tool.input.bytes": input.bytes,
          "tool.input.truncated": input.truncated || undefined,
          "process.cwd": start.cwd,
          "callboard.task.excerpt": start.taskExcerpt,
          "permission.review.settings.model_review": start.settings.modelReview,
          "permission.review.settings.parent_answers": start.settings.parentAnswers,
          "permission.review.settings.approve_allowed": start.settings.approveAllowed !== false,
          "permission.review.settings.fallback": start.settingsFallback || undefined,
        },
      };
    });

    let done = false;
    return {
      result(r) {
        if (done) return;
        done = true;
        const resultMs = Date.now();
        const latencyMs = resultMs - startedMs;
        safeEmit(hooks, () => ({
          timeMs: resultMs,
          eventName: REVIEW_RESULT_EVENT,
          severity: r.verdict.verdict === "kill" ? "WARN" : "INFO",
          body: `permission review ${r.verdict.verdict} → ${r.outcome}: ${start.toolName}`,
          traceId,
          spanId: newSpanId(),
          parentSpanId: requestedSpanId,
          attributes: {
            ...common(),
            "permission.review.screen": start.screen,
            "permission.review.verdict": r.verdict.verdict,
            "permission.review.source": r.verdict.source ?? "model",
            "permission.review.reason": r.verdict.reason,
            "permission.review.failure": r.verdict.failure,
            "permission.review.evidence": r.verdict.evidence,
            "permission.review.latency_ms": latencyMs,
            "permission.review.downgraded_from": r.downgrade?.from,
            "permission.review.downgrade_reason": r.downgrade?.reason,
            "permission.outcome": r.outcome,
            "callboard.request.id": r.requestId,
          },
        }));
      },
    };
  } catch (err) {
    try {
      log.warn(`[PERM-DIAG] audit start failed (decision unaffected): ${err}`);
    } catch {
      /* ignore */
    }
    return NOOP_TRACE;
  }
}

function safeAlias(hooks: PermissionAuditHooks): string | undefined {
  try {
    return hooks.getCallerAlias();
  } catch {
    return undefined;
  }
}
