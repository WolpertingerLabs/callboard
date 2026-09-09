/**
 * The one thing a chat can be blocked on: a question for the human.
 *
 * A chat has at most one open prompt at a time — a tool permission request, an
 * `AskUserQuestion`, or a plan review — parked here as a promise the SSE client
 * resolves through `POST /api/chats/:id/respond`. `buildCanUseTool` in
 * `claude.ts` is the engine-facing producer; `respondToPermission` is the
 * human-facing consumer; `/pending` replays the open one after a page refresh.
 *
 * This module exists so a *second* producer can exist without importing
 * `claude.ts`. `claude.ts` imports `computer-use-tools.ts`, so a computer-use
 * module that reached back into `claude.ts` for this map would close an import
 * cycle. Everything here depends only on the session registry and types.
 *
 * @see requestHumanApproval — the producer that is not a harness callback.
 */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "shared/types/index.js";
import type { PermissionResult } from "../agents/adapters/claude-code/types.js";
import { sessionRegistry } from "./session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pending-requests");

export interface ApprovalCompletion {
  ok: boolean;
  error?: string;
}

export interface PendingRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: readonly unknown[];
  eventType: "permission_request" | "user_question" | "plan_review";
  eventData: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  /**
   * This prompt may be answered ONLY by a signed-in human, never by an API
   * key — see {@link pendingRequestRequiresHuman} for why the distinction
   * exists and where it is enforced.
   *
   * Set by {@link requestHumanApproval} and by nothing else. A harness
   * callback's prompt (`buildCanUseTool`) does not set it: those are ordinary
   * tool permissions, and the `/respond` route has always accepted a bearer
   * token for them.
   */
  humanOnly?: true;
  requestId?: string;
  /** Host startup result; never serialized into the replay or SSE payload. */
  completion?: Promise<ApprovalCompletion>;
}

/**
 * chatId (tracking id) → the prompt that chat is blocked on.
 *
 * Exported for `claude.ts`, which owns the harness-callback producer and the
 * temp-id → session-id rekey. Everything else should go through the functions
 * below.
 */
export const pendingRequests = new Map<string, PendingRequest>();

export function hasPendingRequest(chatId: string): boolean {
  return pendingRequests.has(chatId);
}

/**
 * A value that changes whenever the set of chats awaiting a permission answer
 * changes — the "waiting" half of a folder row's `status`.
 *
 * Derived from the map rather than maintained as a counter alongside it. There
 * are eight places that add to or remove from `pendingRequests` (permission
 * request, blocking approval, response, abort, two unregister paths, the
 * tracking-id rekey, and cleanup), and a hand-bumped counter is one forgotten
 * call site away from silently pinning a folder row to "waiting" forever.
 * Reading the keys cannot drift, and the map holds one entry per chat currently
 * blocked on a prompt — normally zero, a handful at worst — so it costs nothing
 * to ask.
 *
 * Consumed by the folder-list cache; see services/folder-list-cache.ts.
 */
export function pendingRequestFingerprint(): string {
  if (pendingRequests.size === 0) return "";
  return [...pendingRequests.keys()].sort().join(",");
}

export function getPendingRequest(chatId: string): Omit<PendingRequest, "resolve" | "completion"> | null {
  const p = pendingRequests.get(chatId);
  if (!p) return null;
  const { resolve: _, completion: _completion, ...rest } = p;
  return rest;
}

/**
 * Is this chat blocked on a prompt only a signed-in human may answer?
 *
 * The distinction is not cosmetic, and getting it wrong once already cost a
 * security property. `POST /api/chats/:id/respond` sits under `requireAuth`,
 * which accepts a Bearer `cbk_` API key as readily as a session cookie. That is
 * correct for an ordinary tool permission — answering "may I run Bash" over the
 * API is a supported, documented workflow.
 *
 * It is NOT correct for the computer-use gate. The endpoint that gate used to
 * live behind — `POST /api/computer-use/:chatId/:sessionId/approve` — carries
 * `requireSessionAuth` + `requireControlOrigin` under the comment "This control
 * plane is for the signed-in human, never an agent API key", because the entire
 * value of a second gate is that it still holds when the first one has passed.
 * An agent that has got hold of an API key (from disk, an env var, a prior
 * chat's output) must not be able to confirm its own GUI action.
 *
 * So the requirement travels with the prompt rather than being re-derived from
 * a tool name at the route: {@link requestHumanApproval} marks every prompt it
 * raises, and `/respond` refuses a non-session actor for those. A future
 * blocking gate inherits the protection by existing, not by remembering.
 */
export function pendingRequestRequiresHuman(chatId: string): boolean {
  return pendingRequests.get(chatId)?.humanOnly === true;
}

export function respondToPermission(
  chatId: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
  requestId?: string,
): { ok: boolean; toolName?: string; completion?: Promise<ApprovalCompletion> } {
  const pending = pendingRequests.get(chatId);
  if (!pending || typeof allow !== "boolean") return { ok: false };
  // An old consent must never answer a replacement ordinary prompt either.
  if (requestId !== undefined && requestId !== pending.requestId) return { ok: false };
  if (pending.humanOnly && !requestId) return { ok: false };
  const toolName = pending.toolName;
  pendingRequests.delete(chatId);

  if (allow) {
    // For AskUserQuestion the frontend only sends back the collected `answers`.
    // The SDK tool requires the original `questions` to remain in the input
    // (it builds `{...input, answers}`), so merge rather than replace — otherwise
    // `questions` is undefined and the tool crashes mapping over it.
    const resolvedInput = pending.humanOnly
      ? pending.input
      : updatedInput && pending.eventType === "user_question"
        ? { ...pending.input, ...updatedInput }
        : updatedInput || pending.input;
    pending.resolve({
      behavior: "allow",
      updatedInput: resolvedInput,
      updatedPermissions: (pending.humanOnly ? undefined : updatedPermissions) as never,
    });
  } else {
    pending.resolve({ behavior: "deny", message: "User denied", interrupt: true });
  }
  return { ok: true, toolName, ...(allow && pending.completion ? { completion: pending.completion } : {}) };
}

/**
 * How long a blocking human approval waits before it gives up and denies.
 *
 * Five minutes, chosen against two ceilings rather than taste:
 *
 *  - **Below the harness's own patience.** The `wait` tool (services/
 *    callboard-tools.ts) parks an in-process MCP call for up to 300s on every
 *    engine and is used constantly in production, so 300s is the longest tool
 *    block this codebase has evidence for. Going past it would risk the harness
 *    timing the call out while the approval was still open — and a harness that
 *    has given up must never see the action execute afterwards. (It would not:
 *    the per-call `AbortSignal` is honored. But not relying on that is cheaper.)
 *  - **Above a human's reading time.** The old 120s was sized for a request the
 *    human had to *find* in another tab, which is exactly the case where 120s
 *    is not enough. A prompt rendered in the chat the human is already looking
 *    at needs time to read an action and decide, not time to go hunting.
 *
 * Expiry cannot wedge the call either way: the timer, the per-call transport
 * signal and the turn's abort signal all settle the same promise exactly once.
 */
export const HUMAN_APPROVAL_TIMEOUT_MS = 300_000;

export interface HumanApprovalRequest {
  /** Tool name shown in the prompt; also what `/respond` reports back. */
  toolName: string;
  /** Payload the prompt renders. Keep it human-readable, not wire internals. */
  input: Record<string, unknown>;
  /** Trusted host UI discriminator, never derived from tool input. */
  controlRequest?: true;
  /** Optional host result so /respond does not report successful startup early. */
  completion?: Promise<ApprovalCompletion>;
  timeoutMs?: number;
  /** Transport/turn cancellation. An abort denies rather than hanging. */
  signal?: AbortSignal;
}

export interface HumanApprovalOutcome {
  approved: boolean;
  /** Why, for the message the agent is handed. Never "approved" unless a human said so. */
  reason: "human" | "denied" | "timeout" | "aborted" | "no_session" | "prompt_busy";
}

/**
 * Block until a human answers, using the chat's existing prompt surface.
 *
 * This is `buildCanUseTool`'s user-prompt path with the harness callback taken
 * off the front: same map, same `permission_request` event, same
 * `POST /:id/respond` route, same `FeedbackPanel`. What it deliberately does
 * NOT have is the auto-decide half — there is no `ToolPermissionPolicy` here,
 * no `decide()`, no early `allow`. A caller cannot configure this into
 * returning `approved: true` on its own; the only code that sets that flag is
 * the `behavior === "allow"` branch below, reached only from
 * `respondToPermission`, reached only from the authenticated human's POST.
 *
 * Fails closed on every ambiguity: no live session, a prompt already open for
 * this chat (we will not clobber the question the human is looking at), an
 * abort, or the timeout all resolve `approved: false`.
 *
 * Every prompt raised here is marked {@link PendingRequest.humanOnly}: an API
 * key cannot answer it, only a signed-in browser session can. See
 * {@link pendingRequestRequiresHuman}.
 */
export function requestHumanApproval(chatId: string, request: HumanApprovalRequest): Promise<HumanApprovalOutcome> {
  const emitter = sessionRegistry.get(chatId)?.emitter;
  if (!emitter) return Promise.resolve({ approved: false, reason: "no_session" });
  if (pendingRequests.has(chatId)) return Promise.resolve({ approved: false, reason: "prompt_busy" });
  if (request.signal?.aborted) return Promise.resolve({ approved: false, reason: "aborted" });

  const requestId = randomUUID();
  const input = structuredClone(request.input);
  const metadata = { requestId, humanOnly: true, ...(request.controlRequest ? { controlRequest: true } : {}) };
  const timeoutMs = request.timeoutMs ?? HUMAN_APPROVAL_TIMEOUT_MS;
  return new Promise<HumanApprovalOutcome>((resolvePromise) => {
    let settled = false;
    function settle(outcome: HumanApprovalOutcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      // Only ever remove our own entry: a replacement prompt may have taken
      // the slot while we were parked, and dropping it would strand that one.
      if (pendingRequests.get(chatId) === entry) pendingRequests.delete(chatId);
      if (!outcome.approved) log.info(`[PERM-DIAG] blocking approval for ${request.toolName} on ${chatId} → deny (${outcome.reason})`);
      resolvePromise(outcome);
    }
    function onAbort() {
      settle({ approved: false, reason: "aborted" });
    }

    const entry: PendingRequest = {
      toolName: request.toolName,
      input,
      requestId,
      ...(request.completion ? { completion: request.completion } : {}),
      eventType: "permission_request",
      eventData: { toolName: request.toolName, input, ...metadata },
      humanOnly: true,
      resolve: (result) => settle(result.behavior === "allow" ? { approved: true, reason: "human" } : { approved: false, reason: "denied" }),
    };
    const timer = setTimeout(() => settle({ approved: false, reason: "timeout" }), timeoutMs);
    timer.unref?.();

    pendingRequests.set(chatId, entry);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    emitter.emit("event", {
      type: "permission_request",
      content: "",
      toolName: request.toolName,
      input,
      ...metadata,
    } as StreamEvent);
  });
}
