/**
 * Unit tests for the generic OAuth2 TokenManager (Card 2).
 *
 * Drives an injected fetch + clock for determinism. Asserts cache behaviour,
 * single-flight coalescing, refresh-token rotation, both grant flows, both
 * client-auth modes, terminal vs transient errors, per-key isolation,
 * forceRefresh, and — critically — that no secret material leaks into thrown
 * error messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TokenManager,
  OAuth2InvalidGrantError,
  OAuth2RefreshError,
  DEFAULT_REFRESH_SKEW_MS,
  type TokenKey,
} from './token-manager.js';
import type { OAuth2Config } from '../../shared/config.js';

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
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
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
  let fetchMock: ReturnType<typeof vi.fn>;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
    fetchMock = vi.fn();
  });

  function makeManager(): TokenManager {
    return new TokenManager({ fetchImpl: fetchMock as unknown as typeof fetch, now });
  }

  // ── Caching ─────────────────────────────────────────────────────────────

  it('refreshes on a cold cache then serves a cached token without re-fetching', async () => {
    fetchMock.mockResolvedValue(
      mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const tm = makeManager();

    const first = await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    expect(first).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance well within validity (skew default 300s, token lives 3600s).
    clock += 1000 * 1000; // +1000s → 2000s remaining > skew
    const second = await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    expect(second).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit, no new fetch
  });

  it('refreshes once the token is within the skew window of expiry', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    expect(await tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).toBe('tok-1');

    // Move to inside the skew window: now + skew >= expiresAt.
    clock += 3600 * 1000 - DEFAULT_REFRESH_SKEW_MS + 1;
    expect(await tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours a custom refreshSkewMs from the config', async () => {
    fetchMock.mockResolvedValue(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 100 }));
    const tm = makeManager();
    const cfg = refreshConfig({ refreshSkewMs: 10_000 }); // 10s skew, 100s token

    await tm.getAccessToken(KEY, cfg, resolveSecret);
    // 95s later: 5s remaining < 10s skew → stale.
    clock += 95_000;
    await tm.getAccessToken(KEY, cfg, resolveSecret);
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
      Array.from({ length: 8 }, () => tm.getAccessToken(KEY, refreshConfig(), resolveSecret)),
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

    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    clock += 2000; // expired
    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── forceRefresh ─────────────────────────────────────────────────────────

  it('forceRefresh bypasses a still-valid cached token', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    expect(await tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).toBe('tok-1');
    expect(
      await tm.getAccessToken(KEY, refreshConfig(), resolveSecret, { forceRefresh: true }),
    ).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh joins an in-flight refresh (still single-flight)', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValue(pending);
    const tm = makeManager();

    const a = tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    const b = tm.getAccessToken(KEY, refreshConfig(), resolveSecret, { forceRefresh: true });
    await Promise.resolve();
    resolveFetch(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }));

    expect(await a).toBe(ACCESS_TOKEN);
    expect(await b).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next call to refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    tm.invalidate(KEY);
    expect(await tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    // First refresh used the configured secret.
    expect(bodyParams(fetchMock.mock.calls[0]).get('refresh_token')).toBe(REFRESH_TOKEN);

    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret, { forceRefresh: true });
    // Second refresh used the rotated token from response #1.
    expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(ROTATED_REFRESH_TOKEN);
  });

  it('keeps the prior refresh token when the response omits one', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-2', expires_in: 3600 }));
    const tm = makeManager();

    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret, { forceRefresh: true });
    // Both refreshes used the original configured secret (no rotation seen).
    expect(bodyParams(fetchMock.mock.calls[0]).get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(REFRESH_TOKEN);
  });

  // ── Request shape ─────────────────────────────────────────────────────────

  it('refresh_token grant with basic auth produces the exact request shape', async () => {
    fetchMock.mockResolvedValue(
      mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const tm = makeManager();

    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);

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
    fetchMock.mockResolvedValue(
      mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const tm = makeManager();

    await tm.getAccessToken(KEY, refreshConfig({ clientAuth: 'body' }), resolveSecret);

    expect(headers(fetchMock.mock.calls[0]).Authorization).toBeUndefined();
    const params = bodyParams(fetchMock.mock.calls[0]);
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('client_credentials grant omits refresh_token and joins scopes', async () => {
    fetchMock.mockResolvedValue(
      mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const tm = makeManager();
    const catalogKey: TokenKey = { connection: 'spotify-catalog', caller: 'default' };

    await tm.getAccessToken(
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
    fetchMock.mockResolvedValue(
      mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const tm = makeManager();
    await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);
    const ct = headers(fetchMock.mock.calls[0])['Content-Type'];
    expect(ct).not.toContain('json');
  });

  // ── Response mapping ──────────────────────────────────────────────────────

  it('honours responseMapping field overrides', async () => {
    fetchMock.mockResolvedValue(
      mockTokenResponse({ tok: ACCESS_TOKEN, ttl: 3600, newRt: ROTATED_REFRESH_TOKEN }),
    );
    const tm = makeManager();
    const cfg = refreshConfig({
      responseMapping: {
        accessTokenField: 'tok',
        expiresInField: 'ttl',
        refreshTokenField: 'newRt',
      },
    });

    expect(await tm.getAccessToken(KEY, cfg, resolveSecret)).toBe(ACCESS_TOKEN);
    await tm.getAccessToken(KEY, cfg, resolveSecret, { forceRefresh: true });
    expect(bodyParams(fetchMock.mock.calls[1]).get('refresh_token')).toBe(ROTATED_REFRESH_TOKEN);
  });

  // ── Per-key isolation ─────────────────────────────────────────────────────

  it('keeps independent cache entries per (connection, caller)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-A', expires_in: 3600 }))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: 'tok-B', expires_in: 3600 }));
    const tm = makeManager();

    const a = await tm.getAccessToken(
      { connection: 'spotify', caller: 'alice' },
      refreshConfig(),
      resolveSecret,
    );
    const b = await tm.getAccessToken(
      { connection: 'spotify', caller: 'bob' },
      refreshConfig(),
      resolveSecret,
    );

    expect(a).toBe('tok-A');
    expect(b).toBe('tok-B');
    expect(fetchMock).toHaveBeenCalledTimes(2); // two distinct callers → two fetches
  });

  it('treats the same connection for two callers as separate keys', async () => {
    fetchMock.mockResolvedValue(
      mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const tm = makeManager();

    await tm.getAccessToken(
      { connection: 'spotify', caller: 'alice' },
      refreshConfig(),
      resolveSecret,
    );
    await tm.getAccessToken(
      { connection: 'spotify', caller: 'bob' },
      refreshConfig(),
      resolveSecret,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // alice's cached token is reused; no third fetch.
    await tm.getAccessToken(
      { connection: 'spotify', caller: 'alice' },
      refreshConfig(),
      resolveSecret,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Errors ──────────────────────────────────────────────────────────────

  it('throws a terminal OAuth2InvalidGrantError on 400 invalid_grant, no retry', async () => {
    fetchMock.mockResolvedValue(mockTokenResponse({ error: 'invalid_grant' }, 400));
    const tm = makeManager();

    await expect(tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
      OAuth2InvalidGrantError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // no internal retry
  });

  it('surfaces a transient OAuth2RefreshError on a 500', async () => {
    fetchMock.mockResolvedValue(mockTokenResponse({ error: 'server_error' }, 500));
    const tm = makeManager();

    const err = await tm
      .getAccessToken(KEY, refreshConfig(), resolveSecret)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect((err as OAuth2RefreshError).status).toBe(500);
    expect((err as OAuth2RefreshError).terminal).toBe(false);
  });

  it('surfaces a transient OAuth2RefreshError on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED to accounts.spotify.com'));
    const tm = makeManager();

    const err = await tm
      .getAccessToken(KEY, refreshConfig(), resolveSecret)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect((err as OAuth2RefreshError).status).toBeUndefined();
  });

  it('clears the in-flight latch after a failure so a retry can proceed', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse({ error: 'server_error' }, 500))
      .mockResolvedValueOnce(mockTokenResponse({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    const tm = makeManager();

    await expect(tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).rejects.toBeInstanceOf(
      OAuth2RefreshError,
    );
    // A subsequent call is not stuck on a stale in-flight promise.
    expect(await tm.getAccessToken(KEY, refreshConfig(), resolveSecret)).toBe(ACCESS_TOKEN);
  });

  it('errors transiently when a required secret is missing', async () => {
    const tm = makeManager();
    const err = await tm
      .getAccessToken(KEY, refreshConfig(), () => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Secret-boundary invariant ─────────────────────────────────────────────

  it('never leaks secret material into thrown error messages', async () => {
    const cases: (() => Promise<unknown>)[] = [];
    const tm = makeManager();

    // invalid_grant
    fetchMock.mockResolvedValueOnce(mockTokenResponse({ error: 'invalid_grant' }, 400));
    cases.push(() => tm.getAccessToken(KEY, refreshConfig(), resolveSecret));

    // transient 500 with a body that echoes secrets back
    fetchMock.mockResolvedValueOnce(
      mockTokenResponse({ error: 'oops', client_secret: CLIENT_SECRET }, 500),
    );
    cases.push(() =>
      tm.getAccessToken({ connection: 'spotify', caller: 'c2' }, refreshConfig(), resolveSecret),
    );

    // network error whose message contains a token
    fetchMock.mockRejectedValueOnce(new Error(`failed sending ${REFRESH_TOKEN}`));
    cases.push(() =>
      tm.getAccessToken({ connection: 'spotify', caller: 'c3' }, refreshConfig(), resolveSecret),
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
      fetchMock.mockResolvedValue(
        mockTokenResponse({
          access_token: ACCESS_TOKEN,
          expires_in: 3600,
          refresh_token: ROTATED_REFRESH_TOKEN,
        }),
      );
      const tm = makeManager();
      await tm.getAccessToken(KEY, refreshConfig(), resolveSecret);

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
});
