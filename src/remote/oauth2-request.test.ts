/**
 * OAuth2 routes on the request path (executeProxyRequest, list_routes,
 * test_connection), against real local token and API servers.
 *
 * Request-path behaviour ported from PR #26 (Card 3) as the spec: the minted
 * token is injected, a 401 triggers exactly one re-mint and resend, other
 * statuses are not retried. Plus the drawlatch rules: credentials are
 * signer-only, the minted token is scrubbed, caller-supplied Authorization /
 * access_token are refused, and one deadline spans minting and the API call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  OAUTH2_MIN_REMINT_INTERVAL_MS,
  resolveRoutes,
  type ResolvedRoute,
  type Route,
} from '../shared/config.js';
import { dispatchTool, executeProxyRequest, type ToolContext } from './tool-dispatch.js';
import { TokenManager } from './oauth/token-manager.js';
import { resetSharedTokenManager, setSharedTokenManager } from './oauth/shared-token-manager.js';

const CLIENT_ID = 'sentinel-client-id-1111';
const CLIENT_SECRET = 'sentinel-client-secret-2222';
const REFRESH_TOKEN = 'sentinel-refresh-token-3333';
const CREDENTIALS = [CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN];

interface TokenRequest {
  params: URLSearchParams;
  authorization?: string;
}
interface ApiRequest {
  url: string;
  authorization?: string;
  body: string;
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('oauth2 routes on the request path', () => {
  let tokenServer: http.Server;
  let apiServer: http.Server;
  let otherServer: http.Server;
  let tokenBase: string;
  let apiBase: string;
  let otherBase: string;

  let tokenRequests: TokenRequest[] = [];
  let apiRequests: ApiRequest[] = [];
  let otherRequests: ApiRequest[] = [];
  /** Token endpoint behaviour for the current test. */
  let tokenMode: 'ok' | 'invalid_grant' | 'broad-scope' = 'ok';
  let tokenDelayMs = 0;
  /** Tokens the API rejects with 401. */
  let revoked = new Set<string>();
  let apiDelayMs = 0;
  /** Added to the token manager's clock, to step past OAUTH2_MIN_REMINT_INTERVAL_MS. */
  let clockOffsetMs = 0;

  beforeAll(async () => {
    ({ server: tokenServer, base: tokenBase } = await listen((req, res) => {
      void (async () => {
        const params = new URLSearchParams(await readBody(req));
        tokenRequests.push({ params, authorization: req.headers.authorization });
        if (tokenDelayMs) await sleep(tokenDelayMs);
        res.setHeader('content-type', 'application/json');
        if (tokenMode === 'invalid_grant') {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: `bad ${params.get('refresh_token')} ${params.get('client_secret')}`,
            }),
          );
          return;
        }
        const scope = params.get('scope') ?? '';
        res.end(
          JSON.stringify({
            access_token: `minted-access-token-${tokenRequests.length}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: tokenMode === 'broad-scope' ? `${scope} admin` : scope,
          }),
        );
      })();
    }));

    ({ server: apiServer, base: apiBase } = await listen((req, res) => {
      void (async () => {
        const body = await readBody(req);
        const authorization = req.headers.authorization;
        apiRequests.push({ url: req.url!, authorization, body });
        if (apiDelayMs) await sleep(apiDelayMs);
        const token = authorization?.replace(/^Bearer /, '') ?? '';
        if (req.url!.startsWith('/api/forbidden')) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        if (req.url!.startsWith('/api/redirect')) {
          res.statusCode = 302;
          res.setHeader('location', `${otherBase}/other/landing`);
          res.end();
          return;
        }
        if (req.url!.startsWith('/api/always401') || revoked.has(token)) {
          res.statusCode = 401;
          res.end('unauthorized');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-echo-token', token);
        res.end(JSON.stringify({ ok: true, youSent: authorization, token, body }));
      })();
    }));

    ({ server: otherServer, base: otherBase } = await listen((req, res) => {
      otherRequests.push({ url: req.url!, authorization: req.headers.authorization, body: '' });
      res.end('landed');
    }));
  });

  afterAll(async () => {
    for (const s of [tokenServer, apiServer, otherServer]) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    resetSharedTokenManager();
  });

  beforeEach(() => {
    tokenRequests = [];
    apiRequests = [];
    otherRequests = [];
    tokenMode = 'ok';
    tokenDelayMs = 0;
    apiDelayMs = 0;
    revoked = new Set();
    clockOffsetMs = 0;
    setSharedTokenManager(new TokenManager({ now: () => Date.now() + clockOffsetMs }));
  });

  function routeDef(overrides: Partial<Route> = {}): Route {
    return {
      alias: 'svc',
      name: 'Service',
      allowedEndpoints: [`${apiBase}/api/**`, `${otherBase}/other/**`],
      secrets: {
        SVC_CLIENT_ID: CLIENT_ID,
        SVC_CLIENT_SECRET: CLIENT_SECRET,
        SVC_REFRESH_TOKEN: REFRESH_TOKEN,
        SVC_REGION: 'eu-west-9',
      },
      oauth2: {
        tokenUrl: `${tokenBase}/token`,
        grant: 'refresh_token',
        clientAuth: 'body',
        secretRefs: {
          clientId: 'SVC_CLIENT_ID',
          clientSecret: 'SVC_CLIENT_SECRET',
          refreshToken: 'SVC_REFRESH_TOKEN',
        },
        scopes: ['read', 'calendar'],
      },
      testConnection: { method: 'GET', url: `${apiBase}/api/whoami`, description: 'whoami' },
      ...overrides,
    };
  }

  function routes(overrides: Partial<Route> = {}): ResolvedRoute[] {
    return resolveRoutes([routeDef(overrides)], {}, 'alice');
  }

  const context = (callerAlias = 'alice'): ToolContext =>
    ({
      callerAlias,
      origin: 'agent',
      ingestorManager: {} as ToolContext['ingestorManager'],
      refreshRoutes: () => undefined,
    }) as ToolContext;

  const GET = (path: string, extra: Record<string, unknown> = {}) => ({
    method: 'GET',
    url: `${apiBase}${path}`,
    ...extra,
  });

  function expectNoCredentials(value: unknown) {
    const text = JSON.stringify(value);
    for (const secret of CREDENTIALS) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/minted-access-token-\d/);
  }

  it('injects the minted token and scrubs it from the response', async () => {
    const result = await executeProxyRequest(GET('/api/items'), routes(), undefined, {
      caller: 'alice',
    });
    expect(result.status).toBe(200);
    expect(apiRequests[0].authorization).toBe('Bearer minted-access-token-1');
    expect(tokenRequests[0].params.get('scope')).toBe('calendar read');
    expect(tokenRequests[0].params.get('client_secret')).toBe(CLIENT_SECRET);
    // The upstream echoes the token in its body and a header: both scrubbed.
    expect(result.body).toMatchObject({ youSent: 'Bearer ${OAUTH2_ACCESS_TOKEN}' });
    expect(result.headers['x-echo-token']).toBe('${OAUTH2_ACCESS_TOKEN}');
    expectNoCredentials(result);
  });

  it('reuses the cached token across requests', async () => {
    await executeProxyRequest(GET('/api/a'), routes(), undefined, { caller: 'alice' });
    await executeProxyRequest(GET('/api/b'), routes(), undefined, { caller: 'alice' });
    expect(tokenRequests).toHaveLength(1);
  });

  it('mints separately per caller', async () => {
    await executeProxyRequest(GET('/api/a'), routes(), undefined, { caller: 'alice' });
    await executeProxyRequest(GET('/api/a'), routes(), undefined, { caller: 'bob' });
    expect(tokenRequests).toHaveLength(2);
    expect(apiRequests[0].authorization).not.toBe(apiRequests[1].authorization);
  });

  it('refuses without a caller identity', async () => {
    await expect(executeProxyRequest(GET('/api/a'), routes())).rejects.toThrow(/caller/);
    expect(tokenRequests).toHaveLength(0);
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    'rejects a client-supplied %s header without minting',
    async (name) => {
      await expect(
        executeProxyRequest(
          GET('/api/a', { headers: { [name]: 'Bearer mine' } }),
          routes(),
          undefined,
          { caller: 'alice' },
        ),
      ).rejects.toThrow(/set by drawlatch on this OAuth2 route/);
      expect(tokenRequests).toHaveLength(0);
      expect(apiRequests).toHaveLength(0);
    },
  );

  it.each(['access_token', 'ACCESS_TOKEN'])('rejects a %s query parameter', async (param) => {
    await expect(
      executeProxyRequest(GET(`/api/a?${param}=mine`), routes(), undefined, { caller: 'alice' }),
    ).rejects.toThrow(/not allowed on an OAuth2 route/);
    expect(apiRequests).toHaveLength(0);
  });

  it.each(['SVC_CLIENT_ID', 'SVC_CLIENT_SECRET', 'SVC_REFRESH_TOKEN'])(
    'rejects ${%s} in the URL and headers',
    async (name) => {
      await expect(
        executeProxyRequest(GET(`/api/files/\${${name}}`), routes(), undefined, {
          caller: 'alice',
        }),
      ).rejects.toThrow(/an OAuth2 credential of this route/);
      await expect(
        executeProxyRequest(
          GET('/api/a', { headers: { 'X-Echo': `\${${name}}` } }),
          routes(),
          undefined,
          { caller: 'alice' },
        ),
      ).rejects.toThrow(/an OAuth2 credential of this route/);
      expect(apiRequests).toHaveLength(0);
    },
  );

  it('never resolves a credential placeholder in a body', async () => {
    const result = await executeProxyRequest(
      { method: 'POST', url: `${apiBase}/api/notes`, body: 'note: ${SVC_REFRESH_TOKEN}' },
      routes(),
      undefined,
      { caller: 'alice' },
    );
    // oauth2 routes can't set resolveSecretsInBody, so the body goes as written.
    expect(apiRequests[0].body).toBe('note: ${SVC_REFRESH_TOKEN}');
    expectNoCredentials(result);
  });

  it('on 401 re-mints and resends exactly once', async () => {
    await executeProxyRequest(GET('/api/a'), routes(), undefined, { caller: 'alice' });
    revoked.add('minted-access-token-1');
    clockOffsetMs += OAUTH2_MIN_REMINT_INTERVAL_MS;
    const result = await executeProxyRequest(
      { method: 'POST', url: `${apiBase}/api/notes`, body: { n: 1 } },
      routes(),
      undefined,
      { caller: 'alice' },
    );
    expect(result.status).toBe(200);
    expect(tokenRequests).toHaveLength(2);
    expect(apiRequests.slice(1).map((r) => r.authorization)).toEqual([
      'Bearer minted-access-token-1',
      'Bearer minted-access-token-2',
    ]);
    // The body was resent intact.
    expect(apiRequests[2].body).toBe('{"n":1}');
    expectNoCredentials(result);
  });

  it('refuses a control-character path trick without minting', async () => {
    await expect(
      executeProxyRequest(GET('/api/.\t./.\t./admin'), routes(), undefined, { caller: 'alice' }),
    ).rejects.toThrow(/control character/);
    expect(tokenRequests).toHaveLength(0);
    expect(apiRequests).toHaveLength(0);
  });

  it('a 401 on a freshly minted token is returned without re-minting', async () => {
    // An agent can make any allowlisted URL answer 401; it must not be able to
    // turn that into a token-endpoint call per request.
    for (let i = 0; i < 3; i++) {
      const result = await executeProxyRequest(GET('/api/always401'), routes(), undefined, {
        caller: 'alice',
      });
      expect(result.status).toBe(401);
    }
    expect(tokenRequests).toHaveLength(1);
    expect(apiRequests).toHaveLength(3);
  });

  it('does not loop on a persistent 401', async () => {
    await executeProxyRequest(GET('/api/a'), routes(), undefined, { caller: 'alice' });
    clockOffsetMs += OAUTH2_MIN_REMINT_INTERVAL_MS;
    const result = await executeProxyRequest(GET('/api/always401'), routes(), undefined, {
      caller: 'alice',
    });
    expect(result.status).toBe(401);
    expect(apiRequests).toHaveLength(3); // the first request, the 401, one resend
    expect(tokenRequests).toHaveLength(2); // the first mint, one re-mint, never a third
  });

  it('does not retry a 403, and hints at the scopes', async () => {
    const result = await executeProxyRequest(GET('/api/forbidden'), routes(), undefined, {
      caller: 'alice',
    });
    expect(result.status).toBe(403);
    expect(apiRequests).toHaveLength(1);
    expect(tokenRequests).toHaveLength(1);
    expect(result.hint).toContain('calendar, read');
  });

  it('does not forward the token on a cross-origin redirect', async () => {
    const result = await executeProxyRequest(GET('/api/redirect'), routes(), undefined, {
      caller: 'alice',
    });
    expect(result.status).toBe(200);
    expect(otherRequests).toHaveLength(1);
    expect(otherRequests[0].authorization).toBeUndefined();
  });

  it('reports a token failure by code, without credentials', async () => {
    tokenMode = 'invalid_grant';
    const err = await executeProxyRequest(GET('/api/a'), routes(), undefined, {
      caller: 'alice',
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/svc.*invalid_grant/);
    expectNoCredentials((err as Error).message);
    expect(apiRequests).toHaveLength(0);
  });

  it('refuses a token with broader scopes than requested', async () => {
    tokenMode = 'broad-scope';
    await expect(
      executeProxyRequest(GET('/api/a'), routes(), undefined, { caller: 'alice' }),
    ).rejects.toThrow(/broader than this connection allows \(admin\)/);
    expect(apiRequests).toHaveLength(0);
  });

  // Timing: the API answers in 450ms. With the full 600ms it would succeed;
  // with what a 300ms mint leaves (~300ms) it can't. No wall-clock assertion,
  // so a slow machine can't flake it: only "did it time out" is checked, and
  // the control case shows 600ms on its own is enough.
  it('spends one deadline across minting and the API call', async () => {
    apiDelayMs = 450;
    await executeProxyRequest(GET('/api/warm'), routes(), undefined, { caller: 'alice' });
    // Control: token cached, the API call alone fits in 600ms.
    await expect(
      executeProxyRequest(GET('/api/a', { timeoutMs: 600 }), routes(), undefined, {
        caller: 'alice',
      }),
    ).resolves.toMatchObject({ status: 200 });
    // Same call, but the token has to be minted first.
    setSharedTokenManager(new TokenManager());
    tokenDelayMs = 300;
    await expect(
      executeProxyRequest(GET('/api/a', { timeoutMs: 600 }), routes(), undefined, {
        caller: 'alice',
      }),
    ).rejects.toThrow(/timed out/);
    expect(apiRequests.at(-1)?.url).toBe('/api/a');
  });

  it('test_connection gives the test request only what minting left', async () => {
    tokenDelayMs = 300;
    apiDelayMs = 450;
    const result = (await dispatchTool('test_connection', { connection: 'svc' }, routes(), {
      ...context(),
      outboundBudgetMs: 600,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ success: false, oauth2: { tokenMinted: true } });
    expect(String(result.error)).toMatch(/timed out/);
  });

  it('times out minting within the request budget', async () => {
    tokenDelayMs = 500;
    await expect(
      executeProxyRequest(GET('/api/a', { timeoutMs: 150 }), routes(), undefined, {
        caller: 'alice',
      }),
    ).rejects.toThrow(/did not answer within/);
    expect(apiRequests).toHaveLength(0);
  });

  describe('overlapping connections', () => {
    const staticRoute = (alias: string, allowedEndpoints: string[]): Route => ({
      alias,
      headers: { Authorization: 'Bearer ${STATIC_TOKEN}' },
      secrets: { STATIC_TOKEN: 'static-token-value' },
      allowedEndpoints,
    });

    it('refuses a URL two connections match when one is OAuth2', async () => {
      const both = resolveRoutes(
        [staticRoute('static', [`${apiBase}/api/**`]), routeDef()],
        {},
        'alice',
      );
      await expect(
        executeProxyRequest(GET('/api/a'), both, undefined, { caller: 'alice' }),
      ).rejects.toThrow(/Ambiguous endpoint.*"static", "svc"/);
      expect(apiRequests).toHaveLength(0);
      expect(tokenRequests).toHaveLength(0);
    });

    it.each([
      ['an upper-case host', 'https://WWW.googleapis.example/calendar/v3/users/me'],
      ['an explicit default port', 'https://www.googleapis.example:443/calendar/v3/users/me'],
      ['a percent-encoded host', 'https://www%2Egoogleapis.example/calendar/v3/users/me'],
      ['a trailing-dot host', 'https://www.googleapis.example./calendar/v3/users/me'],
    ])('refuses the ambiguity written with %s', async (_label, url) => {
      const both = resolveRoutes(
        [
          staticRoute('static', ['https://*.googleapis.example/**']),
          routeDef({ allowedEndpoints: ['https://www.googleapis.example/calendar/v3/**'] }),
        ],
        {},
        'alice',
      );
      await expect(
        executeProxyRequest({ method: 'GET', url }, both, undefined, { caller: 'alice' }),
        // A percent-encoded host matches no pattern as written, so it is
        // refused even before the ambiguity check. Either way nothing is sent.
      ).rejects.toThrow(/Ambiguous endpoint|Endpoint not allowed/);
      expect(tokenRequests).toHaveLength(0);
      expect(apiRequests).toHaveLength(0);
    });

    it('still serves URLs only one of them matches', async () => {
      const both = resolveRoutes(
        [staticRoute('static', [`${apiBase}/other/**`]), routeDef()],
        {},
        'alice',
      );
      const result = await executeProxyRequest(GET('/api/a'), both, undefined, {
        caller: 'alice',
      });
      expect(result.status).toBe(200);
    });

    it('keeps first-match-wins between static connections', async () => {
      const two = resolveRoutes([
        staticRoute('first', [`${apiBase}/api/**`]),
        staticRoute('second', [`${apiBase}/**`]),
      ]);
      const result = await executeProxyRequest(GET('/api/a'), two);
      expect(result.status).toBe(200);
      expect(apiRequests[0].authorization).toBe('Bearer static-token-value');
    });
  });

  describe('tools', () => {
    it('list_routes reports the auth shape and no secret values', async () => {
      const [info] = (await dispatchTool('list_routes', {}, routes(), context())) as Record<
        string,
        unknown
      >[];
      expect(info.auth).toEqual({
        type: 'oauth2',
        grant: 'refresh_token',
        scopes: ['calendar', 'read'],
      });
      expect(info.withheldSecretNames).toEqual(
        expect.arrayContaining(['SVC_CLIENT_ID', 'SVC_CLIENT_SECRET', 'SVC_REFRESH_TOKEN']),
      );
      expect(info.autoHeaders).toEqual([]);
      expectNoCredentials(info);
      expect(tokenRequests).toHaveLength(0);
    });

    it('test_connection mints first and reports granted scopes', async () => {
      const result = (await dispatchTool(
        'test_connection',
        { connection: 'svc' },
        routes(),
        context(),
      )) as Record<string, unknown>;
      expect(result).toMatchObject({
        success: true,
        status: 200,
        oauth2: {
          tokenMinted: true,
          requestedScopes: ['calendar', 'read'],
          grantedScopes: ['calendar', 'read'],
        },
      });
      expect(tokenRequests).toHaveLength(1);
      expectNoCredentials(result);
    });

    it('test_connection without a test request is a token-only test', async () => {
      const result = (await dispatchTool(
        'test_connection',
        { connection: 'svc' },
        routes({ testConnection: undefined }),
        context(),
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ success: true, oauth2: { tokenMinted: true } });
      expect(apiRequests).toHaveLength(0);
    });

    it('test_connection reports a token failure without credentials', async () => {
      tokenMode = 'invalid_grant';
      const result = (await dispatchTool(
        'test_connection',
        { connection: 'svc' },
        routes(),
        context(),
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ success: false, oauth2: { tokenMinted: false } });
      expect(String(result.error)).toContain('invalid_grant');
      expectNoCredentials(result);
    });

    it('http_request mints for the session caller', async () => {
      await dispatchTool('http_request', GET('/api/a'), routes(), context('carol'));
      await dispatchTool('http_request', GET('/api/a'), routes(), context('carol'));
      await dispatchTool('http_request', GET('/api/a'), routes(), context('dave'));
      expect(tokenRequests).toHaveLength(2);
    });
  });
});
