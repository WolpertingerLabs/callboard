/**
 * A caller that still lists a removed per-scope Google template: the real
 * Express app, a real handshake. Only that connection is dropped; the
 * handshake succeeds and the caller's other connections keep working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from './server.js';
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
import { IngestorManager } from './ingestors/manager.js';

let server: Server;
let baseUrl: string;
let clientKeys: KeyBundle;
let serverPub: PublicKeyBundle;
let mgr: IngestorManager;

beforeAll(async () => {
  clientKeys = generateKeyBundle();
  const serverKeys = generateKeyBundle();
  serverPub = extractPublicKeys(serverKeys);
  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0,
    callers: {
      'test-client': {
        connections: ['github', 'google-sheets', 'google'],
        google: { auth: 'user', services: { docs: 'edit' } },
      },
    },
    rateLimitPerMinute: 60,
  };
  mgr = new IngestorManager(config);
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

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await mgr.stopAll();
});

describe('a removed template ID on a caller', () => {
  it('drops only that connection: the handshake succeeds and list_routes has the rest', async () => {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initResp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initiator.createInit()),
    });
    expect(initResp.status).toBe(200);
    const keys = initiator.processReply((await initResp.json()) as HandshakeReply);
    const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': keys.sessionId },
      body: JSON.stringify(initiator.createFinish(keys)),
    });
    expect(finishResp.ok).toBe(true);
    const channel = new EncryptedChannel(keys);

    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_routes',
      toolInput: {},
      timestamp: Date.now(),
    };
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': channel.sessionId },
      body: new Uint8Array(channel.encryptJSON(request)),
    });
    expect(resp.status).toBe(200);
    const reply = channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
    expect(reply.success).toBe(true);
    const aliases = (reply.result as { alias: string }[]).map((r) => r.alias);
    expect(aliases).toEqual(['github', 'google']);
  });
});
