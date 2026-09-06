/** Identity is supplied by an authenticated host, NEVER by tool arguments. */
export interface Principal { readonly ownerId: string; readonly actorId: string; readonly role: 'agent' | 'human' }
export type Kind = 'browser' | 'native-desktop';
export type Operation = 'probe' | 'open' | 'observe' | 'act' | 'takeover' | 'resume';
export interface AuthorizationRequest {
  readonly principal: Readonly<Principal>;
  readonly operation: Operation;
  readonly targetId: string;
  readonly kind: Kind;
  readonly sessionId?: string;
  readonly generation?: number;
}
/** ask is not approval: caller must resolve through trusted external policy then retry. */
export type AuthorizationDecision = 'allow' | 'deny' | 'ask';
export type Authorizer = (request: Readonly<AuthorizationRequest>) => AuthorizationDecision | Promise<AuthorizationDecision>;
export type ErrorCode = 'denied' | 'approval_required' | 'unsupported' | 'not_found' | 'stale_generation' | 'lease_conflict' | 'stopped' | 'revoked' | 'cancelled' | 'timeout' | 'invalid_request' | 'queue_full' | 'driver_error' | 'disposed';
export class ComputerUseError extends Error {
  constructor(public readonly code: ErrorCode, message: string = code) { super(message); this.name = 'ComputerUseError'; }
}
export interface Probe { available: boolean; kind: Kind; reason?: string; capabilities: readonly string[] }
export interface Frame {
  data: string; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number;
  /** Driver coordinates equal screenshot pixels; no implicit scaling. */
  capturedAt: number;
  url?: string;
}
export type Action =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'wait'; durationMs: number };
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
  probe(): Promise<Probe>;
  open(context: { sessionId: string; signal: AbortSignal }): Promise<DriverSession>;
}
export interface Target { readonly id: string; readonly enabled: boolean; readonly driver: Driver }
export interface ServiceOptions {
  targets?: readonly Target[];
  authorize?: Authorizer;
  actionTimeoutMs?: number;
  maxQueue?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
}
export interface SessionRef { sessionId: string; generation: number }
export interface LeaseRef extends SessionRef { leaseId: string }
export interface ActionRequest extends LeaseRef { actionId: string; action: Action }
export type SessionState = 'starting' | 'ready' | 'stopped' | 'revoked' | 'failed';
export interface SessionStatus extends SessionRef {
  targetId: string; kind: Kind; state: SessionState;
  controller: 'agent' | 'human' | 'none'; expiresAt: number;
}
export interface Lease extends SessionStatus { leaseId: string }
export interface Observation extends SessionRef { frame: Frame }
/** Audit events deliberately omit pixels, URLs, text, and input payloads. */
export interface ServiceEvent { sessionId: string; generation: number; type: 'opened' | 'observed' | 'acted' | 'takeover' | 'resumed' | 'stopped' | 'revoked' | 'failed'; at: number }
