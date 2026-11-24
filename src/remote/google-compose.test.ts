/**
 * test_connection on the composed `google` route: one mint, one test per
 * selected service, reported per service, with consent hints that name
 * services and levels. Also the union token cases that replace the old
 * "one refresh token for several templates" tests, and a generic
 * `testConnections` on a custom connector.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

import {
  resolveCallerRoutesChecked,
  resolveRoutes,
  type GoogleCallerConfig,
  type RemoteServerConfig,
  type ResolvedRoute,
  type Route,
} from '../shared/config.js';
import { TokenManager } from './oauth/token-manager.js';
import { resetSharedTokenManager, setSharedTokenManager } from './oauth/shared-token-manager.js';
import { dispatchTool, type ToolContext } from './tool-dispatch.js';

const S = 'https://www.googleapis.com/auth/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SUBJECT = 'alice-sentinel@example.com';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_KEY = Buffer.from(
  JSON.stringify({
    type: 'service_account',
    private_key_id: 'kid-1',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'robot@proj.iam.gserviceaccount.com',
  }),
).toString('base64');

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'rt',
  GOOGLE_SERVICE_ACCOUNT_KEY: SA_KEY,
};

interface Seen {
  url: string;
  method: string;
  body?: string;
  authorization?: string;
}

/** Token endpoint behaviour: the scopes it reports, or an error code. */
let grant: ((requested: string[]) => string[]) | { error: string } = (r) => r;
/** API status per URL prefix; 200 otherwise. */
let statusFor: (url: string) => number = () => 200;
let seen: Seen[] = [];
let tokenRequests: URLSearchParams[] = [];

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  if (url === TOKEN_URL) {
    const params = new URLSearchParams(init?.body as string);
    tokenRequests.push(params);
    if ('error' in grant) return json({ error: grant.error }, 400);
    let requested = (params.get('scope') ?? '').split(' ').filter(Boolean);
    const assertion = params.get('assertion');
    if (assertion) {
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()) as {
        scope: string;
      };
      requested = claims.scope.split(' ');
    }
    return json({ access_token: 'at-1', expires_in: 3600, scope: grant(requested).join(' ') });
  }
  const headers = new Headers(init?.headers);
  seen.push({
    url,
    method: init?.method ?? 'GET',
    ...(typeof init?.body === 'string' && { body: init.body }),
    authorization: headers.get('authorization') ?? undefined,
  });
  return json({ ok: true }, statusFor(url));
}

function routesFor(google: GoogleCallerConfig, connectors?: Route[]): ResolvedRoute[] {
  const config = {
    host: '127.0.0.1',
    port: 0,
    rateLimitPerMinute: 60,
    ...(connectors && { connectors }),
    callers: {
      alice: {
        connections: ['google', ...(connectors ?? []).flatMap((c) => (c.alias ? [c.alias] : []))],
        google,
      },
    },
  } as RemoteServerConfig;
  const { routes, problems } = resolveCallerRoutesChecked(config, 'alice');
  expect(problems).toEqual([]);
  return resolveRoutes(routes, ENV, 'alice');
}

const context: ToolContext = {
  callerAlias: 'alice',
  origin: 'agent',
  ingestorManager: {} as ToolContext['ingestorManager'],
  refreshRoutes: () => undefined,
};

async function testConnection(routes: ResolvedRoute[], connection = 'google') {
  return (await dispatchTool('test_connection', { connection }, routes, context)) as Record<
    string,
    unknown
  > & {
    services?: Record<string, Record<string, unknown>>;
    oauth2?: Record<string, unknown>;
  };
}

const USER: GoogleCallerConfig = {
  auth: 'user',
  services: { drive: 'read', sheets: 'edit' },
};

beforeEach(() => {
  grant = (r) => r;
  statusFor = () => 200;
  seen = [];
  tokenRequests = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  setSharedTokenManager(new TokenManager({ fetchImpl: fakeFetch as typeof fetch }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharedTokenManager();
});

describe('test_connection on google', () => {
  it('mints once, runs each service test, and passes when all do', async () => {
    const result = await testConnection(routesFor(USER));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get('scope')).toBe(`${S}drive.readonly ${S}spreadsheets`);
    expect(result).toMatchObject({
      success: true,
      connection: 'google',
      oauth2: {
        tokenMinted: true,
        requestedScopes: [S + 'drive.readonly', S + 'spreadsheets'],
        grantedScopes: [S + 'drive.readonly', S + 'spreadsheets'],
      },
      services: {
        drive: {
          level: 'read',
          success: true,
          status: 200,
          description: 'Fetches the Drive user (about.get)',
        },
        sheets: { level: 'edit', success: true, status: 200 },
      },
      consentScopes: `${S}drive.readonly ${S}spreadsheets`,
    });
    expect(result.hint).toBeUndefined();
    expect(result.oauth2?.missingScopes).toBeUndefined();
    // Every test carried the minted token, to the URL its old template used.
    expect(seen.map((s) => s.url).sort()).toEqual([
      'https://sheets.googleapis.com/v4/spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms?fields=spreadsheetId',
      'https://www.googleapis.com/drive/v3/about?fields=user',
    ]);
    expect(seen.every((s) => s.authorization === 'Bearer at-1')).toBe(true);
  });

  it('sends the freeBusy test as a POST with its body', async () => {
    await testConnection(routesFor({ auth: 'user', services: { calendar: 'freebusy' } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: 'https://www.googleapis.com/calendar/v3/freeBusy',
    });
    expect(JSON.parse(seen[0].body ?? '{}')).toMatchObject({ items: [{ id: 'primary' }] });
  });

  it('marks a service the token was not granted as notConsented, with a level-mapped hint', async () => {
    grant = () => [S + 'spreadsheets'];
    statusFor = (url) => (url.includes('/drive/') ? 403 : 200);
    const result = await testConnection(routesFor(USER));
    expect(result).toMatchObject({
      success: false,
      oauth2: { tokenMinted: true, missingScopes: [S + 'drive.readonly'] },
      services: {
        drive: {
          level: 'read',
          success: false,
          status: 403,
          notConsented: true,
          error: 'Unexpected status 403 (expected 200)',
        },
        sheets: { level: 'edit', success: true, status: 200 },
      },
      consentScopes: `${S}drive.readonly ${S}spreadsheets`,
      hint:
        'The token was not granted drive.readonly (drive: read). Re-consent the refresh token ' +
        'with exactly the scopes in consentScopes.',
    });
    expect(result.services?.sheets.notConsented).toBeUndefined();
  });

  it('is refused for a full grant broader than a strict-subset selection, naming the extra levels', async () => {
    // The refresh token was consented for more than is now selected, and
    // Google didn't narrow on refresh.
    grant = (r) => [...r, S + 'documents', S + 'gmail.readonly'];
    const result = await testConnection(routesFor(USER));
    expect(result).toMatchObject({
      success: false,
      oauth2: { tokenMinted: false, requestedScopes: [S + 'drive.readonly', S + 'spreadsheets'] },
      services: {
        drive: { level: 'read', success: false, skipped: 'no token' },
        sheets: { level: 'edit', success: false, skipped: 'no token' },
      },
      consentScopes: `${S}drive.readonly ${S}spreadsheets`,
      hint:
        'The token was granted scopes this selection does not include: documents (docs: edit), ' +
        'gmail.readonly (gmail: read). Add those services, or re-consent the refresh token with ' +
        'exactly the scopes in consentScopes.',
    });
    expect(String(result.error)).toContain('granted scopes broader than this connection allows');
    expect(seen).toEqual([]);
  });

  it('skips every service when the mint fails, and still gives the consent scopes', async () => {
    grant = { error: 'invalid_grant' };
    const result = await testConnection(routesFor(USER));
    expect(result).toMatchObject({
      success: false,
      oauth2: { tokenMinted: false },
      services: {
        drive: { level: 'read', success: false, skipped: 'no token' },
        sheets: { level: 'edit', success: false, skipped: 'no token' },
      },
      consentScopes: `${S}drive.readonly ${S}spreadsheets`,
    });
    expect(String(result.error)).toContain('invalid_grant');
    expect(seen).toEqual([]);
  });

  it('fails overall when any one service fails', async () => {
    statusFor = (url) => (url.includes('sheets.googleapis.com') ? 500 : 200);
    const result = await testConnection(routesFor(USER));
    expect(result.success).toBe(false);
    expect(result.services?.drive.success).toBe(true);
    expect(result.services?.sheets).toMatchObject({ success: false, status: 500 });
    expect(result.services?.sheets.notConsented).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it('never reports the service-account subject, though the assertion carries it', async () => {
    const routes = routesFor({
      auth: 'service-account',
      subject: SUBJECT,
      services: { gmail: 'read', calendar: 'read' },
    });
    const ok = await testConnection(routes);
    expect(ok.success).toBe(true);
    expect(ok.services).toMatchObject({
      gmail: { level: 'read', success: true },
      calendar: { level: 'read', success: true },
    });
    const claims = JSON.parse(
      Buffer.from(String(tokenRequests[0].get('assertion')).split('.')[1], 'base64url').toString(),
    ) as { sub?: string };
    expect(claims.sub).toBe(SUBJECT);
    expect(JSON.stringify(ok)).not.toContain(SUBJECT);

    // Nor on the failure paths, nor in list_routes.
    resetSharedTokenManager();
    setSharedTokenManager(new TokenManager({ fetchImpl: fakeFetch as typeof fetch }));
    grant = (r) => [...r, S + 'drive.readonly'];
    const refused = await testConnection(routes);
    expect(refused.success).toBe(false);
    expect(refused.hint).toContain('drive.readonly (drive: read)');
    expect(refused.hint).toContain('domain-wide delegation');
    expect(JSON.stringify(refused)).not.toContain(SUBJECT);
    const listed = await dispatchTool('list_routes', {}, routes, context);
    expect(JSON.stringify(listed)).not.toContain(SUBJECT);
    expect(JSON.stringify(listed)).toContain('"delegated":true');
  });

  it('list_routes shows the composed description and scopes', async () => {
    const [info] = (await dispatchTool('list_routes', {}, routesFor(USER), context)) as Record<
      string,
      unknown
    >[];
    expect(info).toMatchObject({
      alias: 'google',
      name: 'Google',
      hasTestConnection: true,
      auth: {
        type: 'oauth2',
        grant: 'refresh_token',
        scopes: [S + 'drive.readonly', S + 'spreadsheets'],
      },
    });
    expect(String(info.description)).toMatch(/^Google \(user OAuth\): drive read, sheets edit\./);
  });
});

describe('testConnections on a custom connector', () => {
  it('runs each named test and reports it under its name', async () => {
    const custom: Route = {
      alias: 'acme',
      headers: { Authorization: 'Bearer ${ACME_TOKEN}' },
      secrets: { ACME_TOKEN: 'acme-static' },
      allowedEndpoints: ['https://api.acme.example/**'],
      testConnections: [
        { name: 'me', url: 'https://api.acme.example/me', description: 'who am I' },
        { name: 'items', url: 'https://api.acme.example/items', expectedStatus: [200, 204] },
      ],
    };
    statusFor = (url) => (url.endsWith('/items') ? 404 : 200);
    const routes = routesFor({ auth: 'user', services: { docs: 'edit' } }, [custom]);
    const result = await testConnection(routes, 'acme');
    expect(result).toEqual({
      success: false,
      connection: 'acme',
      services: {
        me: { success: true, status: 200, statusText: '', description: 'who am I' },
        items: {
          success: false,
          status: 404,
          statusText: '',
          error: 'Unexpected status 404 (expected 200 or 204)',
        },
      },
    });
    expect(seen.every((s) => s.authorization === 'Bearer acme-static')).toBe(true);
  });
});
