/**
 * HTTP-level tests for `wait_for_events` and the per-session 429.
 *
 * Boots the real Express app, performs a real handshake, and drives the
 * encrypted `/request` endpoint, so the abort-on-disconnect wiring and the
 * Retry-After header are tested where they live rather than through mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp, getSessionsSnapshot, gracefulShutdown } from './server.js';
import type { RemoteServerConfig } from '../shared/config.js';
import {
  generateKeyBundle,
  extractPublicKeys,
  EncryptedChannel,
  type KeyBundle,
  type PublicKeyBundle,
} from '../shared/crypto/index.js';
import {
  HandshakeInitiator,
  type HandshakeReply,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';
import { BaseIngestor } from './ingestors/base-ingestor.js';
import { IngestorManager } from './ingestors/manager.js';
import { registerIngestorFactory } from './ingestors/registry.js';
import { toolHandlers } from './tool-dispatch.js';
import {
  activeWaitCount,
  releaseAllWaits,
  resumeWaits,
  type WaitForEventsResult,
} from './wait-for-events.js';

class FakeIngestor extends BaseIngestor {
  start(): Promise<void> {
    this.state = 'connected';
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }
  push(eventType: string, data: unknown = {}): void {
    this.pushEvent(eventType, data);
  }
}

const RATE_LIMIT = 4;

let server: Server;
let baseUrl: string;
let clientKeys: KeyBundle;
let serverPub: PublicKeyBundle;
let serverKeys: KeyBundle;
let mgr: IngestorManager;
let chat: FakeIngestor;

beforeAll(async () => {
  registerIngestorFactory(
    'websocket:wfe-http-fake',
    (alias, _config, secrets, size, instanceId) => {
      chat = new FakeIngestor(alias, 'websocket', secrets, size, instanceId);
      return chat;
    },
  );

  clientKeys = generateKeyBundle();
  serverKeys = generateKeyBundle();
  serverPub = extractPublicKeys(serverKeys);

  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0,
    connectors: [
      {
        alias: 'chat',
        allowedEndpoints: [],
        ingestor: {
          type: 'websocket',
          websocket: { gatewayUrl: 'wss://fake.invalid', protocol: 'wfe-http-fake' },
        },
      },
    ],
    callers: { 'test-client': { connections: ['chat'] } },
    rateLimitPerMinute: RATE_LIMIT,
  };

  mgr = new IngestorManager(config);
  await mgr.startAll();

  const app = createApp({
    config,
    ownKeys: serverKeys,
    authorizedPeers: [{ alias: 'test-client', keys: extractPublicKeys(clientKeys) }],
    ingestorManager: mgr,
    disableRateLimiting: true,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(() => {
  // Start every test from zero holds and not draining (see the unit tests).
  releaseAllWaits();
  resumeWaits();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await mgr.stopAll();
});

async function handshake(url = baseUrl): Promise<EncryptedChannel> {
  const initiator = new HandshakeInitiator(clientKeys, serverPub);
  const initResp = await fetch(`${url}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initiator.createInit()),
  });
  const keys = initiator.processReply((await initResp.json()) as HandshakeReply);
  const finishResp = await fetch(`${url}/handshake/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': keys.sessionId },
    body: JSON.stringify(initiator.createFinish(keys)),
  });
  expect(finishResp.ok).toBe(true);
  return new EncryptedChannel(keys);
}

function post(
  channel: EncryptedChannel,
  toolName: string,
  toolInput: Record<string, unknown>,
  signal?: AbortSignal,
  url = baseUrl,
): Promise<Response> {
  const request: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName,
    toolInput,
    timestamp: Date.now(),
  };
  return fetch(`${url}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': channel.sessionId },
    body: new Uint8Array(channel.encryptJSON(request)),
    signal,
  });
}

async function decrypt(channel: EncryptedChannel, resp: Response): Promise<ProxyResponse> {
  expect(resp.ok).toBe(true);
  return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
}

function cursorNow(): Record<string, number> {
  const events = chat.getEvents();
  return { 'chat:_default': events.length ? events[events.length - 1].id : -1 };
}

describe('wait_for_events over /request', () => {
  it('holds, wakes on a new event, and costs one rate-limit slot', async () => {
    const channel = await handshake();
    const pending = post(channel, 'wait_for_events', {
      cursors: cursorNow(),
      timeout_ms: 20_000,
    });
    await vi.waitFor(() => expect(activeWaitCount()).toBe(1));

    chat.push('MESSAGE_CREATE', { hello: 'world' });
    const response = await decrypt(channel, await pending);

    expect(response.success).toBe(true);
    const result = response.result as WaitForEventsResult;
    expect(result.timedOut).toBe(false);
    expect(result.streams['chat:_default'].events.map((e) => e.data)).toEqual([{ hello: 'world' }]);

    const snap = getSessionsSnapshot().find((s) => channel.sessionId.startsWith(s.sessionIdShort));
    expect(snap?.windowRequests).toBe(1);
  });

  it('releases the waiter and its listener when the client disconnects', async () => {
    const channel = await handshake();
    const baseline = mgr.eventListenerCount;
    const ac = new AbortController();
    const pending = post(
      channel,
      'wait_for_events',
      { cursors: cursorNow(), timeout_ms: 50_000 },
      ac.signal,
    ).catch((err: unknown) => err);

    await vi.waitFor(() => {
      expect(activeWaitCount()).toBe(1);
      expect(mgr.eventListenerCount).toBe(baseline + 1);
    });

    ac.abort();
    expect(await pending).toBeInstanceOf(Error);

    await vi.waitFor(() => {
      expect(activeWaitCount()).toBe(0);
      expect(mgr.eventListenerCount).toBe(baseline);
    });
  });

  it('returns a tool error when the per-session cap is exceeded', async () => {
    const channel = await handshake();
    const input = { cursors: cursorNow(), timeout_ms: 20_000 };
    const held = [post(channel, 'wait_for_events', input), post(channel, 'wait_for_events', input)];
    await vi.waitFor(() => expect(activeWaitCount()).toBe(2));

    const third = await decrypt(channel, await post(channel, 'wait_for_events', input));
    expect(third.success).toBe(false);
    expect(third.error).toBe('too many concurrent waits');

    chat.push('release');
    for (const r of await Promise.all(held)) expect((await decrypt(channel, r)).success).toBe(true);
  });
});

describe('per-session 429', () => {
  it('sends Retry-After with the whole seconds until the window resets', async () => {
    const channel = await handshake();
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect((await post(channel, 'ingestor_status', {})).status).toBe(200);
    }

    const limited = await post(channel, 'ingestor_status', {});
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(58);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe('graceful shutdown with a wait held', () => {
  it('answers the wait with timedOut:true and closes promptly', async () => {
    // A separate app and manager: gracefulShutdown stops both. The caller has
    // no ingestors, so the wait has nothing to wake it and would hold 50s.
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      callers: { 'test-client': { connections: [] } },
      rateLimitPerMinute: RATE_LIMIT,
    };
    const shutdownMgr = new IngestorManager(config);
    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: extractPublicKeys(clientKeys) }],
      ingestorManager: shutdownMgr,
      disableRateLimiting: true,
    });
    const shutdownServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(shutdownServer.address() as AddressInfo).port}`;

    try {
      const channel = await handshake(url);
      const pending = post(channel, 'wait_for_events', { timeout_ms: 50_000 }, undefined, url);
      await vi.waitFor(() => expect(activeWaitCount()).toBe(1));

      const started = Date.now();
      await gracefulShutdown(shutdownServer, shutdownMgr);
      const closeMs = Date.now() - started;

      expect(closeMs).toBeLessThan(2_000);
      expect(activeWaitCount()).toBe(0);
      expect(shutdownMgr.eventListenerCount).toBe(0);
      const response = await decrypt(channel, await pending);
      expect(response.success).toBe(true);
      expect((response.result as WaitForEventsResult).timedOut).toBe(true);
    } finally {
      resumeWaits();
      shutdownServer.closeAllConnections();
      shutdownServer.close();
    }
  });
});

describe('createApp after a shutdown', () => {
  it('clears draining, so waits hold again in the new app', async () => {
    releaseAllWaits(); // what gracefulShutdown leaves behind

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      callers: { 'test-client': { connections: [] } },
      rateLimitPerMinute: RATE_LIMIT,
    };
    const freshMgr = new IngestorManager(config);
    createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [],
      ingestorManager: freshMgr,
      disableRateLimiting: true,
    });

    const pending = toolHandlers.wait_for_events({ timeout_ms: 30_000 }, [], {
      callerAlias: 'test-client',
      ingestorManager: freshMgr,
      refreshRoutes: () => undefined,
      sessionId: 'post-restart',
    }) as Promise<WaitForEventsResult>;
    await vi.waitFor(() => expect(activeWaitCount()).toBe(1));

    releaseAllWaits();
    expect((await pending).timedOut).toBe(true);
  });
});
