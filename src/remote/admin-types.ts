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
  /** Items in the caller's vault; null when the vault can't be read. */
  vaultItems: number | null;
  /** Set when the caller's config can't be resolved at all (e.g. a connection
   *  name that is neither a template nor a connector): its handshakes fail. */
  configProblem?: string;
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
  /** Set on a base composed per caller (`google`: from callers.<alias>.google).
   *  It has no fixed `auth`; a caller's own is `callerAuth`. */
  composed?: 'google';
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
  /** The `google` connection: the caller's selection (callers.<alias>.google),
   *  services in catalog order. The subject, if any, is `subject` above. */
  google?: { auth: AdminGoogleAuthMode; services: Record<string, string> };
}

// ── /admin/callers/:alias/connection-status ──────────────────────────────
/** Per-caller status for EVERY connection template — whether the caller has it
 *  enabled, and which secrets are configured (booleans only, never values).
 *  This is the one-call payload the dashboard Connections page renders from. */
export interface AdminConnectionStatus extends AdminConnectionTemplate {
  /** `requiredSecrets` / `optionalSecrets` are this caller's: for `google`,
   *  those of the auth mode it selects (user OAuth when it has none). */
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

// ── /admin/vault/* and /admin/callers/:alias/vault/* ────────────────────
export type AdminVaultKind = 'password' | 'token' | 'note' | 'key-value';
export type AdminVaultExposure = 'inject' | 'reveal';

/** GET /vault/status. Never the key: only its public fingerprint. */
export interface AdminVaultStatus {
  keyPresent: boolean;
  keyId: string | null;
  fileExists: boolean;
  revision: number | null;
  /** Item count per caller that has any vault data. */
  callers: Record<string, number>;
  pendingRequests: number;
  /** Why the vault can't be read, when it can't. */
  error?: string;
}

/** Who an item is shared with (an active grant). */
export interface AdminVaultItemGrant {
  grantee: string;
  /** The mode granted. */
  mode: AdminVaultExposure;
  /** What it allows now: min(mode, the item's exposure). */
  effectiveMode: AdminVaultExposure;
}

/** An item's metadata: everything but its values, plus the field names. */
export interface AdminVaultItem {
  id: string;
  name: string;
  kind: AdminVaultKind;
  exposure: AdminVaultExposure;
  notes?: string;
  tags: string[];
  metadata: Record<string, string>;
  /** Connections the item may be used on; absent = any of the caller's. */
  connections?: string[];
  createdBy: 'agent' | 'admin';
  createdAt: string;
  updatedAt: string;
  valueUpdatedAt: string;
  /** Field names only. */
  fields: string[];
}

/** GET /callers/:alias/vault/items. `revision` is what `If-Match` takes. */
export interface AdminVaultItems {
  revision: number;
  items: (AdminVaultItem & { grants: AdminVaultItemGrant[] })[];
}

/** POST/PATCH /callers/:alias/vault/items[/:name]. */
export interface AdminVaultItemChange {
  item: AdminVaultItem;
}

/** POST /callers/:alias/vault/items/:name/reveal. The only response with values. */
export type AdminVaultReveal =
  | { name: string; owner: string; kind: AdminVaultKind; values: Record<string, string> }
  | { name: string; owner: string; kind: AdminVaultKind; field: string; value: string };

export type AdminVaultRequestStatus = 'pending' | 'granted' | 'denied' | 'cancelled' | 'withdrawn';

/** An item as it is now, for a request or grant row. Null: no such item (any more). */
export interface AdminVaultItemRef {
  name: string;
  kind: AdminVaultKind;
  exposure: AdminVaultExposure;
  /** Connections the item may be used on; absent = any the grantee has enabled. */
  connections?: string[];
}

/** GET /vault/requests. `reason` is agent-written text. */
export interface AdminVaultRequest {
  id: string;
  requester: string;
  owner: string;
  /** The name as asked. */
  itemName: string;
  /** Null: the owner had no such item when it was asked; it can only be denied. */
  itemId: string | null;
  mode: AdminVaultExposure;
  /** Written by the requesting agent, not by the owner. Render as plain text. */
  reason: string;
  status: AdminVaultRequestStatus;
  createdAt: string;
  decidedAt?: string;
  decidedNote?: string;
  grantId?: string;
  item: AdminVaultItemRef | null;
}

/** GET /vault/grants. */
export interface AdminVaultGrant {
  id: string;
  owner: string;
  itemId: string;
  grantee: string;
  mode: AdminVaultExposure;
  status: 'active' | 'revoked';
  requestId?: string;
  grantedAt: string;
  revokedAt?: string;
  revokedReason?: 'admin' | 'item_deleted' | 'caller_deleted';
  item: AdminVaultItemRef | null;
  /** min(mode, item exposure) for an active grant; null once revoked or the item is gone. */
  effectiveMode: AdminVaultExposure | null;
}

/** POST /vault/requests/:id/grant and …/deny. `grant` only on a grant. */
export interface AdminVaultDecision {
  request: Omit<AdminVaultRequest, 'item'>;
  grant?: Omit<AdminVaultGrant, 'item' | 'effectiveMode'>;
}

/** DELETE /vault/grants/:id. `changed: false` when it was already revoked. */
export interface AdminVaultRevoke {
  grant: Omit<AdminVaultGrant, 'item' | 'effectiveMode'>;
  changed: boolean;
}

// ── /admin/google/catalog, /admin/callers/:alias/google ──────────────────
// src/remote/admin-google.ts. The selection is admin-only config: no tool
// reads or writes it.

export type AdminGoogleAuthMode = 'user' | 'service-account';

/** GET /google/catalog: what the dashboard editor renders. Names, levels,
 *  scopes and summaries only; no allowlists or test requests. */
export interface AdminGoogleCatalog {
  /** Each auth mode and the credential names it reads, in catalog order. */
  authModes: { id: AdminGoogleAuthMode; secrets: string[] }[];
  services: {
    id: 'gmail' | 'calendar' | 'drive' | 'sheets' | 'docs' | 'slides';
    name: string;
    docsUrl: string;
    /** The API's name in the Cloud console's API library. */
    enableApi: string;
    levels: {
      id: string;
      summary: string;
      scopes: string[];
      auth: AdminGoogleAuthMode[];
      /** Service-account mode only: the level needs a subject. */
      subjectRequired?: true;
    }[];
  }[];
  crossScopeNotes: { when: Record<string, string>; text: string }[];
}

/** A caller's `google` block, as stored (services in catalog order). */
export interface AdminGoogleSelectionConfig {
  auth: AdminGoogleAuthMode;
  services: Record<string, string>;
  subject?: string;
}

/** GET/PUT/DELETE /callers/:alias/google. */
export interface AdminGoogleSelection {
  /** `google` is in the caller's connections. */
  enabled: boolean;
  /** The valid selection, or null when there is none or it is invalid. */
  selection: AdminGoogleSelectionConfig | null;
  /** Sorted union of the selection's scopes: what the refresh token (user
   *  mode) or the domain-wide delegation entry (service account) must cover. */
  consentScopes: string[];
  /** Why the connection is dropped (enabled), or why the stored block is
   *  invalid (either way). */
  problem?: string;
  /** Cross-service scope notes that apply to the selection. */
  notes: string[];
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
