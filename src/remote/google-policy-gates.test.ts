/**
 * Invariant 2 (plans/google-unified.md): agents still can't enable or
 * credential `google`. The base `google` template has no oauth2 block (its
 * route is composed per caller), so the gates in tool-dispatch.ts must treat
 * it as an OAuth2 connection and refuse all four GOOGLE_* credential names in
 * both auth modes, for every caller, whatever selfManage says.
 *
 * The template list is cut down to `google` and `github` here, so no other
 * template can lend the gates these names: `google` has to be protected on
 * its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRemoteConfig, saveRemoteConfig } from '../shared/config.js';
import { dispatchTool, type ToolContext } from './tool-dispatch.js';
import type { IngestorManager } from './ingestors/index.js';

vi.mock('../shared/connections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/connections.js')>();
  const ONLY = new Set(['google', 'github']);
  return {
    ...real,
    listAvailableConnections: () => real.listAvailableConnections().filter((a) => ONLY.has(a)),
    listConnectionTemplates: () => real.listConnectionTemplates().filter((t) => ONLY.has(t.alias)),
    loadConnection: (name: string) => {
      if (!ONLY.has(name))
        throw new Error(`Unknown connection "${name}" (test: templates cut down)`);
      return real.loadConnection(name);
    },
  };
});

describe('the composed google connection on the agent path', () => {
  let dir: string;
  const stub = { stopOne: () => Promise.resolve({ success: true }) } as unknown as IngestorManager;
  const ctx = (callerAlias: string, origin?: 'agent' | 'admin'): ToolContext => ({
    callerAlias,
    ingestorManager: stub,
    refreshRoutes: () => undefined,
    ...(origin && { origin }),
  });
  const GOOGLE_CREDENTIALS = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
  ];
  /** user mode / service-account mode / no google block / selfManage absent. */
  const CALLERS = ['user', 'sa', 'none', 'legacy', 'disabled'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-google-gates-'));
    process.env.MCP_CONFIG_DIR = dir;
    saveRemoteConfig({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      callers: {
        user: {
          connections: ['github', 'google'],
          selfManage: true,
          google: { auth: 'user', services: { sheets: 'edit', drive: 'read' } },
        },
        sa: {
          connections: ['github', 'google'],
          selfManage: true,
          google: {
            auth: 'service-account',
            subject: 'alice@example.com',
            services: { gmail: 'read', calendar: 'read' },
          },
        },
        none: { connections: ['github'], selfManage: true },
        legacy: { connections: ['github'] },
        // A selection is kept while the connection is disabled.
        disabled: {
          connections: ['github'],
          selfManage: true,
          google: { auth: 'service-account', services: { sheets: 'edit' } },
        },
      },
    });
  });

  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    for (const k of Object.keys(process.env)) {
      if (CALLERS.some((c) => k.startsWith(`${c.toUpperCase()}_`)))
        Reflect.deleteProperty(process.env, k);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['none', 'legacy', 'disabled'])(
    'refuses to enable google for caller %s from the agent, even with selfManage',
    async (caller) => {
      const before = loadRemoteConfig().callers[caller];
      for (const origin of ['agent', undefined] as const) {
        await expect(
          dispatchTool(
            'set_connection_enabled',
            { connection: 'google', enabled: true },
            [],
            ctx(caller, origin),
          ),
        ).rejects.toThrow(/cannot enable "google" from the agent: it is an OAuth2 connection/);
      }
      expect(loadRemoteConfig().callers[caller]).toEqual(before);
    },
  );

  it.each(['user', 'sa'])('still lets the agent of caller %s disable google', async (caller) => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'google', enabled: false },
      [],
      ctx(caller, 'agent'),
    );
    const after = loadRemoteConfig().callers[caller];
    expect(after.connections).toEqual(['github']);
    // Disabling keeps the selection (the dashboard toggle relies on it).
    expect(after.google).toBeDefined();
  });

  for (const caller of CALLERS) {
    it.each(GOOGLE_CREDENTIALS)(`refuses set_secrets on %s for caller ${caller}`, async (name) => {
      for (const value of ['attacker-value', '']) {
        for (const origin of ['agent', undefined] as const) {
          await expect(
            dispatchTool(
              'set_secrets',
              { secrets: { GITHUB_TOKEN: 'ok', [name]: value } },
              [],
              ctx(caller, origin),
            ),
          ).rejects.toThrow(new RegExp(`cannot set or delete ${name}`));
        }
      }
      expect(loadRemoteConfig().callers[caller].env).toBeUndefined();
    });
  }

  it('lets the admin path enable google and set all four credentials', async () => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'google', enabled: true },
      [],
      ctx('none', 'admin'),
    );
    await dispatchTool(
      'set_secrets',
      { secrets: Object.fromEntries(GOOGLE_CREDENTIALS.map((n) => [n, `admin-${n}`])) },
      [],
      ctx('none', 'admin'),
    );
    const after = loadRemoteConfig().callers.none;
    expect(after.connections).toContain('google');
    expect(Object.keys(after.env ?? {}).sort()).toEqual(GOOGLE_CREDENTIALS);
  });

  it('list_connection_templates reports google with the user trio required, the key optional', async () => {
    const list = (await dispatchTool(
      'list_connection_templates',
      {},
      [],
      ctx('user', 'agent'),
    )) as {
      alias: string;
      requiredSecrets: string[];
      optionalSecrets: string[];
      composed?: string;
      auth?: unknown;
    }[];
    const google = list.find((t) => t.alias === 'google');
    expect(google).toMatchObject({
      requiredSecrets: [
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'GOOGLE_OAUTH_REFRESH_TOKEN',
      ],
      optionalSecrets: ['GOOGLE_SERVICE_ACCOUNT_KEY'],
      composed: 'google',
    });
    // No fixed scopes, so no auth block.
    expect(google?.auth).toBeUndefined();
  });

  it('get_secret_status reports the credentials of the mode the caller selects', async () => {
    const statusOf = async (caller: string) =>
      (await dispatchTool('get_secret_status', { connection: 'google' }, [], ctx(caller))) as {
        requiredSecretsSet: Record<string, boolean>;
        optionalSecretsSet: Record<string, boolean>;
      };
    const sa = await statusOf('sa');
    expect(Object.keys(sa.requiredSecretsSet)).toEqual(['GOOGLE_SERVICE_ACCOUNT_KEY']);
    expect(Object.keys(sa.optionalSecretsSet)).toEqual(GOOGLE_CREDENTIALS.slice(0, 3));
    const user = await statusOf('user');
    expect(Object.keys(user.requiredSecretsSet)).toEqual(GOOGLE_CREDENTIALS.slice(0, 3));
    expect(Object.keys((await statusOf('none')).requiredSecretsSet)).toEqual(
      GOOGLE_CREDENTIALS.slice(0, 3),
    );
  });
});
