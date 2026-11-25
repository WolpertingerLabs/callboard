/**
 * Listeners when some of a caller's connections are dropped at resolve time
 * (a removed template ID, `google` without a block or with an invalid one).
 * Routes must be matched to connections by alias, not by position: a dropped
 * connection must not shift later listeners onto the wrong connection.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import type { RemoteServerConfig, Route } from '../../shared/config.js';
import { BaseIngestor } from './base-ingestor.js';
import { IngestorManager } from './manager.js';
import { registerIngestorFactory } from './registry.js';

class FakeIngestor extends BaseIngestor {
  start(): Promise<void> {
    this.state = 'connected';
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }
}

/** Which connection alias each fake listener was created for, by its gateway URL. */
const created: { alias: string; gatewayUrl: string }[] = [];

const listener = (alias: string): Route => ({
  alias,
  allowedEndpoints: [],
  ingestor: {
    type: 'websocket',
    websocket: { gatewayUrl: `wss://${alias}.invalid`, protocol: 'dropped-fake' },
  },
});

const DROPPED_BEFORE: [string, Partial<RemoteServerConfig['callers'][string]>][] = [
  ['a removed template ID', { connections: ['google-sheets', 'chat-a', 'chat-b'] }],
  ['google without a block', { connections: ['google', 'chat-a', 'chat-b'] }],
  [
    'an invalid google block',
    {
      connections: ['google', 'chat-a', 'chat-b'],
      google: { auth: 'user', services: { drive: 'full' } } as never,
    },
  ],
];

const configFor = (callers: RemoteServerConfig['callers']): RemoteServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  rateLimitPerMinute: 60,
  connectors: [listener('chat-a'), listener('chat-b')],
  callers,
});

beforeAll(() => {
  registerIngestorFactory('websocket:dropped-fake', (alias, config, secrets, size, instanceId) => {
    created.push({ alias, gatewayUrl: config.websocket?.gatewayUrl ?? '' });
    return new FakeIngestor(alias, 'websocket', secrets, size, instanceId);
  });
});

let managers: IngestorManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.stopAll();
  managers = [];
  created.length = 0;
});
const manager = (config: RemoteServerConfig) => {
  const m = new IngestorManager(config);
  managers.push(m);
  return m;
};

describe('listeners after a dropped connection', () => {
  it.each(DROPPED_BEFORE)(
    'startAll labels each listener with its own connection (%s first)',
    async (_name, caller) => {
      const m = manager(configFor({ c: caller as RemoteServerConfig['callers'][string] }));
      await m.startAll();
      expect(
        m
          .getStatuses('c')
          .map((s) => s.connection)
          .sort(),
      ).toEqual(['chat-a', 'chat-b']);
      // Each listener was built from its own connection's config.
      expect(created.map((c) => `${c.alias} ${c.gatewayUrl}`).sort()).toEqual([
        'chat-a wss://chat-a.invalid',
        'chat-b wss://chat-b.invalid',
      ]);
    },
  );

  it.each(DROPPED_BEFORE)(
    'startAll honours ingestorOverrides for the right connection (%s first)',
    async (_name, caller) => {
      const m = manager(
        configFor({
          c: {
            ...(caller as RemoteServerConfig['callers'][string]),
            ingestorOverrides: { 'chat-a': { disabled: true } },
          },
        }),
      );
      await m.startAll();
      expect(m.getStatuses('c').map((s) => s.connection)).toEqual(['chat-b']);
      expect(created.map((c) => c.alias)).toEqual(['chat-b']);
    },
  );

  it.each(DROPPED_BEFORE)(
    'startOne starts the connection asked for (%s first)',
    async (_name, caller) => {
      const m = manager(configFor({ c: caller as RemoteServerConfig['callers'][string] }));
      const result = await m.startOne('c', 'chat-b');
      expect(result).toMatchObject({ success: true, connection: 'chat-b' });
      expect(created).toEqual([{ alias: 'chat-b', gatewayUrl: 'wss://chat-b.invalid' }]);
      expect(m.getStatuses('c').map((s) => s.connection)).toEqual(['chat-b']);
      await expect(m.stopOne('c', 'chat-b')).resolves.toMatchObject({ success: true });
    },
  );

  it.each(DROPPED_BEFORE)(
    'startOne on the dropped connection says why, instead of crashing (%s)',
    async (_name, caller) => {
      const c = caller as RemoteServerConfig['callers'][string];
      const m = manager(configFor({ c }));
      const result = await m.startOne('c', c.connections[0]);
      expect(result).toMatchObject({ success: false, connection: c.connections[0] });
      expect((result as { error: string }).error).toMatch(
        /^Connection "[\w-]+" is not loaded for this caller: /,
      );
      expect(created).toEqual([]);
    },
  );
});

describe('startAll with a caller that cannot be resolved', () => {
  it("keeps starting later callers' listeners", async () => {
    const m = manager(
      configFor({
        typo: { connections: ['google-sheetz', 'chat-a'] },
        later: { connections: ['chat-a'] },
      }),
    );
    await expect(m.startAll()).resolves.toBeUndefined();
    expect(m.getStatuses('typo')).toEqual([]);
    expect(m.getStatuses('later').map((s) => s.connection)).toEqual(['chat-a']);
  });

  it('startOne for such a caller returns the error instead of throwing', async () => {
    const m = manager(configFor({ typo: { connections: ['google-sheetz', 'chat-a'] } }));
    const result = await m.startOne('typo', 'chat-a');
    expect(result).toMatchObject({ success: false, connection: 'chat-a' });
    expect((result as { error: string }).error).toMatch(/Unknown connection "google-sheetz"/);
  });
});

describe('control_listener (the dashboard listener control) after a dropped connection', () => {
  it.each(DROPPED_BEFORE)(
    'start/stop act on the real connection (%s first)',
    async (_name, caller) => {
      const { dispatchTool } = await import('../tool-dispatch.js');
      const m = manager(configFor({ c: caller as RemoteServerConfig['callers'][string] }));
      const ctx = {
        callerAlias: 'c',
        origin: 'admin' as const,
        ingestorManager: m,
        refreshRoutes: () => undefined,
      };
      await expect(
        dispatchTool('control_listener', { connection: 'chat-a', action: 'start' }, [], ctx),
      ).resolves.toMatchObject({ success: true, connection: 'chat-a' });
      expect(created).toEqual([{ alias: 'chat-a', gatewayUrl: 'wss://chat-a.invalid' }]);
      await expect(
        dispatchTool('control_listener', { connection: 'chat-a', action: 'stop' }, [], ctx),
      ).resolves.toMatchObject({ success: true });
      expect(
        m.getStatuses('c').every((s) => s.state === 'stopped' || s.connection !== 'chat-a'),
      ).toBe(true);
    },
  );
});
