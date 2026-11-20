/**
 * `oauth2Overrides` is admin config only: no tool may change it.
 *
 * Several tools write the caller's config (set_listener_params,
 * delete_listener_instance, set_connection_enabled), and the admin API reaches
 * tools as the caller, so an agent that could write `oauth2Overrides` through
 * any of them could pick its own scopes. Like the audit-log canary sweep, this
 * calls every registered tool, from both origins, with hostile input aimed at
 * the field, and checks that the stored value is byte-identical afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadRemoteConfig,
  resolveCallerRoutes,
  resolveRoutes,
  saveRemoteConfig,
  type RemoteServerConfig,
} from '../shared/config.js';
import { IngestorManager } from './ingestors/manager.js';
import { resetAuditLogState } from './audit-log.js';
import { resetSharedTokenManager } from './oauth/shared-token-manager.js';
import { dispatchTool, toolHandlers, type ToolContext } from './tool-dispatch.js';

const OVERRIDES = { svc: { scopes: ['items.read'] } };

describe('oauth2Overrides cannot be changed by any tool', () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let manager: IngestorManager;
  let baseline: RemoteServerConfig;

  beforeAll(() => {
    prevConfigDir = process.env.MCP_CONFIG_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-oauth2-overrides-'));
    process.env.MCP_CONFIG_DIR = dir;
    resetAuditLogState();
    // Token endpoint and API, for the tools that make requests.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/token')
                ? { access_token: 'tok-immutable', expires_in: 3600, scope: 'items.read' }
                : [],
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 1000,
      connectors: [
        {
          alias: 'svc',
          secrets: { CID: 'cid-value', CSECRET: 'csecret-value', RT: 'rt-value' },
          allowedEndpoints: ['https://api.example.com/**'],
          oauth2: {
            tokenUrl: 'https://auth.example.com/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: { clientId: 'CID', clientSecret: 'CSECRET', refreshToken: 'RT' },
            scopes: ['items.read', 'items.write'],
          },
          testConnection: { url: 'https://api.example.com/me' },
          ingestor: {
            type: 'poll',
            poll: { url: 'https://api.example.com/items', intervalMs: 60_000 },
          },
          listenerConfig: {
            name: 'Items',
            supportsMultiInstance: true,
            fields: [
              { key: 'oauth2Overrides', label: 'x', type: 'text' },
              { key: 'scopes', label: 'y', type: 'text', instanceKey: true },
            ],
          },
        },
      ],
      callers: {
        alice: { connections: ['svc'], oauth2Overrides: structuredClone(OVERRIDES) },
      },
    };
    baseline = structuredClone(config);
    saveRemoteConfig(config);
    manager = new IngestorManager(config);
  });

  afterAll(async () => {
    await manager.stopAll();
    vi.unstubAllGlobals();
    resetSharedTokenManager();
    if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
    else process.env.MCP_CONFIG_DIR = prevConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The stored value; `undefined` if a tool removed the caller entirely. */
  const stored = () =>
    JSON.stringify(
      (loadRemoteConfig().callers as Partial<RemoteServerConfig['callers']>).alice?.oauth2Overrides,
    );

  const hostile = (scopes: unknown) => ({
    oauth2Overrides: { svc: { scopes } },
    scopes,
    params: { oauth2Overrides: { svc: { scopes } }, scopes: 'items.admin' },
    overrides: { oauth2Overrides: { svc: { scopes } } },
    secrets: { oauth2Overrides: JSON.stringify({ svc: { scopes } }) },
    caller: 'alice',
    connection: 'svc',
    instance_id: 'items.admin',
    enabled: true,
    action: 'restart',
    paramKey: 'oauth2Overrides',
    timeout_ms: 0,
    method: 'GET',
    url: 'https://api.example.com/items',
  });

  it('every tool, both origins, leaves the stored value byte-identical', async () => {
    const before = stored();
    expect(before).toBe(JSON.stringify(OVERRIDES));
    const { instance_id: _omit, ...noInstance } = hostile(['items.read', 'items.write', 'admin']);
    const inputs: Record<string, unknown>[] = [
      { timeout_ms: 0 },
      noInstance,
      hostile(['items.read', 'items.write', 'admin']),
      { ...hostile('*'), create_instance: true },
      { ...hostile(['admin']), enabled: false },
      { ...hostile(null), connection: '__proto__' },
    ];

    const changed: string[] = [];
    for (const origin of ['agent', 'admin'] as const) {
      for (const tool of Object.keys(toolHandlers)) {
        for (const input of inputs) {
          // Start every call from the full config, so an earlier call (say,
          // set_connection_enabled false) can't shield a later one.
          saveRemoteConfig(structuredClone(baseline));
          const config = loadRemoteConfig();
          const routes = resolveRoutes(resolveCallerRoutes(config, 'alice'), {}, 'alice');
          const context: ToolContext = {
            callerAlias: 'alice',
            origin,
            ingestorManager: manager,
            refreshRoutes: () => undefined,
          };
          await dispatchTool(tool, structuredClone(input), routes, context).catch(() => undefined);
          if (stored() !== before) changed.push(`${origin}:${tool}:${JSON.stringify(input)}`);
        }
      }
    }
    expect(changed).toEqual([]);
  }, 60_000);
});
