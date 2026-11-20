/**
 * Configuration schema and loading for MCP proxy and remote server.
 *
 * Config files:
 *   - proxy.config.json  — MCP proxy (local) settings
 *   - remote.config.json — Remote server settings
 *
 * Each loader falls back to built-in defaults when its file is absent.
 *
 * Keys directory: ~/.drawlatch/keys/
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isValidOAuth2Subject, loadConnection, validateOAuth2Route } from './connections.js';
import { ownEntry } from './safe-keys.js';
import type { IngestorConfig } from '../remote/ingestors/types.js';
import type { TriggerRule } from '../remote/triggers/types.js';
import type {
  TestConnectionConfig,
  TestIngestorConfig,
  ListenerConfigSchema,
} from './listener-config.js';

// Re-export listener config types so consumers can import from config.ts
export type {
  TestConnectionConfig,
  TestIngestorConfig,
  ListenerConfigSchema,
} from './listener-config.js';
export type { ListenerConfigField, ListenerConfigOption } from './listener-config.js';

/** Resolve the base config directory at call time (not import time).
 *  Defaults to ~/.drawlatch in the user's home directory.
 *  Override with MCP_CONFIG_DIR env var for custom deployments.
 *
 *  These are functions (not constants) so that process.env.MCP_CONFIG_DIR can
 *  be set at runtime before the first call — important for hosts like
 *  callboard that configure the path after ESM imports are resolved. */
export function getConfigDir(): string {
  return process.env.MCP_CONFIG_DIR ?? path.join(os.homedir(), '.drawlatch');
}
export function getProxyConfigPath(): string {
  return path.join(getConfigDir(), 'proxy.config.json');
}
export function getRemoteConfigPath(): string {
  return path.join(getConfigDir(), 'remote.config.json');
}
export function getKeysDir(): string {
  return path.join(getConfigDir(), 'keys');
}
export function getCallerKeysDir(): string {
  return path.join(getKeysDir(), 'callers');
}
export function getServerKeysDir(): string {
  return path.join(getKeysDir(), 'server');
}
export function getEnvFilePath(): string {
  return path.join(getConfigDir(), '.env');
}

/** Category grouping for built-in connection templates.
 *  Matches the subdirectory name under src/connections/. */
export type ConnectionCategory =
  | 'ai'
  | 'developer-tools'
  | 'gaming'
  | 'messaging'
  | 'productivity'
  | 'social-media'
  | 'web-search';

/** MCP proxy (local) configuration */
export interface ProxyConfig {
  /** Remote server URL */
  remoteUrl: string;
  /** Connection timeout (ms) */
  connectTimeout: number;
  /** Deadline (ms) for the local → remote POST when a call carries no
   *  `timeoutMs` of its own. A liveness bound on the remote, not a work budget:
   *  it also determines the `outboundBudgetMs` the remote is allowed to spend
   *  (`requestTimeout - LOCAL_TIMEOUT_SLACK_MS`), so it must exceed the largest
   *  connection `requestTimeoutMs` you expect to be reachable. Clamped to
   *  MAX_LOCAL_TIMEOUT_MS. */
  requestTimeout: number;
}

/** Secrets an `awsSigV4` route signs with. Looked up by these exact keys in the
 *  route's `secrets` map, so a custom connector can point them at any env var
 *  (e.g. `"AWS_ACCESS_KEY_ID": "${PROD_AWS_ACCESS_KEY_ID}"`). */
export const AWS_SIGV4_REQUIRED_SECRETS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;
/** Optional: present only for temporary (STS) credentials. */
export const AWS_SIGV4_SESSION_TOKEN_SECRET = 'AWS_SESSION_TOKEN';
/** Every secret the signer reads. None of them is ever substituted for a `${VAR}`. */
export const AWS_SIGV4_CREDENTIAL_SECRETS: readonly string[] = [
  ...AWS_SIGV4_REQUIRED_SECRETS,
  AWS_SIGV4_SESSION_TOKEN_SECRET,
];

// ── Withheld secrets ─────────────────────────────────────────────────────────
//
// A route's secrets fall into three tiers by where a `${NAME}` placeholder for
// them may be resolved:
//
//   1. Signer-only: credentials an auth mode consumes itself (AWS SigV4 signing
//      keys). Never substituted anywhere, not even into the route's own
//      `headers`. See signerOnlySecretNames().
//   2. Withheld from callers: substituted into the route's own `headers` and
//      template-authored strings (listener configs), but never into a string
//      the caller supplies (request URL, request headers, request body).
//      See withheldSecretNames().
//   3. Substitutable: everything else. A caller may write `${NAME}` in a URL,
//      header, or (on a `resolveSecretsInBody` route) body. Trello's
//      `?key=${TRELLO_API_KEY}` and Telegram's `/bot${TELEGRAM_BOT_TOKEN}/` are
//      the built-in cases.
//
// Tier 2 exists because upstreams echo identifiers back in error messages:
// `GET /drive/v3/files/${GOOGLE_API_TOKEN}` answers `File not found: ya29…`.
// A token the route already injects through a header has no business in a URL.

/** Shape the withholding helpers read. Both `Route` and `ResolvedRoute` fit. */
interface WithholdingRouteFields {
  awsSigV4?: AwsSigV4Config;
  oauth2?: Pick<OAuth2Config, 'secretRefs'>;
  secrets?: Record<string, string>;
  /** Precomputed tier-2 names (ResolvedRoute). Absent on a raw Route. */
  withheldSecrets?: readonly string[];
}

/**
 * Tier 1: secret names only drawlatch's own auth machinery may read.
 *
 *   - AWS SigV4: the signing credentials.
 *   - OAuth2: every `secretRefs` entry (client ID, client secret, refresh
 *     token). Only the token manager reads them; the minted access token is
 *     what reaches the upstream.
 *
 * A new auth mode that consumes credentials daemon-side (signing, token
 * minting) adds its names here; everything else (header resolution, caller
 * substitution, body scrubbing, list_routes) picks them up automatically.
 */
export function signerOnlySecretNames(route: {
  awsSigV4?: AwsSigV4Config;
  oauth2?: Pick<OAuth2Config, 'secretRefs'>;
}): Set<string> {
  const names = new Set<string>();
  if (route.awsSigV4) for (const name of AWS_SIGV4_CREDENTIAL_SECRETS) names.add(name);
  if (route.oauth2) {
    for (const name of Object.values(route.oauth2.secretRefs)) {
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  return names;
}

/** `${NAME}` references in a set of strings. */
function placeholderNames(values: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/\$\{(\w+)\}/g)) names.add(match[1]);
  }
  return names;
}

/**
 * Secrets withheld because the route's own `headers` reference them, after the
 * `placeholderSecrets` escape hatch. Only this set is subject to the escape
 * hatch: it can't release a `signatureSecret`, a `withheldSecrets` entry, or a
 * signing credential.
 */
function headerOnlySecretNames(route: Route): Set<string> {
  const names = placeholderNames(Object.values(route.headers ?? {}));
  for (const name of route.placeholderSecrets ?? []) names.delete(name);
  return names;
}

/** Names withheld for reasons `placeholderSecrets` can't override. */
function alwaysWithheldSecretNames(route: Route): Set<string> {
  const names = signerOnlySecretNames(route);
  const signatureSecret = route.ingestor?.webhook?.signatureSecret;
  if (signatureSecret) names.add(signatureSecret);
  for (const name of route.withheldSecrets ?? []) names.add(name);
  return names;
}

/**
 * Tier 1 + 2: secret names a caller may not reference in a URL, request
 * header, or request body on this route. Computed from the raw `Route`
 * (before header resolution) by resolveRoutes() and carried on
 * `ResolvedRoute.withheldSecrets`.
 *
 *   - every secret the route's own `headers` reference (the route already
 *     injects it, so a caller never needs to write it), minus names in
 *     `placeholderSecrets`, the escape hatch for a connector whose API needs
 *     a header secret in the URL or body as well;
 *   - plus, regardless of `placeholderSecrets`: every signer-only secret
 *     (tier 1), the webhook ingestor's `signatureSecret` (it only verifies
 *     signatures), and every name in the route's `withheldSecrets`.
 */
export function withheldSecretNames(route: Route): Set<string> {
  const names = headerOnlySecretNames(route);
  for (const name of alwaysWithheldSecretNames(route)) names.add(name);
  // Only names the route actually defines; a header placeholder for a
  // non-secret (unresolved) name withholds nothing.
  const defined = route.secrets ?? {};
  return new Set([...names].filter((name) => name in defined));
}

type WithholdingReason = 'signer' | 'signature' | 'explicit' | 'header';

const WITHHOLDING_REASON_TEXT: Record<WithholdingReason, string> = {
  signer: 'it is a signing credential',
  signature: "it is the webhook listener's signatureSecret",
  explicit: 'it is listed in withheldSecrets',
  header: 'its headers inject it',
};

/** Why a withheld secret is withheld, most binding reason first. */
function withholdingReason(route: Route, name: string): WithholdingReason {
  if (signerOnlySecretNames(route).has(name)) return 'signer';
  if (route.ingestor?.webhook?.signatureSecret === name) return 'signature';
  if ((route.withheldSecrets ?? []).includes(name)) return 'explicit';
  return 'header';
}

/**
 * Configuration problems the withholding rules can cause in a connector, as
 * human-readable warnings naming the connector and secret. Meant for custom
 * connectors (built-in templates are checked by tests), logged once at daemon
 * startup and shown by `drawlatch doctor`.
 *
 *   - Its `description`, `name`, or `listenerConfig.description` tells agents
 *     to write `${NAME}` for a secret that is now withheld, so those requests
 *     will be rejected. placeholderSecrets is suggested only when it would
 *     help, i.e. for a secret withheld because the headers use it.
 *   - A `placeholderSecrets` entry that can't take effect: the secret is
 *     withheld for another reason (signatureSecret, withheldSecrets, signing
 *     credential), or the headers don't reference it at all.
 */
export function connectorWithholdingWarnings(route: Route): string[] {
  const label = `Connector "${route.alias ?? route.name ?? '(unnamed)'}"`;
  const warnings: string[] = [];
  const withheld = withheldSecretNames(route);
  // The same agent-facing text the built-in template audit checks.
  const agentFacing = placeholderNames([
    route.description ?? '',
    route.name ?? '',
    route.listenerConfig?.description ?? '',
  ]);
  for (const name of agentFacing) {
    if (!withheld.has(name)) continue;
    const reason = withholdingReason(route, name);
    // Only a header-derived secret can be released, so only then is
    // placeholderSecrets worth suggesting.
    const advice =
      reason === 'header'
        ? `If the API needs it in the URL or body too, add "${name}" to the connector's ` +
          'placeholderSecrets.'
        : `It can't be released with placeholderSecrets; remove the reference from the ` +
          'description.';
    warnings.push(
      `${label}: its description references \${${name}}, but that secret is withheld from ` +
        `requests (${WITHHOLDING_REASON_TEXT[reason]}), so agents that follow it will be ` +
        `rejected. ${advice}`,
    );
  }
  const always = alwaysWithheldSecretNames(route);
  const inHeaders = placeholderNames(Object.values(route.headers ?? {}));
  for (const name of route.placeholderSecrets ?? []) {
    if (always.has(name)) {
      warnings.push(
        `${label}: placeholderSecrets lists "${name}", but ` +
          `${WITHHOLDING_REASON_TEXT[withholdingReason(route, name)]}, so it stays withheld; ` +
          'remove it from placeholderSecrets.',
      );
    } else if (!inHeaders.has(name)) {
      warnings.push(
        `${label}: placeholderSecrets lists "${name}", which its headers don't reference, ` +
          'so it is substitutable already and the entry has no effect.',
      );
    }
  }
  return warnings;
}

/**
 * `secrets` minus the entries named in `withheld`, and minus any entry whose
 * value *contains* a withheld value: `WRAPPED = "pre-<secret>"` would leak it
 * just the same.
 *
 * Containment only considers withheld values of at least
 * MIN_SCRUBBED_SECRET_LENGTH characters, the same floor scrubSecrets() uses.
 * Header secrets include short non-credentials (`API_VERSION = "2"`), and
 * without a floor one would withhold every secret whose value happens to
 * contain a "2". A value that short carries no protection worth keeping, and
 * scrubbing couldn't hide it anyway.
 */
function secretsExcept(
  secrets: Record<string, string>,
  withheld: ReadonlySet<string>,
): Record<string, string> {
  if (withheld.size === 0) return secrets;
  const withheldValues = [...withheld]
    .map((name) => secrets[name])
    .filter((v): v is string => typeof v === 'string' && v.length >= MIN_SCRUBBED_SECRET_LENGTH);
  const holdsWithheld = (value: string) =>
    typeof value === 'string' && withheldValues.some((w) => value.includes(w));
  return Object.fromEntries(
    Object.entries(secrets).filter(([name, value]) => !withheld.has(name) && !holdsWithheld(value)),
  );
}

/**
 * The secrets a caller-supplied string (request URL, request headers, request
 * body) may substitute for `${VAR}` placeholders: tier 3 only.
 *
 * On a `ResolvedRoute` the tier-2 names come from `withheldSecrets`; a route
 * object without it (a hand-built one) falls back to withholding only the
 * signer-only names.
 */
export function substitutableSecrets(route: WithholdingRouteFields): Record<string, string> {
  const withheld = signerOnlySecretNames(route);
  for (const name of route.withheldSecrets ?? []) withheld.add(name);
  return secretsExcept(route.secrets ?? {}, withheld);
}

/**
 * The secrets a template-authored string may substitute: the route's own
 * `headers`, and listener (ingestor) configs. Everything except tier 1, so
 * SigV4 signing credentials still only reach the signer.
 */
export function templateSecrets(route: WithholdingRouteFields): Record<string, string> {
  return secretsExcept(route.secrets ?? {}, signerOnlySecretNames(route));
}

/**
 * The secrets withheld from callers, as a name → value map: the complement of
 * substitutableSecrets(). Used to scrub response bodies, where an upstream may
 * echo a header-injected token back.
 */
export function withheldSecretValues(route: WithholdingRouteFields): Record<string, string> {
  const secrets = route.secrets ?? {};
  const substitutable = substitutableSecrets(route);
  return Object.fromEntries(Object.entries(secrets).filter(([name]) => !(name in substitutable)));
}

/** Per-request AWS Signature Version 4 signing for a route.
 *
 *  When present, the remote signs every request it sends on this route with the
 *  route's AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN when
 *  set), after headers and body are final. The signing service and region are
 *  inferred from the request hostname (`<service>.<region>.amazonaws.com`,
 *  global `<service>.amazonaws.com` = us-east-1); set them here to override the
 *  inference, e.g. for a single-service custom connector. */
export interface AwsSigV4Config {
  /** Signing name (credential scope service), e.g. "sts", "s3", "execute-api". */
  service?: string;
  /** Signing region, e.g. "us-east-1". */
  region?: string;
}

// ── OAuth2 ──────────────────────────────────────────────────────────────────

/** Grant flows the token manager can run.
 *   - `refresh_token`: exchange a stored refresh token (user OAuth).
 *   - `client_credentials`: the client's own credentials (no user).
 *   - `jwt_bearer`: a signed JWT assertion (RFC 7523), e.g. a Google service
 *     account. RS256 only. */
export type OAuth2Grant = 'refresh_token' | 'client_credentials' | 'jwt_bearer';

/** Names (never values) of the secrets an `oauth2` route mints tokens with.
 *  Each must be a key of the route's `secrets`. All are signer-only: never
 *  substituted into any URL, header, or body, the route's own included. */
export interface OAuth2SecretRefs {
  /** Secret holding the OAuth2 client ID. Required for `refresh_token` and
   *  `client_credentials`; not used by `jwt_bearer`. */
  clientId?: string;
  /** Secret holding the OAuth2 client secret. Same grants as `clientId`. */
  clientSecret?: string;
  /** Secret holding the refresh token. Required for, and only allowed with,
   *  the `refresh_token` grant. */
  refreshToken?: string;
  /** Secret holding a Google service-account key: base64 of the JSON key file
   *  (documented form) or the JSON itself. Required for, and only allowed
   *  with, the `jwt_bearer` grant. Only the JWT signer reads it. */
  serviceAccountKey?: string;
}

/**
 * A route whose bearer token the daemon mints itself from OAuth2 client
 * credentials, instead of a static `Authorization` header. The agent never
 * sees the credentials or the minted token. Validated by
 * validateOAuth2Config() (shared/connections.ts).
 */
export interface OAuth2Config {
  /** Token endpoint. https, or http on a loopback host. For `jwt_bearer` it
   *  is also the assertion's `aud` (never the key file's `token_uri`). */
  tokenUrl: string;
  /** Grant flow used to obtain access tokens. */
  grant: OAuth2Grant;
  /** How the client credentials reach the token endpoint:
   *   - 'basic': `Authorization: Basic base64(client_id:client_secret)`
   *   - 'body':  `client_id` / `client_secret` form fields
   *  Required for `refresh_token` and `client_credentials`; not allowed with
   *  `jwt_bearer` (the signed assertion is the client authentication). */
  clientAuth?: 'basic' | 'body';
  secretRefs: OAuth2SecretRefs;
  /** Scopes to request. Sent as `scope` on every grant (the `scope` claim for
   *  `jwt_bearer`). Admin-controlled: a caller's `oauth2Overrides` can
   *  narrow them, never widen. Required for `jwt_bearer`. */
  scopes?: string[];
  /** Refuse a token whose response omits `scope`. A granted scope outside the
   *  requested set is always refused. Default: true when `scopes` is set,
   *  except for `jwt_bearer`, where the scopes are in the signed assertion and
   *  Google's response does not echo them (default false). */
  verifyGrantedScopes?: boolean;
  /** `jwt_bearer` only: the user to act as (the JWT `sub`, Google domain-wide
   *  delegation). Policy, not a secret, and admin-only: set it on a custom
   *  connector or in `CallerConfig.oauth2Overrides[alias].subject`. A
   *  template may not set it. */
  subject?: string;
  /** `jwt_bearer` only: the connection is unusable without a `subject`
   *  (e.g. Gmail, which has no mailbox of its own for a service account).
   *  A caller without one has the connection dropped at resolve time. */
  subjectRequired?: boolean;
  /** Refresh this long (ms) before the token expires.
   *  Default DEFAULT_OAUTH2_REFRESH_SKEW_MS. */
  refreshSkewMs?: number;
}

/** An `oauth2` block after the caller's override is applied. `subject` is
 *  already merged in. */
export interface ResolvedOAuth2Config extends OAuth2Config {
  /** Sorted, de-duplicated scopes sent to the token endpoint. */
  effectiveScopes: string[];
}

/** Admin-only per-caller narrowing of an `oauth2` route. No tool writes it. */
export interface OAuth2CallerOverride {
  /** Non-empty subset of the route's `oauth2.scopes`. */
  scopes?: string[];
  /** `jwt_bearer` only: the user to act as (domain-wide delegation). Replaces
   *  a custom connector's `oauth2.subject`. */
  subject?: string;
}

/** Longest (ms) one token-endpoint request may take. A request's own
 *  remaining budget can make it shorter. */
export const OAUTH2_TOKEN_TIMEOUT_MS = 10_000;
/** How long (ms) a terminal token failure (`invalid_grant`, refused scopes…)
 *  is remembered before the token endpoint is tried again with the same
 *  credentials. Changing the secret or scopes clears it. */
export const OAUTH2_TERMINAL_BACKOFF_MS = 60_000;
/** Default `refreshSkewMs`. Clamped per token to half its lifetime. */
export const DEFAULT_OAUTH2_REFRESH_SKEW_MS = 300_000;
/** Largest `refreshSkewMs` validation accepts. */
export const MAX_OAUTH2_REFRESH_SKEW_MS = 3_600_000;
/** A 401 doesn't force a new token if the current one is younger than this:
 *  an agent can make any allowlisted endpoint answer 401, and must not be
 *  able to make the daemon mint on every request. */
export const OAUTH2_MIN_REMINT_INTERVAL_MS = 30_000;
/** A rotated refresh token unused this long is forgotten (the configured one
 *  is used next), so rotated state can't grow without bound. Comparable to a
 *  daemon restart, which also forgets rotations. */
export const OAUTH2_ROTATED_TOKEN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Largest token-endpoint response body read, in bytes. */
export const OAUTH2_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

/** A single route / connector definition — scopes secrets and headers to a set of endpoints */
export interface Route {
  /** Alias for referencing this connector from caller connection lists.
   *  Required for custom connectors that callers need to reference by name. */
  alias?: string;
  /** Human-readable name for this route (e.g., "GitHub API", "Stripe Payments").
   *  Optional but recommended for discoverability by the local agent. */
  name?: string;
  /** Short description of what this route provides or what it's used for.
   *  Optional — helps the agent understand the route's purpose. */
  description?: string;
  /** URL linking to API documentation for the service behind this route.
   *  Optional — helps the agent find usage instructions. */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec (JSON or YAML) for this route's API.
   *  Optional — provides more structured, agent-friendly documentation. */
  openApiUrl?: string;
  /** Stability level of this connection: "stable", "beta", or "dev".
   *  Defaults to "dev" if omitted. Helps agents and UIs communicate
   *  whether a connection is production-ready, in testing, or experimental. */
  stability?: 'stable' | 'beta' | 'dev';
  /** Category grouping for this connection template (e.g., "ai", "messaging").
   *  Matches the subdirectory under src/connections/. Only present on built-in
   *  connection templates; custom connectors may omit it. */
  category?: ConnectionCategory;
  /** Headers to inject automatically into outgoing requests for this route.
   *  These MUST NOT conflict with client-provided headers (request is rejected on conflict).
   *  Values may contain ${VAR} placeholders resolved against this route's secrets. */
  headers?: Record<string, string>;
  /** Sign each request with AWS SigV4 instead of (or as well as) static headers.
   *  Callers may not send Authorization, Host, X-Amz-Date, X-Amz-Content-Sha256,
   *  or X-Amz-Security-Token on such a route. See AwsSigV4Config. */
  awsSigV4?: AwsSigV4Config;
  /** Mint the bearer token from OAuth2 client credentials. The route may not
   *  also set an `Authorization` header, `awsSigV4`, or `resolveSecretsInBody`.
   *  See OAuth2Config. */
  oauth2?: OAuth2Config;
  /** Secrets available for ${VAR} placeholder resolution in this route only.
   *  Values can be literals or "${ENV_VAR}" references resolved at startup. */
  secrets?: Record<string, string>;
  /** Extra secret names to withhold from caller-supplied URLs, headers, and
   *  bodies, on top of the automatic ones (every secret `headers` references,
   *  the webhook `signatureSecret`, and signing credentials). Withheld secrets
   *  still resolve in `headers` and listener configs. See withheldSecretNames(). */
  withheldSecrets?: string[];
  /** Escape hatch: secrets `headers` reference that callers may *also* write as
   *  `${NAME}` in URLs, headers, and (with `resolveSecretsInBody`) bodies,
   *  for an API that needs the same credential in both places. Anything listed
   *  here can be echoed back by the upstream, so list only what the API
   *  requires. Cannot release AWS SigV4 signing credentials. */
  placeholderSecrets?: string[];
  /** Allowlisted URL patterns (glob). A request must match at least one pattern
   *  in this route's list to use this route. Empty = matches nothing. */
  allowedEndpoints: string[];
  /** Whether to resolve ${VAR} placeholders in request bodies.
   *  Defaults to false — prevents agents from exfiltrating secrets by
   *  writing placeholder strings into API resources and reading them back. */
  resolveSecretsInBody?: boolean;
  /** Default timeout (ms) for the remote server's outbound fetch to this
   *  connection's upstream API. Omitted = DEFAULT_OUTBOUND_TIMEOUT_MS.
   *
   *  This value doubles as the **ceiling** on what a caller may request:
   *  a per-request `timeoutMs` larger than this is clamped down to it, so a
   *  connection can bound how long any single call may hold a socket open.
   *
   *  Templates are hand-written JSON, so a present-but-malformed value (a
   *  string, null, zero, negative, NaN) fails **closed** to
   *  DEFAULT_OUTBOUND_TIMEOUT_MS rather than removing the ceiling entirely.
   *  Only an absent value means "no connection ceiling".
   *
   *  Values above the MCP client's own tool timeout (60s by default) are not
   *  usable end-to-end until that outer limit is raised too — see README. */
  requestTimeoutMs?: number;
  /** Optional ingestor configuration for real-time event ingestion.
   *  When present, the remote server can start a long-lived ingestor
   *  (WebSocket, webhook listener, or poller) for this connection. */
  ingestor?: IngestorConfig;
  /** Pre-configured test request for verifying connection credentials.
   *  Must be a non-destructive, read-only endpoint with zero side effects. */
  testConnection?: TestConnectionConfig;
  /** Pre-configured test for verifying ingestor / event listener configuration.
   *  Set to null to explicitly indicate this listener cannot be tested.
   *  Omitted if the connection has no ingestor. */
  testIngestor?: TestIngestorConfig | null;
  /** Schema describing configurable fields for this connection's event listener.
   *  Used by UIs and management tools to render configuration forms.
   *  Only present on connections that have an ingestor. */
  listenerConfig?: ListenerConfigSchema;
}

/** A route after secret/header resolution — used at runtime */
export interface ResolvedRoute {
  /** Connection alias (e.g., "github", "discord-bot"). Populated during caller route resolution. */
  alias?: string;
  /** Human-readable name for this route (carried from config) */
  name?: string;
  /** Short description of this route's purpose (carried from config) */
  description?: string;
  /** Link to API documentation for the service behind this route (carried from config) */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec for this route's API (carried from config) */
  openApiUrl?: string;
  /** Stability level (carried from config) */
  stability?: 'stable' | 'beta' | 'dev';
  /** Category grouping (carried from config) */
  category?: ConnectionCategory;
  headers: Record<string, string>;
  /** AWS SigV4 signing settings (carried from config). Credentials stay in `secrets`. */
  awsSigV4?: AwsSigV4Config;
  /** OAuth2 settings (carried from config, after the caller's override).
   *  `effectiveScopes` is the sorted, de-duplicated scope list actually
   *  requested. Credentials stay in `secrets`. */
  oauth2?: ResolvedOAuth2Config;
  secrets: Record<string, string>;
  /** Names of secrets a caller may not reference in a URL, request header, or
   *  request body (tiers 1 and 2; see withheldSecretNames()). Names only. */
  withheldSecrets: string[];
  allowedEndpoints: string[];
  /** Whether to resolve ${VAR} placeholders in request bodies (default: false) */
  resolveSecretsInBody: boolean;
  /** Default + ceiling for the outbound fetch timeout in ms (carried from config).
   *  Absent = fall back to DEFAULT_OUTBOUND_TIMEOUT_MS. Deliberately carried
   *  through unvalidated: dropping a malformed value here would make it look
   *  *absent*, which means "no ceiling". `resolveOutboundTimeout` sees the raw
   *  value and fails closed on it instead. */
  requestTimeoutMs?: number;
  /** Pre-configured test request for verifying connection credentials (carried from config) */
  testConnection?: TestConnectionConfig;
  /** Pre-configured test for verifying ingestor / event listener (carried from config) */
  testIngestor?: TestIngestorConfig | null;
  /** Listener configuration schema for UI rendering (carried from config) */
  listenerConfig?: ListenerConfigSchema;
  /** Raw ingestor configuration (carried from config, needed by tool handlers) */
  ingestorConfig?: IngestorConfig;
}

/** Per-connection ingestor overrides (all fields optional — omitted fields inherit from template). */
export interface IngestorOverrides {
  /** Override the Discord Gateway intents bitmask. */
  intents?: number;
  /** Override event type filter (e.g., ["MESSAGE_CREATE"]). Empty array = capture all. */
  eventFilter?: string[];
  /** Only buffer events from these guild IDs. Omitted = all guilds. */
  guildIds?: string[];
  /** Only buffer events from these channel IDs. Omitted = all channels. */
  channelIds?: string[];
  /** Only buffer events from these user IDs. Omitted = all users. */
  userIds?: string[];
  /** Override ring buffer capacity. */
  bufferSize?: number;
  /** Disable the ingestor for this connection entirely. */
  disabled?: boolean;
  /** Override the poll interval in milliseconds (poll ingestors only). */
  intervalMs?: number;
  /** Generic parameter bag for listener configuration.
   *  Keys correspond to ListenerConfigField.key values from the connection's
   *  listenerConfig schema. Values are mapped to typed ingestor config fields
   *  during mergeIngestorConfig(). */
  params?: Record<string, unknown>;
}

/** How a caller's keypair was provisioned (drives the dashboard source badge). */
export type CallerSource = 'local-auto' | 'bundle-issued';

/** Per-caller access configuration */
export interface CallerConfig {
  /** Human-readable name for this caller (used in audit logs) */
  name?: string;
  /** How this caller's keypair was provisioned:
   *   - 'bundle-issued' — minted via the credential-issuance flow (download/CLI)
   *   - 'local-auto'    — auto-shared to a co-located callboard over the filesystem
   *  Absent for callers created before issuance existed, or added by hand. */
  source?: CallerSource;
  /** List of connection aliases — references built-in templates (e.g., "github")
   *  or custom connector aliases defined in the top-level connectors array. */
  connections: string[];
  /** Per-caller environment variable overrides.
   *  Keys = env var names that connectors reference (e.g., "GITHUB_TOKEN").
   *  Values = "${REAL_ENV_VAR}" (redirect to a different env var) or a literal string (direct injection).
   *  These are resolved first, then checked BEFORE process.env during secret resolution. */
  env?: Record<string, string>;
  /** Per-connection ingestor overrides. Keys are connection aliases (e.g., "discord-bot").
   *  Allows callers to customize intents, event filters, guild/channel/user ID filters,
   *  buffer size, or disable an ingestor without modifying the connection template. */
  ingestorOverrides?: Record<string, IngestorOverrides>;
  /** Multi-instance listener definitions keyed by connection alias.
   *  Value is a map of instanceId → IngestorOverrides.
   *  When present for a connection, spawns one ingestor per instanceId instead of
   *  a single default instance. Takes precedence over ingestorOverrides for that connection.
   *  Instance IDs must match /^[a-zA-Z0-9_-]+$/.
   *
   *  Example:
   *  ```json
   *  {
   *    "trello": {
   *      "project-board": { "params": { "boardId": "abc123" } },
   *      "sprint-board":  { "params": { "boardId": "def456" } }
   *    }
   *  }
   *  ``` */
  listenerInstances?: Record<string, Record<string, IngestorOverrides>>;
  /** Trigger rules that map ingestor events to Claude Code remote trigger invocations.
   *  When an ingestor event matches a rule's criteria (source, event type, filter),
   *  the engine dispatches the event to the configured remote trigger. */
  triggerRules?: TriggerRule[];
  /** Whether this caller's agent may change its own configuration over the
   *  encrypted channel: `set_connection_enabled` and `set_secrets`. When false,
   *  those tools refuse on the agent path and only the admin dashboard/API can
   *  make the change. Absent = true, so existing configs keep working; callers
   *  created by drawlatch (dashboard, `issue-caller`, local auto-provisioning)
   *  are written with `false`. See callerMaySelfManage(). */
  selfManage?: boolean;
  /** Per-connection narrowing of `oauth2` routes, keyed by connection alias.
   *  Admin config only: no tool reads or writes it (the dashboard does not
   *  edit it either yet). `scopes` must be a non-empty subset of the route's
   *  `oauth2.scopes`; an invalid entry drops that connection for this caller
   *  and is logged. To widen scopes, define a custom connector. */
  oauth2Overrides?: Record<string, OAuth2CallerOverride>;
}

/** Whether a caller's agent may run set_connection_enabled / set_secrets on
 *  itself. Absent means allowed, for configs written before the flag existed. */
export function callerMaySelfManage(caller: CallerConfig | undefined): boolean {
  return caller?.selfManage !== false;
}

/** Remote server configuration */
export interface RemoteServerConfig {
  /** Host to bind to */
  host: string;
  /** Port to listen on */
  port: number;
  /** Custom connector definitions — a reusable pool referenced by alias from callers.
   *  Each connector scopes secrets and headers to endpoint patterns. */
  connectors?: Route[];
  /** Per-caller access control. Keys are caller aliases (used in audit logs).
   *  Each caller specifies which connections they can use.
   *  Caller public keys are loaded from keys/callers/<alias>/. */
  callers: Record<string, CallerConfig>;
  /** Rate limit: max requests per minute per session */
  rateLimitPerMinute: number;
  /** When true, drawlatch brings up and supervises its own cloudflared quick
   *  tunnel on startup, injecting the public URL into callback-dependent
   *  connection configs before secret resolution and ingestor start (item C).
   *  Equivalent to setting DRAWLATCH_TUNNEL=1. Not a control surface — just a
   *  config flag. Default: false. */
  tunnel?: boolean;
}

// ── Nested request deadlines ─────────────────────────────────────────────────

/**
 * A proxied call passes through three nested deadlines, and they must fire
 * **innermost-first** — only the remote's outbound fetch can actually cancel
 * the upstream API call, so it has to be the layer that gives up:
 *
 *   remote → upstream    outbound deadline    <  local → remote
 *   local  → remote      requestTimeout       <  MCP client → local
 *   MCP client → local   MCP_TOOL_TIMEOUT     =  60s (MCP SDK default)
 *
 * The ordering is maintained in two directions:
 *
 *   - Downward: the local proxy sends the remote an `outboundBudgetMs` derived
 *     from the deadline it actually armed, minus LOCAL_TIMEOUT_SLACK_MS. The
 *     remote clamps every outbound fetch to that budget, so the outbound leg is
 *     always strictly smaller than the local leg regardless of what the
 *     connection's `requestTimeoutMs` says.
 *   - Upward: a caller-supplied `timeoutMs` raises the local deadline to
 *     `timeoutMs + LOCAL_TIMEOUT_SLACK_MS`, so asking for a longer upstream
 *     call widens the outer layer to match instead of being cut short by it.
 *
 * Slack is subtracted exactly once, by the layer that owns it (the local
 * proxy); the remote never learns what the slack value is.
 *
 * These live here rather than in remote/tool-dispatch.ts because both sides of
 * the proxy need them and both already import this module.
 */

/**
 * Head-room (ms) between the local → remote deadline and the outbound budget
 * handed to the remote. Covers encryption, HTTP transport, and the remote's own
 * routing work.
 */
export const LOCAL_TIMEOUT_SLACK_MS = 5_000;

/**
 * Floor (ms) for a derived outbound budget. Keeps a pathologically small local
 * `requestTimeout` from producing a zero or negative budget that would abort
 * every call instantly.
 */
export const MIN_OUTBOUND_TIMEOUT_MS = 1_000;

/**
 * Default deadline (ms) for the remote → upstream API fetch when neither the
 * caller nor the matched route specifies one. Chosen to sit below the MCP
 * client's 60s cap with room for both outer layers.
 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 25_000;

/**
 * Hard upper bound (ms) on any outbound fetch deadline.
 *
 * Deliberately below undici's 300s `headersTimeout`. Passing an
 * `AbortSignal.timeout()` to fetch() does **not** disable that internal
 * timeout — the two race, and whichever is smaller wins. An effective deadline
 * above 300s would therefore be unreachable: undici would fire first and
 * surface `UND_ERR_HEADERS_TIMEOUT` wrapped in a bare `TypeError`, bypassing
 * drawlatch's own timeout reporting. Staying under 300s keeps our signal the
 * binding one and our error message the one the caller sees.
 */
export const MAX_OUTBOUND_TIMEOUT_MS = 290_000;

/**
 * Hard upper bound (ms) on the local → remote deadline.
 *
 * Node's timers are 32-bit: a delay above 2147483647 triggers
 * `TimeoutOverflowWarning` and collapses to 1ms, and above 4294962295
 * `AbortSignal.timeout()` throws `RangeError [ERR_OUT_OF_RANGE]`. Either would
 * invert the ordering — the local leg aborting instantly while the remote's
 * fetch runs on and bills — so an absurd `requestTimeout` or `timeoutMs` is
 * clamped here instead.
 */
export const MAX_LOCAL_TIMEOUT_MS = MAX_OUTBOUND_TIMEOUT_MS + LOCAL_TIMEOUT_SLACK_MS;

// ── Daemon shutdown ──────────────────────────────────────────────────────

/** After SIGTERM/SIGINT the daemon exits on its own after this long, even if
 *  connections haven't drained. */
export const SHUTDOWN_FORCE_EXIT_MS = 10_000;
/** Longest each shutdown flush of pending audit quota markers may take. */
export const SHUTDOWN_FLUSH_MS = 2_000;
/**
 * How long `drawlatch stop`/`restart` waits before SIGKILL. Derived from the
 * daemon's own limits (forced exit, then its final bounded flush) plus slack,
 * so the CLI never kills a daemon that is still shutting down as designed.
 * SIGKILL is only for a daemon that is wedged.
 */
export const STOP_KILL_AFTER_MS = SHUTDOWN_FORCE_EXIT_MS + SHUTDOWN_FLUSH_MS + 3_000;

/**
 * Deadline (ms) for the local → remote POST.
 *
 * When the request carries a `timeoutMs`, derive the deadline from it so the
 * chain stays ordered `upstream < local < MCP client`. Otherwise fall back to
 * the configured flat `requestTimeout`, which is a liveness bound on the remote
 * rather than a work budget.
 *
 * Both branches are clamped to MAX_LOCAL_TIMEOUT_MS — see that constant for
 * what an unclamped value does to Node's 32-bit timers.
 */
export function resolveLocalTimeout(
  toolInput: Record<string, unknown>,
  config: ProxyConfig,
): number {
  const requested = toolInput.timeoutMs;
  const raw =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested + LOCAL_TIMEOUT_SLACK_MS
      : config.requestTimeout;

  // A non-finite or non-positive `requestTimeout` (hand-edited config) would
  // otherwise arm a signal that aborts instantly. Clamp up, not down.
  if (!Number.isFinite(raw) || raw <= 0) return MAX_LOCAL_TIMEOUT_MS;
  return Math.min(raw, MAX_LOCAL_TIMEOUT_MS);
}

/**
 * The outbound budget (ms) to advertise to the remote, derived from the
 * deadline the local proxy actually armed — not from `config.requestTimeout`.
 *
 * That distinction matters: sending `config.requestTimeout` unconditionally
 * would hand the remote a 25s budget for a caller who explicitly asked for
 * 120s and whose socket will in fact wait 125s, re-breaking the ordering this
 * mechanism exists to keep. Slack is subtracted exactly once, here, by the
 * layer that owns it; the remote never learns what the slack value is.
 */
export function resolveOutboundBudget(localTimeout: number): number {
  // The MIN floor keeps a pathologically small `requestTimeout` from producing a
  // zero or negative budget — but the floor itself can exceed the local deadline
  // (requestTimeout <= 1000 would yield a 1000ms budget against a <=1000ms local
  // leg), re-inverting the very ordering this module exists to maintain. Cap the
  // floor at the local deadline so the outbound leg is never the longer one.
  return Math.min(
    localTimeout,
    Math.max(MIN_OUTBOUND_TIMEOUT_MS, localTimeout - LOCAL_TIMEOUT_SLACK_MS),
  );
}

// ── Defaults ─────────────────────────────────────────────────────────────────

function proxyDefaults(): ProxyConfig {
  return {
    remoteUrl: 'http://localhost:9999',
    connectTimeout: 10_000,
    // A *liveness* bound ("is the remote wedged"), not a work budget. The
    // outbound leg is separately clamped to `requestTimeout - slack`, so a hung
    // upstream still fails at its own much smaller deadline; only a totally
    // unresponsive remote takes the long path. Set below 30s, every connection
    // ceiling above ~25s was dead on arrival by construction.
    requestTimeout: 185_000,
  };
}

function remoteDefaults(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 9999,
    callers: {},
    rateLimitPerMinute: 240,
  };
}

// ── Split config loading (preferred) ─────────────────────────────────────────

/**
 * Load the MCP proxy (local) config.
 *
 * Resolution order:
 *   1. proxy.config.json (flat ProxyConfig)
 *   2. Built-in defaults
 *
 * Key paths are derived automatically:
 *   - Caller keys: keys/callers/{MCP_KEY_ALIAS || "default"}/
 *   - Server keys: keys/server/
 */
export function loadProxyConfig(): ProxyConfig {
  const def = proxyDefaults();

  let config: ProxyConfig;

  if (fs.existsSync(getProxyConfigPath())) {
    const raw = JSON.parse(fs.readFileSync(getProxyConfigPath(), 'utf-8'));
    config = { ...def, ...raw };
  } else {
    config = def;
  }

  return config;
}

/**
 * Resolve the caller key alias for the MCP proxy.
 *
 * Resolution: MCP_KEY_ALIAS env var > "default"
 */
export function resolveCallerKeyAlias(): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentionally coerces empty string
  return process.env.MCP_KEY_ALIAS?.trim() || 'default';
}

/**
 * Load the remote server config.
 *
 * Resolution order:
 *   1. remote.config.json (flat RemoteServerConfig)
 *   2. Built-in defaults
 */
export function loadRemoteConfig(): RemoteServerConfig {
  const def = remoteDefaults();

  let config: RemoteServerConfig;

  if (fs.existsSync(getRemoteConfigPath())) {
    const raw = JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf-8'));
    config = { ...def, ...raw };
  } else {
    config = def;
  }

  return config;
}

// ── Split config saving ─────────────────────────────────────────────────────

export function saveRemoteConfig(config: RemoteServerConfig): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(getRemoteConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Per-caller route resolution ──────────────────────────────────────────

/**
 * Resolve the effective routes for a specific caller.
 *
 * For each connection name in the caller's `connections` list:
 *   1. Check custom connectors (by alias) first
 *   2. Fall back to built-in connection templates (e.g., "github", "stripe")
 *
 * Returns an array of Route objects ready for `resolveRoutes()`.
 */
export function resolveCallerRoutes(config: RemoteServerConfig, callerAlias: string): Route[] {
  const { routes, problems } = resolveCallerRoutesChecked(config, callerAlias);
  for (const problem of problems) logConfigProblemOnce(problem);
  return routes;
}

/** Config problems already logged, so a per-request re-resolve doesn't spam. */
const loggedConfigProblems = new Set<string>();
function logConfigProblemOnce(problem: string): void {
  if (loggedConfigProblems.has(problem)) return;
  loggedConfigProblems.add(problem);
  console.error(`[config] ${problem}`);
}

/**
 * resolveCallerRoutes(), also returning the problems it found. A connection
 * with an invalid `oauth2` block (custom connector) or an invalid
 * `oauth2Overrides` entry is dropped for this caller rather than crashing the
 * daemon or running with the wrong scopes.
 */
export function resolveCallerRoutesChecked(
  config: RemoteServerConfig,
  callerAlias: string,
): { routes: Route[]; problems: string[]; dropped: Record<string, string> } {
  if (!(callerAlias in config.callers)) return { routes: [], problems: [], dropped: {} };
  const caller = config.callers[callerAlias];
  const problems: string[] = [];
  /** Connection alias → why it was dropped for this caller. */
  const dropped: Record<string, string> = {};

  // Build lookup map for custom connectors by alias
  const connectorsByAlias = new Map<string, Route>();
  for (const c of config.connectors ?? []) {
    if (c.alias) connectorsByAlias.set(c.alias, c);
  }

  const overrides = caller.oauth2Overrides ?? {};
  for (const alias of Object.keys(overrides)) {
    if (!caller.connections.includes(alias)) {
      problems.push(
        `Caller "${callerAlias}": oauth2Overrides["${alias}"] names a connection this caller does not have; ignored.`,
      );
    }
  }

  const routes: Route[] = [];
  for (const name of caller.connections) {
    // Custom connectors take precedence over built-in templates
    const custom = connectorsByAlias.get(name);
    let route = custom ?? loadConnection(name);
    // Ensure every route carries its alias so it survives resolution
    if (route.alias !== name) route = { ...route, alias: name };

    try {
      // Templates are validated by loadConnection(); custom connectors here.
      if (custom && route.oauth2 !== undefined) validateOAuth2Route(route, 'connector');
      // Own-property lookup: a connection named `__proto__` or `constructor`
      // must not pick up Object.prototype as its override.
      route = applyOAuth2Override(route, ownEntry(overrides, name));
      if (route.oauth2?.subjectRequired && !route.oauth2.subject) {
        throw new Error(
          'oauth2: this connection acts as a user (subjectRequired) and no subject is set; ' +
            `add oauth2Overrides["${name}"].subject to the caller's config`,
        );
      }
    } catch (err) {
      dropped[name] = (err as Error).message;
      problems.push(`Caller "${callerAlias}": connection "${name}" dropped: ${dropped[name]}`);
      continue;
    }
    routes.push(route);
  }
  return { routes, problems, dropped };
}

/**
 * Every oauth2 problem in a remote config, across all callers. Run at daemon
 * boot so a misconfiguration shows up in the log before the first request.
 */
export function validateRemoteConfig(config: RemoteServerConfig): string[] {
  const problems: string[] = [];
  for (const alias of Object.keys(config.callers)) {
    try {
      problems.push(...resolveCallerRoutesChecked(config, alias).problems);
    } catch (err) {
      problems.push(`Caller "${alias}": ${(err as Error).message}`);
    }
  }
  // The caller logs these; don't repeat them on the next resolve.
  for (const problem of problems) loggedConfigProblems.add(problem);
  return problems;
}

/** Glob (`*` within a segment, `**` across) → anchored regex, as matchRoute uses. */
function allowlistGlobRegex(glob: string, star = '[^/]*'): RegExp {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\0')
        .replace(/\*/g, star)
        .replace(/\0/g, '.*') +
      '$',
    'i',
  );
}

/**
 * Whether two allowlist patterns can match a common URL. Hosts are compared
 * as globs; paths by their literal prefix up to the first wildcard (or by an
 * exact match when one side has none). Conservative: two wildcard hosts, or a
 * pattern without `scheme://host`, count as overlapping. Used only for the
 * boot warning; executeProxyRequest checks real URLs.
 */
export function allowlistPatternsOverlap(a: string, b: string): boolean {
  const split = (p: string) => /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(p);
  const ma = split(a);
  const mb = split(b);
  if (!ma || !mb) return true;
  if (ma[1].toLowerCase() !== mb[1].toLowerCase()) return false;
  const [hostA, hostB] = [ma[2], mb[2]];
  const hostOverlap =
    hostA.includes('*') && hostB.includes('*')
      ? true
      : hostA.includes('*')
        ? allowlistGlobRegex(hostA, '.*').test(hostB)
        : hostB.includes('*')
          ? allowlistGlobRegex(hostB, '.*').test(hostA)
          : hostA.toLowerCase() === hostB.toLowerCase();
  if (!hostOverlap) return false;
  const [pathA, pathB] = [ma[3], mb[3]];
  const wildA = pathA.includes('*');
  const wildB = pathB.includes('*');
  if (!wildA && !wildB) return pathA === pathB;
  if (!wildA) return allowlistGlobRegex(pathB).test(pathA);
  if (!wildB) return allowlistGlobRegex(pathA).test(pathB);
  const prefixA = pathA.slice(0, pathA.indexOf('*'));
  const prefixB = pathB.slice(0, pathB.indexOf('*'));
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

/**
 * Warnings for callers whose connections have overlapping allowlists. A
 * request goes to the first connection whose allowlist matches, so an overlap
 * means list order silently decides which credential is used; where an OAuth2
 * connection is involved, executeProxyRequest refuses such requests outright.
 * Paths count, not just hosts: the scoped Google templates share
 * `www.googleapis.com` (Calendar, Drive) without overlapping. Logged at
 * daemon boot.
 */
export function connectionOverlapWarnings(config: RemoteServerConfig): string[] {
  const warnings: string[] = [];
  for (const alias of Object.keys(config.callers)) {
    let routes: Route[];
    try {
      routes = resolveCallerRoutesChecked(config, alias).routes;
    } catch {
      continue; // reported by validateRemoteConfig()
    }
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const a = routes[i];
        const b = routes[j];
        let pair: [string, string] | undefined;
        // Exclusions (`!pattern`) only subtract; compare what each allows.
        const positive = (patterns: string[]) => patterns.filter((p) => !p.startsWith('!'));
        for (const pa of positive(a.allowedEndpoints)) {
          const pb = positive(b.allowedEndpoints).find((p) => allowlistPatternsOverlap(pa, p));
          if (pb !== undefined) {
            pair = [pa, pb];
            break;
          }
        }
        if (!pair) continue;
        const oauth = a.oauth2 || b.oauth2 ? ' Requests matching both are refused (OAuth2).' : '';
        warnings.push(
          `Caller "${alias}": connections "${a.alias}" and "${b.alias}" have overlapping ` +
            `allowlists ("${pair[0]}" / "${pair[1]}"); a request matching both uses whichever ` +
            `is listed first.${oauth}`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Apply a caller's override to a route's `oauth2` block: narrow its scopes,
 * set its `subject`. Throws when the override is malformed, targets a route
 * without `oauth2`, is not a non-empty subset of the route's scopes, or sets a
 * subject on a grant other than `jwt_bearer`.
 */
function applyOAuth2Override(route: Route, override: OAuth2CallerOverride | undefined): Route {
  if (override === undefined) return route;
  // Hand-edited JSON: the declared type is not a guarantee.
  const raw: unknown = override;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('oauth2Overrides entry must be an object');
  }
  for (const key of Object.keys(override)) {
    if (key !== 'scopes' && key !== 'subject') {
      throw new Error(`oauth2Overrides entry has unknown field "${key}"`);
    }
  }
  if (!route.oauth2) {
    throw new Error('oauth2Overrides is set but the connection has no oauth2 block');
  }
  if (override.subject !== undefined) {
    if (route.oauth2.grant !== 'jwt_bearer') {
      throw new Error("oauth2Overrides subject is only used by the 'jwt_bearer' grant");
    }
    if (!isValidOAuth2Subject(override.subject)) {
      throw new Error('oauth2Overrides subject must be an email address');
    }
    route = { ...route, oauth2: { ...route.oauth2, subject: override.subject } };
  }
  if (override.scopes === undefined) return route;
  const scopes: unknown = override.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((s) => typeof s === 'string' && s !== '')
  ) {
    throw new Error('oauth2Overrides scopes must be a non-empty array of strings');
  }
  const oauth2 = route.oauth2!;
  const allowed = new Set(oauth2.scopes ?? []);
  const extra = (scopes as string[]).filter((s) => !allowed.has(s));
  if (extra.length > 0) {
    throw new Error(
      `oauth2Overrides scopes may only narrow the connection's scopes; not allowed: ${extra.join(', ')}`,
    );
  }
  return { ...route, oauth2: { ...oauth2, scopes: [...new Set(scopes as string[])] } };
}

// ── Secret / placeholder resolution ──────────────────────────────────────────

/**
 * Replace ${VAR} placeholders in a string with values from a secrets map.
 * Unknown placeholders are left unchanged (with a warning).
 */
export function resolvePlaceholders(str: string, secretsMap: Record<string, string>): string {
  return str.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    if (name in secretsMap) return secretsMap[name];
    console.error(`[config] Warning: placeholder ${match} not found in secrets`);
    return match;
  });
}

/** Secret values shorter than this are neither scrubbed nor used for
 *  containment checks; see scrubSecrets(). */
export const MIN_SCRUBBED_SECRET_LENGTH = 4;

/**
 * scrubSecrets() applied to every string in a JSON-shaped value: string
 * leaves and object keys. The tree is walked rather than serialized and
 * re-parsed, so a secret containing JSON syntax can't corrupt the structure.
 * Past 64 levels of nesting the subtree comes back as scrubbed JSON text
 * rather than unscrubbed: failing open would hide a token behind deep nesting.
 */
export function scrubSecretsDeep(
  value: unknown,
  secrets: Record<string, string> | SecretScrubber,
): unknown {
  // Compile the forms once for the whole tree, not once per string: a large
  // body has hundreds of thousands of leaves.
  const scrub = typeof secrets === 'function' ? secrets : compileSecretScrubber(secrets);
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth >= 64) return scrub(JSON.stringify(v));
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, item]) => [
        scrub(k),
        walk(item, depth + 1),
      ]),
    );
  };
  return walk(value, 0);
}

/**
 * Replace every resolved secret value found in `text` with its `${NAME}`
 * placeholder.
 *
 * fetch() echoes hostile input straight back in its own error messages, and
 * what it echoes is the *resolved* form. Two reachable cases:
 *
 *   - `TypeError: Headers.append: "Bearer sk-…" is an invalid header value` —
 *     thrown verbatim when a resolved secret carries an interior CR/LF/NUL
 *     (a PEM-ish secret, or a token pasted with an embedded newline).
 *   - `TypeError: Failed to parse URL from /1/boards?key=…` — the resolved URL
 *     with query-param secrets substituted, reachable when a user-defined
 *     `allowedEndpoints` of bare `**` compiles to `^.*$` and matches a
 *     relative URL.
 *
 * Either would reach the remote's console, the client, and the model. The
 * same goes for a redirect's `Location` and the final URL reported after
 * redirects, which can echo a substituted query parameter back.
 *
 * Each secret is scrubbed as-is, in its `encodeURIComponent` form (how it
 * appears once a server or URL parser has re-encoded a query string), and in
 * its JSON-string-escaped forms (with and without `\/`). This is best-effort
 * defense in depth, not a guarantee: base64, case-folded, truncated, or
 * otherwise transformed copies are not recognised.
 *
 * Values shorter than 4 characters are skipped: they are not meaningful
 * secrets, and substring-replacing them would shred the message (a secret
 * `a` would turn every `a` in the text into a placeholder). The trade-off is
 * that a real 1–3 character secret is not scrubbed, which is acceptable
 * because such a value carries no meaningful protection anyway.
 *
 * Longest value first: when one secret is a prefix of another, replacing the
 * shorter one first leaves the remainder of the longer one exposed (secrets
 * `tok-OUT` and `tok-OUTER-VALUE` would scrub to `${INNER}ER-VALUE`).
 */
export function scrubSecrets(text: string, secrets: Record<string, string>): string {
  return compileSecretScrubber(secrets)(text);
}

/** A scrubSecrets() with its secret forms precomputed. */
export type SecretScrubber = (text: string) => string;

/**
 * Build the forms scrubSecrets() looks for once, and return a function that
 * applies them. Use it when scrubbing many strings with the same secrets (a
 * JSON tree, every event a listener buffers); the output is identical to
 * calling scrubSecrets() on each string.
 */
export function compileSecretScrubber(secrets: Record<string, string>): SecretScrubber {
  const forms: [name: string, form: string][] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || value.length < MIN_SCRUBBED_SECRET_LENGTH) continue;
    const seen = new Set<string>();
    const add = (form: string) => {
      if (seen.has(form)) return;
      seen.add(form);
      forms.push([name, form]);
    };
    add(value);
    add(encodeURIComponent(value));
    // How the value appears inside a JSON string in a body that wasn't parsed
    // (a text/plain or HTML error page quoting JSON): `"` → `\"`, control
    // characters → `\uXXXX`, and, from some encoders, `/` → `\/`.
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    add(jsonEscaped);
    add(jsonEscaped.replace(/\//g, '\\/'));
  }
  forms.sort(([, a], [, b]) => b.length - a.length);
  const replacements = forms.map(([name, form]) => [form, `\${${name}}`] as const);
  if (replacements.length === 0) return (text) => text;

  return (text) => {
    let out = text;
    for (const [form, placeholder] of replacements) {
      if (out.includes(form)) out = out.split(form).join(placeholder);
    }
    return out;
  };
}

/**
 * Load secrets from the config's secrets map, resolving from environment
 * variables. Value can be a literal string or "${VAR_NAME}" to read from env.
 *
 * Resolution order for each ${VAR} reference:
 *   1. `envOverrides[VAR]` — caller's explicit env mapping (pre-resolved)
 *   2. `process.env[PREFIX_VAR]` — prefixed env var (e.g., ALICE_GITHUB_TOKEN)
 *   3. Warning if not found (bare process.env fallback intentionally removed
 *      to prevent cross-caller secret leakage)
 *
 * When `callerAlias` is omitted, step 2 is skipped (used for resolving
 * the caller's own env mapping where prefixing doesn't apply).
 */
export function resolveSecrets(
  secretsMap: Record<string, string>,
  envOverrides?: Record<string, string>,
  callerAlias?: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(secretsMap)) {
    const envMatch = /^\$\{(.+)\}$/.exec(value);
    if (envMatch) {
      const varName = envMatch[1];
      // 1. Caller's explicit env mapping (pre-resolved values)
      let envVal = envOverrides?.[varName];
      // 2. Prefixed env var (e.g., ALICE_GITHUB_TOKEN for caller "alice" + var "GITHUB_TOKEN")
      if (envVal === undefined && callerAlias) {
        const prefix = callerAlias.toUpperCase().replace(/-/g, '_');
        envVal = process.env[`${prefix}_${varName}`];
      }
      if (envVal !== undefined) {
        resolved[key] = envVal;
      } else {
        console.error(
          `[secrets] Warning: env var ${varName} not found for key ${key}${callerAlias ? ` (caller: ${callerAlias})` : ''}`,
        );
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve all routes: resolve secrets from env vars, then resolve header
 * placeholders against each route's own resolved secrets.
 *
 * When `envOverrides` is provided, those pre-resolved values are checked
 * before process.env during secret resolution (used for per-caller env).
 *
 * When `callerAlias` is provided, prefixed env vars (e.g., ALICE_GITHUB_TOKEN)
 * are checked as a fallback before giving up on a ${VAR} reference.
 */
export function resolveRoutes(
  routes: Route[],
  envOverrides?: Record<string, string>,
  callerAlias?: string,
): ResolvedRoute[] {
  return routes.map((route) => {
    const resolvedSecrets = resolveSecrets(route.secrets ?? {}, envOverrides, callerAlias);
    // Header-only secrets resolve here, and only here. Signing credentials are
    // never substituted, so a header that references one keeps its literal
    // placeholder and executeProxyRequest rejects it.
    const headerSecrets = templateSecrets({ ...route, secrets: resolvedSecrets });
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(route.headers ?? {})) {
      resolvedHeaders[key] = resolvePlaceholders(value, headerSecrets);
    }
    return {
      ...(route.alias !== undefined && { alias: route.alias }),
      ...(route.name !== undefined && { name: route.name }),
      ...(route.description !== undefined && { description: route.description }),
      ...(route.docsUrl !== undefined && { docsUrl: route.docsUrl }),
      ...(route.openApiUrl !== undefined && { openApiUrl: route.openApiUrl }),
      ...(route.stability !== undefined && { stability: route.stability }),
      ...(route.category !== undefined && { category: route.category }),
      headers: resolvedHeaders,
      ...(route.awsSigV4 !== undefined && { awsSigV4: route.awsSigV4 }),
      ...(route.oauth2 !== undefined && {
        oauth2: {
          ...route.oauth2,
          effectiveScopes: [...new Set(route.oauth2.scopes ?? [])].sort(),
        },
      }),
      secrets: resolvedSecrets,
      withheldSecrets: [...withheldSecretNames(route)],
      allowedEndpoints: route.allowedEndpoints,
      resolveSecretsInBody: route.resolveSecretsInBody ?? false,
      ...(route.requestTimeoutMs !== undefined && { requestTimeoutMs: route.requestTimeoutMs }),
      ...(route.testConnection !== undefined && { testConnection: route.testConnection }),
      ...(route.testIngestor !== undefined && { testIngestor: route.testIngestor }),
      ...(route.listenerConfig !== undefined && { listenerConfig: route.listenerConfig }),
      ...(route.ingestor !== undefined && { ingestorConfig: route.ingestor }),
    };
  });
}
