import type {
  AdminCaller,
  AdminCallerConnection,
  AdminConnectionStatus,
  AdminConnectionTemplate,
  AdminEvent,
  AdminGoogleCatalog,
  AdminGoogleSelection,
  AdminGoogleSelectionConfig,
  AdminHealth,
  AdminIngestor,
  AdminMeta,
  AdminSecret,
  AdminSession,
  AdminVaultDecision,
  AdminVaultExposure,
  AdminVaultGrant,
  AdminVaultItemChange,
  AdminVaultItems,
  AdminVaultRequest,
  AdminVaultReveal,
  AdminVaultRevoke,
  AdminVaultStatus,
  CallerBundleV1,
  DaemonOfflineEnvelope,
} from "drawlatch-admin-types";
import { isGatewayFailure, notifyAuthRequired } from "./auth";

/**
 * What a read returns instead of data when it fails. `kind` says why:
 * - `network`: no response at all (connection refused, DNS, offline). Since
 *   the daemon serves this dashboard, this is what "daemon down" looks like.
 * - `http`: something answered with a non-2xx status (`status`); `error`
 *   carries the daemon's own message when it sent one (`fromDaemon`). A
 *   502/503/504 *without* the daemon's JSON error comes from a proxy in front
 *   of a stopped daemon, so it counts as down; the daemon's own 503s (vault
 *   key missing, no password) don't.
 * - `auth`: 401; the session is gone and the app is already showing Login.
 */
export interface DaemonDownEnvelope extends DaemonOfflineEnvelope {
  kind?: "network" | "http" | "auth";
  status?: number;
  /** The body was the daemon's own JSON error, so the daemon is running. */
  fromDaemon?: boolean;
}

export type DaemonResponse<T> = T | DaemonDownEnvelope;

/** Result of a mutating call — never an "offline" envelope; errors are explicit. */
export type MutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

export function isDaemonDown<T>(
  body: DaemonResponse<T>,
): body is DaemonDownEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as DaemonOfflineEnvelope).daemon === "down"
  );
}

/** True when a failed read means the daemon itself can't be reached. */
export function isUnreachable(body: DaemonDownEnvelope): boolean {
  if (body.kind === "network") return true;
  return (
    body.kind === "http" &&
    body.status !== undefined &&
    body.fromDaemon !== true &&
    isGatewayFailure(body.status)
  );
}

/** Fired when a request gets no response, so the daemon status is
 *  re-checked at once instead of at the next 5s poll. */
export const DAEMON_UNREACHABLE = "drawlatch:daemon-unreachable";

const UNREACHABLE_MESSAGE = "Can't reach the Drawlatch daemon. Is it running?";

function notifyUnreachable(): void {
  window.dispatchEvent(new Event(DAEMON_UNREACHABLE));
}

async function getJson<T>(path: string): Promise<DaemonResponse<T>> {
  // Never throws: every failure comes back as an envelope, so a page's
  // load() always settles and can show its error or offline state.
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch {
    notifyUnreachable();
    return { daemon: "down", kind: "network", error: UNREACHABLE_MESSAGE };
  }
  if (res.status === 401) {
    // Session expired (or missing) — boot the user back to Login.
    notifyAuthRequired();
    return { daemon: "down", kind: "auth", status: 401, error: "Not authenticated" };
  }
  if (!res.ok) {
    // Show the daemon's own message when it sent one. Admin error messages
    // name fields, limits and items, never secret or vault values.
    let message: string | undefined;
    try {
      message = ((await res.json()) as { error?: unknown }).error as
        | string
        | undefined;
    } catch {
      // empty / non-JSON body
    }
    const fromDaemon = typeof message === "string" && message !== "";
    const envelope: DaemonDownEnvelope = {
      daemon: "down",
      kind: "http",
      status: res.status,
      fromDaemon,
      error:
        typeof message === "string" && message !== ""
          ? `${message} (HTTP ${res.status})`
          : `HTTP ${res.status}`,
    };
    if (isUnreachable(envelope)) notifyUnreachable();
    return envelope;
  }
  try {
    return (await res.json()) as DaemonResponse<T>;
  } catch {
    // The connection dropped mid-body, or something that isn't the daemon
    // answered with HTML.
    return {
      daemon: "down",
      kind: "http",
      status: res.status,
      error: `Unreadable response (HTTP ${res.status})`,
    };
  }
}

async function mutate<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<MutationResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      // Vault responses are no-store on the daemon; don't let the browser
      // reuse anything either.
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    notifyUnreachable();
    return { ok: false, error: UNREACHABLE_MESSAGE };
  }
  if (res.status === 401) {
    notifyAuthRequired();
    return { ok: false, error: "Not authenticated", status: 401 };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // empty / non-JSON body
  }
  if (!res.ok) {
    const error =
      (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    if (isGatewayFailure(res.status, (parsed as { error?: unknown } | null)?.error)) {
      notifyUnreachable();
    }
    return { ok: false, error, status: res.status };
  }
  return { ok: true, data: parsed as T };
}

const enc = encodeURIComponent;

/** Fired after a grant, deny or revoke, so the nav badge refreshes at once. */
export const VAULT_REQUESTS_CHANGED = "drawlatch:vault-requests-changed";
export function notifyVaultRequestsChanged(): void {
  window.dispatchEvent(new Event(VAULT_REQUESTS_CHANGED));
}

export const api = {
  // ── Reads ────────────────────────────────────────────────────────────
  meta: () => getJson<AdminMeta>("/api/admin/meta"),
  health: () => getJson<AdminHealth>("/api/admin/health"),
  secrets: () => getJson<AdminSecret[]>("/api/admin/secrets"),
  connections: () =>
    getJson<AdminConnectionTemplate[]>("/api/admin/connections"),
  callers: () => getJson<AdminCaller[]>("/api/admin/callers"),
  callerConnections: (alias: string) =>
    getJson<AdminCallerConnection[]>(
      `/api/admin/callers/${enc(alias)}/connections`,
    ),
  connectionStatus: (alias: string) =>
    getJson<AdminConnectionStatus[]>(
      `/api/admin/callers/${enc(alias)}/connection-status`,
    ),
  ingestors: () => getJson<AdminIngestor[]>("/api/admin/ingestors"),
  callerIngestors: (alias: string) =>
    getJson<AdminIngestor[]>(`/api/admin/callers/${enc(alias)}/ingestors`),
  callerEvents: (alias: string, afterId = -1) =>
    getJson<AdminEvent[]>(
      `/api/admin/callers/${enc(alias)}/events?after_id=${afterId}`,
    ),
  sessions: () => getJson<AdminSession[]>("/api/admin/sessions"),

  // ── Vault (items) ─────────────────────────────────────────────────────
  // Only vaultReveal ever returns values. Its result belongs in the calling
  // component's state and nowhere else (no shared cache, no context).
  vaultStatus: () => getJson<AdminVaultStatus>("/api/admin/vault/status"),
  vaultItems: (alias: string) =>
    getJson<AdminVaultItems>(`/api/admin/callers/${enc(alias)}/vault/items`),
  vaultCreate: (alias: string, body: VaultItemInput) =>
    mutate<AdminVaultItemChange>(
      "POST",
      `/api/admin/callers/${enc(alias)}/vault/items`,
      body,
    ),
  /** `revision` is sent as If-Match: a stale edit fails with 409. */
  vaultUpdate: (
    alias: string,
    name: string,
    body: VaultItemPatch,
    revision?: number,
  ) =>
    mutate<AdminVaultItemChange>(
      "PATCH",
      `/api/admin/callers/${enc(alias)}/vault/items/${enc(name)}`,
      body,
      revision !== undefined ? { "if-match": String(revision) } : {},
    ),
  vaultDelete: (alias: string, name: string, revision?: number) =>
    mutate<{ deleted: string; revokedGrants: number; withdrawnRequests: number }>(
      "DELETE",
      `/api/admin/callers/${enc(alias)}/vault/items/${enc(name)}`,
      undefined,
      revision !== undefined ? { "if-match": String(revision) } : {},
    ),
  vaultReveal: (alias: string, name: string) =>
    mutate<AdminVaultReveal>(
      "POST",
      `/api/admin/callers/${enc(alias)}/vault/items/${enc(name)}/reveal`,
      {},
    ),

  // ── Vault (access requests and grants) ────────────────────────────────
  // Grant, deny and revoke exist only on the admin API: no agent tool can.
  vaultRequests: () => getJson<AdminVaultRequest[]>("/api/admin/vault/requests"),
  vaultGrant: (id: string, mode: AdminVaultExposure) =>
    mutate<AdminVaultDecision>(
      "POST",
      `/api/admin/vault/requests/${enc(id)}/grant`,
      { mode },
    ),
  vaultDeny: (id: string, note?: string) =>
    mutate<AdminVaultDecision>(
      "POST",
      `/api/admin/vault/requests/${enc(id)}/deny`,
      note ? { note } : {},
    ),
  vaultGrants: () => getJson<AdminVaultGrant[]>("/api/admin/vault/grants"),
  vaultRevoke: (id: string) =>
    mutate<AdminVaultRevoke>("DELETE", `/api/admin/vault/grants/${enc(id)}`),

  // ── Caller create / delete (item E) ───────────────────────────────────
  createCaller: (alias: string, name?: string) =>
    mutate<{ alias: string; name: string; fingerprint: string }>(
      "POST",
      "/api/admin/callers",
      { alias, ...(name ? { name } : {}) },
    ),
  deleteCaller: (alias: string) =>
    mutate<{ deleted: string }>("DELETE", `/api/admin/callers/${enc(alias)}`),

  // ── Credential issuance (caller credential bundle) ────────────────────
  // Returns the bundle ONCE (it contains the caller PRIVATE key). Re-issuing
  // mints a fresh keypair and invalidates the prior credential.
  issueCaller: (
    alias: string,
    body: {
      connections?: string[];
      endpointUrl?: string;
      passphrase?: string;
      name?: string;
    },
  ) =>
    mutate<CallerBundleV1>(
      "POST",
      `/api/admin/callers/${enc(alias)}/issue`,
      body,
    ),

  // ── Tunnel (cloudflared) config-only toggle ───────────────────────────
  // Persists `config.tunnel` to remote.config.json. The daemon reads this at
  // boot, so a restart is required for the change to take effect.
  setTunnel: (enabled: boolean) =>
    mutate<{ tunnel: boolean }>("PUT", "/api/admin/tunnel", { enabled }),

  // Whether the caller's agent may enable connections / set secrets for itself.
  setCallerSelfManage: (alias: string, enabled: boolean) =>
    mutate<{ alias: string; selfManage: boolean }>(
      "PUT",
      `/api/admin/callers/${enc(alias)}/self-manage`,
      { enabled },
    ),

  // ── Google selection (callers.<alias>.google) ─────────────────────────
  // Admin-only config: these routes write it directly, never through a tool.
  googleCatalog: () => getJson<AdminGoogleCatalog>("/api/admin/google/catalog"),
  googleSelection: (alias: string) =>
    getJson<AdminGoogleSelection>(`/api/admin/callers/${enc(alias)}/google`),
  setGoogleSelection: (alias: string, selection: AdminGoogleSelectionConfig) =>
    mutate<AdminGoogleSelection>(
      "PUT",
      `/api/admin/callers/${enc(alias)}/google`,
      selection,
    ),
  deleteGoogleSelection: (alias: string) =>
    mutate<AdminGoogleSelection>(
      "DELETE",
      `/api/admin/callers/${enc(alias)}/google`,
    ),

  // ── Connection enable / secrets / test ────────────────────────────────
  setConnectionEnabled: (
    alias: string,
    connection: string,
    enabled: boolean,
  ) =>
    mutate<{ success: boolean; connection: string; enabled: boolean }>(
      "POST",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}`,
      { enabled },
    ),
  setSecrets: (
    alias: string,
    connection: string,
    secrets: Record<string, string>,
  ) =>
    mutate<{ success: boolean; secretsSet: Record<string, boolean> }>(
      "PUT",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/secrets`,
      { secrets },
    ),
  testConnection: (alias: string, connection: string) =>
    mutate<Record<string, unknown>>(
      "POST",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/test`,
    ),
  testIngestor: (alias: string, connection: string) =>
    mutate<Record<string, unknown>>(
      "POST",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/test-ingestor`,
    ),

  // ── Listener / ingestor control ───────────────────────────────────────
  controlListener: (
    alias: string,
    connection: string,
    action: "start" | "stop" | "restart",
    instanceId?: string,
  ) =>
    mutate<Record<string, unknown>>(
      "POST",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/control`,
      { action, ...(instanceId ? { instance_id: instanceId } : {}) },
    ),
  listenerConfigs: (alias: string) =>
    getJson<ListenerConfigEntry[]>(
      `/api/admin/callers/${enc(alias)}/listener-configs`,
    ),
  getListenerParams: (alias: string, connection: string, instanceId?: string) =>
    getJson<ListenerParamsResult>(
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/params${
        instanceId ? `?instance_id=${enc(instanceId)}` : ""
      }`,
    ),
  setListenerParams: (
    alias: string,
    connection: string,
    params: Record<string, unknown>,
    opts: { instanceId?: string; createInstance?: boolean } = {},
  ) =>
    mutate<Record<string, unknown>>(
      "PUT",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/params`,
      {
        params,
        ...(opts.instanceId ? { instance_id: opts.instanceId } : {}),
        ...(opts.createInstance ? { create_instance: true } : {}),
      },
    ),
  listListenerInstances: (alias: string, connection: string) =>
    getJson<ListenerInstancesResult>(
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/instances`,
    ),
  createListenerInstance: (
    alias: string,
    connection: string,
    instanceId: string,
    params: Record<string, unknown>,
  ) =>
    mutate<Record<string, unknown>>(
      "POST",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/instances`,
      { instance_id: instanceId, params },
    ),
  deleteListenerInstance: (
    alias: string,
    connection: string,
    instanceId: string,
  ) =>
    mutate<{ success: boolean }>(
      "DELETE",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/instances/${enc(instanceId)}`,
    ),
  resolveListenerOptions: (
    alias: string,
    connection: string,
    paramKey: string,
  ) =>
    mutate<ResolveOptionsResult>(
      "POST",
      `/api/admin/callers/${enc(alias)}/connections/${enc(connection)}/listener/resolve-options`,
      { paramKey },
    ),
};

// ── Vault request bodies ────────────────────────────────────────────────

export interface VaultItemInput {
  name: string;
  kind: "password" | "token" | "note" | "key-value";
  values: Record<string, string>;
  exposure?: "inject" | "reveal";
  notes?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  connections?: string[];
}

/** `connections: null` removes the binding; `notes: null` clears notes. */
export interface VaultItemPatch {
  values?: Record<string, string>;
  rename?: string;
  exposure?: "inject" | "reveal";
  notes?: string | null;
  tags?: string[];
  metadata?: Record<string, string>;
  connections?: string[] | null;
}

// ── Listener-config response shapes (mirror tool-dispatch return shapes) ──

/** A single configurable field for a listener (mirrors ListenerConfigField). */
export interface ListenerField {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  type:
    | "text"
    | "number"
    | "boolean"
    | "select"
    | "multiselect"
    | "secret"
    | "text[]";
  default?: string | number | boolean | string[];
  options?: { value: string | number | boolean; label: string; description?: string }[];
  placeholder?: string;
  min?: number;
  max?: number;
  pattern?: string;
  dynamicOptions?: unknown;
  instanceKey?: boolean;
  group?: string;
}

export interface ListenerConfigEntry {
  connection?: string;
  name: string;
  description?: string;
  fields: ListenerField[];
  ingestorType?: "websocket" | "webhook" | "poll";
  supportsMultiInstance: boolean;
  instanceKeyField?: string;
}

export interface ListenerParamsResult {
  success: boolean;
  connection: string;
  instance_id?: string;
  params: Record<string, unknown>;
  defaults: Record<string, unknown>;
  instances?: string[];
  error?: string;
}

export interface ListenerInstancesResult {
  success: boolean;
  connection: string;
  instances: {
    instanceId: string;
    disabled: boolean;
    params: Record<string, unknown>;
  }[];
  error?: string;
}

export interface ResolveOptionsResult {
  success: boolean;
  connection?: string;
  paramKey?: string;
  options?: { value: string | number | boolean; label: string }[];
  error?: string;
}
