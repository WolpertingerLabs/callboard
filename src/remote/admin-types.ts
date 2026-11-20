/**
 * Response DTOs for the daemon's `/admin/*` API (served at `/api/admin/*`).
 *
 * This file is the single source of truth for these shapes. `src/remote/admin.ts`
 * imports them to annotate its handler responses, and the frontend imports them
 * (type-only) instead of maintaining a duplicate `shared` mirror.
 *
 * Type-only — compiles to nothing.
 */

// The issued credential bundle shape is shared with the issuer/importer; re-export
// it here (type-only) so the frontend can type the issue response without reaching
// into shared/ runtime modules.
export type {
  CallerBundleV1,
  BundleEncryption,
  CallerSource,
} from '../shared/protocol/caller-bundle.js';

// ── /admin/meta ──────────────────────────────────────────────────────────
export interface AdminMeta {
  version: string;
  port: number;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  configPath: string;
  callerKeysDir: string;
  serverKeysDir: string;
  envFilePath: string;
  /** Public URL of the self-managed cloudflared tunnel, when active (item C). */
  tunnelUrl: string | null;
  /** Whether the cloudflared tunnel is enabled in config (intent flag).
   *  Distinct from `tunnelUrl`, which reflects the active runtime state —
   *  the two disagree until the daemon restarts after a toggle. */
  tunnelEnabled: boolean;
}

// ── /admin/health ────────────────────────────────────────────────────────
export interface AdminIngestorCounts {
  connected: number;
  error: number;
  starting: number;
  stopped: number;
}

export interface AdminHealth {
  status: 'ok';
  activeSessions: number;
  ingestorCounts: AdminIngestorCounts;
  uptimeSec: number;
}

// ── /admin/callers ───────────────────────────────────────────────────────
export interface AdminCaller {
  alias: string;
  name: string | null;
  connections: string[];
  envKeys: string[];
  fingerprint: string | null;
  keysDirExists: boolean;
  /** How this caller's keypair was provisioned (drives the source badge).
   *  null for callers created before issuance existed. */
  source: 'local-auto' | 'bundle-issued' | null;
  /** Whether the caller's agent may run set_connection_enabled / set_secrets
   *  on itself (config `selfManage`, absent = true). */
  selfManage: boolean;
}

// ── /admin/connections ───────────────────────────────────────────────────
export type ConnectionCategory =
  | 'ai'
  | 'developer-tools'
  | 'gaming'
  | 'messaging'
  | 'productivity'
  | 'social-media'
  | 'web-search';

export interface AdminConnectionTemplate {
  alias: string;
  name: string;
  description?: string;
  docsUrl?: string;
  openApiUrl?: string;
  stability: 'stable' | 'beta' | 'dev';
  category: ConnectionCategory;
  requiredSecrets: string[];
  optionalSecrets: string[];
  hasIngestor: boolean;
  ingestorType?: 'websocket' | 'webhook' | 'poll';
  hasTestConnection: boolean;
  hasTestIngestor: boolean;
  hasListenerConfig: boolean;
  supportsMultiInstance: boolean;
  allowedEndpoints: string[];
  /** Present when drawlatch mints the token itself (names only). */
  auth?: {
    type: 'oauth2';
    grant: AdminOAuth2Grant;
    /** The template's scopes, sorted. */
    scopes: string[];
    /** jwt_bearer: unusable until a caller sets oauth2Overrides[alias].subject. */
    subjectRequired?: boolean;
  };
}

export type AdminOAuth2Grant = 'refresh_token' | 'client_credentials' | 'jwt_bearer';

/** How one caller's connection authenticates, after the caller's
 *  `oauth2Overrides`. Read-only: overrides are edited in remote.config.json. */
export interface AdminConnectionAuth {
  type: 'oauth2';
  grant: AdminOAuth2Grant;
  /** Scopes requested for this caller, sorted. */
  scopes: string[];
  /** The caller's oauth2Overrides narrowed the connection's scopes. */
  narrowed: boolean;
  /** jwt_bearer: the user the service account acts as (admin config). */
  subject?: string;
  subjectRequired?: boolean;
}

// ── /admin/callers/:alias/connection-status ──────────────────────────────
/** Per-caller status for EVERY connection template — whether the caller has it
 *  enabled, and which secrets are configured (booleans only, never values).
 *  This is the one-call payload the dashboard Connections page renders from. */
export interface AdminConnectionStatus extends AdminConnectionTemplate {
  enabled: boolean;
  requiredSecretsSet: Record<string, boolean>;
  optionalSecretsSet: Record<string, boolean>;
  /** Enabled oauth2 connections: the auth this caller actually gets. */
  callerAuth?: AdminConnectionAuth;
  /** Enabled but dropped for this caller (e.g. an invalid oauth2Overrides
   *  entry, or a subjectRequired connection without a subject). */
  problem?: string;
}

// ── /admin/callers/:alias/connections ────────────────────────────────────
export interface AdminSecretRef {
  name: string;
  present: boolean;
}

export interface AdminListenerInstance {
  instanceId: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface AdminCallerConnection {
  connectionAlias: string;
  enabled: boolean;
  isCustom: boolean;
  requiredSecrets: AdminSecretRef[];
  optionalSecrets: AdminSecretRef[];
  hasIngestor: boolean;
  instances: AdminListenerInstance[];
  /** oauth2 connections: the auth this caller gets (after oauth2Overrides). */
  auth?: AdminConnectionAuth;
  /** Why the daemon drops this connection for this caller, if it does. */
  problem?: string;
}

// ── /admin/ingestors ─────────────────────────────────────────────────────
export type IngestorState = 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'error';

export interface AdminIngestor {
  callerAlias: string;
  connection: string;
  instanceId?: string;
  type: 'websocket' | 'webhook' | 'poll';
  state: IngestorState;
  bufferedEvents: number;
  totalEventsReceived: number;
  lastEventAt: string | null;
  error?: string;
  webhookRegistration?: {
    registered: boolean;
    webhookId?: string;
    error?: string;
  };
}

// ── /admin/sessions ──────────────────────────────────────────────────────
export interface AdminSession {
  sessionIdShort: string;
  callerAlias: string;
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  windowRequests: number;
  windowStart: number;
}

// ── /admin/callers/:alias/events ─────────────────────────────────────────
/** A buffered ingestor event, as surfaced to the dashboard Logs viewer.
 *  This is the ingested payload from an external service (e.g. a Discord
 *  message) — never a drawlatch secret. */
export interface AdminEvent {
  id: number;
  idempotencyKey: string;
  receivedAt: string;
  receivedAtMs: number;
  callerAlias: string;
  source: string;
  instanceId?: string;
  eventType: string;
  data: unknown;
}

// ── /admin/secrets ───────────────────────────────────────────────────────
export interface AdminSecret {
  callerAlias: string;
  connection: string;
  name: string;
  required: boolean;
  present: boolean;
}

// ── Daemon reachability envelope ─────────────────────────────────────────
/**
 * Failure envelope the dashboard frontend synthesizes when an admin read fails
 * (401, or any other non-OK response). The daemon never sends it; see
 * frontend/src/api.ts.
 */
export interface DaemonOfflineEnvelope {
  daemon: 'down';
  error: string;
}
