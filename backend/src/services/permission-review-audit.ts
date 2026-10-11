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
import { emitAuditRecord, newSpanId, newTraceId, truncateUtf8, type AttrValue, type AuditRecordInput } from "./audit-log.js";
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

function serializeInput(input: unknown): { json: string; bytes: number; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "null";
  } catch (err) {
    json = JSON.stringify({ unserializable: String(err) });
  }
  const { value, truncated } = truncateUtf8(json);
  return { json: value, bytes: Buffer.byteLength(json, "utf8"), truncated };
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
