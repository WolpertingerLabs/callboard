/**
 * Connection template loading.
 *
 * Connections are pre-built Route templates (JSON files) that ship with
 * the package in the connections/ directory, organized into category
 * subdirectories (ai/, messaging/, social-media/, etc.).
 *
 * At runtime, templates are loaded from disk relative to this module's
 * location, so they work from both src/ (dev via tsx) and dist/ (production).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWS_SIGV4_REQUIRED_SECRETS,
  MAX_OAUTH2_REFRESH_SKEW_MS,
  type ConnectionCategory,
  type OAuth2Config,
  type OAuth2Grant,
  type Route,
} from './config.js';

/** Metadata about a built-in connection template — used by UIs to render
 *  connection cards, form fields, and badges without parsing raw JSON. */
export interface ConnectionTemplateInfo {
  /** Template alias / filename (e.g., "github", "slack"). */
  alias: string;
  /** Human-readable name (e.g., "GitHub API"). */
  name: string;
  /** Short description of the connection's purpose. */
  description?: string;
  /** Link to API documentation. */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec. */
  openApiUrl?: string;
  /** Stability level: "stable", "beta", or "dev". */
  stability: 'stable' | 'beta' | 'dev';
  /** Category grouping (e.g., "ai", "messaging", "social-media"). */
  category: ConnectionCategory;
  /** Secret names every request authenticates with — placeholders in route
   *  headers, plus AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY on an `awsSigV4`
   *  route and the `secretRefs` of an `oauth2` route — so they must always be
   *  configured. */
  requiredSecrets: string[];
  /** Secret names defined in the template but not required for auth.
   *  Used by ingestors, URL placeholders, body templates, AWS_SESSION_TOKEN, etc. */
  optionalSecrets: string[];
  /** Whether this connection has an ingestor for real-time events. */
  hasIngestor: boolean;
  /** Ingestor type, when present. */
  ingestorType?: 'websocket' | 'webhook' | 'poll';
  /** Whether this connection has a pre-configured test request. */
  hasTestConnection: boolean;
  /** Whether this connection's ingestor has a pre-configured test. */
  hasTestIngestor: boolean;
  /** Whether this connection has a listener configuration schema. */
  hasListenerConfig: boolean;
  /** Whether this connection's listener supports multiple concurrent instances
   *  (e.g., watching multiple Trello boards or Reddit subreddits simultaneously). */
  supportsMultiInstance: boolean;
  /** Allowlisted URL patterns (glob). */
  allowedEndpoints: string[];
  /** How the connection authenticates, when drawlatch mints the credential
   *  itself. Names only: no secret values. */
  auth?: { type: 'oauth2'; grant: OAuth2Grant; scopes: string[] };
}

/** Directory containing connection template JSON files. */
const CONNECTIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'connections',
);

// ── Lazy-cached alias→filepath index ──────────────────────────────────────

/** Cached alias → absolute filepath index. Built lazily on first access.
 *  Templates live in category subdirectories (connections/ai/anthropic.json). */
let connectionIndex: Map<string, string> | null = null;

/** Build the alias→filepath index by scanning CONNECTIONS_DIR.
 *  Templates live one level deep, in category subdirectories. The alias is
 *  always the filename without .json. */
function getConnectionIndex(): Map<string, string> {
  if (connectionIndex) return connectionIndex;

  connectionIndex = new Map();
  if (!fs.existsSync(CONNECTIONS_DIR)) return connectionIndex;

  const entries = fs.readdirSync(CONNECTIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Category subdirectory — scan one level deep
      const subdir = path.join(CONNECTIONS_DIR, entry.name);
      const subEntries = fs.readdirSync(subdir, 'utf-8');
      for (const subFile of subEntries) {
        if (subFile.endsWith('.json')) {
          const alias = subFile.replace(/\.json$/, '');
          connectionIndex.set(alias, path.join(subdir, subFile));
        }
      }
    }
  }

  return connectionIndex;
}

/** Invalidate the cached index. Exported for testing only. */
export function _resetConnectionIndex(): void {
  connectionIndex = null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Load a single connection template by name.
 *
 * @param name — Connection name (e.g., "github", "stripe", "trello").
 *               Must match the filename without the .json extension.
 * @returns The parsed Route object from the template.
 * @throws If the template file does not exist or contains invalid JSON.
 */
export function loadConnection(name: string): Route {
  const index = getConnectionIndex();
  const filePath = index.get(name);

  if (!filePath) {
    const available = listAvailableConnections();
    throw new Error(
      `Unknown connection "${name}". Available connections: ${available.join(', ') || '(none)'}`,
    );
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const route = JSON.parse(raw) as Route;
  if (route.oauth2 !== undefined) {
    try {
      validateOAuth2Route(route, 'template');
    } catch (err) {
      throw new Error(`Connection template "${name}": ${(err as Error).message}`);
    }
  }
  return route;
}

// ── OAuth2 validation ─────────────────────────────────────────────────────

const OAUTH2_FIELDS = new Set([
  'tokenUrl',
  'grant',
  'clientAuth',
  'secretRefs',
  'scopes',
  'verifyGrantedScopes',
  'refreshSkewMs',
]);
const OAUTH2_SECRET_REF_FIELDS = new Set(['clientId', 'clientSecret', 'refreshToken']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate an `oauth2` block on its own. Templates and custom connectors are
 * hand-written JSON, so every field is checked at runtime, and unknown fields
 * are rejected rather than ignored (a misspelt `scopes` must not silently
 * mean "no scopes").
 */
export function validateOAuth2Config(oauth2: unknown): asserts oauth2 is OAuth2Config {
  if (oauth2 === null || typeof oauth2 !== 'object' || Array.isArray(oauth2)) {
    throw new Error('oauth2 must be an object');
  }
  const raw = oauth2 as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!OAUTH2_FIELDS.has(key)) throw new Error(`oauth2: unknown field "${key}"`);
  }

  if (typeof raw.tokenUrl !== 'string' || !raw.tokenUrl) {
    throw new Error('oauth2: tokenUrl is required');
  }
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(raw.tokenUrl);
  } catch {
    throw new Error('oauth2: tokenUrl is not a valid URL');
  }
  const loopbackHttp = tokenUrl.protocol === 'http:' && LOOPBACK_HOSTS.has(tokenUrl.hostname);
  if (tokenUrl.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('oauth2: tokenUrl must be https (http only on a loopback host)');
  }
  if (tokenUrl.username || tokenUrl.password) {
    throw new Error('oauth2: tokenUrl may not contain credentials');
  }

  if (raw.grant !== 'refresh_token' && raw.grant !== 'client_credentials') {
    throw new Error(
      `oauth2: grant must be 'refresh_token' or 'client_credentials' (got ${JSON.stringify(raw.grant)})`,
    );
  }
  if (raw.clientAuth !== 'basic' && raw.clientAuth !== 'body') {
    throw new Error(
      `oauth2: clientAuth must be 'basic' or 'body' (got ${JSON.stringify(raw.clientAuth)})`,
    );
  }

  const refs = raw.secretRefs;
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    throw new Error('oauth2: secretRefs is required');
  }
  for (const [key, value] of Object.entries(refs)) {
    if (!OAUTH2_SECRET_REF_FIELDS.has(key)) {
      throw new Error(`oauth2: unknown secretRefs field "${key}"`);
    }
    if (typeof value !== 'string' || !/^\w+$/.test(value)) {
      throw new Error(`oauth2: secretRefs.${key} must be a secret name`);
    }
  }
  const { clientId, clientSecret, refreshToken } = refs as Partial<OAuth2Config['secretRefs']>;
  if (!clientId) throw new Error('oauth2: secretRefs.clientId is required');
  if (!clientSecret) throw new Error('oauth2: secretRefs.clientSecret is required');
  if (raw.grant === 'refresh_token' && !refreshToken) {
    throw new Error("oauth2: secretRefs.refreshToken is required for the 'refresh_token' grant");
  }
  if (raw.grant === 'client_credentials' && refreshToken) {
    throw new Error(
      "oauth2: secretRefs.refreshToken is not used by the 'client_credentials' grant",
    );
  }

  if (raw.scopes !== undefined) {
    if (
      !Array.isArray(raw.scopes) ||
      !raw.scopes.every((s) => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))
    ) {
      // RFC 6749 §3.3 scope-token characters: no spaces, quotes, or backslashes.
      throw new Error('oauth2: scopes must be an array of scope strings (no spaces)');
    }
  }
  if (raw.verifyGrantedScopes !== undefined) {
    if (typeof raw.verifyGrantedScopes !== 'boolean') {
      throw new Error('oauth2: verifyGrantedScopes must be a boolean');
    }
    if (raw.verifyGrantedScopes && !(raw.scopes as string[] | undefined)?.length) {
      throw new Error('oauth2: verifyGrantedScopes needs scopes to verify against');
    }
  }
  if (raw.refreshSkewMs !== undefined) {
    if (
      typeof raw.refreshSkewMs !== 'number' ||
      !Number.isFinite(raw.refreshSkewMs) ||
      raw.refreshSkewMs < 0 ||
      raw.refreshSkewMs > MAX_OAUTH2_REFRESH_SKEW_MS
    ) {
      throw new Error(
        `oauth2: refreshSkewMs must be a number from 0 to ${MAX_OAUTH2_REFRESH_SKEW_MS}`,
      );
    }
  }
}

/** Glob → regex for the host part of an allowlist pattern (`*` = any host chars). */
function hostGlobMatches(hostGlob: string, host: string): boolean {
  const re = new RegExp(
    '^' + hostGlob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*') + '$',
    'i',
  );
  return re.test(host);
}

/**
 * Validate an `oauth2` route: the block itself, plus how it combines with the
 * rest of the route.
 *
 *   - Every `secretRefs` name must be a key of `secrets`.
 *   - No `Authorization` header (the minted token is the authorization), and
 *     no header may reference an oauth2 credential.
 *   - Not combined with `awsSigV4` or `resolveSecretsInBody`.
 *   - No `allowedEndpoints` pattern may reach the token endpoint's host: the
 *     agent could otherwise call it directly.
 */
export function validateOAuth2Route(route: Route, _source: 'template' | 'connector'): void {
  validateOAuth2Config(route.oauth2);
  const oauth2 = route.oauth2;
  const secrets = route.secrets ?? {};
  const refNames = Object.values(oauth2.secretRefs).filter((n): n is string => !!n);
  for (const name of refNames) {
    if (!(name in secrets)) {
      throw new Error(`oauth2: secretRefs names "${name}", which is not in the route's secrets`);
    }
  }
  for (const [key, value] of Object.entries(route.headers ?? {})) {
    if (key.toLowerCase() === 'authorization') {
      throw new Error(
        'oauth2: the route may not set an Authorization header; the minted token is injected',
      );
    }
    for (const name of extractPlaceholderNames(value)) {
      if (refNames.includes(name)) {
        throw new Error(`oauth2: header "${key}" references the oauth2 credential \${${name}}`);
      }
    }
  }
  if (route.awsSigV4 !== undefined) {
    throw new Error('oauth2 cannot be combined with awsSigV4');
  }
  if (route.resolveSecretsInBody) {
    throw new Error('oauth2 cannot be combined with resolveSecretsInBody');
  }
  const tokenHost = new URL(oauth2.tokenUrl).host;
  for (const pattern of route.allowedEndpoints) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(pattern);
    // A pattern without a scheme://host prefix can match any host.
    if (!m || hostGlobMatches(m[1], tokenHost)) {
      throw new Error(
        `oauth2: allowedEndpoints pattern "${pattern}" can reach the token endpoint host ${tokenHost}`,
      );
    }
  }
}

/**
 * List all available connection template names.
 *
 * Scans the connections directory (including category subdirectories) for
 * .json files and returns their basenames (without extension), sorted
 * alphabetically.
 */
export function listAvailableConnections(): string[] {
  const index = getConnectionIndex();
  return [...index.keys()].sort();
}

// ── Template introspection ────────────────────────────────────────────────

/** Extract ${VAR} placeholder names from a string. */
function extractPlaceholderNames(str: string): Set<string> {
  const names = new Set<string>();
  for (const match of str.matchAll(/\$\{(\w+)\}/g)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * List all available connection templates with structured metadata.
 *
 * For each built-in template, returns its name, description, docs links,
 * secrets (categorized as required vs. optional), ingestor info, and
 * allowed endpoints.
 *
 * Secret categorization:
 *   - **required** — referenced in route `headers` values, the signing
 *     keys of an `awsSigV4` route, or the `secretRefs` of an `oauth2` route
 *     (used on every outgoing request, so they must always be configured).
 *   - **optional** — every other entry in the template's `secrets` map (used
 *     by ingestors, URL placeholders, an AWS session token, etc.).
 *
 * Used by:
 *   - the remote server's tool dispatch and boot-time health table
 *   - the admin dashboard API (src/remote/admin.ts)
 *   - the drawlatch CLI (bin/drawlatch.js)
 */
export function listConnectionTemplates(): ConnectionTemplateInfo[] {
  return listAvailableConnections().map((alias) =>
    describeConnectionTemplate(alias, loadConnection(alias)),
  );
}

/** The ConnectionTemplateInfo for one template. Exported for tests. */
export function describeConnectionTemplate(alias: string, route: Route): ConnectionTemplateInfo {
  // Collect secret names every request authenticates with: placeholders in
  // header values, plus the signing keys of an awsSigV4 route
  const authSecretNames = new Set<string>();
  for (const value of Object.values(route.headers ?? {})) {
    for (const name of extractPlaceholderNames(value)) {
      authSecretNames.add(name);
    }
  }
  if (route.awsSigV4) {
    for (const name of AWS_SIGV4_REQUIRED_SECRETS) authSecretNames.add(name);
  }
  if (route.oauth2) {
    for (const name of Object.values(route.oauth2.secretRefs)) {
      if (name) authSecretNames.add(name);
    }
  }

  // Partition secrets into required (used for auth) vs optional (elsewhere)
  const allSecretNames = Object.keys(route.secrets ?? {});
  const requiredSecrets = allSecretNames.filter((s) => authSecretNames.has(s));
  const optionalSecrets = allSecretNames.filter((s) => !authSecretNames.has(s));

  return {
    alias,
    name: route.name ?? alias,
    ...(route.description !== undefined && { description: route.description }),
    ...(route.docsUrl !== undefined && { docsUrl: route.docsUrl }),
    ...(route.openApiUrl !== undefined && { openApiUrl: route.openApiUrl }),
    stability: route.stability ?? 'dev',
    category: route.category!,
    requiredSecrets,
    optionalSecrets,
    hasIngestor: route.ingestor !== undefined,
    ...(route.ingestor !== undefined && { ingestorType: route.ingestor.type }),
    hasTestConnection: route.testConnection !== undefined,
    hasTestIngestor: route.testIngestor !== undefined && route.testIngestor !== null,
    hasListenerConfig: route.listenerConfig !== undefined,
    supportsMultiInstance: route.listenerConfig?.supportsMultiInstance ?? false,
    allowedEndpoints: route.allowedEndpoints,
    ...(route.oauth2 !== undefined && {
      auth: {
        type: 'oauth2' as const,
        grant: route.oauth2.grant,
        scopes: [...new Set(route.oauth2.scopes ?? [])].sort(),
      },
    }),
  };
}
