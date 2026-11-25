/**
 * Unit tests for the generic OAuth2 TokenManager (ported from PR #26, Card 2,
 * plus the drawlatch hardening: identity keys, scope verification, transport
 * limits, error classification, terminal backoff).
 *
 * Drives an injected fetch + clock for determinism. Asserts cache behaviour,
 * single-flight coalescing, refresh-token rotation, both grant flows, both
 * client-auth modes, terminal vs transient errors, per-key isolation,
 * forceRefresh, and — critically — that no secret material leaks into thrown
 * error messages.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import crypto from 'node:crypto';
import {
  TokenManager,
  OAuth2InvalidGrantError,
  OAuth2RefreshError,
  OAuth2ScopeError,
  OAuth2TerminalError,
  type TokenKey,
} from './token-manager.js';
import {
  DEFAULT_OAUTH2_REFRESH_SKEW_MS,
  OAUTH2_MIN_REMINT_INTERVAL_MS,
  OAUTH2_TERMINAL_BACKOFF_MS,
  OAUTH2_TOKEN_RESPONSE_MAX_BYTES,
  OAUTH2_TOKEN_TIMEOUT_MS,
  type OAuth2Config,
} from '../../shared/config.js';

// ── Secret material (used to assert non-leakage) ────────────────────────────

const CLIENT_ID = 'spotify-client-id-XYZ';
const CLIENT_SECRET = 'super-secret-client-secret-7f3a';
const REFRESH_TOKEN = 'initial-refresh-token-abc123';
const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token-def456';
const ACCESS_TOKEN = 'access-token-value-qwerty';

const ALL_SECRET_VALUES = [
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  ROTATED_REFRESH_TOKEN,
  ACCESS_TOKEN,
];

// ── Helpers ──────────────────────────────────────────────────────────────

function mockTokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch implementation answering every call with a fresh copy of `body`. */
function alwaysRespond(body: unknown, status = 200): () => Promise<Response> {
  return () => Promise.resolve(mockTokenResponse(body, status));
}

const secrets: Record<string, string> = {
  SPOTIFY_CLIENT_ID: CLIENT_ID,
  SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN: REFRESH_TOKEN,
};

const resolveSecret = (name: string): string | undefined => secrets[name];

function refreshConfig(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    tokenUrl: 'https://accounts.spotify.com/api/token',
    grant: 'refresh_token',
    clientAuth: 'basic',
    secretRefs: {
      clientId: 'SPOTIFY_CLIENT_ID',
      clientSecret: 'SPOTIFY_CLIENT_SECRET',
      refreshToken: 'SPOTIFY_REFRESH_TOKEN',
    },
    ...overrides,
  };
}

function clientCredsConfig(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    tokenUrl: 'https://accounts.spotify.com/api/token',
    grant: 'client_credentials',
    clientAuth: 'basic',
    secretRefs: {
      clientId: 'SPOTIFY_CLIENT_ID',
      clientSecret: 'SPOTIFY_CLIENT_SECRET',
    },
    ...overrides,
  };
}

const KEY: TokenKey = { connection: 'spotify', caller: 'default' };

/** getToken(), returning only the access token string. */
async function accessToken(
  tm: TokenManager,
  ...args: Parameters<TokenManager['getToken']>
): Promise<string> {
  return (await tm.getToken(...args)).accessToken;
}

/** Parse the form-encoded body argument from a fetch mock call. */
function bodyParams(call: unknown[]): URLSearchParams {
  const init = call[1] as RequestInit;
  return new URLSearchParams(init.body as string);
}

function headers(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('TokenManager', () => {
  let fetchMock: Mock<typeof fetch>;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
    fetchMock = vi.fn<typeof fetch>();
  });

  function makeManager(): TokenManager {
    return new TokenManager({ fetchImpl: fetchMock, now });
  }

  // ── Caching ─────────────────────────────────────────────────────────────

  it('refreshes on a cold cache then serves a cached token without re-fetching', async () => {
    fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();

    const first = await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    expect(first).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance well within validity (skew default 300s, token lives 3600s).
    clock += 1000 * 1000; // +1000s → 2000s remaining > skew
    const second = await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    expect(second).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit, no new fetch
  });

  it('refreshes once the token is within the skew window of expiry', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret)).toBe('tok-1');

    // Move to inside the skew window: now + skew >= expiresAt.
    clock += 3600 * 1000 - DEFAULT_OAUTH2_REFRESH_SKEW_MS + 1;
    expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret)).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours a custom refreshSkewMs from the config', async () => {
    fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 100 }));
    const tm = makeManager();
    const cfg = refreshConfig({ refreshSkewMs: 10_000 }); // 10s skew, 100s token

    await accessToken(tm, KEY, cfg, resolveSecret);
    // 95s later: 5s remaining < 10s skew → stale.
    clock += 95_000;
    await accessToken(tm, KEY, cfg, resolveSecret);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Single-flight ───────────────────────────────────────────────────────

  it('coalesces N concurrent calls into exactly one token-endpoint request', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValue(pending);
    const tm = makeManager();

    const calls = Promise.all(
      Array.from({ length: 8 }, () => accessToken(tm, KEY, refreshConfig(), resolveSecret)),
    );
    // Let the microtasks queue up against the single in-flight promise.
    await Promise.resolve();
    resolveFetch(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }));

    const results = await calls;
    expect(results).toEqual(Array.from({ length: 8 }, () => ACCESS_TOKEN));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh refresh after the in-flight promise settles', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 1 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    clock += 2000; // expired
    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── forceRefresh ─────────────────────────────────────────────────────────

  it('forceRefresh bypasses a still-valid cached token', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret)).toBe('tok-1');
    clock += OAUTH2_MIN_REMINT_INTERVAL_MS; // past the re-mint floor
    expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret, { forceRefresh: true })).toBe(
      'tok-2',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh joins an in-flight refresh (still single-flight)', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValue(pending);
    const tm = makeManager();

    const a = accessToken(tm, KEY, refreshConfig(), resolveSecret);
    const b = accessToken(tm, KEY, refreshConfig(), resolveSecret, { forceRefresh: true });
    await Promise.resolve();
    resolveFetch(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }));

    expect(await a).toBe(ACCESS_TOKEN);
    expect(await b).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Refresh-token rotation ────────────────────────────────────────────────

  it('persists a rotated refresh_token and uses it on the next refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockTokenResponse({
          access_token: 'tok-1',
          expires_in: 3600,
          refresh_token: ROTATED_REFRESH_TOKEN,
        }),
      )
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    // First refresh used the configured secret.
    expect(bodyParams(fetchMock.mock.calls[0]).get('refresh_token')).toBe(REFRESH_TOKEN);

    clock += OAUTH2_MIN_REMINT_INTERVAL_MS; // past the re-mint floor
    await accessToken(tm, KEY, refreshConfig(), resolveSecret, { forceRefresh: true });
    // Second refresh used the rotated token from response #1.
    expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(ROTATED_REFRESH_TOKEN);
  });

  it('keeps the prior refresh token when the response omits one', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    clock += OAUTH2_MIN_REMINT_INTERVAL_MS; // past the re-mint floor
    await accessToken(tm, KEY, refreshConfig(), resolveSecret, { forceRefresh: true });
    // Both refreshes used the original configured secret (no rotation seen).
    expect(bodyParams(fetchMock.mock.calls[0]).get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(REFRESH_TOKEN);
  });

  // ── Request shape ─────────────────────────────────────────────────────────

  it('refresh_token grant with basic auth produces the exact request shape', async () => {
    fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();

    await accessToken(tm, KEY, refreshConfig(), resolveSecret);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(init.method).toBe('POST');
    expect(headers(fetchMock.mock.calls[0])['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const expectedBasic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    expect(headers(fetchMock.mock.calls[0]).Authorization).toBe(`Basic ${expectedBasic}`);

    const params = bodyParams(fetchMock.mock.calls[0]);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(params.get('client_id')).toBeNull(); // basic → not in body
    expect(params.get('client_secret')).toBeNull();
  });

  it('client_auth=body sends credentials in the form, no Authorization header', async () => {
    fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();

    await accessToken(tm, KEY, refreshConfig({ clientAuth: 'body' }), resolveSecret);

    expect(headers(fetchMock.mock.calls[0]).Authorization).toBeUndefined();
    const params = bodyParams(fetchMock.mock.calls[0]);
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('client_credentials grant omits refresh_token and joins scopes', async () => {
    fetchMock.mockImplementation(
      alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'read write' }),
    );
    const tm = makeManager();
    const catalogKey: TokenKey = { connection: 'spotify-catalog', caller: 'default' };

    await accessToken(
      tm,
      catalogKey,
      clientCredsConfig({ scopes: ['read', 'write'] }),
      resolveSecret,
    );

    const params = bodyParams(fetchMock.mock.calls[0]);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('refresh_token')).toBeNull();
    expect(params.get('scope')).toBe('read write');
    // Still uses basic auth header for the client.
    const expectedBasic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    expect(headers(fetchMock.mock.calls[0]).Authorization).toBe(`Basic ${expectedBasic}`);
  });

  it('never sends a JSON content-type', async () => {
    fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();
    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    const ct = headers(fetchMock.mock.calls[0])['Content-Type'];
    expect(ct).not.toContain('json');
  });

  // ── Per-key isolation ─────────────────────────────────────────────────────

  it('keeps independent cache entries per (connection, caller)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-A', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-B', expires_in: 3600 }));
    const tm = makeManager();

    const a = await accessToken(
      tm,
      { connection: 'spotify', caller: 'alice' },
      refreshConfig(),
      resolveSecret,
    );
    const b = await accessToken(
      tm,
      { connection: 'spotify', caller: 'bob' },
      refreshConfig(),
      resolveSecret,
    );

    expect(a).toBe('tok-A');
    expect(b).toBe('tok-B');
    expect(fetchMock).toHaveBeenCalledTimes(2); // two distinct callers → two fetches
  });

  it('treats the same connection for two callers as separate keys', async () => {
    fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();

    await accessToken(
      tm,
      { connection: 'spotify', caller: 'alice' },
      refreshConfig(),
      resolveSecret,
    );
    await accessToken(tm, { connection: 'spotify', caller: 'bob' }, refreshConfig(), resolveSecret);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // alice's cached token is reused; no third fetch.
    await accessToken(
      tm,
      { connection: 'spotify', caller: 'alice' },
      refreshConfig(),
      resolveSecret,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Errors ──────────────────────────────────────────────────────────────

  it('throws a terminal OAuth2InvalidGrantError on 400 invalid_grant, no retry', async () => {
    fetchMock.mockImplementation(alwaysRespond({ error: 'invalid_grant' }, 400));
    const tm = makeManager();

    await expect(accessToken(tm, KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
      OAuth2InvalidGrantError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // no internal retry
  });

  it('surfaces a transient OAuth2RefreshError on a 500', async () => {
    fetchMock.mockImplementation(alwaysRespond({ error: 'server_error' }, 500));
    const tm = makeManager();

    const err = await accessToken(tm, KEY, refreshConfig(), resolveSecret).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect((err as OAuth2RefreshError).status).toBe(500);
    expect((err as OAuth2RefreshError).terminal).toBe(false);
  });

  it('surfaces a transient OAuth2RefreshError on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED to accounts.spotify.com'));
    const tm = makeManager();

    const err = await accessToken(tm, KEY, refreshConfig(), resolveSecret).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect((err as OAuth2RefreshError).status).toBeUndefined();
  });

  it('clears the in-flight latch after a failure so a retry can proceed', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ error: 'server_error' }, 500))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();

    await expect(accessToken(tm, KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
      OAuth2RefreshError,
    );
    // A subsequent call is not stuck on a stale in-flight promise.
    expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret)).toBe(ACCESS_TOKEN);
  });

  it('errors transiently when a required secret is missing', async () => {
    const tm = makeManager();
    const err = await accessToken(tm, KEY, refreshConfig(), () => undefined).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Secret-boundary invariant ─────────────────────────────────────────────

  it('never leaks secret material into thrown error messages', async () => {
    const cases: (() => Promise<unknown>)[] = [];
    const tm = makeManager();

    // invalid_grant
    fetchMock.mockResolvedValueOnce(mockTokenResponse({ error: 'invalid_grant' }, 400));
    cases.push(() => accessToken(tm, KEY, refreshConfig(), resolveSecret));

    // transient 500 with a body that echoes secrets back
    fetchMock.mockResolvedValueOnce(
      mockTokenResponse({ error: 'oops', client_secret: CLIENT_SECRET }, 500),
    );
    cases.push(() =>
      accessToken(tm, { connection: 'spotify', caller: 'c2' }, refreshConfig(), resolveSecret),
    );

    // network error whose message contains a token
    fetchMock.mockRejectedValueOnce(new Error(`failed sending ${REFRESH_TOKEN}`));
    cases.push(() =>
      accessToken(tm, { connection: 'spotify', caller: 'c3' }, refreshConfig(), resolveSecret),
    );

    for (const run of cases) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const text = `${(err as Error).message}\n${(err as Error).stack ?? ''}`;
      for (const secret of ALL_SECRET_VALUES) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('does not leak secrets via the logger', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Force debug-level logging on (the refresh path logs at debug).
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';

    try {
      fetchMock.mockImplementation(
        alwaysRespond({
          access_token: ACCESS_TOKEN,
          expires_in: 3600,
          refresh_token: ROTATED_REFRESH_TOKEN,
        }),
      );
      const tm = makeManager();
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);

      const allLogged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join('\n');
      for (const secret of ALL_SECRET_VALUES) {
        expect(allLogged).not.toContain(secret);
      }
    } finally {
      process.env.LOG_LEVEL = prevLevel;
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // ── Hardening (drawlatch) ─────────────────────────────────────────────────

  describe('scopes', () => {
    it('sends scope on the refresh_token grant, sorted and de-duplicated', async () => {
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'a b' }),
      );
      await accessToken(
        makeManager(),
        KEY,
        refreshConfig({ scopes: ['b', 'a', 'b'] }),
        resolveSecret,
      );
      expect(bodyParams(fetchMock.mock.calls[0]).get('scope')).toBe('a b');
    });

    it('omits scope when none are configured', async () => {
      fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
      await accessToken(makeManager(), KEY, refreshConfig(), resolveSecret);
      expect(bodyParams(fetchMock.mock.calls[0]).has('scope')).toBe(false);
    });

    it('refuses a token whose granted scopes exceed the request, and does not cache it', async () => {
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'read drive.full' }),
      );
      const tm = makeManager();
      const err = await accessToken(
        tm,
        KEY,
        refreshConfig({ scopes: ['read'] }),
        resolveSecret,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuth2ScopeError);
      expect((err as Error).message).toContain('drive.full');
      expect((err as Error).message).not.toContain(ACCESS_TOKEN);
      // Not cached: a later call (after the backoff) asks again.
      clock += OAUTH2_TERMINAL_BACKOFF_MS + 1;
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: 'tok-ok', expires_in: 3600, scope: 'read' }),
      );
      expect(await accessToken(tm, KEY, refreshConfig({ scopes: ['read'] }), resolveSecret)).toBe(
        'tok-ok',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a response without scope when scopes are set (verification on by default)', async () => {
      fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
      await expect(
        accessToken(makeManager(), KEY, refreshConfig({ scopes: ['read'] }), resolveSecret),
      ).rejects.toBeInstanceOf(OAuth2ScopeError);
    });

    it('accepts a response without scope when verifyGrantedScopes is false', async () => {
      fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
      expect(
        await accessToken(
          makeManager(),
          KEY,
          refreshConfig({ scopes: ['read'], verifyGrantedScopes: false }),
          resolveSecret,
        ),
      ).toBe(ACCESS_TOKEN);
    });

    it('still refuses broader scopes when verifyGrantedScopes is false', async () => {
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'read write' }),
      );
      // verifyGrantedScopes:false only tolerates a *missing* scope field.
      await expect(
        accessToken(
          makeManager(),
          KEY,
          refreshConfig({ scopes: ['read'], verifyGrantedScopes: false }),
          resolveSecret,
        ),
      ).rejects.toBeInstanceOf(OAuth2ScopeError);
    });

    it('names the extra scopes on OAuth2ScopeError, with the message unchanged', async () => {
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'read write admin' }),
      );
      const err = await accessToken(
        makeManager(),
        KEY,
        refreshConfig({ scopes: ['read'] }),
        resolveSecret,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuth2ScopeError);
      expect((err as OAuth2ScopeError).extraScopes).toEqual(['admin', 'write']);
      expect((err as Error).message).toBe(
        `OAuth2 token for connection "${KEY.connection}" refused: the token endpoint granted ` +
          'scopes broader than this connection allows (admin, write). Mint a dedicated refresh ' +
          "token with exactly the connection's scopes.",
      );
    });

    it('sets no extraScopes when the refusal is a missing scope field', async () => {
      fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
      const err = await accessToken(
        makeManager(),
        KEY,
        refreshConfig({ scopes: ['read'] }),
        resolveSecret,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuth2ScopeError);
      expect((err as OAuth2ScopeError).extraScopes).toBeUndefined();
    });

    it('allows fewer scopes than requested and reports the missing ones', async () => {
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'read' }),
      );
      const token = await makeManager().getToken(
        KEY,
        refreshConfig({ scopes: ['read', 'write'] }),
        resolveSecret,
      );
      expect(token.grantedScopes).toEqual(['read']);
      expect(token.missingScopes).toEqual(['write']);
    });
  });

  describe('cache identity', () => {
    it('re-mints when the configured refresh token changes (no stale token)', async () => {
      fetchMock
        .mockImplementationOnce(alwaysRespond({ access_token: 'tok-1', expires_in: 3600 }))
        .mockImplementationOnce(alwaysRespond({ access_token: 'tok-2', expires_in: 3600 }));
      const tm = makeManager();
      expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret)).toBe('tok-1');
      const rotatedByAdmin = (name: string) =>
        name === 'SPOTIFY_REFRESH_TOKEN' ? 'admin-new-refresh-token' : secrets[name];
      expect(await accessToken(tm, KEY, refreshConfig(), rotatedByAdmin)).toBe('tok-2');
    });

    it('re-mints when the scopes change', async () => {
      fetchMock
        .mockImplementationOnce(
          alwaysRespond({ access_token: 'tok-1', expires_in: 3600, scope: 'a' }),
        )
        .mockImplementationOnce(
          alwaysRespond({ access_token: 'tok-2', expires_in: 3600, scope: 'b' }),
        );
      const tm = makeManager();
      expect(await accessToken(tm, KEY, refreshConfig({ scopes: ['a'] }), resolveSecret)).toBe(
        'tok-1',
      );
      expect(await accessToken(tm, KEY, refreshConfig({ scopes: ['b'] }), resolveSecret)).toBe(
        'tok-2',
      );
    });

    it('drops a rotated refresh token once the configured one changes', async () => {
      fetchMock
        .mockImplementationOnce(
          alwaysRespond({
            access_token: 'tok-1',
            expires_in: 3600,
            refresh_token: ROTATED_REFRESH_TOKEN,
          }),
        )
        .mockImplementation(alwaysRespond({ access_token: 'tok-2', expires_in: 3600 }));
      const tm = makeManager();
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);
      const reconfigured = (name: string) =>
        name === 'SPOTIFY_REFRESH_TOKEN' ? 'admin-new-refresh-token' : secrets[name];
      await accessToken(tm, KEY, refreshConfig(), reconfigured, { forceRefresh: true });
      expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(
        'admin-new-refresh-token',
      );
    });

    it('requires a caller identity', async () => {
      const err = await accessToken(
        makeManager(),
        { connection: 'spotify', caller: '' },
        refreshConfig(),
        resolveSecret,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuth2RefreshError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('terminal backoff', () => {
    it('remembers a terminal failure instead of calling the endpoint again', async () => {
      fetchMock.mockImplementation(alwaysRespond({ error: 'invalid_grant' }, 400));
      const tm = makeManager();
      await expect(accessToken(tm, KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
        OAuth2InvalidGrantError,
      );
      await expect(
        accessToken(tm, KEY, refreshConfig(), resolveSecret, { forceRefresh: true }),
      ).rejects.toBeInstanceOf(OAuth2InvalidGrantError);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      clock += OAUTH2_TERMINAL_BACKOFF_MS + 1;
      await expect(accessToken(tm, KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
        OAuth2InvalidGrantError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a new credential is tried straight away', async () => {
      fetchMock
        .mockImplementationOnce(alwaysRespond({ error: 'invalid_grant' }, 400))
        .mockImplementationOnce(alwaysRespond({ access_token: 'tok-new', expires_in: 3600 }));
      const tm = makeManager();
      await expect(accessToken(tm, KEY, refreshConfig(), resolveSecret)).rejects.toThrow();
      const fixed = (name: string) =>
        name === 'SPOTIFY_REFRESH_TOKEN' ? 'freshly-consented-token' : secrets[name];
      expect(await accessToken(tm, KEY, refreshConfig(), fixed)).toBe('tok-new');
    });

    it('does not back off after a transient failure', async () => {
      fetchMock
        .mockImplementationOnce(alwaysRespond({}, 503))
        .mockImplementationOnce(alwaysRespond({ access_token: 'tok', expires_in: 3600 }));
      const tm = makeManager();
      await expect(accessToken(tm, KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
        OAuth2RefreshError,
      );
      expect(await accessToken(tm, KEY, refreshConfig(), resolveSecret)).toBe('tok');
    });
  });

  describe('transport', () => {
    it("gives up on its own deadline without cancelling a joined caller's wait", async () => {
      vi.useFakeTimers();
      try {
        let resolveFetch!: (r: Response) => void;
        fetchMock.mockReturnValue(
          new Promise<Response>((res) => {
            resolveFetch = res;
          }),
        );
        const tm = makeManager();
        const impatient = accessToken(tm, KEY, refreshConfig(), resolveSecret, {
          timeoutMs: 50,
        }).catch((e: unknown) => e);
        const patient = accessToken(tm, KEY, refreshConfig(), resolveSecret, {
          timeoutMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(60);
        const err = await impatient;
        expect(err).toBeInstanceOf(OAuth2RefreshError);
        expect((err as Error).message).toContain('within 50ms');

        resolveFetch(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
        expect(await patient).toBe(ACCESS_TOKEN);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never waits longer than OAUTH2_TOKEN_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockReturnValue(new Promise<Response>(() => undefined));
        const pending = accessToken(makeManager(), KEY, refreshConfig(), resolveSecret, {
          timeoutMs: 10 * 60_000,
        }).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(OAUTH2_TOKEN_TIMEOUT_MS + 1);
        expect(await pending).toBeInstanceOf(OAuth2RefreshError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes a timeout signal to the token request', async () => {
      fetchMock.mockImplementation(alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
      await accessToken(makeManager(), KEY, refreshConfig(), resolveSecret);
      const init = fetchMock.mock.calls[0][1]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe('manual');
    });

    it('does not follow a redirect from the token endpoint', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.example/token' } }),
        ),
      );
      const err = await accessToken(makeManager(), KEY, refreshConfig(), resolveSecret).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OAuth2RefreshError);
      expect((err as OAuth2RefreshError).status).toBe(302);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('caps the response body', async () => {
      const big = JSON.stringify({
        access_token: ACCESS_TOKEN,
        expires_in: 3600,
        pad: 'x'.repeat(OAUTH2_TOKEN_RESPONSE_MAX_BYTES),
      });
      // No content-length: the streaming cap has to catch it.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(big));
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      );
      const err = await accessToken(makeManager(), KEY, refreshConfig(), resolveSecret).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OAuth2RefreshError);
      expect((err as Error).message).toContain('exceeds');
    });

    it('refuses a non-Bearer token_type and a token that cannot be a header value', async () => {
      for (const body of [
        { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'mac' },
        { access_token: `${ACCESS_TOKEN}\r\nX-Evil: 1`, expires_in: 3600 },
        { access_token: ACCESS_TOKEN },
      ]) {
        fetchMock.mockImplementation(alwaysRespond(body));
        await expect(
          accessToken(makeManager(), KEY, refreshConfig(), resolveSecret),
        ).rejects.toBeInstanceOf(OAuth2RefreshError);
      }
    });
  });

  describe('error classification', () => {
    const codes = [
      'invalid_grant',
      'invalid_scope',
      'invalid_client',
      'unauthorized_client',
      'access_denied',
      'admin_policy_enforced',
    ];

    it.each(codes)('%s is terminal and reported by code only', async (code) => {
      fetchMock.mockImplementation(
        alwaysRespond(
          {
            error: code,
            error_description: `echo ${CLIENT_SECRET} ${REFRESH_TOKEN} ${CLIENT_ID}`,
          },
          code === 'invalid_client' ? 401 : 400,
        ),
      );
      const err = await accessToken(
        makeManager(),
        KEY,
        refreshConfig({ clientAuth: 'body' }),
        resolveSecret,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuth2TerminalError);
      expect((err as OAuth2TerminalError).oauth2Error).toBe(code);
      const text = `${(err as Error).message}\n${(err as Error).stack ?? ''}`;
      expect(text).toContain(code);
      for (const secret of ALL_SECRET_VALUES) expect(text).not.toContain(secret);
    });

    it("recognises Google's error_subtype invalid_rapt", async () => {
      fetchMock.mockImplementation(
        alwaysRespond({ error: 'invalid_grant', error_subtype: 'invalid_rapt' }, 400),
      );
      const err = await accessToken(makeManager(), KEY, refreshConfig(), resolveSecret).catch(
        (e: unknown) => e,
      );
      expect((err as OAuth2TerminalError).oauth2Error).toBe('invalid_rapt');
      expect((err as OAuth2TerminalError).terminal).toBe(true);
    });

    it('does not echo an unrecognised error code', async () => {
      fetchMock.mockImplementation(alwaysRespond({ error: `weird_${CLIENT_SECRET}` }, 400));
      const err = await accessToken(makeManager(), KEY, refreshConfig(), resolveSecret).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OAuth2RefreshError);
      expect((err as Error).message).not.toContain('weird');
    });
  });

  describe('shared refresh tokens and rotation', () => {
    /** A provider that rotates on every refresh and rejects a reused token. */
    function rotatingProvider() {
      let current = REFRESH_TOKEN;
      let n = 0;
      fetchMock.mockImplementation((_url, init) => {
        const sent = new URLSearchParams(init?.body as string).get('refresh_token');
        if (sent !== current) {
          return Promise.resolve(mockTokenResponse({ error: 'invalid_grant' }, 400));
        }
        n++;
        current = `rotated-${n}`;
        return Promise.resolve(
          mockTokenResponse({ access_token: `tok-${n}`, expires_in: 3600, refresh_token: current }),
        );
      });
    }

    it('serializes concurrent refreshes that share a refresh token', async () => {
      rotatingProvider();
      const tm = makeManager();
      const results = await Promise.all([
        accessToken(tm, { connection: 'spotify', caller: 'alice' }, refreshConfig(), resolveSecret),
        accessToken(tm, { connection: 'spotify', caller: 'bob' }, refreshConfig(), resolveSecret),
        accessToken(
          tm,
          { connection: 'spotify-other', caller: 'alice' },
          refreshConfig({ scopes: ['x'], verifyGrantedScopes: false }),
          resolveSecret,
        ),
      ]);
      expect(results.sort()).toEqual(['tok-1', 'tok-2', 'tok-3']);
      // Each request sent the token the previous one rotated to.
      expect(fetchMock.mock.calls.map((c) => bodyParams(c).get('refresh_token'))).toEqual([
        REFRESH_TOKEN,
        'rotated-1',
        'rotated-2',
      ]);
    });

    it('does not serialize client_credentials grants', async () => {
      const resolvers: ((r: Response) => void)[] = [];
      fetchMock.mockImplementation(
        () => new Promise<Response>((resolve) => resolvers.push(resolve)),
      );
      const tm = makeManager();
      const a = accessToken(
        tm,
        { connection: 'c', caller: 'alice' },
        clientCredsConfig(),
        resolveSecret,
      );
      const b = accessToken(
        tm,
        { connection: 'c', caller: 'bob' },
        clientCredsConfig(),
        resolveSecret,
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      for (const r of resolvers) r(mockTokenResponse({ access_token: 'cc', expires_in: 3600 }));
      expect(await Promise.all([a, b])).toEqual(['cc', 'cc']);
    });
  });

  describe('401-driven re-mints', () => {
    it('skips the re-mint for a token younger than OAUTH2_MIN_REMINT_INTERVAL_MS', async () => {
      fetchMock.mockImplementation(alwaysRespond({ access_token: 'tok', expires_in: 3600 }));
      const tm = makeManager();
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);
      clock += OAUTH2_MIN_REMINT_INTERVAL_MS - 1;
      const t = await accessToken(tm, KEY, refreshConfig(), resolveSecret, {
        forceRefresh: true,
        rejectedToken: 'tok',
      });
      expect(t).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips the re-mint when the rejected token was already replaced', async () => {
      fetchMock
        .mockImplementationOnce(alwaysRespond({ access_token: 'old', expires_in: 3600 }))
        .mockImplementationOnce(alwaysRespond({ access_token: 'new', expires_in: 3600 }));
      const tm = makeManager();
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);
      clock += OAUTH2_MIN_REMINT_INTERVAL_MS;
      await accessToken(tm, KEY, refreshConfig(), resolveSecret, {
        forceRefresh: true,
        rejectedToken: 'old',
      });
      clock += OAUTH2_MIN_REMINT_INTERVAL_MS;
      // A late 401 for "old" must not throw away "new".
      expect(
        await accessToken(tm, KEY, refreshConfig(), resolveSecret, {
          forceRefresh: true,
          rejectedToken: 'old',
        }),
      ).toBe('new');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('refresh skew', () => {
    it('clamps the skew to half the token lifetime', async () => {
      // 120s tokens against the default 300s skew: without the clamp every
      // call would mint.
      fetchMock.mockImplementation(alwaysRespond({ access_token: 'short', expires_in: 120 }));
      const tm = makeManager();
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);
      clock += 59_000;
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      clock += 2_000; // past half the lifetime
      await accessToken(tm, KEY, refreshConfig(), resolveSecret);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(DEFAULT_OAUTH2_REFRESH_SKEW_MS).toBeGreaterThan(60_000);
    });

    it.each([
      ['verifyGrantedScopes', { scopes: ['a'], verifyGrantedScopes: false }],
      ['refreshSkewMs', { refreshSkewMs: 1_000 }],
    ])('changing %s mints a new token instead of reusing the cached one', async (_k, patch) => {
      fetchMock.mockImplementation(
        alwaysRespond({ access_token: ACCESS_TOKEN, expires_in: 3600, scope: 'a' }),
      );
      const tm = makeManager();
      const base = patch.scopes ? { scopes: ['a'] } : {};
      await accessToken(tm, KEY, refreshConfig(base), resolveSecret);
      await accessToken(tm, KEY, refreshConfig(patch), resolveSecret);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('forgets rotated refresh tokens that go unused', async () => {
    fetchMock
      .mockImplementationOnce(
        alwaysRespond({
          access_token: 't1',
          expires_in: 3600,
          refresh_token: ROTATED_REFRESH_TOKEN,
        }),
      )
      .mockImplementation(alwaysRespond({ access_token: 't2', expires_in: 3600 }));
    const tm = makeManager();
    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    clock += 31 * 24 * 60 * 60 * 1000;
    await accessToken(tm, KEY, refreshConfig(), resolveSecret);
    expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(REFRESH_TOKEN);
  });
});

describe('error codes are matched as own properties only', () => {
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'treats error "%s" as unrecognised (transient), with no native source in the message',
    async (code) => {
      const tm = new TokenManager({
        fetchImpl: alwaysRespond({ error: code, error_description: 'x' }, 400) as typeof fetch,
      });
      for (const config of [
        refreshConfig(),
        {
          tokenUrl: 'https://oauth2.googleapis.com/token',
          grant: 'jwt_bearer' as const,
          secretRefs: { serviceAccountKey: 'SA' },
          scopes: ['s'],
        },
      ]) {
        let error: unknown;
        try {
          await tm.getToken(
            KEY,
            config,
            config.grant === 'jwt_bearer' ? () => SA_KEY_B64 : resolveSecret,
          );
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(OAuth2RefreshError);
        expect((error as OAuth2RefreshError).terminal).toBe(false);
        const message = (error as Error).message;
        expect(message).toContain('HTTP 400');
        expect(message).not.toMatch(/native code|function|\[object/);
        expect(message).not.toContain(code);
      }
    },
  );
});

const SA_KEY_B64 = Buffer.from(
  JSON.stringify({
    type: 'service_account',
    client_email: 'robot@proj.iam.gserviceaccount.com',
    private_key: crypto
      .generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
).toString('base64');
