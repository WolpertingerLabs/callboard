/** Identity is supplied by an authenticated host, NEVER by tool arguments. */
export interface Principal {
  readonly ownerId: string;
  readonly actorId: string;
  readonly role: "agent" | "human";
}
export type Kind = "browser" | "native-desktop";
export type Operation = "probe" | "open" | "observe" | "act" | "takeover" | "resume";
export interface AuthorizationRequest {
  readonly principal: Readonly<Principal>;
  readonly operation: Operation;
  readonly targetId: string;
  readonly kind: Kind;
  readonly sessionId?: string;
  readonly generation?: number;
}
/** ask is not approval: caller must resolve through trusted external policy then retry. */
export type AuthorizationDecision = "allow" | "deny" | "ask";
export type Authorizer = (request: Readonly<AuthorizationRequest>) => AuthorizationDecision | Promise<AuthorizationDecision>;
export type ErrorCode =
  | "denied"
  | "approval_required"
  | "unsupported"
  | "not_found"
  | "stale_frame"
  | "stale_generation"
  | "lease_conflict"
  | "stopped"
  | "revoked"
  | "cancelled"
  | "timeout"
  | "invalid_request"
  | "queue_full"
  | "driver_error"
  | "disposed";
export class ComputerUseError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}
export interface Probe {
  available: boolean;
  kind: Kind;
  /** Model-visible: safe for any principal, so it never names host paths or environment. */
  reason?: string;
  /**
   * Operator-only diagnostics (resolved host paths and layout) for a trusted
   * control plane. `getToolDefinitions` strips this before any MCP result, so
   * only an embedder holding the Probe itself may display it.
   */
  operatorDetail?: string;
  /** Optional host-fact classification; missing/unknown values require generic guidance. */
  readiness?: "setup-required" | "unsupported" | "permission-blocked" | "unknown";
  capabilities: readonly string[];
}
export interface Frame {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Driver coordinates equal screenshot pixels; no implicit scaling. */
  capturedAt: number;
  url?: string;
}
export type Action =
  | { type: "click"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: "scroll"; deltaX: number; deltaY: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "navigate"; url: string }
  | { type: "wait"; durationMs: number };
export interface DriverSession {
  observe(signal: AbortSignal): Promise<Frame>;
  act(action: Action, signal: AbortSignal): Promise<void>;
  /** MUST release owned input on abort; must not kill pre-existing native apps. */
  releaseInput(): Promise<void>;
  close(): Promise<void>;
}
export interface Driver {
  readonly kind: Kind;
  /** Shared native input MUST share a lock domain, including across driver instances. */
  readonly lockDomain?: string;
  /**
   * `"driver"` (the default): every session of this driver shares its one
   * `lockDomain`, so only one is open at a time. `"session"`: each `open`
   * gets an input device of its own (a fresh container per session, say), so
   * the lock is `lockDomain` plus the session id and sessions never contend.
   * Only a driver that really gives each session its own device may say so.
   */
  readonly lockScope?: "driver" | "session";
  probe(): Promise<Probe>;
  open(context: {
    sessionId: string;
    /**
     * The session owner's `ownerId`, for a driver that labels what it creates
     * per session. Metadata only: a driver must never authorize by it.
     */
    ownerId?: string;
    signal: AbortSignal;
    onTargetChanged?: () => void;
    /**
     * The driver lost its target out of band (a remote driver's connection
     * dropped). The service fences the session `failed` and cleans it up at
     * once instead of waiting for the next call to fail. Optional to call.
     */
    onLost?: () => void;
    /**
     * The host's opaque per-session selector ({@link OpenOptions.variant}),
     * e.g. which image a container-per-session driver starts. The service
     * validates its grammar and passes it through; it means nothing to the
     * service. A driver that does not support variants should refuse one.
     */
    variant?: string;
  }): Promise<DriverSession>;
}
export interface Target {
  readonly id: string;
  readonly enabled: boolean;
  readonly driver: Driver;
}
export interface ServiceOptions {
  targets?: readonly Target[];
  authorize?: Authorizer;
  actionTimeoutMs?: number;
  maxQueue?: number;
  /** The absolute session TTL, unless an `open` asks for its own ({@link OpenOptions.ttlMs}). Default 15 minutes, at most 2 hours. */
  sessionTtlMs?: number;
  /**
   * The longest per-session TTL an `open` may ask for. Default: `sessionTtlMs`
   * (so a host must opt in to longer sessions); at most 24 hours.
   */
  maxSessionTtlMs?: number;
  maxSessions?: number;
  /** How long a stopped/failed/revoked session stays listed in status after cleanup. Default 60s. */
  terminalRetentionMs?: number;
}
/** Per-session options of `ComputerUseService.open`, set by the host, never by a model. */
export interface OpenOptions {
  /**
   * This session's absolute TTL, from 1 second to `maxSessionTtlMs`. Default
   * `sessionTtlMs`. Out of range is `invalid_request`, never clamped.
   */
  ttlMs?: number;
  /**
   * An opaque selector passed to the driver's `open` (`variant`) and shown in
   * status: 1–128 characters of `[A-Za-z0-9._@:-]`, starting with a letter or
   * digit. Callboard uses it for a Sandbox desktop profile (`blender@<digest>`).
   */
  variant?: string;
}
export interface SessionRef {
  sessionId: string;
  generation: number;
}
export interface LeaseRef extends SessionRef {
  leaseId: string;
}
export interface ActionRequest extends LeaseRef {
  /** Exact observation token; single-use and invalid after newer captures or known target changes. */
  frameId: string;
  actionId: string;
  action: Action;
}
export type SessionState = "starting" | "ready" | "stopped" | "revoked" | "failed";
export interface SessionStatus extends SessionRef {
  targetId: string;
  kind: Kind;
  state: SessionState;
  controller: "agent" | "human" | "none";
  expiresAt: number;
  /** The session's {@link OpenOptions.variant}, when it was opened with one. */
  variant?: string;
}
export interface Lease extends SessionStatus {
  leaseId: string;
}
export interface Observation extends SessionRef {
  /** Metadata paired with these pixels, never inferred from the control generation. */
  frameId: string;
  frame: Frame;
}
/** Audit events deliberately omit pixels, URLs, text, and input payloads. */
export interface ServiceEvent {
  sessionId: string;
  generation: number;
  type: "opened" | "observed" | "acted" | "takeover" | "resumed" | "stopped" | "revoked" | "failed";
  at: number;
}
