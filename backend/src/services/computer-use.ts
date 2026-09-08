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
interface Pending {
  chatId: string;
  kind: ComputerTargetKind;
  signature: string;
  expiresAt: number;
  sessionId?: string;
  generation?: number;
  action?: unknown;
  frameId?: string;
  execute?: (id: string) => Promise<unknown>;
}

export class ComputerUseHost {
  private readonly grants = new Map<string, Grant>();
  private readonly opening = new Map<string, HostPolicy>();
  private readonly pending = new Map<string, Pending>();
  private readonly events = new Map<string, unknown[]>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly probes = new Map<ComputerTargetKind, { at: number; result: Promise<Awaited<ReturnType<Driver["probe"]>>> }>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  constructor(
    readonly service: ComputerUseService,
    readonly drivers: Readonly<Record<ComputerTargetKind, Driver>>,
    private readonly readPolicy: (chatId: string) => HostPolicy = loadComputerUsePolicy,
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
      if (pending.chatId === chatId)
        sessions.push({
          id,
          sessionId: id,
          kind: pending.kind === "browser" ? "browser" : "native",
          targetLabel: hostname(),
          target: hostname(),
          targetId: targetId(pending.kind),
          ...(pending.action
            ? {
                requestedAction: pending.action,
                requestedFrameId: pending.frameId,
                parentSessionId: pending.sessionId,
                reason: `Confirm one GUI action on session ${pending.sessionId}, frame ${pending.frameId}: ${JSON.stringify(pending.action)}. It may transmit data, change files, or execute code. Approval expires after two minutes.`,
              }
            : {
                reason:
                  "Approve access to this specific target for this chat until expiry. Screenshots are sent to the configured model when requested. Every agent action still needs a separate confirmation here, whatever the permission level. Subagents the engine runs inside this chat's turn (Claude Code Task subagents, Codex native subagents) share this grant and act under this chat's identity.",
              }),
          state: "pending_approval" as SessionStatus["state"],
          generation: 0,
          controller: null,
          expiresAt: pending.expiresAt,
        });
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
    if (pending.execute && pending.sessionId && pending.generation) {
      this.agentLease(chatId, pending.sessionId, pending.generation);
      this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId: pending.sessionId, generation: pending.generation, frameId: pending.frameId! });
      const result = await pending.execute(id);
      if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
        throw controlError("driver_error", "The approved action did not complete. Refresh session state before retrying; approval cannot be reused.");
      }
      return result;
    }
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
  async requestAgentAction(chatId: string, id: string, generation: number, frameId: string, action: unknown, execute: (id: string) => Promise<unknown>) {
    const grant = this.grant(chatId, id);
    this.agentLease(chatId, id, generation);
    this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId: id, generation, frameId });
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      JSON.stringify(action).length > 8192 ||
      !["click", "move", "drag", "scroll", "key", "type", "navigate", "wait"].includes(String((action as { type?: unknown }).type))
    )
      throw controlError("invalid_request", "Action must be a bounded GUI operation");
    if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= 4)
      throw controlError("queue_full", "Resolve existing GUI action approvals first");
    const approvalId = randomUUID();
    this.pending.set(approvalId, {
      chatId,
      kind: uiKind(grant.lease.kind),
      signature: grant.signature,
      expiresAt: Date.now() + 120_000,
      sessionId: id,
      generation,
      action: structuredClone(action),
      frameId,
      execute,
    });
    return {
      approvalRequired: true,
      approvalId,
      sessionId: id,
      instruction:
        "Wait for the human to confirm this action in the Computer Control panel, then observe the resulting state. Never repeat an unconfirmed mutation.",
    };
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
