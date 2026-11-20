/**
 * The one entry point for putting a managed OAuth2 token on a request.
 *
 * Shared by executeProxyRequest (http_request, test_connection, test_ingestor,
 * resolve_listener_options) and the poll ingestor, so they all mint through the
 * same TokenManager with the same identity and the same secret handling.
 */

import { OAUTH2_TOKEN_TIMEOUT_MS, type ResolvedRoute } from '../../shared/config.js';
import { getSharedTokenManager } from './shared-token-manager.js';
import { OAuth2RefreshError, type TokenManager } from './token-manager.js';

/** Name under which the minted access token is scrubbed from responses and errors. */
export const OAUTH2_ACCESS_TOKEN_PLACEHOLDER = 'OAUTH2_ACCESS_TOKEN';

/** Header names drawlatch owns on an oauth2 route; a caller may not send them. */
export const OAUTH2_RESERVED_HEADERS = new Set(['authorization']);
/** Query parameters a caller may not send on an oauth2 route (RFC 6750 §2.3). */
export const OAUTH2_RESERVED_QUERY_PARAMS = new Set(['access_token']);

export type OAuth2Route = ResolvedRoute & { oauth2: NonNullable<ResolvedRoute['oauth2']> };

export function isOAuth2Route(route: ResolvedRoute): route is OAuth2Route {
  return route.oauth2 !== undefined;
}

export interface OAuth2AuthResult {
  /** `Bearer <token>`, for the Authorization header. */
  authorization: string;
  /** Add to every scrub map for this request: `{ OAUTH2_ACCESS_TOKEN: token }`. */
  scrub: Record<string, string>;
  /** Scopes the token endpoint reported, sorted (names only). */
  grantedScopes?: string[];
  /** Requested scopes it did not grant. */
  missingScopes?: string[];
}

export interface OAuth2AuthorizeOptions {
  /** How long this caller may wait for a token (ms). Capped at OAUTH2_TOKEN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Mint a new token even if a cached one is still valid (after a 401). */
  forceRefresh?: boolean;
  /** Defaults to the process-wide shared manager. */
  tokenManager?: TokenManager;
}

/**
 * Mint (or reuse) the access token for `route` on behalf of `caller`.
 *
 * Reads the oauth2 credentials from the route's full `secrets` map: they are
 * signer-only, so this is the only code that ever sees them.
 *
 * @throws OAuth2Error (from token-manager.ts). Messages carry the connection
 *   alias, HTTP status, a recognised OAuth2 error code, and a fixed hint only.
 */
export async function oauth2Authorize(
  route: OAuth2Route,
  caller: string,
  opts: OAuth2AuthorizeOptions = {},
): Promise<OAuth2AuthResult> {
  if (!route.alias) {
    // The alias is part of the token identity; never share a slot by URL.
    throw new OAuth2RefreshError('(unnamed)', undefined, 'oauth2 routes need a connection alias');
  }
  const manager = opts.tokenManager ?? getSharedTokenManager();
  const oauth2 = { ...route.oauth2, scopes: route.oauth2.effectiveScopes };
  const token = await manager.getToken(
    { connection: route.alias, caller },
    oauth2,
    (name) => route.secrets[name],
    {
      forceRefresh: opts.forceRefresh ?? false,
      timeoutMs: Math.min(opts.timeoutMs ?? OAUTH2_TOKEN_TIMEOUT_MS, OAUTH2_TOKEN_TIMEOUT_MS),
    },
  );
  return {
    authorization: `Bearer ${token.accessToken}`,
    scrub: { [OAUTH2_ACCESS_TOKEN_PLACEHOLDER]: token.accessToken },
    ...(token.grantedScopes && { grantedScopes: token.grantedScopes }),
    ...(token.missingScopes && { missingScopes: token.missingScopes }),
  };
}
