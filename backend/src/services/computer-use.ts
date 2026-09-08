/** Thin Callboard host: policy, human grants and presentation. Drivers live in the independent package. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Action, AuthorizationRequest, ComputerUseService, Driver, Lease, Principal, SessionStatus } from "@wolpertingerlabs/computer-use";
import { assertNativeAgentControllable } from "./codex-native-agents.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";
import { resolveSessionContext } from "../utils/session-provenance.js";
import { chatFileService } from "./chat-file-service.js";
import { computerUseScopeError, readComputerUsePolicy, type ComputerTargetKind, type ComputerUsePolicy } from "./computer-use-policy.js";
import { requestHumanApproval, type HumanApprovalOutcome } from "./pending-requests.js";

const log = createLogger("computer-use");

/**
 * Codes the host or the driver package raises to tell a caller what to do
 * differently: a chat that does not exist, a malformed action, a stale frame,
 * an approval the human has not given yet, a turn that moved on. They are the
 * control plane working, so they log at debug — a viewer clicking against an
 * old frame would otherwise fill the log with `stale_frame` at error level.
 *
 * `denied` is deliberately *not* here; see the level table in
 * `logComputerUseFailure`.
 */
const ROUTINE_CONTROL_CODES = new Set([
  "not_found",
  "invalid_request",
  "approval_required",
  // The two ways a GUI action ends without the human ever saying yes: nobody
  // answered the chat prompt in time, and there was nowhere to ask (no live
  // session, or the chat's one prompt slot was already occupied). Neither is a
  // fault — an operator who wants them raises the level. They are emphatically
  // NOT the escalated case, which is a human answering yes and it still not
  // happening; see `markConfirmedFailure`.
  "approval_timeout",
  "approval_unavailable",
  "queue_full",
  "lease_conflict",
  "stale_frame",
  "stale_generation",
  "stopped",
  "revoked",
  "cancelled",
]);

/** Identifiers are caller-supplied; keep them to the id alphabet so nothing forges a log line. */
const controlId = (value: unknown): string => (typeof value === "string" ? value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160) : "");

/**
 * An abort is not a fault, and it does not always arrive as `cancelled`: the
 * MCP client rejects an aborted call with a numeric `-32001` McpError, and a
 * DOMException abort carries the numeric `code` 20. Callers that hold the
 * signal say so explicitly (`context.cancelled`), because `-32001` is also the
 * SDK's *timeout*, which is a genuine fault and must stay at error.
 */
const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || (error as { code?: unknown }).code === 20 || (error as { code?: unknown }).code === "ABORT_ERR");

/**
 * Fold anything that could end a line or move the cursor into a space. Covers
 * C0 and C1 (`\p{Cc}`, which includes NEL) and the format characters, plus the
 * two Unicode separators outside those classes: `less` ignores U+2028, but CSS
 * `white-space: pre` treats it as a forced break, so a log rendered in a
 * browser would show it as one.
 */
const oneLine = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ");

/**
 * The frames of an error, with the `Name: message` header removed.
 *
 * The header is dropped by *length*, not by taking everything after the first
 * newline: a message can itself contain `\n    at forged (/evil.js:1:1)`, and
 * that survives a per-line frame filter looking like the innermost call site.
 * Slicing the message out of the stack removes the whole region it controls.
 */
function stackFrames(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return "";
  const cut = error.message ? error.stack.indexOf(error.message) : -1;
  const body = cut >= 0 ? error.stack.slice(cut + error.message.length) : error.stack;
  const frames = body
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .map(oneLine)
    .join("\n")
    .slice(0, 2000);
  return frames ? `\n${frames}` : "";
}

export interface FailureContext {
  /** The caller's signal was aborted — a stopped turn, not a fault. Wins over `escalate`. */
  cancelled?: boolean;
  /** This failure is not routine whatever its code: a human approved it and it did not happen. */
  escalate?: boolean;
}

/**
 * "The human said yes, and it still did not happen" — carried on the error
 * itself, because that fact is known where the throw happens and needed where
 * it is logged.
 *
 * `escalate` used to be derived from a parameter (`approvedSignal`) that only
 * the redemption path passed. With the confirmation inlined into the blocking
 * call, the redemption path is no longer a separate call — but the *window*
 * still is: everything {@link ComputerUseHost.requestAgentAction} throws after
 * `outcome.approved` is a confirmed-but-unfulfilled action, and everything it
 * throws before is an ordinary refusal. A denial, a timeout, an occupied
 * prompt slot and a malformed action are all pre-approval, and none of them
 * escalate.
 *
 * A symbol so it cannot collide with a driver's own field and never reaches
 * the model: `failure()` serializes only `code` and `message`.
 */
const CONFIRMED_BY_HUMAN = Symbol("callboard.computerUse.confirmedByHuman");

export function markConfirmedFailure<E>(error: E): E {
  if (error && typeof error === "object") Object.defineProperty(error, CONFIRMED_BY_HUMAN, { value: true, enumerable: false });
  return error;
}

/** Did this failure happen after a human confirmed the action? See {@link markConfirmedFailure}. */
export function isConfirmedFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as Record<symbol, unknown>)[CONFIRMED_BY_HUMAN] === true;
}

/**
 * Record a computer-control failure for the operator.
 *
 * The HTTP and MCP surfaces both answer the caller with a sanitized message on
 * purpose; this is the other half of that trade — the detail has to land
 * somewhere, and that somewhere is the server log. Error text and identifiers
 * only: browser sessions handle credentials and page content, and none of that
 * belongs here.
 *
 * The level follows *fault*, not HTTP status:
 *
 * - **debug** — the routine codes above, plus anything cancelled. Below the
 *   default `info`, so a healthy host stays silent.
 * - **warn** — `denied`. Nothing is broken, so it is not an error, but it is
 *   the one refusal an operator must be able to see without raising the level:
 *   the service emits no audit event for a denial, repeated ones are a
 *   prompt-injection signal, and `loadComputerUsePolicy` also answers `denied`
 *   for a chat file whose metadata will not parse — a corrupt chat silently
 *   losing computer control.
 * - **error** — `driver_error`, `unsupported`, `timeout`, `disposed` and any
 *   uncoded throwable (reported to clients as `unavailable`). The driver or the
 *   host itself failed; this is what is missing when a session lands in
 *   `failed`. Logged with the message and the stack frames.
 */
export function logComputerUseFailure(operation: string, ids: { chatId?: unknown; sessionId?: unknown }, error: unknown, context: FailureContext = {}): void {
  const raw = (error as { code?: unknown } | null | undefined)?.code;
  // Same treatment as the identifiers: a code can reach here from a recovered
  // MCP payload, so bound it and drop anything that could act as a separator.
  // The alphabet stays wide enough for an errno (`ENOENT`, `ERR_DLOPEN_FAILED`),
  // which is the most greppable thing an uncoded throwable carries.
  const coded = typeof raw === "string" ? raw.slice(0, 64).replace(/[^a-zA-Z0-9_]/g, "") : "";
  const label = context.cancelled || isAbort(error) ? "cancelled" : coded || "unavailable";
  const chatId = controlId(ids.chatId) || "-";
  const sessionId = controlId(ids.sessionId);
  const where = `${operation} chat=${chatId}${sessionId ? ` session=${sessionId}` : ""} code=${label}`;
  const detail = oneLine(error instanceof Error ? error.message : String(error ?? "")).slice(0, 500);
  if (label === "cancelled" || (!context.escalate && ROUTINE_CONTROL_CODES.has(label))) {
    log.debug(`Computer control ${where} refused: ${detail}`);
    return;
  }
  if (label === "denied" && !context.escalate) {
    log.warn(`Computer control ${where} refused: ${detail}`);
    return;
  }
  log.error(`Computer control ${where} failed: ${detail}${stackFrames(error)}`);
}

export interface HostPolicy {
  policy: ComputerUsePolicy;
  signature: string;
}
export function loadComputerUsePolicy(chatId: string): HostPolicy {
  const chat = chatFileService.getChat(chatId);
  if (!chat) throw controlError("not_found", "Chat not found");
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(chat.metadata || "{}");
  } catch {
    throw controlError("denied", "Chat permission metadata is unreadable");
  }
  if (!metadata || typeof metadata !== "object" || metadata.archived === true) throw controlError("denied", "Chat is unavailable");
  let routing: Record<string, unknown>;
  try {
    // Use main's current/historical provenance rules; never treat an inherited
    // native-child MCP identity or ambiguous namespace as independently owned.
    routing = parseChatMetadata(resolveSessionContext(chat.session_id, chat.metadata).metadata);
    assertNativeAgentControllable(chatId, { sessionId: chat.session_id, provider: routing.provider });
  } catch {
    throw controlError(
      "denied",
      "Chat ownership or provider provenance is unverified or parent-owned. Use the owning parent thread for native Codex children.",
    );
  }
  const policy = readComputerUsePolicy(metadata.defaultPermissions);
  // The signature is what a grant is bound to; drift revokes the live session.
  // Sign only what changes the authority itself: the permission axes and the
  // engine identity the provenance check just verified. The wider chat
  // fingerprint (session ids, last branch, model, folder) used to be in here,
  // and a nudge resume appending a session id or an acknowledged branch drift
  // revoked the browser mid-turn with "permissions changed".
  return { policy, signature: JSON.stringify([policy, routing.provider, routing.acpProviderId]) };
}
export function controlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export const controlPrincipal = (chatId: string, role: "agent" | "human"): Principal => ({ ownerId: chatId, actorId: `${role}:${chatId}`, role });
const uiKind = (kind: string): ComputerTargetKind => (kind === "browser" ? "browser" : "desktop");
const targetId = (kind: ComputerTargetKind) => (kind === "browser" ? "managed-browser" : "native-desktop");
const PROBE_CACHE_MS = 5_000;
interface Grant {
  chatId: string;
  signature: string;
  expiresAt: number;
  lease: Lease;
}
/**
 * A human's pending decision to **enable a target** under `computerControl:
 * "ask"`. Nothing else lives here any more: a per-action approval is no longer
 * a parked record the human has to go and find, it is an awaited prompt in the
 * chat (see {@link ComputerUseHost.requestAgentAction}).
 */
interface Pending {
  chatId: string;
  kind: ComputerTargetKind;
  signature: string;
  expiresAt: number;
}

/** Action shapes the host will forward. Anything else is rejected unopened. */
const ACTION_TYPES = ["click", "move", "drag", "scroll", "key", "type", "navigate", "wait"];

/** The only approval the panel still shows: a human's own Enable request under "ask". */
const PENDING_TARGET_REASON =
  "Approve access to this specific target for this chat until expiry. Screenshots are sent to the configured model when requested. Every agent action still needs a separate confirmation, whatever the permission level — that one is asked in the chat, not here. Subagents the engine runs inside this chat's turn (Claude Code Task subagents, Codex native subagents) share this grant and act under this chat's identity.";

const humanTarget = (kind: ComputerTargetKind) => `${kind === "browser" ? "managed browser" : "native desktop"} on ${hostname()}`;

/** Show the human what they are approving. Never UUIDs, never raw JSON. */
export function describeAgentAction(action: Record<string, unknown>, target: string): string {
  const clip = (value: unknown, limit = 160) => {
    const text = String(value ?? "");
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const at = `(${Number(action.x)}, ${Number(action.y)})`;
  switch (action.type) {
    case "navigate":
      return `Open ${clip(action.url, 300)} in the ${target}`;
    case "click":
      return `${action.button === "right" ? "Right-click" : action.button === "middle" ? "Middle-click" : "Click"} at ${at} in the ${target}`;
    case "move":
      return `Move the pointer to ${at} in the ${target}`;
    case "drag":
      return `Drag from (${Number(action.x)}, ${Number(action.y)}) to (${Number(action.toX)}, ${Number(action.toY)}) in the ${target}`;
    case "scroll":
      return `Scroll by (${Number(action.deltaX)}, ${Number(action.deltaY)}) in the ${target}`;
    case "key":
      return `Press ${clip(action.key, 60)} in the ${target}`;
    case "type":
      return `Type “${clip(action.text)}” into the ${target}`;
    case "wait":
      return `Wait ${Number(action.durationMs)}ms on the ${target}`;
    default:
      return `Perform a ${clip(action.type, 40)} action in the ${target}`;
  }
}

/** What the human is asked, stripped of transport identifiers. */
export interface ActionConfirmationRequest {
  chatId: string;
  /** One readable line: what will happen, where. */
  summary: string;
  /** The target, in words. */
  target: string;
  /** The immutable snapshot that executes verbatim if approved. */
  action: Record<string, unknown>;
  /** Transport/turn cancellation; an abort is a refusal, never an approval. */
  signal?: AbortSignal;
}
export type ConfirmAgentAction = (request: ActionConfirmationRequest) => Promise<HumanApprovalOutcome>;

/**
 * The tool name the confirmation prompt is attributed to — the same string the
 * model called and the transcript shows.
 */
export const CU_ACTION_TOOL_NAME = "mcp__computer_use__cu_action";

/**
 * The production confirmation: the chat's own blocking prompt.
 *
 * Note what is NOT threaded in here — the chat's `computerControl` level, or
 * any policy at all. `requestHumanApproval` has no auto-decide branch, so
 * "allow" cannot shortcut it. That is the second gate, and it is second
 * precisely because the first one (the tool call itself) already passed.
 */
export const confirmAgentActionInChat: ConfirmAgentAction = (request) =>
  requestHumanApproval(request.chatId, {
    toolName: CU_ACTION_TOOL_NAME,
    input: { summary: request.summary, target: request.target, action: request.action },
    signal: request.signal,
  });

/** Why the action did not run, in terms the model can act on — and never as an invitation to retry a denial. */
const REFUSALS: Record<HumanApprovalOutcome["reason"], { code: string; message: string }> = {
  human: { code: "denied", message: "Internal error: an approval was treated as a refusal." },
  denied: {
    code: "denied",
    message: "The human refused this GUI action, so it was NOT performed. Do not repeat it or try a variation of it; ask them what to do instead.",
  },
  timeout: {
    code: "approval_timeout",
    message: "Nobody confirmed this GUI action in time, so it was NOT performed. Observe the current state before requesting it again.",
  },
  aborted: {
    code: "cancelled",
    message: "The turn ended before the human confirmed, so this GUI action was NOT performed.",
  },
  no_session: {
    code: "approval_unavailable",
    message: "There is no live chat session to confirm a GUI action in, so it was NOT performed. Every GUI action needs a human watching this chat.",
  },
  prompt_busy: {
    code: "approval_unavailable",
    message: "This chat is already waiting on another prompt, so the GUI action was NOT performed. Let the human answer that first, then observe and re-request.",
  },
};

export class ComputerUseHost {
  private readonly grants = new Map<string, Grant>();
  private readonly opening = new Map<string, HostPolicy>();
  private readonly pending = new Map<string, Pending>();
  private readonly events = new Map<string, unknown[]>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly probes = new Map<ComputerTargetKind, { at: number; result: Promise<Awaited<ReturnType<Driver["probe"]>>> }>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  /** Chats with a GUI action currently parked on a human. At most one each. */
  private readonly awaiting = new Set<string>();
  constructor(
    readonly service: ComputerUseService,
    readonly drivers: Readonly<Record<ComputerTargetKind, Driver>>,
    private readonly readPolicy: (chatId: string) => HostPolicy = loadComputerUsePolicy,
    private readonly confirmAction: ConfirmAgentAction = confirmAgentActionInChat,
  ) {
    this.watchdog = setInterval(() => {
      void this.expire();
    }, 1000);
    this.watchdog.unref();
  }
  /** Called by the package before AND after every action/observation. */
  authorize = (request: AuthorizationRequest): "allow" | "deny" => {
    try {
      const current = this.readPolicy(request.principal.ownerId);
      if (computerUseScopeError(uiKind(request.kind), current.policy)) return "deny";
      if (request.operation === "open") {
        const initial = this.opening.get(`${request.principal.ownerId}:${request.targetId}`);
        return initial?.signature === current.signature ? "allow" : "deny";
      }
      const grant = request.sessionId ? this.grants.get(request.sessionId) : undefined;
      return grant && grant.chatId === request.principal.ownerId && grant.signature === current.signature && grant.expiresAt > Date.now() ? "allow" : "deny";
    } catch {
      return "deny";
    }
  };
  private listen(chatId: string) {
    if (this.unsubscribers.has(chatId)) return;
    this.unsubscribers.set(
      chatId,
      this.service.subscribe(controlPrincipal(chatId, "human"), (event) => {
        const entries = this.events.get(chatId) ?? [];
        entries.push(event);
        this.events.set(chatId, entries.slice(-100));
      }),
    );
  }
  private async expire() {
    for (const [id, grant] of this.grants) {
      let valid = grant.expiresAt > Date.now();
      try {
        valid = valid && this.readPolicy(grant.chatId).signature === grant.signature;
      } catch {
        valid = false;
      }
      if (!valid) {
        this.grants.delete(id);
        await this.service.revoke(controlPrincipal(grant.chatId, "human"), id).catch(() => {});
      }
    }
    for (const [id, pending] of this.pending) if (pending.expiresAt <= Date.now()) this.pending.delete(id);
  }
  /**
   * Driver probes are host facts, not chat facts, and the native one execs
   * `xdotool getdisplaygeometry` with a 5s timeout — on a configured but
   * unreachable DISPLAY every status poll and `cu_open` blocked on it. Cache
   * for a few seconds. Only an *available* result is kept: both shipped
   * drivers catch their own failures and resolve `{ available: false }`, so
   * evicting on rejection alone cached a missing prerequisite for the full
   * window. An unavailable probe is re-run on the next poll so a fix is seen
   * promptly.
   */
  private probe(kind: ComputerTargetKind) {
    const cached = this.probes.get(kind);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const result = this.drivers[kind].probe();
    const entry = { at: Date.now(), result };
    this.probes.set(kind, entry);
    result.then(
      (probe) => {
        if (!probe.available && this.probes.get(kind) === entry) this.probes.delete(kind);
      },
      () => {
        if (this.probes.get(kind) === entry) this.probes.delete(kind);
      },
    );
    return result;
  }
  private presentation(value: SessionStatus) {
    return {
      ...value,
      id: value.sessionId,
      kind: value.kind === "browser" ? "browser" : "native",
      controller: value.controller === "none" ? null : value.controller,
      targetLabel: hostname(),
      target: hostname(),
    };
  }
  async status(chatId: string) {
    const { policy } = this.readPolicy(chatId);
    await this.expire();
    const capabilities = await Promise.all(
      (["browser", "desktop"] as const).map(async (kind) => {
        const restriction = computerUseScopeError(kind, policy);
        try {
          // This status is served only to a signed-in human (routes/computer-use.ts
          // is requireSessionAuth-gated; the agent bridge returns sessions alone), so
          // it is the one surface allowed to show the driver's operator diagnostics.
          const { operatorDetail, ...probe } = await this.probe(kind);
          const detailed = [probe.reason, operatorDetail].filter(Boolean).join(" ") || undefined;
          return { ...probe, kind: kind === "browser" ? "browser" : "native", available: probe.available && !restriction, reason: restriction ?? detailed };
        } catch {
          return {
            kind: kind === "browser" ? "browser" : "native",
            available: false,
            capabilities: [],
            reason: "Driver probe unavailable; install/configure the native prerequisites on the service host.",
          };
        }
      }),
    );
    const sessions = this.service.status(controlPrincipal(chatId, "human")).map((session) => this.presentation(session));
    for (const [id, pending] of this.pending)
      if (pending.chatId === chatId) {
        // Bound to a variable, not pushed as a fresh literal: `reason` is a
        // viewer-only field the package's SessionStatus does not declare.
        const request = {
          id,
          sessionId: id,
          kind: pending.kind === "browser" ? ("browser" as const) : ("native" as const),
          targetLabel: hostname(),
          target: hostname(),
          targetId: targetId(pending.kind),
          reason: PENDING_TARGET_REASON,
          state: "pending_approval" as SessionStatus["state"],
          generation: 0,
          controller: null,
          expiresAt: pending.expiresAt,
        };
        sessions.push(request);
      }
    return {
      capabilities,
      sessions,
      permission: policy.computerControl,
      target: hostname(),
      platform: process.platform,
      events: this.events.get(chatId) ?? [],
      modelVision:
        "Runtime image delivery requires a tool/vision-capable configured model; live artistic/model qualification has not been established on this host.",
    };
  }
  async open(chatId: string, kind: ComputerTargetKind) {
    const current = this.readPolicy(chatId);
    const restriction = computerUseScopeError(kind, current.policy);
    if (restriction) throw controlError("denied", restriction);
    if (current.policy.computerControl === "ask") {
      if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= 2)
        throw controlError("queue_full", "Resolve the existing target approval first");
      const id = randomUUID();
      this.pending.set(id, { chatId, kind, signature: current.signature, expiresAt: Date.now() + 120_000 });
      return {
        id,
        sessionId: id,
        kind: kind === "browser" ? "browser" : "native",
        state: "pending_approval",
        controller: null,
        generation: 0,
        targetLabel: hostname(),
      };
    }
    return this.openApproved(chatId, kind, current);
  }
  /** Confirm a human's own Enable request. GUI actions are confirmed in the chat, not here. */
  async approve(chatId: string, id: string, _generation?: unknown) {
    const pending = this.pending.get(id);
    if (pending && pending.chatId !== chatId) throw controlError("not_found", "Approval not found");
    this.pending.delete(id);
    const current = this.readPolicy(chatId);
    if (
      !pending ||
      pending.chatId !== chatId ||
      pending.expiresAt <= Date.now() ||
      pending.signature !== current.signature ||
      current.policy.computerControl === "deny"
    )
      throw controlError("denied", "Approval expired or its scope changed; enable the target again");
    return this.openApproved(chatId, pending.kind, current);
  }
  private async openApproved(chatId: string, kind: ComputerTargetKind, current: HostPolicy) {
    const key = `${chatId}:${targetId(kind)}`;
    if (this.opening.has(key)) throw controlError("lease_conflict", "Target is already starting");
    if (this.service.status(controlPrincipal(chatId, "human")).some((s) => s.targetId === targetId(kind) && ["starting", "ready"].includes(s.state)))
      throw controlError("lease_conflict", "Stop this chat's existing target session first");
    this.listen(chatId);
    this.opening.set(key, current);
    try {
      const lease = await this.service.open(controlPrincipal(chatId, "agent"), targetId(kind));
      this.grants.set(lease.sessionId, { chatId, signature: current.signature, expiresAt: lease.expiresAt, lease });
      return this.presentation(lease);
    } finally {
      this.opening.delete(key);
    }
  }
  private grant(chatId: string, id: string): Grant {
    const grant = this.grants.get(id);
    if (!grant || grant.chatId !== chatId) throw controlError("not_found", "Control session not found");
    if (grant.expiresAt <= Date.now() || this.readPolicy(chatId).signature !== grant.signature) {
      this.grants.delete(id);
      void this.service.revoke(controlPrincipal(chatId, "human"), id);
      throw controlError("revoked", "Control grant expired or permissions changed");
    }
    return grant;
  }
  async observe(chatId: string, id: string) {
    const grant = this.grant(chatId, id);
    return this.service.observe(controlPrincipal(chatId, "human"), { sessionId: id, generation: grant.lease.generation });
  }
  async action(chatId: string, id: string, action: unknown, generation: unknown, frameId: string) {
    const grant = this.grant(chatId, id);
    if (generation !== grant.lease.generation) throw controlError("stale_generation", "Refresh the viewer before acting");
    if (action && typeof action === "object" && (action as { type?: string }).type === "drag") {
      const value = action as { fromX?: unknown; fromY?: unknown; toX?: unknown; toY?: unknown };
      action = { type: "drag", x: value.fromX, y: value.fromY, toX: value.toX, toY: value.toY };
    }
    return this.presentation(
      await this.service.act(controlPrincipal(chatId, "human"), {
        sessionId: id,
        generation: grant.lease.generation,
        leaseId: grant.lease.leaseId,
        actionId: randomUUID(),
        frameId,
        action: action as Action,
      }),
    );
  }
  async takeover(chatId: string, id: string, expectedGeneration?: unknown) {
    const grant = this.grant(chatId, id);
    if (expectedGeneration !== grant.lease.generation) throw controlError("stale_generation", "Refresh control state before takeover");
    grant.lease = await this.service.takeover(controlPrincipal(chatId, "human"), { sessionId: id, generation: grant.lease.generation });
    await this.observe(chatId, id);
    return this.presentation(grant.lease);
  }
  async resume(chatId: string, id: string, expectedGeneration?: unknown) {
    const grant = this.grant(chatId, id);
    if (expectedGeneration !== grant.lease.generation) throw controlError("stale_generation", "Refresh control state before resuming");
    // The service returns the fresh agent observation with the lease. Drop it:
    // a grant must not retain a screenshot, and this endpoint returns control
    // state, not pixels — the viewer observes explicitly.
    const { observation: _observation, ...lease } = await this.service.resume(controlPrincipal(chatId, "human"), {
      sessionId: id,
      generation: grant.lease.generation,
      leaseId: grant.lease.leaseId,
    });
    grant.lease = lease;
    return this.presentation(grant.lease);
  }
  async stop(chatId: string, id: string, _generation?: unknown) {
    if (this.pending.get(id)?.chatId === chatId) {
      this.pending.delete(id);
      return { id, state: "stopped" };
    }
    // Even denied/revoked owners may stop; ownership still enforced by the service.
    const result = await this.service.stop(controlPrincipal(chatId, "human"), id);
    this.grants.delete(id);
    return this.presentation(result);
  }
  async revoke(chatId: string, id: string, _generation?: unknown) {
    if (this.pending.get(id)?.chatId === chatId) {
      this.pending.delete(id);
      return { id, state: "revoked" };
    }
    const result = await this.service.revoke(controlPrincipal(chatId, "human"), id);
    this.grants.delete(id);
    return this.presentation(result);
  }
  /**
   * The second gate: one GUI action, one human confirmation, every time.
   *
   * Blocks the agent's tool call on the human's answer and then returns the
   * real outcome. It used to park a record in `pending` and return
   * `{approvalRequired}` immediately, leaving the human to find it in the
   * Computer Control panel and the agent to poll; the approval was described in
   * session/frame UUIDs and raw JSON, and its two-minute clock ran while they
   * hunted for it.
   *
   * The gate itself did not move. This method is reached only *after* the chat
   * policy already allowed the `cu_action` tool call — production logs read
   * `tool=mcp__computer_use__cu_action, category=computerControl,
   * decision=allow` — and it consults no policy of its own. There is no level,
   * setting or argument that makes {@link ConfirmAgentAction} answer without a
   * human: the production implementation is `requestHumanApproval`, which has
   * no auto-decide branch at all.
   *
   * Everything the deferred `approve()` used to re-check on redemption is
   * re-checked after the wait, because a human takes time and the world moves:
   * the grant, its signature, the lease generation, who holds control, and the
   * frame the action was aimed at.
   */
  async requestAgentAction<T>(
    chatId: string,
    id: string,
    generation: number,
    frameId: string,
    action: unknown,
    execute: (actionId: string) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const grant = this.grant(chatId, id);
    this.agentLease(chatId, id, generation);
    this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId: id, generation, frameId });
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      JSON.stringify(action).length > 8192 ||
      !ACTION_TYPES.includes(String((action as { type?: unknown }).type))
    )
      throw controlError("invalid_request", "Action must be a bounded GUI operation");
    // A queue cannot form when the call blocks: the agent's own turn is parked
    // here until this one is answered. What CAN arrive is a second, concurrent
    // tool call in the same assistant block, and two prompts cannot share one
    // chat's prompt slot — so refuse the second explicitly rather than let it
    // clobber the request the human is reading. (This replaces a cap of four
    // parked requests, which was reachable only because the call returned.)
    if (this.awaiting.has(chatId))
      throw controlError("queue_full", "Another GUI action in this chat is already waiting for the human. Request one action at a time.");
    const target = humanTarget(uiKind(grant.lease.kind));
    // Approval and execution share one immutable snapshot: what the human is
    // shown is what runs, even if the caller mutates its object afterwards.
    const request = structuredClone(action) as Record<string, unknown>;
    this.awaiting.add(chatId);
    let outcome: HumanApprovalOutcome;
    try {
      outcome = await this.confirmAction({ chatId, summary: describeAgentAction(request, target), target, action: request, signal: options?.signal });
    } finally {
      this.awaiting.delete(chatId);
    }
    if (!outcome.approved) {
      const refusal = REFUSALS[outcome.reason];
      throw controlError(refusal.code, refusal.message);
    }
    // Past this line the human has said yes, so every failure is one they will
    // never see: their click already returned 200 from `/respond`, and only the
    // model is told what happened next. `markConfirmedFailure` is what puts
    // those in the operator's log at error level — see {@link FailureContext}.
    try {
      const current = this.readPolicy(chatId);
      if (grant.signature !== current.signature || current.policy.computerControl === "deny")
        throw controlError("denied", "The chat's control scope changed while this action was awaiting confirmation; enable the target again");
      // Re-derives the grant: expiry, ownership, signature, generation, controller.
      this.agentLease(chatId, id, generation);
      this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId: id, generation, frameId });
      if (options?.signal?.aborted)
        throw controlError("cancelled", "The turn ended after the human confirmed but before the action ran; it was NOT performed.");
      const result = await execute(randomUUID());
      if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true)
        throw controlError("driver_error", "The approved action did not complete. Refresh session state before retrying; approval cannot be reused.");
      return result;
    } catch (error) {
      throw markConfirmedFailure(error);
    }
  }
  agentLease(chatId: string, id: string, generation: number) {
    const grant = this.grant(chatId, id);
    if (generation !== grant.lease.generation) throw controlError("stale_generation", "Observe current session state before acting");
    if (grant.lease.controller !== "agent") throw controlError("lease_conflict", "The human has control");
    return { sessionId: id, generation, leaseId: grant.lease.leaseId };
  }
  async dispose() {
    clearInterval(this.watchdog);
    this.grants.clear();
    this.pending.clear();
    this.awaiting.clear();
    for (const off of this.unsubscribers.values()) off();
    this.unsubscribers.clear();
    await this.service.dispose();
  }
}

let hostPromise: Promise<ComputerUseHost> | undefined;
export function getComputerUseHost(): Promise<ComputerUseHost> {
  return (hostPromise ??= (async () => {
    const pkg = await import("@wolpertingerlabs/computer-use");
    const drivers = {
      browser: pkg.createBrowserDriver({ network: "unrestricted", executablePath: process.env.CALLBOARD_BROWSER_EXECUTABLE }),
      desktop: pkg.createNativeDesktopDriver({
        enabled: true,
        display: process.env.CALLBOARD_NATIVE_DISPLAY ?? process.env.DISPLAY,
        acknowledgeFullDesktopAccess: true,
        permissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
      }),
    };
    const service = new pkg.ComputerUseService({
      targets: [
        { id: "managed-browser", enabled: true, driver: drivers.browser },
        { id: "native-desktop", enabled: true, driver: drivers.desktop },
      ],
      authorize: (request) => host?.authorize(request) ?? "deny",
    });
    const host: ComputerUseHost = new ComputerUseHost(service, drivers);
    return host;
  })().catch((error) => {
    hostPromise = undefined;
    throw error;
  }));
}
export async function shutdownComputerUse(): Promise<void> {
  const pending = hostPromise;
  hostPromise = undefined;
  if (pending) await (await pending).dispose();
}
