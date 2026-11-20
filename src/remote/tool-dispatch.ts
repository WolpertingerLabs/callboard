/**
 * Canonical MCP tool implementations — the single source of truth.
 *
 * These handlers implement every proxy/management tool drawlatch exposes:
 *   http_request, list_routes, poll_events, wait_for_events, ingest_logs,
 *   ingestor_status,
 *   test_connection, test_ingestor, control_listener,
 *   list_listener_configs, resolve_listener_options,
 *   get/set_listener_params, list/delete_listener_instance,
 *   list_connection_templates, set_connection_enabled,
 *   set_secrets, get_secret_status.
 *
 * Consumed by:
 *   - The remote secure server's `/request` dispatch (src/remote/server.ts)
 *   - The password-gated admin API (src/remote/admin-mutations.ts)
 *
 * Pure in the sense that handlers take `routes` + `context` as input rather
 * than reading global session state. The only side effects are the outbound
 * fetch() and config/.env writes (which mirror what the live daemon does).
 */

import {
  callerMaySelfManage,
  loadRemoteConfig,
  saveRemoteConfig,
  resolvePlaceholders,
  scrubSecrets,
  scrubSecretsDeep,
  compileSecretScrubber,
  signerOnlySecretNames,
  substitutableSecrets,
  templateSecrets,
  withheldSecretValues,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  MAX_OUTBOUND_TIMEOUT_MS,
  OAUTH2_TOKEN_TIMEOUT_MS,
  type CallerConfig,
  type IngestorOverrides,
  type ResolvedRoute,
} from '../shared/config.js';
import { listConnectionTemplates } from '../shared/connections.js';
import { assertSafeConnectionKey, assertSafeInstanceId, ownEntry } from '../shared/safe-keys.js';
import { isSecretSetForCaller, setCallerSecrets } from '../shared/env-utils.js';
import {
  SIGV4_RESERVED_HEADERS,
  SIGV4_RESERVED_QUERY_PARAMS,
  signProxyRequest,
} from './aws-sigv4.js';
import { ingestLogs } from './audit-log.js';
import {
  OAUTH2_ACCESS_TOKEN_PLACEHOLDER,
  OAUTH2_RESERVED_HEADERS,
  OAUTH2_RESERVED_QUERY_PARAMS,
  isOAuth2Route,
  oauth2Authorize,
  type OAuth2AuthResult,
  type OAuth2Route,
} from './oauth/authenticate.js';
import type { IngestorManager } from './ingestors/index.js';
import { safeFetch } from './safe-fetch.js';
import { assertNoControlChars, isEndpointAllowed, normalizeOutboundUrl } from './url-policy.js';
import { waitForEvents } from './wait-for-events.js';

// ── Endpoint matching ────────────────────────────────────────────────────────

// The URL policy lives in url-policy.ts (the poll ingestor shares it).
export { isEndpointAllowed, normalizeOutboundUrl, pathHasDotSegment } from './url-policy.js';

/**
 * Find the first route whose allowedEndpoints match the given URL.
 * Routes with empty allowedEndpoints match nothing.
 */
export function matchRoute(url: string, routes: ResolvedRoute[]): ResolvedRoute | null {
  for (const route of routes) {
    if (route.allowedEndpoints.length > 0 && isEndpointAllowed(url, route.allowedEndpoints)) {
      return route;
    }
  }
  return null;
}

// ── Outbound timeouts ──────────────────────────────────────────────────────

/**
 * The outbound (remote → upstream) half of drawlatch's nested deadline chain.
 * The constants themselves live in shared/config.ts, which both sides of the
 * proxy import; see the block comment there for the ordering invariant.
 *
 * Re-exported here because this module is where callers reach when they reason
 * about the outbound leg.
 */
export { DEFAULT_OUTBOUND_TIMEOUT_MS, MAX_OUTBOUND_TIMEOUT_MS } from '../shared/config.js';

/** True only for a finite, strictly positive number (rejects 0, NaN, Infinity). */
function isUsableTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the connection's outbound ceiling in milliseconds — the deadline the
 * matched route permits, before the local proxy's own budget is applied.
 *
 * Precedence:
 *   1. `requested` — the caller's per-request `timeoutMs`, clamped to the
 *      route's `requestTimeoutMs` when the route sets one, otherwise to
 *      MAX_OUTBOUND_TIMEOUT_MS.
 *   2. `routeTimeout` — the connection's own default (itself clamped to
 *      MAX_OUTBOUND_TIMEOUT_MS).
 *   3. DEFAULT_OUTBOUND_TIMEOUT_MS.
 *
 * The two levels treat malformed input differently, on purpose:
 *
 *   - A malformed `requested` (0, negative, NaN, Infinity, non-number) means
 *     "not specified" and degrades to the next fallback.
 *   - A malformed `routeTimeout` fails **closed** to
 *     DEFAULT_OUTBOUND_TIMEOUT_MS. Route templates are hand-written JSON, so
 *     `"requestTimeoutMs": "45000"` is a plausible typo; treating it as absent
 *     would *remove* the connection's ceiling and jump straight to
 *     MAX_OUTBOUND_TIMEOUT_MS — silently widening the very bound the template
 *     author was trying to impose. Only `undefined` means "no ceiling set".
 */
export function resolveOutboundTimeout(requested: unknown, routeTimeout: unknown): number {
  let routeCeiling: number | undefined;
  if (routeTimeout === undefined) {
    routeCeiling = undefined;
  } else if (isUsableTimeout(routeTimeout)) {
    routeCeiling = Math.min(routeTimeout, MAX_OUTBOUND_TIMEOUT_MS);
  } else {
    routeCeiling = DEFAULT_OUTBOUND_TIMEOUT_MS;
  }

  if (!isUsableTimeout(requested)) {
    return routeCeiling ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  }

  return Math.min(requested, routeCeiling ?? MAX_OUTBOUND_TIMEOUT_MS);
}

/**
 * Apply the local proxy's outbound budget on top of the connection ceiling.
 *
 * `budgetMs` is the window the local proxy actually armed its own socket for,
 * minus its slack — see `outboundBudgetMs` on ProxyRequest. An **absent** or
 * malformed budget means "no clamp", never zero: two real callers arrive
 * without one (the password-gated admin API, and an older local proxy talking
 * to a newer remote). Guarded explicitly rather than with `??` because
 * `Math.min(ceiling, undefined - slack)` is silently NaN, which
 * `AbortSignal.timeout()` then rejects outright.
 */
export function applyOutboundBudget(ceiling: number, budgetMs: unknown): number {
  return isUsableTimeout(budgetMs) ? Math.min(ceiling, budgetMs) : ceiling;
}

/** Why an outbound fetch failed, when the failure was a deadline of some kind. */
type TimeoutKind =
  /** Our own AbortSignal fired — the deadline drawlatch armed. */
  | 'deadline'
  /** undici gave up before the upstream accepted the TCP/TLS connection. */
  | 'connect'
  /** undici's own headers/body timeout fired before ours did. */
  | 'upstream-stalled';

/**
 * Classify an abort/timeout rejection from fetch().
 *
 * Node surfaces our own `AbortSignal.timeout()` as a DOMException named
 * "TimeoutError" (or "AbortError"), sometimes re-wrapped in a TypeError whose
 * `cause` carries the original. undici's *internal* deadlines are different
 * animals: they arrive as a bare `TypeError: fetch failed` / `TypeError:
 * terminated` whose cause carries a `UND_ERR_*_TIMEOUT` code, and a plain
 * name check returns false for them, so they escape the timeout handler
 * entirely. undici's default `connectTimeout` is 10s — below our own 25s
 * default — so this is not a corner case.
 *
 * "The upstream never accepted our connection" is a different failure from
 * "our deadline fired", and the caller needs to tell them apart, so they get
 * distinct messages.
 */
function classifyTimeout(err: unknown): TimeoutKind | null {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    const code: unknown = (e as { code?: unknown }).code;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'deadline';
    if (e.name === 'ConnectTimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'connect';
    if (
      e.name === 'HeadersTimeoutError' ||
      e.name === 'BodyTimeoutError' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return 'upstream-stalled';
    }
  }
  return null;
}

// ── Secret hygiene in error messages ───────────────────────────────────────

/**
 * Whether any message in an error's `cause` chain carries a resolved secret.
 *
 * Checked separately from scrubbing because a clean top-level message can sit
 * above a leaking cause — `TypeError: fetch failed` is undici's usual wrapper.
 * Depth-capped and cycle-safe: `err.cause = err` is a legal construction.
 */
function leaksSecret(err: Error, secrets: Record<string, string>): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    if (scrubSecrets(e.message, secrets) !== e.message) return true;
    if (e.cause === e) break;
  }
  return false;
}

/** Secret names a route withholds from caller-supplied strings, split by why. */
interface WithheldNames {
  /** Consumed by drawlatch's own auth machinery (AWS SigV4 signing keys,
   *  OAuth2 client credentials and refresh token). */
  signerOnly: Set<string>;
  /** Which auth mode owns `signerOnly`, for the error message. */
  signerMode?: 'sigv4' | 'oauth2';
  /** Every other withheld secret: ones the route's headers inject, the webhook
   *  `signatureSecret`, the route's `withheldSecrets`, and any secret whose
   *  value contains one of those. */
  withheld: Set<string>;
}

/**
 * Reject `text` if it references a secret the route withholds from
 * substitution. Failing loudly beats sending the literal placeholder: the
 * caller learns why, and nothing leaves the daemon. The daemon log names the
 * connection too, so an operator whose custom connector relied on the old
 * behaviour can find it (and the `placeholderSecrets` escape hatch).
 */
function assertNoWithheldSecrets(
  text: string,
  names: WithheldNames,
  where: string,
  connection: string | undefined,
): void {
  if (names.signerOnly.size === 0 && names.withheld.size === 0) return;
  for (const match of text.matchAll(/\$\{(\w+)\}/g)) {
    const name = match[1];
    if (names.signerOnly.has(name)) {
      throw new Error(
        names.signerMode === 'oauth2'
          ? `${where} references \${${name}}, an OAuth2 credential of this route. ` +
              'drawlatch uses it only for OAuth2 token minting and never substitutes it ' +
              'into URLs, headers, or bodies; the minted access token is injected for you.'
          : `${where} references \${${name}}, a signing credential of this AWS SigV4 route. ` +
              'Signing credentials are only used to sign requests and are never substituted ' +
              'into URLs, headers, or bodies.',
      );
    }
    if (names.withheld.has(name)) {
      console.error(
        `[tool-dispatch] Rejected a request on connection "${connection ?? '?'}": ` +
          `it references withheld secret \${${name}}. If this connection's API needs it ` +
          "in the URL or body, list it in the connector's placeholderSecrets.",
      );
      throw new Error(
        `${where} references \${${name}}, a secret this connection withholds from requests. ` +
          'Withheld secrets (withheldSecretNames in list_routes) are used by the connection ' +
          'itself, for example injected through its own headers or used to verify webhooks, ' +
          'and are never substituted into request URLs, headers, or bodies, where an ' +
          'upstream could echo the value back. Remove the placeholder; if the connection ' +
          'injects it, the request is already authenticated.',
      );
    }
  }
}

/** Header values fetch() rejects — and echoes back in full when it does. */
const INVALID_HEADER_VALUE = /[\r\n\0]/;

// ── Proxy request execution ────────────────────────────────────────────────

/** A file attachment transmitted as base64 data through the encrypted channel. */
export interface FileAttachment {
  /** Form field name (e.g., "files[0]", "file", "attachment") */
  field: string;
  /** Base64-encoded file content */
  data: string;
  /** Filename for the upload */
  filename: string;
  /** MIME type (e.g., "image/png", "application/pdf") */
  contentType: string;
}

export interface ProxyRequestInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** File attachments — triggers multipart/form-data encoding */
  files?: FileAttachment[];
  /** Form field name for the JSON body part (default: "payload_json") */
  bodyFieldName?: string;
  /** Deadline (ms) for the outbound fetch to the upstream API. Clamped to the
   *  matched route's `requestTimeoutMs` when it sets one. Omitted = use the
   *  route's default, else DEFAULT_OUTBOUND_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ProxyRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** Final URL, present only when redirects were followed. */
  url?: string;
  /** Extra guidance from drawlatch, e.g. which OAuth2 scopes a 403'd token carries. */
  hint?: string;
}

/**
 * Headers that may follow a redirect to another origin. Content negotiation
 * only; credentials, connection identifiers (Twitch `Client-Id`), and every
 * other route or caller header stay behind. Listing what may go, rather than
 * what may not, means a new secret-bearing header name is safe by default.
 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'user-agent',
]);

/**
 * The subset of outbound headers sent on a cross-origin redirect hop: names on
 * CROSS_ORIGIN_SAFE_HEADERS whose value contains none of the route's secret
 * values (a caller can write `Accept: ${TOKEN}`). Every secret is checked,
 * however short — dropping a harmless header beats sending a secret.
 */
function crossOriginSafeHeaders(
  headers: Record<string, string>,
  secrets: Record<string, string>,
): Record<string, string> {
  const values = Object.values(secrets).filter((v) => typeof v === 'string' && v.length > 0);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([k, v]) =>
        CROSS_ORIGIN_SAFE_HEADERS.has(k.toLowerCase()) && !values.some((s) => v.includes(s)),
    ),
  );
}

/**
 * Core proxy request execution — route matching, secret injection, and fetch.
 *
 * Pure in the sense that it takes routes as input rather than reading global
 * state. The only side effect is the outbound fetch().
 *
 * `outboundBudgetMs` is the ceiling the *local proxy* can actually wait out,
 * forwarded on the ProxyRequest envelope. It clamps the connection's own
 * `requestTimeoutMs`, which is what keeps the deadline chain ordered even for
 * calls that carry no per-request `timeoutMs` — including handlers like
 * `test_connection` that expose no `timeoutMs` of their own. Omitted means
 * "no clamp": see applyOutboundBudget.
 */
export interface ProxyRequestOptions {
  /** The request comes from the connection's own template (testConnection,
   *  testIngestor, listenerConfig dynamicOptions), not from the agent. Pass
   *  only the owning route. Such a request may use withheld secrets (never
   *  signing credentials), and its headers override the route's headers of
   *  the same name instead of conflicting with them: Slack's testIngestor
   *  sends its app token in place of the bot token. The response is still
   *  scrubbed of withheld values. */
  templateAuthored?: boolean;
  /** Caller the request is made for. Required on an oauth2 route: it is part
   *  of the token identity. */
  caller?: string;
}

export async function executeProxyRequest(
  input: ProxyRequestInput,
  routes: ResolvedRoute[],
  outboundBudgetMs?: number,
  options: ProxyRequestOptions = {},
): Promise<ProxyRequestResult> {
  const { caller } = options;
  const { method, url, headers = {}, body, files, bodyFieldName, timeoutMs } = input;
  const templateAuthored = options.templateAuthored === true;
  /** What this request may substitute on a given route. */
  const usable = (route: ResolvedRoute) =>
    templateAuthored ? templateSecrets(route) : substitutableSecrets(route);

  // Step 0: refuse control characters before anything else looks at the URL
  // (Step 6 checks the resolved form again).
  assertNoControlChars(url, url);

  // Step 1: Find matching route — try raw URL first
  let matched: ResolvedRoute | null = matchRoute(url, routes);
  let resolvedUrl = url;

  if (matched) {
    // Resolve URL placeholders using matched route's secrets
    resolvedUrl = resolvePlaceholders(url, usable(matched));
  } else {
    // Try resolving URL with each route's secrets to find a match
    for (const route of routes) {
      if (route.allowedEndpoints.length === 0) continue;
      const candidateUrl = resolvePlaceholders(url, usable(route));
      if (isEndpointAllowed(candidateUrl, route.allowedEndpoints)) {
        matched = route;
        resolvedUrl = candidateUrl;
        break;
      }
    }
  }

  if (!matched) {
    throw new Error(`Endpoint not allowed: ${url}`);
  }

  // Secrets this route may substitute, and the ones it withholds (signing
  // credentials, header-only secrets). A reference to a withheld one anywhere
  // it would otherwise be resolved is rejected outright.
  const secrets = usable(matched);
  const signerOnly = signerOnlySecretNames(matched);
  const signerMode = matched.oauth2 ? 'oauth2' : 'sigv4';
  const noneWithheld: WithheldNames = { signerOnly, signerMode, withheld: new Set() };
  const withheld: WithheldNames = templateAuthored
    ? noneWithheld
    : { signerOnly, signerMode, withheld: new Set(Object.keys(withheldSecretValues(matched))) };
  for (const name of signerOnly) withheld.withheld.delete(name);
  const connection = matched.alias;
  assertNoWithheldSecrets(url, withheld, 'The request URL', connection);
  // Route headers were resolved with everything but the signer-only secrets,
  // so a placeholder left in one can only name a signing credential.
  for (const [k, v] of Object.entries(matched.headers)) {
    assertNoWithheldSecrets(v, noneWithheld, `Connection header "${k}"`, connection);
  }

  // Step 2: Resolve client headers using matched route's secrets
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    assertNoWithheldSecrets(v, withheld, `Header "${k}"`, connection);
    resolvedHeaders[k] = resolvePlaceholders(v, secrets);
  }

  // Step 3: Check for header conflicts — reject if client provides a header
  // that conflicts with a route-level header (case-insensitive). A template's
  // own request overrides the route header instead (see ProxyRequestOptions).
  const routeHeaderKeys = new Set(Object.keys(matched.headers).map((k) => k.toLowerCase()));
  const clientHeaderKeys = new Set(Object.keys(resolvedHeaders).map((k) => k.toLowerCase()));
  for (const clientKey of templateAuthored ? [] : Object.keys(resolvedHeaders)) {
    if (routeHeaderKeys.has(clientKey.toLowerCase())) {
      throw new Error(
        `Header conflict: client-provided header "${clientKey}" conflicts with a route-level header. Remove it from the request.`,
      );
    }
  }

  // Step 3b: On a SigV4 route the signer owns the auth headers. Letting a
  // caller set them would let it choose what gets signed.
  if (matched.awsSigV4) {
    for (const clientKey of Object.keys(resolvedHeaders)) {
      if (SIGV4_RESERVED_HEADERS.has(clientKey.toLowerCase())) {
        throw new Error(
          `Header conflict: "${clientKey}" is set by drawlatch's AWS SigV4 signer on this route. Remove it from the request.`,
        );
      }
    }
    let params: URLSearchParams | undefined;
    try {
      params = new URL(resolvedUrl).searchParams;
    } catch {
      // Unparseable URLs fail at fetch() / signing with their own error.
    }
    for (const key of params?.keys() ?? []) {
      if (SIGV4_RESERVED_QUERY_PARAMS.has(key.toLowerCase())) {
        throw new Error(
          `Query parameter "${key}" is not allowed on an AWS SigV4 route: drawlatch signs the request itself.`,
        );
      }
    }
  }

  // Step 3c: On an oauth2 route drawlatch owns the credential. A caller-sent
  // Authorization header or access_token parameter would replace or shadow
  // the minted token with one of the caller's choosing.
  if (matched.oauth2) {
    for (const clientKey of Object.keys(resolvedHeaders)) {
      if (OAUTH2_RESERVED_HEADERS.has(clientKey.toLowerCase())) {
        throw new Error(
          `Header conflict: "${clientKey}" is set by drawlatch on this OAuth2 route (it mints the access token itself). Remove it from the request.`,
        );
      }
    }
    let params: URLSearchParams | undefined;
    try {
      params = new URL(resolvedUrl).searchParams;
    } catch {
      // Unparseable URLs fail at fetch() with their own error.
    }
    for (const key of params?.keys() ?? []) {
      if (OAUTH2_RESERVED_QUERY_PARAMS.has(key.toLowerCase())) {
        throw new Error(
          `Query parameter "${key}" is not allowed on an OAuth2 route: drawlatch supplies the access token itself.`,
        );
      }
    }
  }

  // Step 4: Merge route-level headers (they take effect after conflict check)
  for (const [k, v] of Object.entries(matched.headers)) {
    if (templateAuthored && clientHeaderKeys.has(k.toLowerCase())) continue;
    resolvedHeaders[k] = v;
  }

  // Step 4b: Reject header values fetch() would reject anyway. Done here, by
  // name only, because fetch()'s own rejection echoes the offending *value* in
  // full — and these values carry resolved secrets. A token pasted with a
  // trailing newline is enough to trigger it.
  for (const [k, v] of Object.entries(resolvedHeaders)) {
    if (INVALID_HEADER_VALUE.test(v)) {
      throw new Error(
        `Invalid value for header "${k}": it contains a carriage return, newline, or NUL. ` +
          'Check the resolved secret for stray whitespace or line breaks. ' +
          '(The value itself is withheld because it may be a credential.)',
      );
    }
  }

  // Step 5: Resolve body placeholders using matched route's secrets.
  // Only when the route explicitly opts in via resolveSecretsInBody — prevents
  // exfiltration of secrets by writing placeholder strings into API resources
  // and reading them back.
  let fetchBody: string | FormData | undefined;
  // Whether substitution changed the body, i.e. it now carries secrets. Such a
  // body must not be resent to another origin by a 307/308.
  let bodyCarriesSecrets = false;

  if (files?.length) {
    // ── Multipart mode: build FormData with file attachments ──
    const form = new FormData();

    // Add the JSON body as a named part (default: "payload_json" for Discord-style APIs)
    if (body !== null && body !== undefined) {
      const serialized = typeof body === 'string' ? body : JSON.stringify(body);
      if (matched.resolveSecretsInBody) {
        assertNoWithheldSecrets(serialized, withheld, 'The request body', connection);
      }
      const resolvedPayload = matched.resolveSecretsInBody
        ? resolvePlaceholders(serialized, secrets)
        : serialized;
      bodyCarriesSecrets = resolvedPayload !== serialized;
      form.append(bodyFieldName ?? 'payload_json', resolvedPayload);
    }

    // Attach each file from base64 data
    for (const file of files) {
      const buffer = Buffer.from(file.data, 'base64');
      const blob = new Blob([buffer], { type: file.contentType });
      form.append(file.field, blob, file.filename);
    }

    fetchBody = form;
    // Let fetch auto-set Content-Type with the correct multipart boundary —
    // remove any Content-Type that may have been set by route headers
    delete resolvedHeaders['Content-Type'];
    delete resolvedHeaders['content-type'];
  } else {
    // ── Standard JSON/string body ──
    if (typeof body === 'string') {
      if (matched.resolveSecretsInBody) {
        assertNoWithheldSecrets(body, withheld, 'The request body', connection);
      }
      fetchBody = matched.resolveSecretsInBody ? resolvePlaceholders(body, secrets) : body;
      bodyCarriesSecrets = fetchBody !== body;
    } else if (body !== null && body !== undefined) {
      const serialized = JSON.stringify(body);
      if (matched.resolveSecretsInBody) {
        assertNoWithheldSecrets(serialized, withheld, 'The request body', connection);
      }
      fetchBody = matched.resolveSecretsInBody
        ? resolvePlaceholders(serialized, secrets)
        : serialized;
      bodyCarriesSecrets = fetchBody !== serialized;
      if (!resolvedHeaders['content-type'] && !resolvedHeaders['Content-Type']) {
        resolvedHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  // Step 6: Final endpoint check on the fully resolved URL, after parsing it
  // the way fetch() will. From here on `resolvedUrl` is the normalized href:
  // the string the allowlist accepted is exactly the string sent.
  resolvedUrl = normalizeOutboundUrl(resolvedUrl, matched.allowedEndpoints, url);

  // Step 6b: AWS SigV4. Last, so the signature covers the final URL, headers,
  // and body bytes exactly as sent.
  let outboundHeaders = resolvedHeaders;
  let outboundBody: string | FormData | Uint8Array<ArrayBuffer> | undefined = fetchBody;
  if (matched.awsSigV4) {
    const signed = await signProxyRequest({
      method,
      url: resolvedUrl,
      headers: resolvedHeaders,
      body: fetchBody,
      config: matched.awsSigV4,
      secrets: matched.secrets,
    });
    outboundHeaders = signed.headers;
    outboundBody = signed.body;
  }

  // Step 7: Make the actual HTTP request.
  // Always pass a signal — a bare fetch() would inherit undici's 300s headers
  // timeout, which is larger than every outer ceiling in the chain and so
  // would leave the upstream call running after the caller gave up.
  const connectionCeiling = resolveOutboundTimeout(timeoutMs, matched.requestTimeoutMs);
  const effectiveTimeout = applyOutboundBudget(connectionCeiling, outboundBudgetMs);
  // One deadline for the whole call: token minting (and a 401 re-mint) spend
  // the same budget as the API request itself.
  const deadline = Date.now() + effectiveTimeout;
  const remainingMs = () => Math.max(1, deadline - Date.now());

  // Step 6c: OAuth2. After every check, so a rejected request never mints.
  // The minted token is scrubbed from everything returned, like a withheld
  // secret: `tokenScrub` holds every token this request has sent.
  const oauth2Route: OAuth2Route | undefined = isOAuth2Route(matched) ? matched : undefined;
  const tokenScrub: Record<string, string> = {};
  let auth: OAuth2AuthResult | undefined;
  const mint = async (forceRefresh: boolean): Promise<void> => {
    if (!oauth2Route) return;
    if (!caller) {
      throw new Error(
        `Connection "${oauth2Route.alias ?? '(unnamed)'}" uses OAuth2, which needs the caller's identity; this request path did not supply one.`,
      );
    }
    if (auth)
      tokenScrub[`${OAUTH2_ACCESS_TOKEN_PLACEHOLDER}_PREVIOUS`] =
        auth.scrub[OAUTH2_ACCESS_TOKEN_PLACEHOLDER];
    auth = await oauth2Authorize(oauth2Route, caller, {
      timeoutMs: Math.min(OAUTH2_TOKEN_TIMEOUT_MS, remainingMs()),
      forceRefresh,
    });
    Object.assign(tokenScrub, auth.scrub);
    outboundHeaders = { ...outboundHeaders, Authorization: auth.authorization };
  };
  await mint(false);
  /** Everything scrubbed from headers, URLs, and errors. */
  const allSecrets = () => ({ ...matched.secrets, ...tokenScrub });

  try {
    // The signal is one wall-clock budget spanning connect, headers, *and*
    // body. The body read therefore has to sit inside this try: when an
    // upstream dribbles out its response, the deadline fires on `resp.json()`,
    // and outside the try that surfaces as a bare DOMException — exactly the
    // opaque error the drawlatch deadline exists to replace.
    // Redirects are followed by safeFetch, not fetch(): only to URLs this
    // route's allowlist accepts, never https → http, and cross-origin with
    // nothing but content-negotiation headers that carry no secret (and no
    // 307/308 resend of a body with substituted secrets). Anything else comes
    // back to the caller as the 3xx itself.
    const routeAllowlist = matched.allowedEndpoints;
    const send = () =>
      safeFetch(resolvedUrl, {
        method,
        headers: outboundHeaders,
        body: outboundBody,
        // Non-oauth2 routes arm exactly the effective timeout; nothing else
        // has spent any of it.
        signal: AbortSignal.timeout(oauth2Route ? remainingMs() : effectiveTimeout),
        isAllowed: (target) => isEndpointAllowed(target.href, routeAllowlist),
        crossOriginHeaders: crossOriginSafeHeaders(outboundHeaders, allSecrets()),
        bodyCarriesSecrets,
        // A signed request is never replayed, even same-origin: the signature
        // covers the original path, so a re-sent copy would need re-signing.
        ...(matched.awsSigV4 && { maxRedirects: 0 }),
      });
    let { response: resp, url: finalUrl, redirects } = await send();

    // A 401 on an oauth2 route usually means the cached token was revoked or
    // expired early: mint a fresh one and resend, exactly once. The body is a
    // string or FormData (SigV4, the only Uint8Array producer, can't combine
    // with oauth2), so it can be sent again.
    if (oauth2Route && resp.status === 401 && deadline - Date.now() > 0) {
      await resp.body?.cancel().catch(() => undefined);
      await mint(true);
      ({ response: resp, url: finalUrl, redirects } = await send());
    }

    // `application/json` and structured-syntax `+json` types
    // (`application/problem+json`, `application/vnd.api+json`) are parsed,
    // which also decodes `\uXXXX` escapes so the scrub below sees the real
    // characters. A `+json` body that doesn't parse comes back as text, as it
    // did before; invalid `application/json` still throws, as resp.json() did.
    const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
    const mediaType = contentType.split(';')[0].trim();
    let rawBody: unknown;
    if (contentType.includes('application/json')) {
      rawBody = JSON.parse(await resp.text());
    } else if (mediaType.endsWith('+json')) {
      const text = await resp.text();
      try {
        rawBody = JSON.parse(text);
      } catch {
        rawBody = text;
      }
    } else {
      rawBody = await resp.text();
    }
    // Withheld secrets only. The substitutable ones are the caller's to use by
    // design (Trello's `?token=`, Telegram's bot token, a resolveSecretsInBody
    // write the caller reads back), and many are plain config values
    // (REDDIT_SUBREDDIT, TWITCH_USER_ID) that legitimately appear in
    // responses; scrubbing those would corrupt data and protect nothing.
    // The minted OAuth2 token counts as withheld too.
    const withheldValues = { ...withheldSecretValues(matched), ...tokenScrub };
    const responseBody =
      Object.keys(withheldValues).length > 0 ? scrubSecretsDeep(rawBody, withheldValues) : rawBody;
    // Every route secret plus the minted token(s), compiled once for all the
    // strings below.
    const scrubAll = compileSecretScrubber(allSecrets());

    return {
      status: resp.status,
      // A reason phrase is upstream-controlled text like any other.
      statusText: scrubAll(resp.statusText),
      // A refused redirect's `Location` can carry a substituted secret back
      // (`?key=sk-…`), and so can any header an upstream echoes. The body is
      // scrubbed above, of withheld secrets only.
      headers: Object.fromEntries([...resp.headers.entries()].map(([k, v]) => [k, scrubAll(v)])),
      body: responseBody,
      // A same-origin `Location` can echo the original query back, and that
      // can carry substituted secrets.
      ...(redirects > 0 && { url: scrubAll(finalUrl) }),
      // A 403 is not retried: a fresh token has the same scopes.
      ...(oauth2Route &&
        resp.status === 403 && {
          hint:
            `This OAuth2 connection's token is limited to the scopes ` +
            `[${oauth2Route.oauth2.effectiveScopes.join(', ') || 'none requested'}]. A 403 may ` +
            "mean the request needs a scope this connection doesn't grant; ask the operator.",
        }),
    };
  } catch (err) {
    // Every message below reports the caller's own URL, never `resolvedUrl` —
    // the resolved form can carry secrets (e.g. Trello's key/token query
    // params).
    const kind = classifyTimeout(err);

    if (kind === 'connect') {
      throw new Error(
        `Upstream never accepted the connection: ${method} ${url}. ` +
          "The TCP/TLS handshake timed out before drawlatch's own deadline fired — " +
          'the upstream host is unreachable or refusing connections, which is a different ' +
          'failure from your request being too slow. Raising timeoutMs will not help.',
      );
    }

    if (kind === 'deadline' || kind === 'upstream-stalled') {
      const budgetBound = effectiveTimeout < connectionCeiling;
      throw new Error(
        `Upstream request timed out after ${effectiveTimeout}ms: ${method} ${url}. ` +
          'The upstream call was cancelled. ' +
          (budgetBound
            ? `This connection allows ${connectionCeiling}ms, but the local proxy's requestTimeout capped this call at ${effectiveTimeout}ms — raise requestTimeout in proxy.config.json to use the full ceiling. `
            : "Raise timeoutMs (up to this connection's requestTimeoutMs), or use the API's async job pattern. "),
      );
    }

    // Anything else: fetch() echoes hostile input verbatim, and the input it
    // sees is the secret-resolved form. Scrub before it reaches the console,
    // the client, and the model. A new Error rather than a mutation — `message`
    // is not writable on every error subclass Node throws here.
    // The chain matters, not just the top level: undici reports `TypeError:
    // fetch failed` with the real reason on `cause`, so a clean top-level
    // message can sit above a leaking one. In-process hosts importing this
    // module log the error object directly, which prints `[cause]`. Rethrowing
    // as a fresh Error drops the chain, which is the point.
    const scrubMap = allSecrets();
    if (err instanceof Error && leaksSecret(err, scrubMap)) {
      throw new Error(scrubSecrets(err.message, scrubMap));
    }
    throw err;
  }
}

// ── Tool handlers ──────────────────────────────────────────────────────────

/**
 * Validate the agent-supplied keys a listener tool uses to index caller config
 * maps. Returns an error message, or undefined when they're safe. An absent,
 * null, or empty `instanceId` means "no instance", as the handlers treat it.
 * See shared/safe-keys.ts for why `__proto__` matters here.
 */
function invalidListenerKeys(
  connection: unknown,
  instanceId: unknown,
  requireInstance = false,
): string | undefined {
  try {
    assertSafeConnectionKey(connection);
    if (requireInstance || (instanceId !== undefined && instanceId !== null && instanceId !== '')) {
      assertSafeInstanceId(instanceId);
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Refuse a self-management tool (set_connection_enabled, set_secrets) on the
 * agent path when the caller has `selfManage: false`. Without this, an agent
 * could enable any connection template for itself, and because secrets
 * resolve per caller *by name*, a newly enabled connection sharing a secret
 * name with an existing one (another google-* connector) would come up with
 * the existing token already attached.
 */
function assertMaySelfManage(
  tool: string,
  caller: CallerConfig | undefined,
  context: ToolContext,
): void {
  if (context.origin === 'admin' || callerMaySelfManage(caller)) return;
  throw new Error(
    `${tool} is not available to this agent: caller "${context.callerAlias}" has ` +
      'selfManage disabled, so its connections and secrets can only be changed by the ' +
      'operator (drawlatch dashboard or remote.config.json).',
  );
}

/** Context passed to every tool handler, providing caller identity and shared services. */
export interface ToolContext {
  /** The caller alias for the session making this request. */
  callerAlias: string;
  /** Which door the call came through:
   *   - 'agent' — the encrypted `/request` path, i.e. the caller's own agent.
   *   - 'admin' — the password-gated admin API (dashboard), acting for the
   *     operator on this caller's behalf.
   *  Absent is treated as 'agent', so a context built without it gets the
   *  more restricted behaviour. Gates set_connection_enabled / set_secrets
   *  when the caller has `selfManage: false`. */
  origin?: 'agent' | 'admin';
  /** The shared ingestor manager (for poll_events / ingestor_status). */
  ingestorManager: IngestorManager;
  /** Re-resolve routes for all sessions belonging to this caller.
   *  Call after secrets or connection list changes. */
  refreshRoutes: () => void;
  /** How long (ms) the caller's own socket will actually wait, minus its slack
   *  — forwarded on the ProxyRequest envelope by the local proxy. Clamps every
   *  outbound fetch this request makes, so handlers that expose no `timeoutMs`
   *  of their own (test_connection, test_ingestor, resolve_listener_options)
   *  still stay inside the caller's deadline.
   *
   *  Absent means **no clamp**, never zero: the admin API and older local
   *  proxies both arrive without one. */
  outboundBudgetMs?: number;
  /** The encrypted session making this request. Scopes per-session limits
   *  (e.g. concurrent `wait_for_events` holds). Absent on the admin API. */
  sessionId?: string;
  /** Aborts when the client goes away (the HTTP request closes), so
   *  long-held handlers like `wait_for_events` can release early. */
  signal?: AbortSignal;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  routes: ResolvedRoute[],
  context: ToolContext,
) => Promise<unknown> | object;

export const toolHandlers: Record<string, ToolHandler> = {
  /**
   * Proxied HTTP request with route-scoped secret injection.
   * Delegates to the extracted executeProxyRequest() function.
   */
  async http_request(input, routes, context) {
    return executeProxyRequest(
      input as unknown as ProxyRequestInput,
      routes,
      context.outboundBudgetMs,
      { caller: context.callerAlias },
    );
  },

  /**
   * List available routes with metadata, endpoint patterns, and secret names (not values).
   * Provides full disclosure of available routes for the local agent.
   */
  list_routes(_input, routes, context) {
    const routeList = routes.map((route, index) => {
      const info: Record<string, unknown> = { index };

      if (route.alias) info.alias = route.alias;
      if (route.name) info.name = route.name;
      if (route.description) info.description = route.description;
      if (route.docsUrl) info.docsUrl = route.docsUrl;
      if (route.openApiUrl) info.openApiUrl = route.openApiUrl;
      if (route.stability) info.stability = route.stability;
      if (route.category) info.category = route.category;

      info.allowedEndpoints = route.allowedEndpoints;
      info.secretNames = Object.keys(route.secrets);
      info.autoHeaders = Object.keys(route.headers);
      // Secrets the connection injects itself (or uses to sign / verify) and
      // that a request may therefore not reference as ${NAME}.
      const withheldNames = Object.keys(withheldSecretValues(route));
      if (withheldNames.length > 0) info.withheldSecretNames = withheldNames;
      if (route.awsSigV4) info.awsSigV4 = route.awsSigV4;
      // Names only: never a token, expiry, or credential fingerprint.
      if (route.oauth2) {
        info.auth = {
          type: 'oauth2',
          grant: route.oauth2.grant,
          scopes: route.oauth2.effectiveScopes,
        };
      }

      // Timeouts. The budget clamp is otherwise silent, so report what a call
      // would actually get *right now* rather than only the connection's
      // nominal ceiling — an agent can then pick a workable `timeoutMs`
      // instead of discovering the clamp by timing out.
      if (route.requestTimeoutMs !== undefined) info.requestTimeoutMs = route.requestTimeoutMs;
      info.defaultTimeoutMs = applyOutboundBudget(
        resolveOutboundTimeout(undefined, route.requestTimeoutMs),
        context.outboundBudgetMs,
      );
      info.maxTimeoutMs = applyOutboundBudget(
        resolveOutboundTimeout(MAX_OUTBOUND_TIMEOUT_MS, route.requestTimeoutMs),
        context.outboundBudgetMs,
      );

      // Ingestor & testing metadata
      info.hasTestConnection = route.testConnection !== undefined;
      info.hasIngestor = route.ingestorConfig !== undefined;
      if (route.ingestorConfig) {
        info.ingestorType = route.ingestorConfig.type;
        info.hasTestIngestor = route.testIngestor !== undefined && route.testIngestor !== null;
        info.hasListenerConfig = route.listenerConfig !== undefined;
        if (route.listenerConfig) {
          info.listenerParamKeys = route.listenerConfig.fields.map((f) => f.key);
          info.supportsMultiInstance = route.listenerConfig.supportsMultiInstance ?? false;
        }
      }

      return info;
    });

    return Promise.resolve(routeList);
  },

  /**
   * Poll for new events from ingestors (Discord Gateway, webhooks, pollers).
   * Returns events since a cursor, optionally filtered by connection.
   */
  poll_events(input, _routes, context) {
    const { connection, after_id, instance_id } = input as {
      connection?: string;
      after_id?: number;
      instance_id?: string;
    };
    const afterId = after_id ?? -1;

    if (connection) {
      return Promise.resolve(
        context.ingestorManager.getEvents(context.callerAlias, connection, afterId, instance_id),
      );
    }
    return Promise.resolve(context.ingestorManager.getAllEvents(context.callerAlias, afterId));
  },

  /**
   * Long-poll across every ingestor stream this caller owns. Returns as soon
   * as any stream has events past its cursor, else holds until one does or
   * the timeout fires. See wait-for-events.ts for the wire contract.
   */
  wait_for_events(input, _routes, context) {
    return waitForEvents(input, context);
  },

  /**
   * Append OTLP-shaped log records to this caller's audit log. Write-only:
   * there is no tool that reads, lists, or changes what is stored. The caller
   * stamped on each line is the authenticated one, never the payload's. See
   * audit-log.ts for the wire contract and limits.
   */
  ingest_logs(input, _routes, context) {
    return ingestLogs(input, context.callerAlias);
  },

  /**
   * Get the status of all active ingestors for this caller.
   */
  ingestor_status(_input, _routes, context) {
    return Promise.resolve(context.ingestorManager.getStatuses(context.callerAlias));
  },

  /**
   * Test a connection's API credentials by executing a pre-configured,
   * non-destructive read-only request. Returns success/failure with status details.
   */
  async test_connection(input, routes, context) {
    const { connection } = input as { connection: string };

    // Find the route matching this connection alias
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return { success: false, connection, error: `Unknown connection: ${connection}` };
    }

    // OAuth2: always mint first, so a credential problem is reported as one
    // rather than as a failed API call. Scope names only.
    let oauth2Report: Record<string, unknown> | undefined;
    if (isOAuth2Route(route)) {
      try {
        const auth = await oauth2Authorize(route, context.callerAlias, {
          timeoutMs: applyOutboundBudget(OAUTH2_TOKEN_TIMEOUT_MS, context.outboundBudgetMs),
        });
        oauth2Report = {
          tokenMinted: true,
          requestedScopes: route.oauth2.effectiveScopes,
          ...(auth.grantedScopes && { grantedScopes: auth.grantedScopes }),
          ...(auth.missingScopes && { missingScopes: auth.missingScopes }),
        };
      } catch (err) {
        return {
          success: false,
          connection,
          oauth2: { tokenMinted: false, requestedScopes: route.oauth2.effectiveScopes },
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!route.testConnection) {
        return {
          success: true,
          connection,
          oauth2: oauth2Report,
          description: 'Minted an OAuth2 access token (this connection has no test request).',
        };
      }
    }

    if (!route.testConnection) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This connection does not have a test configuration.',
      };
    }

    const testConfig = route.testConnection;
    const method = testConfig.method ?? 'GET';
    const expectedStatus = testConfig.expectedStatus ?? [200];

    try {
      const result = await executeProxyRequest(
        {
          method,
          url: testConfig.url,
          headers: testConfig.headers,
          body: testConfig.body,
        },
        // The template's own request: its route only, and it may use withheld
        // secrets (see ProxyRequestOptions).
        [route],
        context.outboundBudgetMs,
        { templateAuthored: true, caller: context.callerAlias },
      );

      const isSuccess = expectedStatus.includes(result.status);
      return {
        success: isSuccess,
        connection,
        status: result.status,
        statusText: result.statusText,
        description: testConfig.description,
        ...(oauth2Report && { oauth2: oauth2Report }),
        ...(isSuccess
          ? {}
          : {
              error: `Unexpected status ${result.status} (expected ${expectedStatus.join(' or ')})`,
            }),
      };
    } catch (err) {
      return {
        success: false,
        connection,
        description: testConfig.description,
        ...(oauth2Report && { oauth2: oauth2Report }),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Test an event listener / ingestor's configuration by running a lightweight
   * verification appropriate to its type (auth check, secret check, poll check).
   */
  async test_ingestor(input, routes, context) {
    const { connection } = input as { connection: string };

    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return { success: false, connection, error: `Unknown connection: ${connection}` };
    }

    if (!route.ingestorConfig) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This connection does not have an event listener.',
      };
    }

    // testIngestor is explicitly null = not testable
    if (route.testIngestor === null) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This event listener does not support testing.',
      };
    }

    if (!route.testIngestor) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This event listener does not have a test configuration.',
      };
    }

    const testConfig = route.testIngestor;

    try {
      switch (testConfig.strategy) {
        case 'webhook_verify': {
          // Verify that all required secrets are present and non-empty
          const missing: string[] = [];
          for (const secretName of testConfig.requireSecrets ?? []) {
            if (!route.secrets[secretName]) {
              missing.push(secretName);
            }
          }
          if (missing.length > 0) {
            return {
              success: false,
              connection,
              strategy: testConfig.strategy,
              description: testConfig.description,
              error: `Missing required secrets: ${missing.join(', ')}`,
            };
          }
          return {
            success: true,
            connection,
            strategy: testConfig.strategy,
            description: testConfig.description,
            message: 'All required webhook secrets are configured.',
          };
        }

        case 'websocket_auth':
        case 'http_request':
        case 'poll_once': {
          // Execute the test HTTP request
          if (!testConfig.request) {
            return {
              success: false,
              connection,
              strategy: testConfig.strategy,
              description: testConfig.description,
              error: 'Test configuration missing request details.',
            };
          }

          const method = testConfig.request.method ?? 'GET';
          const expectedStatus = testConfig.request.expectedStatus ?? [200];

          const result = await executeProxyRequest(
            {
              method,
              url: testConfig.request.url,
              headers: testConfig.request.headers,
              body: testConfig.request.body,
            },
            [route],
            context.outboundBudgetMs,
            { templateAuthored: true, caller: context.callerAlias },
          );

          const isSuccess = expectedStatus.includes(result.status);
          return {
            success: isSuccess,
            connection,
            strategy: testConfig.strategy,
            status: result.status,
            statusText: result.statusText,
            description: testConfig.description,
            ...(isSuccess
              ? { message: 'Listener test passed.' }
              : { error: `Unexpected status ${result.status}` }),
          };
        }

        default:
          return {
            success: false,
            connection,
            error: `Unknown test strategy: ${String(testConfig.strategy)}`,
          };
      }
    } catch (err) {
      return {
        success: false,
        connection,
        strategy: testConfig.strategy,
        description: testConfig.description,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * List listener configuration schemas for all connections that have configurable
   * event listeners. Returns the schema fields, current values, and metadata.
   */
  list_listener_configs(_input, routes, _context) {
    const configs = routes
      .filter((r) => r.listenerConfig)
      .map((r) => ({
        connection: r.alias,
        name: r.listenerConfig!.name,
        description: r.listenerConfig!.description,
        fields: r.listenerConfig!.fields,
        ingestorType: r.ingestorConfig?.type,
        supportsMultiInstance: r.listenerConfig!.supportsMultiInstance ?? false,
        instanceKeyField: r.listenerConfig!.fields.find((f) => f.instanceKey)?.key,
      }));
    return Promise.resolve(configs);
  },

  /**
   * Resolve dynamic options for a listener configuration field.
   * Fetches options from the external API (e.g., list of Trello boards).
   */
  async resolve_listener_options(input, routes, context) {
    const { connection, paramKey } = input as { connection: string; paramKey: string };

    const route = routes.find((r) => r.alias === connection);
    if (!route?.listenerConfig) {
      return { success: false, error: `No listener config for connection: ${connection}` };
    }

    const field = route.listenerConfig.fields.find((f) => f.key === paramKey);
    if (!field?.dynamicOptions) {
      return { success: false, error: `No dynamic options for field: ${paramKey}` };
    }

    const {
      url,
      method = 'GET',
      body,
      responsePath,
      labelField,
      valueField,
    } = field.dynamicOptions;

    try {
      const result = await executeProxyRequest(
        { method, url, headers: {}, body },
        // The template's own request: its route only, and it may use withheld
        // secrets (see ProxyRequestOptions).
        [route],
        context.outboundBudgetMs,
        { templateAuthored: true, caller: context.callerAlias },
      );

      // Navigate to the response path to find the items array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- navigating unknown response shape
      let items: any = result.body;
      if (responsePath) {
        for (const segment of responsePath.split('.')) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
          items = items?.[segment as keyof typeof items];
        }
      }

      if (!Array.isArray(items)) {
        return { success: false, error: 'Response did not contain an array at the expected path.' };
      }

      const options = items.map((item) => ({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        value: item[valueField],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        label: item[labelField],
      }));

      return { success: true, connection, paramKey, options };
    } catch (err) {
      return {
        success: false,
        connection,
        paramKey,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Start, stop, or restart an event listener for a specific connection.
   */
  async control_listener(input, _routes, context) {
    const { connection, action, instance_id } = input as {
      connection: string;
      action: 'start' | 'stop' | 'restart';
      instance_id?: string;
    };

    const keyError = invalidListenerKeys(connection, instance_id);
    if (keyError) return { success: false, connection, action, error: keyError };

    const mgr = context.ingestorManager;

    try {
      switch (action) {
        case 'start':
          return await mgr.startOne(context.callerAlias, connection, instance_id);
        case 'stop':
          return await mgr.stopOne(context.callerAlias, connection, instance_id);
        case 'restart':
          return await mgr.restartOne(context.callerAlias, connection, instance_id);
        default:
          return { success: false, error: `Unknown action: ${String(action)}` };
      }
    } catch (err) {
      return {
        success: false,
        connection,
        action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Read current listener parameter overrides for a connection.
   * Returns current param values and schema defaults for form population.
   */
  get_listener_params(input, routes, context) {
    const { connection, instance_id } = input as {
      connection: string;
      instance_id?: string;
    };
    const keyError = invalidListenerKeys(connection, instance_id);
    if (keyError) return Promise.resolve({ success: false, connection, error: keyError });

    // Find the route for this connection
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Unknown connection: ${connection}`,
      });
    }

    if (!route.listenerConfig) {
      return Promise.resolve({
        success: false,
        connection,
        error: 'This connection does not have a listener configuration.',
      });
    }

    // Build defaults from schema fields
    const defaults: Record<string, unknown> = {};
    for (const field of route.listenerConfig.fields) {
      if (field.default !== undefined) {
        defaults[field.key] = field.default;
      }
    }

    // Load config to read current overrides
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
    if (!callerConfig) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Caller not found: ${context.callerAlias}`,
      });
    }

    let params: Record<string, unknown> = {};

    if (instance_id) {
      // Multi-instance: read from listenerInstances
      const instanceOverrides = ownEntry(
        ownEntry(callerConfig.listenerInstances, connection),
        instance_id,
      );
      if (!instanceOverrides) {
        return Promise.resolve({
          success: false,
          connection,
          instance_id,
          error: `Instance not found: ${instance_id}`,
        });
      }
      params = instanceOverrides.params ?? {};
    } else {
      // Single-instance: read from ingestorOverrides
      const overrides = ownEntry(callerConfig.ingestorOverrides, connection);
      params = overrides?.params ?? {};
    }

    // When no instance_id is given on a multi-instance connection, include
    // the list of configured instance IDs so callers can discover them
    // without needing a separate list_listener_instances call.
    let instances: string[] | undefined;
    if (!instance_id && route.listenerConfig.supportsMultiInstance) {
      const instanceMap = ownEntry(callerConfig.listenerInstances, connection) ?? {};
      instances = Object.keys(instanceMap);
    }

    return Promise.resolve({
      success: true,
      connection,
      ...(instance_id && { instance_id }),
      params,
      defaults,
      ...(instances !== undefined && { instances }),
    });
  },

  /**
   * Add or edit listener parameter overrides for a connection.
   * Merges params into existing config. For multi-instance, set create_instance
   * to true to create a new instance if it doesn't exist.
   * After saving, restarts the affected ingestor so new params take effect immediately.
   */
  async set_listener_params(input, routes, context) {
    const { connection, instance_id, params, create_instance } = input as {
      connection: string;
      instance_id?: string;
      params: Record<string, unknown>;
      create_instance?: boolean;
    };
    const keyError = invalidListenerKeys(connection, instance_id);
    if (keyError) return { success: false, connection, error: keyError };
    // Runtime check: `params` is untrusted input despite its declared type.
    if (
      (params as unknown) === null ||
      typeof (params as unknown) !== 'object' ||
      Array.isArray(params)
    ) {
      return { success: false, connection, error: 'params must be an object.' };
    }

    // Find the route for this connection
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return { success: false, connection, error: `Unknown connection: ${connection}` };
    }

    if (!route.listenerConfig) {
      return {
        success: false,
        connection,
        error: 'This connection does not have a listener configuration.',
      };
    }

    // Validate param keys against schema
    const validKeys = new Set(route.listenerConfig.fields.map((f) => f.key));
    const unknownKeys = Object.keys(params).filter((k) => !validKeys.has(k));
    if (unknownKeys.length > 0) {
      return {
        success: false,
        connection,
        error: `Unknown parameter keys: ${unknownKeys.join(', ')}. Valid keys: ${Array.from(validKeys).join(', ')}`,
      };
    }

    // Load config, modify, save
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
    if (!callerConfig) {
      return {
        success: false,
        connection,
        error: `Caller not found: ${context.callerAlias}`,
      };
    }

    let mergedParams: Record<string, unknown>;

    if (instance_id) {
      // Multi-instance: write to listenerInstances
      // Own-property lookups throughout: see shared/safe-keys.ts.
      callerConfig.listenerInstances ??= {};
      const connInstances =
        ownEntry(callerConfig.listenerInstances, connection) ??
        (callerConfig.listenerInstances[connection] = {});

      const existing: IngestorOverrides | undefined = ownEntry(connInstances, instance_id);

      if (!existing && !create_instance) {
        return {
          success: false,
          connection,
          instance_id,
          error: `Instance "${instance_id}" does not exist. Set create_instance to true to create it.`,
        };
      }

      if (existing) {
        existing.params = { ...(existing.params ?? {}), ...params };
        mergedParams = existing.params;
      } else {
        connInstances[instance_id] = { params };
        mergedParams = params;
      }
    } else {
      // Single-instance: write to ingestorOverrides
      callerConfig.ingestorOverrides ??= {};
      const overrides =
        ownEntry(callerConfig.ingestorOverrides, connection) ??
        (callerConfig.ingestorOverrides[connection] = {});
      overrides.params = { ...(overrides.params ?? {}), ...params };
      mergedParams = overrides.params;
    }

    saveRemoteConfig(config);

    // Restart the affected ingestor so new params take effect immediately.
    // This matches callboard's local-proxy behavior (which calls reinitialize()).
    const mgr = context.ingestorManager;
    if (mgr.has(context.callerAlias, connection, instance_id)) {
      try {
        await mgr.restartOne(context.callerAlias, connection, instance_id);
      } catch (err) {
        // Config was saved successfully — log the restart failure but don't fail the operation
        console.error(
          `[remote] Warning: params saved but failed to restart ingestor ${context.callerAlias}:${connection}${instance_id ? `:${instance_id}` : ''}:`,
          err,
        );
        return {
          success: true,
          connection,
          ...(instance_id && { instance_id }),
          params: mergedParams,
          warning:
            'Params saved but ingestor restart failed. Use control_listener to restart manually.',
        };
      }
    }

    return {
      success: true,
      connection,
      ...(instance_id && { instance_id }),
      params: mergedParams,
    };
  },

  /**
   * List all configured listener instances for a multi-instance connection.
   * Returns every instance from config (including stopped/disabled ones),
   * unlike ingestor_status which only shows running instances.
   */
  list_listener_instances(input, routes, context) {
    const { connection } = input as { connection: string };
    const keyError = invalidListenerKeys(connection, undefined);
    if (keyError) return Promise.resolve({ success: false, connection, error: keyError });

    // Find the route for this connection
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Unknown connection: ${connection}`,
      });
    }

    if (!route.listenerConfig?.supportsMultiInstance) {
      return Promise.resolve({
        success: false,
        connection,
        error: 'This connection does not support multi-instance listeners.',
      });
    }

    // Read from config
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
    if (!callerConfig) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Caller not found: ${context.callerAlias}`,
      });
    }

    const instanceMap = ownEntry(callerConfig.listenerInstances, connection) ?? {};
    const instances = Object.entries(instanceMap).map(([instanceId, overrides]) => ({
      instanceId,
      disabled: overrides.disabled ?? false,
      params: overrides.params ?? {},
    }));

    return Promise.resolve({
      success: true,
      connection,
      instances,
    });
  },

  /**
   * Delete a multi-instance listener instance.
   * Removes from config and stops the running ingestor if active.
   */
  async delete_listener_instance(input, _routes, context) {
    const { connection, instance_id } = input as {
      connection: string;
      instance_id: string;
    };
    const keyError = invalidListenerKeys(connection, instance_id, true);
    if (keyError) return { success: false, connection, instance_id, error: keyError };

    // Load config
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
    if (!callerConfig) {
      return {
        success: false,
        connection,
        instance_id,
        error: `Caller not found: ${context.callerAlias}`,
      };
    }

    const instances = ownEntry(callerConfig.listenerInstances, connection);
    if (!instances || !Object.hasOwn(instances, instance_id)) {
      return {
        success: false,
        connection,
        instance_id,
        error: `Instance "${instance_id}" not found for connection "${connection}".`,
      };
    }

    // Stop the running ingestor if active
    const mgr = context.ingestorManager;
    if (mgr.has(context.callerAlias, connection, instance_id)) {
      try {
        await mgr.stopOne(context.callerAlias, connection, instance_id, { permanent: true });
      } catch (err) {
        // Log but don't fail the delete
        console.error(
          `[remote] Warning: failed to stop ingestor ${context.callerAlias}:${connection}:${instance_id}:`,
          err,
        );
      }
    }

    // Remove from config
    const { [instance_id]: _removed, ...remainingInstances } = instances;

    // Clean up empty maps
    if (Object.keys(remainingInstances).length === 0) {
      if (callerConfig.listenerInstances) {
        const { [connection]: _removedConn, ...remainingConns } = callerConfig.listenerInstances;
        if (Object.keys(remainingConns).length === 0) {
          delete callerConfig.listenerInstances;
        } else {
          callerConfig.listenerInstances = remainingConns;
        }
      }
    } else {
      callerConfig.listenerInstances![connection] = remainingInstances;
    }

    saveRemoteConfig(config);

    return { success: true, connection, instance_id };
  },

  // ── Config management tools ─────────────────────────────────────────────

  /**
   * List all available connection templates with caller-specific status.
   * Returns template metadata, which ones the caller has enabled,
   * and which secrets are configured.
   */
  list_connection_templates: (
    _input: Record<string, unknown>,
    _routes: ResolvedRoute[],
    context: ToolContext,
  ) => {
    const config = loadRemoteConfig();
    const caller = config.callers[context.callerAlias];
    const enabledSet = new Set(caller.connections);
    const selfManageable = context.origin === 'admin' || callerMaySelfManage(caller);

    const templates = listConnectionTemplates();

    return templates.map((t) => {
      const callerEnv = caller.env;
      const requiredSecretsSet: Record<string, boolean> = {};
      for (const s of t.requiredSecrets) {
        requiredSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
      }
      const optionalSecretsSet: Record<string, boolean> = {};
      for (const s of t.optionalSecrets) {
        optionalSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
      }

      return {
        alias: t.alias,
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
        ...(t.docsUrl !== undefined && { docsUrl: t.docsUrl }),
        ...(t.openApiUrl !== undefined && { openApiUrl: t.openApiUrl }),
        stability: t.stability,
        category: t.category,
        requiredSecrets: t.requiredSecrets,
        optionalSecrets: t.optionalSecrets,
        hasIngestor: t.hasIngestor,
        ...(t.ingestorType !== undefined && { ingestorType: t.ingestorType }),
        allowedEndpoints: t.allowedEndpoints,
        enabled: enabledSet.has(t.alias),
        requiredSecretsSet,
        optionalSecretsSet,
        // Whether set_connection_enabled / set_secrets will work for this caller.
        selfManageable,
      };
    });
  },

  /**
   * Enable or disable a connection for the authenticated caller.
   */
  set_connection_enabled: async (
    input: Record<string, unknown>,
    _routes: ResolvedRoute[],
    context: ToolContext,
  ) => {
    const connection = input.connection as string;
    const enabled = input.enabled as boolean;

    if (!connection || typeof enabled !== 'boolean') {
      throw new Error('Required: connection (string) and enabled (boolean)');
    }

    const config = loadRemoteConfig();
    const caller = config.callers[context.callerAlias];
    assertMaySelfManage('set_connection_enabled', caller, context);

    // Verify the connection template exists (built-in or custom connector)
    const connectorAliases = new Set((config.connectors ?? []).map((c) => c.alias).filter(Boolean));
    const templateAliases = new Set(listConnectionTemplates().map((t) => t.alias));
    if (!connectorAliases.has(connection) && !templateAliases.has(connection)) {
      throw new Error(`Unknown connection: ${connection}`);
    }

    const connectionSet = new Set(caller.connections);

    if (enabled) {
      connectionSet.add(connection);
    } else {
      connectionSet.delete(connection);

      // Stop any running ingestors for this connection
      const ingestorManager = context.ingestorManager;
      try {
        await ingestorManager.stopOne(context.callerAlias, connection);
      } catch {
        // Ingestor may not be running — that's fine
      }
    }

    caller.connections = [...connectionSet];
    saveRemoteConfig(config);

    // Invalidate cached resolved routes so connection changes take effect immediately
    context.refreshRoutes();

    return { success: true, connection, enabled };
  },

  /**
   * Set or delete secrets for the authenticated caller.
   * Uses prefixed env vars to prevent cross-caller collisions.
   */
  set_secrets: (input: Record<string, unknown>, _routes: ResolvedRoute[], context: ToolContext) => {
    const secrets = input.secrets as Record<string, string> | undefined;

    if (!secrets || typeof secrets !== 'object') {
      throw new Error('Required: secrets (Record<string, string>)');
    }

    const config = loadRemoteConfig();
    assertMaySelfManage('set_secrets', config.callers[context.callerAlias], context);

    const { config: updatedConfig, status } = setCallerSecrets(
      secrets,
      context.callerAlias,
      config,
    );

    saveRemoteConfig(updatedConfig);

    // Invalidate cached resolved routes so new secrets take effect immediately
    context.refreshRoutes();

    return { success: true, secretsSet: status };
  },

  /**
   * Check which secrets are set for the authenticated caller (never returns values).
   */
  get_secret_status: (
    input: Record<string, unknown>,
    _routes: ResolvedRoute[],
    context: ToolContext,
  ) => {
    const connection = input.connection as string;

    if (!connection) {
      throw new Error('Required: connection (string)');
    }

    // Find the connection template
    const templates = listConnectionTemplates();
    const template = templates.find((t) => t.alias === connection);
    if (!template) {
      throw new Error(`Unknown connection: ${connection}`);
    }

    const config = loadRemoteConfig();
    const caller = config.callers[context.callerAlias];
    const callerEnv = caller.env;

    const requiredSecretsSet: Record<string, boolean> = {};
    for (const s of template.requiredSecrets) {
      requiredSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
    }

    const optionalSecretsSet: Record<string, boolean> = {};
    for (const s of template.optionalSecrets) {
      optionalSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
    }

    return {
      success: true,
      connection,
      requiredSecretsSet,
      optionalSecretsSet,
    };
  },
};

/**
 * Dispatch a single tool call by name. Throws on unknown tool.
 *
 * The canonical entry point for the admin API, which invokes tools without
 * going through the encrypted `/request` path.
 */
export async function dispatchTool(
  toolName: string,
  input: Record<string, unknown>,
  routes: ResolvedRoute[],
  context: ToolContext,
): Promise<unknown> {
  const handler = toolHandlers[toolName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation for untrusted input
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return handler(input, routes, context);
}
