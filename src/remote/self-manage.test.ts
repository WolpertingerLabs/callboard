/**
 * The caller self-management lock: `selfManage: false` refuses
 * set_connection_enabled / set_secrets on the agent path (encrypted
 * `/request`), while the admin API (dashboard) path still works. The admin
 * HTTP endpoints are covered in admin-mutations.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRemoteConfig, saveRemoteConfig, type RemoteServerConfig } from '../shared/config.js';
import { dispatchTool, type ToolContext } from './tool-dispatch.js';
import type { IngestorManager } from './ingestors/index.js';

// ── selfManage lock ──────────────────────────────────────────────────────

describe('selfManage lock on set_connection_enabled / set_secrets', () => {
  let dir: string;
  const stub = { stopOne: () => Promise.resolve({ success: true }) } as unknown as IngestorManager;

  function ctx(callerAlias: string, origin?: 'agent' | 'admin'): ToolContext {
    return {
      callerAlias,
      ingestorManager: stub,
      refreshRoutes: () => undefined,
      ...(origin && { origin }),
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-selfmanage-'));
    process.env.MCP_CONFIG_DIR = dir;
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      callers: {
        legacy: { connections: ['github'] },
        locked: { connections: ['github'], selfManage: false },
        open: { connections: ['github'], selfManage: true },
      },
      rateLimitPerMinute: 60,
    };
    saveRemoteConfig(config);
  });

  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([['agent' as const], [undefined]])(
    'refuses both tools for a locked caller on the agent path (origin %s)',
    async (origin) => {
      await expect(
        dispatchTool(
          'set_connection_enabled',
          { connection: 'notion', enabled: true },
          [],
          ctx('locked', origin),
        ),
      ).rejects.toThrow('selfManage disabled');
      await expect(
        dispatchTool('set_secrets', { secrets: { GITHUB_TOKEN: 'x' } }, [], ctx('locked', origin)),
      ).rejects.toThrow('selfManage disabled');
      const after = loadRemoteConfig().callers.locked;
      expect(after.connections).toEqual(['github']);
      expect(after.env).toBeUndefined();
    },
  );

  it('lets the admin path change a locked caller', async () => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'notion', enabled: true },
      [],
      ctx('locked', 'admin'),
    );
    await dispatchTool(
      'set_secrets',
      { secrets: { NOTION_API_KEY: 'admin-set' } },
      [],
      ctx('locked', 'admin'),
    );
    const after = loadRemoteConfig().callers.locked;
    expect(after.connections).toContain('notion');
    expect(Object.keys(after.env ?? {})).toContain('NOTION_API_KEY');
    delete process.env.LOCKED_NOTION_API_KEY;
  });

  it.each(['legacy', 'open'])('allows the agent path when selfManage is %s', async (alias) => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'notion', enabled: true },
      [],
      ctx(alias, 'agent'),
    );
    expect(loadRemoteConfig().callers[alias].connections).toContain('notion');
  });

  it('tells the agent in list_connection_templates whether it can self-manage', async () => {
    const locked = (await dispatchTool(
      'list_connection_templates',
      {},
      [],
      ctx('locked', 'agent'),
    )) as {
      selfManageable: boolean;
    }[];
    expect(locked.every((t) => !t.selfManageable)).toBe(true);
    const legacy = (await dispatchTool(
      'list_connection_templates',
      {},
      [],
      ctx('legacy', 'agent'),
    )) as {
      selfManageable: boolean;
    }[];
    expect(legacy.every((t) => t.selfManageable)).toBe(true);
  });
});

// ── OAuth2 connections are operator-only on the agent path ─────────────────

describe('OAuth2 connections and credentials on the agent path', () => {
  let dir: string;
  const stub = { stopOne: () => Promise.resolve({ success: true }) } as unknown as IngestorManager;
  const ctx = (callerAlias: string, origin?: 'agent' | 'admin'): ToolContext => ({
    callerAlias,
    ingestorManager: stub,
    refreshRoutes: () => undefined,
    ...(origin && { origin }),
  });
  const ADDED_ENV = ['OPEN_GITHUB_TOKEN', 'OPEN_GOOGLE_OAUTH_REFRESH_TOKEN', 'OPEN_ACME_RT'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-oauth2-agent-'));
    process.env.MCP_CONFIG_DIR = dir;
    saveRemoteConfig({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [
        {
          alias: 'acme',
          allowedEndpoints: ['https://api.acme.example/**'],
          secrets: { ACME_ID: '${ACME_ID}', ACME_SECRET: '${ACME_SECRET}', ACME_RT: '${ACME_RT}' },
          oauth2: {
            tokenUrl: 'https://auth.acme.example/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: {
              clientId: 'ACME_ID',
              clientSecret: 'ACME_SECRET',
              refreshToken: 'ACME_RT',
            },
          },
        },
      ],
      callers: {
        open: { connections: ['github', 'google-gmail-readonly'], selfManage: true },
        legacy: { connections: ['github'] },
        // Read-write Sheets, enabled by the operator.
        sheets: { connections: ['github', 'google-sheets'], selfManage: true },
        // Read-write Docs and Slides, enabled by the operator.
        editors: { connections: ['github', 'google-docs', 'google-slides'], selfManage: true },
      },
    });
  });

  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    for (const k of ADDED_ENV) Reflect.deleteProperty(process.env, k);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['open', 'google-drive-file'],
    ['open', 'google-drive-readonly-sa'],
    ['open', 'acme'],
    ['legacy', 'google-gmail-readonly'],
    ['open', 'google-sheets'],
    ['open', 'google-sheets-sa'],
    ['legacy', 'google-sheets'],
    ['sheets', 'google-sheets-sa'],
    ['sheets', 'google-sheets-readonly'],
    ['open', 'google-docs'],
    ['open', 'google-docs-sa'],
    ['open', 'google-slides'],
    ['open', 'google-slides-sa'],
    ['legacy', 'google-docs'],
    ['legacy', 'google-slides'],
    ['sheets', 'google-docs'],
    ['sheets', 'google-slides'],
    ['editors', 'google-docs-sa'],
    ['editors', 'google-slides-sa'],
  ])(
    'refuses to enable OAuth2 connection for caller %s: %s, even with selfManage',
    async (caller, connection) => {
      const before = loadRemoteConfig().callers[caller].connections;
      for (const origin of ['agent', undefined] as const) {
        await expect(
          dispatchTool(
            'set_connection_enabled',
            { connection, enabled: true },
            [],
            ctx(caller, origin),
          ),
        ).rejects.toThrow(/cannot enable .* OAuth2 connection/);
      }
      expect(loadRemoteConfig().callers[caller].connections).toEqual(before);
    },
  );

  it('still lets the agent enable a static connection and disable an OAuth2 one', async () => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'notion', enabled: true },
      [],
      ctx('open', 'agent'),
    );
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'google-gmail-readonly', enabled: false },
      [],
      ctx('open', 'agent'),
    );
    expect(loadRemoteConfig().callers.open.connections).toEqual(['github', 'notion']);
  });

  it.each([
    ['GOOGLE_OAUTH_REFRESH_TOKEN', 'attacker-rt'],
    ['GOOGLE_OAUTH_CLIENT_ID', 'x'],
    ['GOOGLE_SERVICE_ACCOUNT_KEY', 'x'],
    ['GOOGLE_OAUTH_REFRESH_TOKEN', ''], // deleting counts too
    ['ACME_RT', 'x'], // a custom connector's secretRef
  ])('refuses set_secrets on OAuth2 credential %s=%j from the agent', async (name, value) => {
    for (const origin of ['agent', undefined] as const) {
      await expect(
        dispatchTool(
          'set_secrets',
          { secrets: { GITHUB_TOKEN: 'ok', [name]: value } },
          [],
          ctx('open', origin),
        ),
      ).rejects.toThrow(new RegExp(`cannot set or delete ${name}`));
    }
    // Nothing from the refused call was written, not even the allowed name.
    expect(loadRemoteConfig().callers.open.env).toBeUndefined();
  });

  it.each([
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
  ])('refuses set_secrets on %s for a caller with google-sheets enabled', async (name) => {
    for (const value of ['attacker-value', '']) {
      for (const origin of ['agent', undefined] as const) {
        await expect(
          dispatchTool('set_secrets', { secrets: { [name]: value } }, [], ctx('sheets', origin)),
        ).rejects.toThrow(new RegExp(`cannot set or delete ${name}`));
      }
    }
    expect(loadRemoteConfig().callers.sheets.env).toBeUndefined();
  });

  it.each([
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
  ])(
    'refuses set_secrets on %s for a caller with google-docs and google-slides enabled',
    async (name) => {
      for (const value of ['attacker-value', '']) {
        for (const origin of ['agent', undefined] as const) {
          await expect(
            dispatchTool('set_secrets', { secrets: { [name]: value } }, [], ctx('editors', origin)),
          ).rejects.toThrow(new RegExp(`cannot set or delete ${name}`));
        }
      }
      expect(loadRemoteConfig().callers.editors.env).toBeUndefined();
    },
  );

  it('still lets the agent disable google-docs and google-slides', async () => {
    for (const connection of ['google-docs', 'google-slides']) {
      await dispatchTool(
        'set_connection_enabled',
        { connection, enabled: false },
        [],
        ctx('editors', 'agent'),
      );
    }
    expect(loadRemoteConfig().callers.editors.connections).toEqual(['github']);
  });

  it('still lets the agent disable google-sheets', async () => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'google-sheets', enabled: false },
      [],
      ctx('sheets', 'agent'),
    );
    expect(loadRemoteConfig().callers.sheets.connections).toEqual(['github']);
  });

  it('lets the agent set other secrets', async () => {
    await dispatchTool(
      'set_secrets',
      { secrets: { GITHUB_TOKEN: 'agent-set' } },
      [],
      ctx('open', 'agent'),
    );
    expect(Object.keys(loadRemoteConfig().callers.open.env ?? {})).toEqual(['GITHUB_TOKEN']);
  });

  it('leaves the admin path unaffected', async () => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'google-drive-file', enabled: true },
      [],
      ctx('open', 'admin'),
    );
    await dispatchTool(
      'set_secrets',
      { secrets: { GOOGLE_OAUTH_REFRESH_TOKEN: 'admin-rt', ACME_RT: 'admin-acme' } },
      [],
      ctx('open', 'admin'),
    );
    const after = loadRemoteConfig().callers.open;
    expect(after.connections).toContain('google-drive-file');
    expect(Object.keys(after.env ?? {}).sort()).toEqual(['ACME_RT', 'GOOGLE_OAUTH_REFRESH_TOKEN']);
  });
});

describe('list_connection_templates reports oauth2 auth', () => {
  it('includes auth for OAuth2 templates only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-oauth2-list-'));
    process.env.MCP_CONFIG_DIR = dir;
    try {
      saveRemoteConfig({
        host: '127.0.0.1',
        port: 0,
        rateLimitPerMinute: 60,
        callers: { open: { connections: [], selfManage: true } },
      });
      const list = (await dispatchTool('list_connection_templates', {}, [], {
        callerAlias: 'open',
        origin: 'agent',
        ingestorManager: {} as IngestorManager,
        refreshRoutes: () => undefined,
      })) as { alias: string; auth?: { type: string; grant: string } }[];
      const by = Object.fromEntries(list.map((t) => [t.alias, t]));
      expect(by['google-drive-file'].auth).toMatchObject({
        type: 'oauth2',
        grant: 'refresh_token',
      });
      expect(by.github.auth).toBeUndefined();
    } finally {
      delete process.env.MCP_CONFIG_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('set_secrets refuses the variables behind signing credentials', () => {
  let dir: string;
  const ctx = (origin: 'agent' | 'admin'): ToolContext => ({
    callerAlias: 'open',
    origin,
    ingestorManager: {} as IngestorManager,
    refreshRoutes: () => undefined,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-signing-vars-'));
    process.env.MCP_CONFIG_DIR = dir;
    saveRemoteConfig({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [
        {
          // Keys and variables differ; one credential is a literal.
          alias: 'renamed',
          allowedEndpoints: ['https://api.acme.example/**'],
          secrets: {
            ID: '${ACME_CLIENT}',
            SEC: 'LITERAL_CLIENT_SECRET',
            RT: '${ACME_REFRESH}',
            REGION: '${ACME_REGION}',
          },
          oauth2: {
            tokenUrl: 'https://auth.acme.example/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: { clientId: 'ID', clientSecret: 'SEC', refreshToken: 'RT' },
          },
        },
        {
          alias: 'team-aws',
          allowedEndpoints: ['https://sts.us-east-1.amazonaws.com/**'],
          awsSigV4: {},
          secrets: {
            AWS_ACCESS_KEY_ID: '${TEAM_AWS_KEY}',
            AWS_SECRET_ACCESS_KEY: '${TEAM_AWS_SECRET}',
          },
        },
      ],
      callers: { open: { connections: ['github'], selfManage: true } },
    });
  });

  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('OPEN_')) Reflect.deleteProperty(process.env, k);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    'ACME_REFRESH',
    'ACME_CLIENT',
    'RT',
    'TEAM_AWS_KEY',
    'TEAM_AWS_SECRET',
    'AWS_ACCESS_KEY_ID',
  ])('refuses %s from the agent', async (name) => {
    await expect(
      dispatchTool('set_secrets', { secrets: { [name]: 'attacker' } }, [], ctx('agent')),
    ).rejects.toThrow(new RegExp(`cannot set or delete ${name}`));
    expect(loadRemoteConfig().callers.open.env).toBeUndefined();
  });

  it('a literal credential refers to no variable, so nothing more is blocked', async () => {
    // SEC is a literal: its value isn't a settable name. ACME_REGION is a
    // non-credential variable of the same connector.
    await dispatchTool(
      'set_secrets',
      { secrets: { ACME_REGION: 'eu', LITERAL_CLIENT_SECRET: 'x' } },
      [],
      ctx('agent'),
    );
    expect(Object.keys(loadRemoteConfig().callers.open.env ?? {}).sort()).toEqual([
      'ACME_REGION',
      'LITERAL_CLIENT_SECRET',
    ]);
  });

  it('the admin origin may set them', async () => {
    await dispatchTool(
      'set_secrets',
      { secrets: { ACME_REFRESH: 'admin', TEAM_AWS_KEY: 'admin' } },
      [],
      ctx('admin'),
    );
    expect(Object.keys(loadRemoteConfig().callers.open.env ?? {}).sort()).toEqual([
      'ACME_REFRESH',
      'TEAM_AWS_KEY',
    ]);
  });
});
