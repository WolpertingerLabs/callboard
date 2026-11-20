/**
 * Listener tools index caller config maps with agent-supplied `connection`
 * and `instance_id`. A key of `__proto__` used to resolve to
 * Object.prototype, so one caller's `set_listener_params` could set
 * `Object.prototype.params` and every other caller's listener without params
 * of its own would inherit them (REDDIT_SUBREDDIT, GitHub repoFilter, …).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { assertSafeInstanceId, ownEntry } from '../shared/safe-keys.js';
import { IngestorManager } from './ingestors/manager.js';
import type { IngestorManager as IngestorManagerType } from './ingestors/index.js';
import { dispatchTool, type ToolContext } from './tool-dispatch.js';

const RESERVED = ['__proto__', 'constructor', 'prototype'];

describe('listener tools reject prototype keys', () => {
  let dir: string;
  const stub = {
    has: () => false,
    stopOne: () => Promise.resolve({ success: true }),
    restartOne: () => Promise.resolve({ success: true }),
    startOne: () => Promise.resolve({ success: true }),
  } as unknown as IngestorManagerType;

  function ctx(callerAlias: string): ToolContext {
    return { callerAlias, ingestorManager: stub, refreshRoutes: () => undefined, origin: 'agent' };
  }

  function routesFor(alias: string) {
    const cfg = loadRemoteConfig();
    return resolveRoutes(resolveCallerRoutes(cfg, alias), {}, alias);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-listener-keys-'));
    process.env.MCP_CONFIG_DIR = dir;
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      callers: {
        alice: { connections: ['reddit', 'trello'] },
        // bob's reddit listener has overrides but no params of its own.
        bob: { connections: ['reddit', 'trello'], ingestorOverrides: { reddit: {} } },
      },
      rateLimitPerMinute: 60,
    };
    saveRemoteConfig(config);
  });

  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    // Belt and braces: never leave pollution behind for other suites.
    delete (Object.prototype as Record<string, unknown>).params;
  });

  it.each(RESERVED)(
    'set_listener_params with instance_id %s is rejected and pollutes nothing',
    async (id) => {
      const result = (await dispatchTool(
        'set_listener_params',
        {
          connection: 'reddit',
          instance_id: id,
          params: { subreddit: 'attacker_sub' },
          create_instance: true,
        },
        routesFor('alice'),
        ctx('alice'),
      )) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid instance_id/);
      expect(({} as { params?: unknown }).params).toBeUndefined();

      // bob is unaffected: no params, and his listener would get no subreddit.
      const bob = (await dispatchTool(
        'get_listener_params',
        { connection: 'reddit' },
        routesFor('bob'),
        ctx('bob'),
      )) as { params: Record<string, unknown> };
      expect(bob.params).toEqual({});
      expect(loadRemoteConfig().callers.alice.listenerInstances).toBeUndefined();
    },
  );

  it('rejects malformed instance ids (documented regex)', async () => {
    for (const id of ['a:b', 'a b', '../x', 'a/b']) {
      const r = (await dispatchTool(
        'set_listener_params',
        { connection: 'trello', instance_id: id, params: {}, create_instance: true },
        routesFor('alice'),
        ctx('alice'),
      )) as { success: boolean };
      expect(r.success).toBe(false);
    }
  });

  it.each(RESERVED)('rejects connection %s on every listener tool', async (conn) => {
    const r = routesFor('alice');
    for (const [tool, input] of [
      ['set_listener_params', { connection: conn, params: {} }],
      ['get_listener_params', { connection: conn }],
      ['list_listener_instances', { connection: conn }],
      ['delete_listener_instance', { connection: conn, instance_id: 'x' }],
      ['control_listener', { connection: conn, action: 'start' }],
    ] as const) {
      const out = (await dispatchTool(tool, input, r, ctx('alice'))) as { success: boolean };
      expect(out.success, tool).toBe(false);
    }
  });

  it('get / delete / control with instance_id __proto__ find nothing', async () => {
    const r = routesFor('alice');
    for (const [tool, input] of [
      ['get_listener_params', { connection: 'trello', instance_id: '__proto__' }],
      ['delete_listener_instance', { connection: 'trello', instance_id: '__proto__' }],
      ['control_listener', { connection: 'trello', action: 'start', instance_id: '__proto__' }],
    ] as const) {
      const out = (await dispatchTool(tool, input, r, ctx('alice'))) as {
        success: boolean;
        error: string;
      };
      expect(out.success, tool).toBe(false);
      expect(out.error, tool).toMatch(/Invalid instance_id/);
    }
  });

  it('delete_listener_instance only deletes own-property instances', async () => {
    const cfg = loadRemoteConfig();
    cfg.callers.alice.listenerInstances = { trello: { board1: { params: { boardId: 'b1' } } } };
    saveRemoteConfig(cfg);
    const out = (await dispatchTool(
      'delete_listener_instance',
      { connection: 'trello', instance_id: 'toString' },
      routesFor('alice'),
      ctx('alice'),
    )) as { success: boolean };
    expect(out.success).toBe(false);
    expect(Object.keys(loadRemoteConfig().callers.alice.listenerInstances!.trello)).toEqual([
      'board1',
    ]);
  });

  it('still creates and edits a valid instance', async () => {
    const r = routesFor('alice');
    const created = (await dispatchTool(
      'set_listener_params',
      {
        connection: 'trello',
        instance_id: 'board-1',
        params: { boardId: 'b1' },
        create_instance: true,
      },
      r,
      ctx('alice'),
    )) as { success: boolean };
    expect(created.success).toBe(true);
    expect(loadRemoteConfig().callers.alice.listenerInstances?.trello['board-1'].params).toEqual({
      boardId: 'b1',
    });
  });
});

describe('IngestorManager.startOne rejects a prototype instance id', () => {
  it('returns an error instead of reading Object.prototype', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      callers: { c: { connections: ['trello'] } },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = (await manager.startOne('c', 'trello', '__proto__')) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid instance_id/);
  });
});

describe('safe-keys helpers', () => {
  it('ownEntry ignores inherited properties', () => {
    const map: Record<string, number> = { a: 1 };
    expect(ownEntry(map, 'a')).toBe(1);
    for (const k of [...RESERVED, 'toString', 'hasOwnProperty']) {
      expect(ownEntry(map, k)).toBeUndefined();
    }
    expect(ownEntry(undefined, 'a')).toBeUndefined();
  });

  it('assertSafeInstanceId accepts the documented charset only', () => {
    expect(() => assertSafeInstanceId('board_1-A')).not.toThrow();
    for (const bad of [...RESERVED, '', 'a.b', 42, null]) {
      expect(() => assertSafeInstanceId(bad)).toThrow(/Invalid instance_id/);
    }
  });
});
