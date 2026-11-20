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
          { connection: 'google', enabled: true },
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
      { connection: 'google', enabled: true },
      [],
      ctx('locked', 'admin'),
    );
    await dispatchTool(
      'set_secrets',
      { secrets: { GOOGLE_API_TOKEN: 'admin-set' } },
      [],
      ctx('locked', 'admin'),
    );
    const after = loadRemoteConfig().callers.locked;
    expect(after.connections).toContain('google');
    expect(Object.keys(after.env ?? {})).toContain('GOOGLE_API_TOKEN');
    delete process.env.LOCKED_GOOGLE_API_TOKEN;
  });

  it.each(['legacy', 'open'])('allows the agent path when selfManage is %s', async (alias) => {
    await dispatchTool(
      'set_connection_enabled',
      { connection: 'google', enabled: true },
      [],
      ctx(alias, 'agent'),
    );
    expect(loadRemoteConfig().callers[alias].connections).toContain('google');
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
