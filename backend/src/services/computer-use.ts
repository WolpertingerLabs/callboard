/** Thin Callboard host: policy, human grants and presentation. Drivers live in the independent package. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Action, AuthorizationRequest, ComputerUseService, Driver, Lease, Principal, SessionStatus } from "@wolpertingerlabs/computer-use";
import { chatFileService } from "./chat-file-service.js";
import { computerUseScopeError, readComputerUsePolicy, type ComputerTargetKind, type ComputerUsePolicy } from "./computer-use-policy.js";

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
  const policy = readComputerUsePolicy(metadata.defaultPermissions);
  return { policy, signature: JSON.stringify([policy, metadata.provider, metadata.model, metadata.acpProviderId]) };
}
export function controlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export const controlPrincipal = (chatId: string, role: "agent" | "human"): Principal => ({ ownerId: chatId, actorId: `${role}:${chatId}`, role });
const uiKind = (kind: string): ComputerTargetKind => (kind === "browser" ? "browser" : "desktop");
const targetId = (kind: ComputerTargetKind) => (kind === "browser" ? "managed-browser" : "native-desktop");
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
  execute?: (id: string) => Promise<unknown>;
}

export class ComputerUseHost {
  private readonly grants = new Map<string, Grant>();
  private readonly opening = new Map<string, HostPolicy>();
  private readonly pending = new Map<string, Pending>();
  private readonly events = new Map<string, unknown[]>();
  private readonly unsubscribers = new Map<string, () => void>();
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
          const probe = await this.drivers[kind].probe();
          return { ...probe, kind: kind === "browser" ? "browser" : "native", available: probe.available && !restriction, reason: restriction ?? probe.reason };
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
                parentSessionId: pending.sessionId,
                reason: `Confirm one GUI action on session ${pending.sessionId}: ${JSON.stringify(pending.action)}. It may transmit data, change files, or execute code. Approval expires after two minutes.`,
              }
            : { reason: "Approve access to this specific target for this chat until expiry. Screenshots are sent to the configured model when requested." }),
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
  async action(chatId: string, id: string, action: unknown, generation: unknown) {
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
    grant.lease = await this.service.resume(controlPrincipal(chatId, "human"), {
      sessionId: id,
      generation: grant.lease.generation,
      leaseId: grant.lease.leaseId,
    });
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
  async requestAgentAction(chatId: string, id: string, generation: number, action: unknown, execute: (id: string) => Promise<unknown>) {
    const grant = this.grant(chatId, id);
    this.agentLease(chatId, id, generation);
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
      action,
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
