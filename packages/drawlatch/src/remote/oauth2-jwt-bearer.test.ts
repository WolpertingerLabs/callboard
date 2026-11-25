/**
 * The `jwt_bearer` grant (Google service accounts) end to end: a local token
 * server that verifies the RS256 assertion with the key's public half, and a
 * local API server. Covers the claims drawlatch signs (aud = tokenUrl, never
 * the key's token_uri; sub only from admin config), the cache identity, error
 * hints, and that the key never leaves the signer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  resolveCallerRoutesChecked,
  resolveRoutes,
  type RemoteServerConfig,
  type ResolvedRoute,
  type Route,
} from '../shared/config.js';
import { dispatchTool, executeProxyRequest, type ToolContext } from './tool-dispatch.js';
import { TokenManager } from './oauth/token-manager.js';
import { resetSharedTokenManager, setSharedTokenManager } from './oauth/shared-token-manager.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PEM_BODY_LINE = PEM.split('\n')[1];
const CLIENT_EMAIL = 'robot@proj.iam.gserviceaccount.com';

function keySecret(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      type: 'service_account',
      private_key_id: 'kid-1',
      private_key: PEM,
      client_email: CLIENT_EMAIL,
      token_uri: 'https://evil.example.com/token',
      ...overrides,
    }),
  ).toString('base64');
}

interface Claims {
  iss: string;
  scope: string;
  aud: string;
  iat: number;
  exp: number;
  sub?: string;
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

describe('jwt_bearer routes', () => {
  let tokenServer: http.Server;
  let apiServer: http.Server;
  let tokenBase: string;
  let apiBase: string;

  let tokenRequests: { params: URLSearchParams; claims?: Claims; authorization?: string }[] = [];
  let apiAuth: (string | undefined)[] = [];
  let tokenMode: 'ok' | 'no-scope' | 'broad-scope' | 'unauthorized_client' | 'access_denied' = 'ok';

  beforeAll(async () => {
    ({ server: tokenServer, base: tokenBase } = await listen((req, res) => {
      void (async () => {
        const params = new URLSearchParams(await readBody(req));
        const assertion = params.get('assertion') ?? '';
        const [h, p, s] = assertion.split('.');
        const verified =
          !!s &&
          crypto.verify(
            'RSA-SHA256',
            Buffer.from(`${h}.${p}`),
            publicKey,
            Buffer.from(s, 'base64url'),
          );
        const claims = verified
          ? (JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims)
          : undefined;
        tokenRequests.push({ params, claims, authorization: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (!verified) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'bad sig' }));
          return;
        }
        if (tokenMode === 'unauthorized_client' || tokenMode === 'access_denied') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: tokenMode, error_description: `echo ${assertion}` }));
          return;
        }
        res.end(
          JSON.stringify({
            access_token: `sa-access-token-${tokenRequests.length}`,
            token_type: 'Bearer',
            expires_in: 3599,
            ...(tokenMode === 'ok' && { scope: claims!.scope }),
            ...(tokenMode === 'broad-scope' && { scope: `${claims!.scope} admin` }),
          }),
        );
      })();
    }));
    ({ server: apiServer, base: apiBase } = await listen((req, res) => {
      apiAuth.push(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, url: req.url, youSent: req.headers.authorization }));
    }));
  });

  afterAll(async () => {
    for (const s of [tokenServer, apiServer]) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    resetSharedTokenManager();
  });

  beforeEach(() => {
    tokenRequests = [];
    apiAuth = [];
    tokenMode = 'ok';
    setSharedTokenManager(new TokenManager());
  });

  function routeDef(overrides: Partial<Route> = {}, oauth2: Partial<Route['oauth2']> = {}): Route {
    return {
      alias: 'gsa',
      allowedEndpoints: [`${apiBase}/api/**`],
      secrets: { SA_KEY: keySecret() },
      oauth2: {
        tokenUrl: `${tokenBase}/token`,
        grant: 'jwt_bearer',
        secretRefs: { serviceAccountKey: 'SA_KEY' },
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        ...oauth2,
      },
      testConnection: { url: `${apiBase}/api/about`, description: 'about' },
      ...overrides,
    };
  }

  const routes = (overrides: Partial<Route> = {}, oauth2: Partial<Route['oauth2']> = {}) =>
    resolveRoutes([routeDef(overrides, oauth2)], {}, 'alice');

  const context = (callerAlias = 'alice'): ToolContext =>
    ({
      callerAlias,
      origin: 'agent',
      ingestorManager: {} as ToolContext['ingestorManager'],
      refreshRoutes: () => undefined,
    }) as ToolContext;

  const get = (r: ResolvedRoute[], path = '/api/files', caller = 'alice') =>
    executeProxyRequest({ method: 'GET', url: `${apiBase}${path}` }, r, undefined, { caller });

  function expectNoKeyMaterial(value: unknown) {
    const text = JSON.stringify(value);
    expect(text).not.toContain(PEM_BODY_LINE);
    expect(text).not.toContain(keySecret().slice(0, 40));
    expect(text).not.toMatch(/sa-access-token-\d/);
    expect(text).not.toMatch(/eyJ[\w-]+\.eyJ/); // no assertion
  }

  it('signs an assertion for the route tokenUrl and injects the minted token', async () => {
    const result = await get(routes());
    expect(result.status).toBe(200);
    expect(apiAuth).toEqual(['Bearer sa-access-token-1']);
    const [{ params, claims, authorization }] = tokenRequests;
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    // No client credentials or scope form field: the assertion carries them.
    expect([...params.keys()].sort()).toEqual(['assertion', 'grant_type']);
    expect(authorization).toBeUndefined();
    expect(claims).toMatchObject({
      iss: CLIENT_EMAIL,
      aud: `${tokenBase}/token`,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    });
    expect(claims!.exp - claims!.iat).toBe(3600);
    expect(claims && 'sub' in claims).toBe(false);
    expect(result.body).toMatchObject({ youSent: 'Bearer ${OAUTH2_ACCESS_TOKEN}' });
    expectNoKeyMaterial(result);
  });

  it('sends sub from the caller override, and a different subject mints separately', async () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [routeDef()],
      callers: {
        alice: { connections: ['gsa'], oauth2Overrides: { gsa: { subject: 'ceo@example.com' } } },
        bob: { connections: ['gsa'], oauth2Overrides: { gsa: { subject: 'cfo@example.com' } } },
      },
    } as RemoteServerConfig;
    const forCaller = (alias: string) =>
      resolveRoutes(resolveCallerRoutesChecked(config, alias).routes, {}, alias);
    await get(forCaller('alice'), '/api/files', 'alice');
    await get(forCaller('alice'), '/api/files', 'alice');
    await get(forCaller('bob'), '/api/files', 'bob');
    expect(tokenRequests.map((r) => r.claims?.sub)).toEqual(['ceo@example.com', 'cfo@example.com']);
  });

  it('re-mints when the subject changes for the same caller', async () => {
    await get(routes({}, { subject: 'a@example.com' }));
    await get(routes({}, { subject: 'b@example.com' }));
    await get(routes({}, { subject: 'a@example.com' }));
    expect(tokenRequests.map((r) => r.claims?.sub)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('re-mints when the key changes (no stale token)', async () => {
    await get(routes());
    await get(routes({ secrets: { SA_KEY: keySecret({ private_key_id: 'kid-2' }) } }));
    await get(routes());
    expect(tokenRequests).toHaveLength(2);
  });

  it('accepts a token response without scope (the scopes are in the signed assertion)', async () => {
    tokenMode = 'no-scope';
    const result = await get(routes());
    expect(result.status).toBe(200);
  });

  it('still refuses a reported scope broader than the assertion', async () => {
    tokenMode = 'broad-scope';
    await expect(get(routes())).rejects.toThrow(/broader than this connection allows \(admin\)/);
    expect(apiAuth).toHaveLength(0);
  });

  it.each([
    ['unauthorized_client', /domain-wide delegation in the Admin console/],
    ['access_denied', /not authorized for this client ID in the Admin console/],
  ] as const)('maps %s to a fixed service-account hint', async (code, hint) => {
    tokenMode = code;
    let message = '';
    try {
      await get(routes());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(code);
    expect(message).toMatch(hint);
    expectNoKeyMaterial(message);
  });

  it('reports a malformed key by secret name only', async () => {
    const bad = 'not-a-key-sentinel-55aa';
    await expect(get(routes({ secrets: { SA_KEY: bad } }))).rejects.toThrow(
      /secret SA_KEY is not a valid Google service-account key/,
    );
    try {
      await get(routes({ secrets: { SA_KEY: bad } }));
    } catch (err) {
      expect((err as Error).message).not.toContain(bad);
    }
    expect(tokenRequests).toHaveLength(0);
  });

  it('refuses the key as a placeholder in a URL, header, or body', async () => {
    const r = routes({ resolveSecretsInBody: false });
    for (const input of [
      { method: 'GET', url: `${apiBase}/api/files?k=\${SA_KEY}` },
      { method: 'GET', url: `${apiBase}/api/files`, headers: { 'X-K': '${SA_KEY}' } },
    ]) {
      await expect(executeProxyRequest(input, r, undefined, { caller: 'alice' })).rejects.toThrow(
        /SA_KEY/,
      );
    }
    expect(apiAuth).toHaveLength(0);
  });

  it('list_routes reports grant, scopes and delegated, never the subject or key', async () => {
    const [info] = (await dispatchTool(
      'list_routes',
      {},
      routes({}, { subject: 'ceo@example.com' }),
      context(),
    )) as Record<string, unknown>[];
    expect(info.auth).toEqual({
      type: 'oauth2',
      grant: 'jwt_bearer',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      delegated: true,
    });
    expect(info.withheldSecretNames).toEqual(['SA_KEY']);
    expect(JSON.stringify(info)).not.toContain('ceo@example.com');
    expectNoKeyMaterial(info);

    const [plain] = (await dispatchTool('list_routes', {}, routes(), context())) as Record<
      string,
      unknown
    >[];
    expect(plain.auth).not.toHaveProperty('delegated');
  });

  it('test_connection mints with the service account and runs the test request', async () => {
    const result = (await dispatchTool(
      'test_connection',
      { connection: 'gsa' },
      routes(),
      context(),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      success: true,
      status: 200,
      oauth2: {
        tokenMinted: true,
        grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
    });
    expectNoKeyMaterial(result);
  });
});
