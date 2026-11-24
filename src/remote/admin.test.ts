/**
 * Unit tests for the loopback-only /admin router.
 *
 * Verifies the four security non-negotiables:
 *   1. requireLoopback rejects non-loopback IPs.
 *   2. requireLoopback accepts the three loopback variants.
 *   3. /admin/secrets reports presence booleans only — never env values.
 *   4. /admin/sessions returns the sanitized projection (no channel,
 *      no resolvedRoutes).
 *   5. /admin/ingestors flattens IngestorStatus + callerAlias.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { requireLoopback } from './server.js';
import { createAdminRouter } from './admin.js';
import type { IngestorManager } from './ingestors/index.js';
import type { IngestorStatus } from './ingestors/types.js';
import type { RemoteServerConfig } from '../shared/config.js';
import type { SessionSnapshot } from './server.js';
import type { AdminCallerConnection, AdminConnectionStatus } from './admin-types.js';

// ── requireLoopback unit tests ────────────────────────────────────────────

function fakeReq(remoteAddress: string | undefined): express.Request {
  return { socket: { remoteAddress } } as unknown as express.Request;
}

interface FakeResHandle {
  res: express.Response;
  state: { status: number | null; body: unknown };
}

function fakeRes(): FakeResHandle {
  const state: FakeResHandle['state'] = { status: null, body: null };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as express.Response;
  return { res, state };
}

describe('requireLoopback', () => {
  it('rejects external IPs with 403', () => {
    const r = fakeRes();
    let calledNext = false;
    requireLoopback(fakeReq('8.8.8.8'), r.res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(false);
    expect(r.state.status).toBe(403);
    expect(r.state.body).toEqual({ error: 'Forbidden: local access only' });
  });

  it('rejects when the remote address is undefined (closed/unknown socket)', () => {
    const r = fakeRes();
    let calledNext = false;
    requireLoopback(fakeReq(undefined), r.res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(false);
    expect(r.state.status).toBe(403);
    expect(r.state.body).toEqual({ error: 'Forbidden: local access only' });
  });

  it('rejects non-loopback IPv6 addresses', () => {
    const r = fakeRes();
    let calledNext = false;
    requireLoopback(fakeReq('2001:db8::1'), r.res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(false);
    expect(r.state.status).toBe(403);
    expect(r.state.body).toEqual({ error: 'Forbidden: local access only' });
  });

  it('accepts the three loopback address variants', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const r = fakeRes();
      let calledNext = false;
      requireLoopback(fakeReq(addr), r.res, () => {
        calledNext = true;
      });
      expect(calledNext, `should pass for ${addr}`).toBe(true);
      expect(r.state.status, `no status set for ${addr}`).toBe(null);
    }
  });
});

// ── End-to-end (admin router only) tests ─────────────────────────────────

let server: Server;
let baseUrl: string;
let testConfig: RemoteServerConfig;
let snapshots: SessionSnapshot[] = [];
let ingestorStatuses: (IngestorStatus & { callerAlias: string })[] = [];
let tmpConfigDir: string;

const SECRET_VALUE = 'sekret-must-not-leak-1234567890';
const LISTENER_SECRET_VALUE = 'listener-param-secret-must-not-leak-zzz';

beforeAll(async () => {
  // Isolated config dir so getCallerKeysDir/etc don't touch the user's home.
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-admin-test-'));
  process.env.MCP_CONFIG_DIR = tmpConfigDir;

  // Caller env mapping: TOKEN -> ${MY_VAR}; MY_VAR's value is the secret string.
  // This exercises both the env-mapping branch in isSecretSetForCaller and the
  // "values must never appear in the response body" guarantee.
  process.env.MY_VAR = SECRET_VALUE;

  // Use the github connection template — it has a stable required-secret list.
  // Also wire up a custom connector with a listenerConfig field of type: 'secret'
  // to exercise the /admin/callers/:alias/connections params filter.
  testConfig = {
    host: '127.0.0.1',
    port: 0,
    connectors: [
      {
        alias: 'secret-listener',
        name: 'Secret Listener (test fixture)',
        allowedEndpoints: [],
        listenerConfig: {
          name: 'Secret Listener',
          fields: [
            { key: 'boardId', label: 'Board ID', type: 'text' },
            { key: 'apiToken', label: 'API Token', type: 'secret' },
          ],
        },
      },
    ],
    callers: {
      acme: {
        name: 'ACME Corp',
        connections: ['github', 'secret-listener'],
        env: { GITHUB_TOKEN: '${MY_VAR}' },
        listenerInstances: {
          'secret-listener': {
            inst1: {
              params: {
                boardId: 'board-public-123',
                apiToken: LISTENER_SECRET_VALUE,
              },
            },
          },
        },
      },
    },
    rateLimitPerMinute: 60,
  };

  // Stub IngestorManager — admin only ever calls getAllStatuses().
  const fakeMgr = {
    getAllStatuses: () => ingestorStatuses,
  } as unknown as IngestorManager;

  const app = express();
  app.use(
    '/admin',
    requireLoopback,
    createAdminRouter({
      getSessionsSnapshot: () => snapshots,
      ingestorManager: () => fakeMgr,
      loadConfig: () => testConfig,
      version: 'test-1.2.3',
      port: 9999,
      startedAt: Date.now(),
    }),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  delete process.env.MY_VAR;
  delete process.env.MCP_CONFIG_DIR;
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

describe('/admin/secrets', () => {
  it('reports presence booleans only — never env values', async () => {
    const resp = await fetch(`${baseUrl}/admin/secrets`);
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as {
      callerAlias: string;
      connection: string;
      name: string;
      required: boolean;
      present: boolean;
    }[];

    // Some required+optional secrets must be enumerated for github
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((row) => row.callerAlias === 'acme')).toBe(true);

    // The GITHUB_TOKEN should be present (since MY_VAR is set)
    const token = body.find((r) => r.name === 'GITHUB_TOKEN');
    expect(token).toBeDefined();
    expect(token?.present).toBe(true);

    // Critical: the actual secret value must NEVER appear in the response
    const raw = JSON.stringify(body);
    expect(raw.includes(SECRET_VALUE)).toBe(false);
    expect(raw.includes('${MY_VAR}')).toBe(false);
  });
});

describe('/admin/callers/:alias/connections', () => {
  it('filters out listenerConfig fields whose type is "secret" from instance params', async () => {
    const resp = await fetch(`${baseUrl}/admin/callers/acme/connections`);
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as {
      connectionAlias: string;
      enabled: boolean;
      isCustom: boolean;
      instances: { instanceId: string; enabled: boolean; params: Record<string, unknown> }[];
    }[];

    const secretConn = body.find((c) => c.connectionAlias === 'secret-listener');
    if (!secretConn) throw new Error('expected secret-listener connection in response');
    expect(secretConn.instances).toHaveLength(1);

    const inst = secretConn.instances[0];
    expect(inst.instanceId).toBe('inst1');
    expect(inst.enabled).toBe(true);
    // Public param (non-secret field) is preserved
    expect(inst.params.boardId).toBe('board-public-123');
    // Secret-typed field is stripped
    expect(inst.params.apiToken).toBeUndefined();

    // Critical: the secret value must NEVER appear anywhere in the response.
    const raw = JSON.stringify(body);
    expect(raw.includes(LISTENER_SECRET_VALUE)).toBe(false);
  });
});

describe('oauth2 auth on caller connections (read-only)', () => {
  it('narrowed compares the caller scopes to the connection scopes', async () => {
    const connector = {
      alias: 'acme-oauth',
      allowedEndpoints: ['https://api.acme.example/**'],
      secrets: { A: 'a', B: 'b', R: 'r' },
      oauth2: {
        tokenUrl: 'https://auth.acme.example/token',
        grant: 'refresh_token' as const,
        clientAuth: 'body' as const,
        secretRefs: { clientId: 'A', clientSecret: 'B', refreshToken: 'R' },
        scopes: ['write', 'read'],
      },
    };
    testConfig.connectors = [...(testConfig.connectors ?? []), connector];
    testConfig.callers.narrow = { connections: ['acme-oauth'] };
    const narrowedFor = async (scopes: string[] | undefined) => {
      testConfig.callers.narrow.oauth2Overrides = scopes ? { 'acme-oauth': { scopes } } : {};
      const resp = await fetch(`${baseUrl}/admin/callers/narrow/connections`);
      const [row] = (await resp.json()) as AdminCallerConnection[];
      return row.auth?.narrowed;
    };
    try {
      expect(await narrowedFor(undefined)).toBe(false);
      // An override repeating every scope (any order) narrows nothing.
      expect(await narrowedFor(['read', 'write'])).toBe(false);
      expect(await narrowedFor(['read'])).toBe(true);
    } finally {
      testConfig.connectors = testConfig.connectors.filter((c) => c.alias !== 'acme-oauth');
      Reflect.deleteProperty(testConfig.callers, 'narrow');
    }
  });
});

describe('the google connection on caller views (read-only)', () => {
  const SA_KEY_VALUE = 'google-sa-key-must-not-leak-xyz';
  const USER_TRIO = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ];
  beforeAll(() => {
    process.env.GSA_KEY = SA_KEY_VALUE;
    testConfig.callers.gsa = {
      connections: ['google', 'github'],
      env: { GOOGLE_SERVICE_ACCOUNT_KEY: '${GSA_KEY}' },
      google: {
        auth: 'service-account',
        subject: 'ceo@example.com',
        services: { gmail: 'read', calendar: 'read' },
      },
    };
    testConfig.callers.guser = {
      connections: ['google'],
      google: { auth: 'user', services: { sheets: 'edit' } },
    };
    testConfig.callers.gbad = {
      connections: ['google'],
      google: { auth: 'user', services: { drive: 'full' } } as never,
    };
    testConfig.callers.stale = { connections: ['github', 'google-sheetz'] };
    testConfig.callers.migrated = { connections: ['github', 'google-sheets'] };
  });
  afterAll(() => {
    for (const alias of ['gsa', 'guser', 'gbad', 'stale', 'migrated'])
      Reflect.deleteProperty(testConfig.callers, alias);
    delete process.env.GSA_KEY;
  });

  it('connections: composed auth with the subject, and the selected mode’s secrets', async () => {
    const resp = await fetch(`${baseUrl}/admin/callers/gsa/connections`);
    const body = (await resp.json()) as AdminCallerConnection[];
    const google = body.find((c) => c.connectionAlias === 'google');
    expect(google?.auth).toEqual({
      type: 'oauth2',
      grant: 'jwt_bearer',
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
      narrowed: false,
      subject: 'ceo@example.com',
      // The selection, for the dashboard's mode badge and service chips.
      google: { auth: 'service-account', services: { gmail: 'read', calendar: 'read' } },
    });
    expect(google?.requiredSecrets).toEqual([
      { name: 'GOOGLE_SERVICE_ACCOUNT_KEY', present: true },
    ]);
    expect(google?.optionalSecrets.map((s) => s.name)).toEqual(USER_TRIO);
    expect(google?.problem).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SA_KEY_VALUE);
  });

  it('connection-status: per-mode required secrets, callerAuth, and composed', async () => {
    const statusOf = async (alias: string) => {
      const resp = await fetch(`${baseUrl}/admin/callers/${alias}/connection-status`);
      const body = (await resp.json()) as AdminConnectionStatus[];
      return body.find((c) => c.alias === 'google');
    };
    const sa = await statusOf('gsa');
    expect(sa).toMatchObject({
      enabled: true,
      composed: 'google',
      requiredSecrets: ['GOOGLE_SERVICE_ACCOUNT_KEY'],
      requiredSecretsSet: { GOOGLE_SERVICE_ACCOUNT_KEY: true },
      optionalSecrets: USER_TRIO,
      callerAuth: { grant: 'jwt_bearer', subject: 'ceo@example.com', narrowed: false },
    });
    expect(sa?.auth).toBeUndefined();
    const user = await statusOf('guser');
    expect(user).toMatchObject({
      requiredSecrets: USER_TRIO,
      optionalSecrets: ['GOOGLE_SERVICE_ACCOUNT_KEY'],
      callerAuth: {
        grant: 'refresh_token',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        google: { auth: 'user', services: { sheets: 'edit' } },
      },
    });
    // Not enabled: the default (user) mode's secrets, no callerAuth.
    const none = await statusOf('acme');
    expect(none).toMatchObject({ enabled: false, requiredSecrets: USER_TRIO });
    expect(none?.callerAuth).toBeUndefined();
    // An invalid selection is a problem on the card.
    const bad = await statusOf('gbad');
    expect(bad?.problem).toMatch(/^google\.services\.drive: "full" is not offered/);
    expect(bad?.callerAuth).toBeUndefined();
  });

  it('secrets: the selected mode’s names are the required ones', async () => {
    const resp = await fetch(`${baseUrl}/admin/secrets`);
    const body = (await resp.json()) as {
      callerAlias: string;
      connection: string;
      name: string;
      required: boolean;
      present: boolean;
    }[];
    const rows = body.filter((r) => r.callerAlias === 'gsa' && r.connection === 'google');
    expect(rows.filter((r) => r.required).map((r) => r.name)).toEqual([
      'GOOGLE_SERVICE_ACCOUNT_KEY',
    ]);
    expect(rows.find((r) => r.required)?.present).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SA_KEY_VALUE);
  });

  it('connections: a removed template ID is a problem on that connection only', async () => {
    const resp = await fetch(`${baseUrl}/admin/callers/migrated/connections`);
    const body = (await resp.json()) as AdminCallerConnection[];
    const by = Object.fromEntries(body.map((c) => [c.connectionAlias, c]));
    expect(by['google-sheets'].problem).toBe(
      'Connection "google-sheets" was removed: use "google" with callers.migrated.google.services.sheets = "edit" (auth "user"). See CONNECTIONS.md → Google.',
    );
    expect(by.github.problem).toBeUndefined();
    // Neither a template nor a connector: not labelled custom.
    expect(by['google-sheets'].isCustom).toBe(false);
  });

  it('callers: configProblem for a caller that cannot be resolved, none otherwise', async () => {
    const resp = await fetch(`${baseUrl}/admin/callers`);
    const body = (await resp.json()) as { alias: string; configProblem?: string }[];
    const by = Object.fromEntries(body.map((c) => [c.alias, c]));
    expect(by.stale.configProblem).toMatch(/^Unknown connection "google-sheetz"/);
    expect(by.gsa.configProblem).toBeUndefined();
    // A dropped connection is a per-connection problem, not a caller one.
    expect(by.gbad.configProblem).toBeUndefined();
    expect(by.acme.configProblem).toBeUndefined();
    expect(by.migrated.configProblem).toBeUndefined();
  });
});

describe('/admin/sessions', () => {
  it('returns only the sanitized SessionSnapshot keys (no channel, no resolvedRoutes)', async () => {
    snapshots = [
      {
        sessionIdShort: 'abc123def456',
        callerAlias: 'acme',
        createdAt: 1_700_000_000_000,
        lastActivity: 1_700_000_005_000,
        requestCount: 7,
        windowRequests: 3,
        windowStart: 1_700_000_004_000,
      },
    ];

    const resp = await fetch(`${baseUrl}/admin/sessions`);
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as Record<string, unknown>[];

    expect(body).toHaveLength(1);
    const expectedKeys = [
      'sessionIdShort',
      'callerAlias',
      'createdAt',
      'lastActivity',
      'requestCount',
      'windowRequests',
      'windowStart',
    ].sort();
    expect(Object.keys(body[0]).sort()).toEqual(expectedKeys);

    // Belt-and-braces: no AES key material or resolved-route fields leaked.
    const raw = JSON.stringify(body);
    expect(raw.toLowerCase().includes('channel')).toBe(false);
    expect(raw.toLowerCase().includes('resolvedroutes')).toBe(false);
    expect(raw.toLowerCase().includes('secrets')).toBe(false);
  });
});

describe('/admin/ingestors', () => {
  it('returns one row per ingestor with augmented callerAlias / connection / instanceId', async () => {
    ingestorStatuses = [
      {
        callerAlias: 'acme',
        connection: 'github',
        instanceId: 'main-repo',
        type: 'webhook',
        state: 'connected',
        bufferedEvents: 4,
        totalEventsReceived: 100,
        lastEventAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const resp = await fetch(`${baseUrl}/admin/ingestors`);
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as Record<string, unknown>[];

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      callerAlias: 'acme',
      connection: 'github',
      instanceId: 'main-repo',
      type: 'webhook',
      state: 'connected',
      bufferedEvents: 4,
      totalEventsReceived: 100,
      lastEventAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
