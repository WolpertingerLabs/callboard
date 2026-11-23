/**
 * End-to-end tests for the remote server.
 *
 * Boots a real Express app with in-memory keys, performs handshakes
 * over HTTP, sends encrypted requests, and validates the full flow.
 * Tests route-based secret scoping, header injection, and header conflict rejection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, type AuthorizedPeer } from './server.js';
import type { RemoteServerConfig } from '../shared/config.js';
import {
  generateKeyBundle,
  extractPublicKeys,
  saveKeyBundle,
  serializeKeyBundle,
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
import { checkEnvVars, loadE2EEnv } from './ingestors/e2e/setup.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

let clientKeys: KeyBundle;
let serverKeys: KeyBundle;
let clientPub: PublicKeyBundle;
let serverPub: PublicKeyBundle;

const testSecrets: Record<string, string> = {
  TEST_SECRET: 'hello-from-the-vault',
  API_KEY: 'sk-test-1234567890',
};

beforeAll(async () => {
  // Generate fresh key pairs for client and server
  clientKeys = generateKeyBundle();
  serverKeys = generateKeyBundle();
  clientPub = extractPublicKeys(clientKeys);
  serverPub = extractPublicKeys(serverKeys);

  // Build a config that uses our in-memory keys directly
  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0, // not used — we listen on a random port
    connectors: [
      {
        alias: 'test-route',
        secrets: testSecrets, // literal values, no env var resolution needed
        allowedEndpoints: [], // empty = matches nothing (we use a different server for http_request tests)
      },
    ],
    callers: {
      'test-client': { connections: ['test-route'] },
    },
    rateLimitPerMinute: 60,
  };

  const app = createApp({
    config,
    ownKeys: serverKeys,
    authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
  });

  // Start on a random available port
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
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Perform a full handshake and return the encrypted channel + session ID */
async function performHttpHandshake(): Promise<{
  channel: EncryptedChannel;
  sessionId: string;
}> {
  const initiator = new HandshakeInitiator(clientKeys, serverPub);

  // Step 1: Send init
  const initMsg = initiator.createInit();
  const initResp = await fetch(`${baseUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initMsg),
  });
  expect(initResp.ok).toBe(true);

  const reply = (await initResp.json()) as HandshakeReply;

  // Step 2: Process reply and derive keys
  const sessionKeys = initiator.processReply(reply);
  const channel = new EncryptedChannel(sessionKeys);

  // Step 3: Send finish
  const finishMsg = initiator.createFinish(sessionKeys);
  const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionKeys.sessionId,
    },
    body: JSON.stringify(finishMsg),
  });
  expect(finishResp.ok).toBe(true);

  const finishResult = (await finishResp.json()) as { status: string; sessionId: string };
  expect(finishResult.status).toBe('established');

  return { channel, sessionId: sessionKeys.sessionId };
}

/** Send an encrypted tool request and return the decrypted response */
async function sendToolRequest(
  channel: EncryptedChannel,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ProxyResponse> {
  const request: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName,
    toolInput,
    timestamp: Date.now(),
  };

  const encrypted = channel.encryptJSON(request);
  const resp = await fetch(`${baseUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': channel.sessionId,
    },
    body: new Uint8Array(encrypted),
  });

  expect(resp.ok).toBe(true);
  return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Health check', () => {
  it('should return ok status', async () => {
    const resp = await fetch(`${baseUrl}/health`);
    expect(resp.ok).toBe(true);

    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('Handshake', () => {
  it('should complete a full handshake successfully', async () => {
    const { channel, sessionId } = await performHttpHandshake();
    expect(sessionId).toBeDefined();
    expect(channel.sessionId).toBe(sessionId);
  });

  it('should reject unauthorized clients', async () => {
    const rogueKeys = generateKeyBundle();

    const initiator = new HandshakeInitiator(rogueKeys, serverPub);
    const initMsg = initiator.createInit();

    const resp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });

    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain('not authorized');
  });

  it('should reject finish without session ID header', async () => {
    const resp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'handshake_finish', payload: 'deadbeef' }),
    });

    expect(resp.status).toBe(400);
  });

  it('should reject finish with unknown session ID', async () => {
    const resp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': 'nonexistent-session',
      },
      body: JSON.stringify({ type: 'handshake_finish', payload: 'deadbeef' }),
    });

    expect(resp.status).toBe(404);
  });
});

describe('Encrypted requests', () => {
  let channel: EncryptedChannel;

  beforeAll(async () => {
    const result = await performHttpHandshake();
    channel = result.channel;
  });

  it('should list routes', async () => {
    const response = await sendToolRequest(channel, 'list_routes', {});
    expect(response.success).toBe(true);

    const routes = response.result as Record<string, unknown>[];
    expect(routes).toHaveLength(1);
    expect(routes[0].index).toBe(0);
    expect(routes[0].secretNames).toContain('TEST_SECRET');
    expect(routes[0].secretNames).toContain('API_KEY');
    expect(routes[0].allowedEndpoints).toEqual([]);
  });

  it('should return an error for unknown tools', async () => {
    const response = await sendToolRequest(channel, 'nonexistent_tool', {});
    expect(response.success).toBe(false);
    expect(response.error).toContain('Unknown tool');
  });
});

describe('Security', () => {
  it('should reject replayed encrypted payloads', async () => {
    const { channel } = await performHttpHandshake();

    // Send a valid request first
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_routes',
      toolInput: {},
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const body = new Uint8Array(encrypted);

    // First request succeeds — consume the response to advance the recv counter
    const resp1 = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body,
    });
    expect(resp1.ok).toBe(true);
    const firstResponse = channel.decryptJSON<ProxyResponse>(
      Buffer.from(await resp1.arrayBuffer()),
    );
    expect(firstResponse.success).toBe(true);

    // Replay the exact same encrypted payload — server rejects (counter mismatch)
    const resp2 = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body,
    });
    // Server detects replay: either sends encrypted error (200) or session breaks (500)
    if (resp2.ok) {
      const errorResponse = channel.decryptJSON<ProxyResponse>(
        Buffer.from(await resp2.arrayBuffer()),
      );
      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('Duplicate counter');
    } else {
      expect(resp2.status).toBe(500);
    }
  });

  it('should reject requests with unknown session IDs', async () => {
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': 'totally-fake-session-id',
      },
      body: new Uint8Array(Buffer.from('garbage')),
    });

    expect(resp.status).toBe(401);
  });

  it('should reject requests without session ID header', async () => {
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('garbage')),
    });

    expect(resp.status).toBe(400);
  });

  it('should support multiple concurrent sessions', async () => {
    const session1 = await performHttpHandshake();
    const session2 = await performHttpHandshake();

    expect(session1.sessionId).not.toBe(session2.sessionId);

    // Both sessions should work independently
    const resp1 = await sendToolRequest(session1.channel, 'list_routes', {});
    const resp2 = await sendToolRequest(session2.channel, 'list_routes', {});

    expect(resp1.success).toBe(true);
    expect(resp2.success).toBe(true);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  let rateLimitedServer: Server;
  let rateLimitedUrl: string;

  beforeAll(async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'rate-test',
          secrets: { SECRET: 'value' },
          allowedEndpoints: [],
        },
      ],
      callers: {
        'test-client': { connections: ['rate-test'] },
      },
      rateLimitPerMinute: 3, // Very low limit for testing
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });

    await new Promise<void>((resolve) => {
      rateLimitedServer = app.listen(0, '127.0.0.1', () => {
        const addr = rateLimitedServer.address() as AddressInfo;
        rateLimitedUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      rateLimitedServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should reject requests that exceed the rate limit', async () => {
    // Perform handshake on the rate-limited server
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${rateLimitedUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${rateLimitedUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    expect(finishResp.ok).toBe(true);

    // Send 3 requests (within limit)
    for (let i = 0; i < 3; i++) {
      const request: ProxyRequest = {
        type: 'proxy_request',
        id: crypto.randomUUID(),
        toolName: 'list_routes',
        toolInput: {},
        timestamp: Date.now(),
      };
      const encrypted = channel.encryptJSON(request);
      const resp = await fetch(`${rateLimitedUrl}/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Session-Id': channel.sessionId,
        },
        body: new Uint8Array(encrypted),
      });
      expect(resp.ok).toBe(true);
      // Must consume response to advance recv counter
      channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
    }

    // 4th request should be rate-limited
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_routes',
      toolInput: {},
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${rateLimitedUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.status).toBe(429);
    const body = await resp.text();
    expect(body).toContain('Rate limit exceeded');
  });
});

// ── http_request tool handler ──────────────────────────────────────────────

describe('http_request tool', () => {
  let targetServer: Server;
  let targetUrl: string;
  let httpTestServer: Server;
  let httpTestUrl: string;

  beforeAll(async () => {
    // Create a target HTTP server that the proxy will call
    targetServer = http.createServer((req, res) => {
      if (req.url === '/json-endpoint') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'hello', auth: req.headers.authorization ?? null }));
      } else if (req.url === '/text-endpoint') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain text response');
      } else if (req.url === '/echo-body') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        const addr = targetServer.address() as AddressInfo;
        targetUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Create the MCP server with route-based config
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'http-test',
          secrets: { MY_TOKEN: 'Bearer secret-jwt-token', BODY_SECRET: 'super-secret-body' },
          allowedEndpoints: [`${targetUrl}/**`],
        },
      ],
      callers: {
        'test-client': { connections: ['http-test'] },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });

    await new Promise<void>((resolve) => {
      httpTestServer = app.listen(0, '127.0.0.1', () => {
        const addr = httpTestServer.address() as AddressInfo;
        httpTestUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        targetServer.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        httpTestServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  });

  /** Perform handshake against the http_request test server */
  async function httpHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${httpTestUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${httpTestUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  /** Send encrypted tool request to the http_request test server */
  async function sendHttpToolRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${httpTestUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should proxy a GET request and return JSON response', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/json-endpoint`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { status: number; body: { message: string } };
    expect(result.status).toBe(200);
    expect(result.body.message).toBe('hello');
  });

  it('should proxy a GET request and return text response', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/text-endpoint`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(result.body).toBe('plain text response');
  });

  it('should resolve secret placeholders in headers', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/json-endpoint`,
      headers: { Authorization: '${MY_TOKEN}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    expect(result.body.auth).toBe('Bearer secret-jwt-token');
  });

  it('should NOT resolve placeholders in string body by default (resolveSecretsInBody=false)', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'POST',
      url: `${targetUrl}/echo-body`,
      headers: { 'Content-Type': 'text/plain' },
      body: 'my secret is ${BODY_SECRET}',
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { received: string } };
    // Placeholder should be left as-is — not resolved
    expect(result.body.received).toBe('my secret is ${BODY_SECRET}');
  });

  it('should NOT resolve placeholders in object body by default (resolveSecretsInBody=false)', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'POST',
      url: `${targetUrl}/echo-body`,
      headers: {},
      body: { key: '${BODY_SECRET}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { received: string; contentType: string } };
    const parsed = JSON.parse(result.body.received) as { key: string };
    // Placeholder should be left as-is — not resolved
    expect(parsed.key).toBe('${BODY_SECRET}');
    // Should still auto-set Content-Type when body is an object
    expect(result.body.contentType).toContain('application/json');
  });

  it('should reject requests to endpoints not on the allowlist', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: 'https://evil.example.com/steal-secrets',
      headers: {},
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Endpoint not allowed');
  });

  it('should leave unknown placeholders unchanged with a warning', async () => {
    const channel = await httpHandshake();
    // Send a request where the Authorization header has an unknown placeholder
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/json-endpoint`,
      headers: { Authorization: '${UNKNOWN_SECRET}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    // The unknown placeholder should be left as-is
    expect(result.body.auth).toBe('${UNKNOWN_SECRET}');
  });
});

// ── resolveSecretsInBody opt-in ──────────────────────────────────────────────

describe('http_request with resolveSecretsInBody enabled', () => {
  let bodyTargetServer: Server;
  let bodyTargetUrl: string;
  let bodyTestServer: Server;
  let bodyTestUrl: string;

  beforeAll(async () => {
    // Target server that echoes the body back
    bodyTargetServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
      });
    });

    await new Promise<void>((resolve) => {
      bodyTargetServer.listen(0, '127.0.0.1', () => {
        const addr = bodyTargetServer.address() as AddressInfo;
        bodyTargetUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'body-test',
          secrets: { MY_TOKEN: 'Bearer secret-jwt-token', BODY_SECRET: 'super-secret-body' },
          allowedEndpoints: [`${bodyTargetUrl}/**`],
          resolveSecretsInBody: true,
        },
      ],
      callers: {
        'test-client': { connections: ['body-test'] },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });

    await new Promise<void>((resolve) => {
      bodyTestServer = app.listen(0, '127.0.0.1', () => {
        const addr = bodyTestServer.address() as AddressInfo;
        bodyTestUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        bodyTargetServer.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        bodyTestServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  });

  async function bodyHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${bodyTestUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${bodyTestUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  async function sendBodyToolRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${bodyTestUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should resolve placeholders in string body when resolveSecretsInBody is true', async () => {
    const channel = await bodyHandshake();
    const response = await sendBodyToolRequest(channel, 'http_request', {
      method: 'POST',
      url: `${bodyTargetUrl}/echo`,
      headers: { 'Content-Type': 'text/plain' },
      body: 'my secret is ${BODY_SECRET}',
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { received: string } };
    expect(result.body.received).toBe('my secret is super-secret-body');
  });

  it('should resolve placeholders in object body when resolveSecretsInBody is true', async () => {
    const channel = await bodyHandshake();
    const response = await sendBodyToolRequest(channel, 'http_request', {
      method: 'POST',
      url: `${bodyTargetUrl}/echo`,
      headers: {},
      body: { key: '${BODY_SECRET}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { received: string; contentType: string } };
    const parsed = JSON.parse(result.body.received) as { key: string };
    expect(parsed.key).toBe('super-secret-body');
    expect(result.body.contentType).toContain('application/json');
  });
});

// ── Route isolation ────────────────────────────────────────────────────────

describe('Route isolation', () => {
  let targetServerA: Server;
  let targetUrlA: string;
  let targetServerB: Server;
  let targetUrlB: string;
  let isolationServer: Server;
  let isolationUrl: string;

  beforeAll(async () => {
    // Create two target HTTP servers
    targetServerA = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ server: 'A', auth: req.headers.authorization ?? null }));
    });
    targetServerB = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ server: 'B', auth: req.headers.authorization ?? null }));
    });

    await Promise.all([
      new Promise<void>((resolve) => {
        targetServerA.listen(0, '127.0.0.1', () => {
          const addr = targetServerA.address() as AddressInfo;
          targetUrlA = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        targetServerB.listen(0, '127.0.0.1', () => {
          const addr = targetServerB.address() as AddressInfo;
          targetUrlB = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
    ]);

    // Create a server with two routes pointing to different targets
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'route-a',
          headers: { Authorization: 'Bearer route-a-token' },
          secrets: { TOKEN_A: 'secret-a-value' },
          allowedEndpoints: [`${targetUrlA}/**`],
        },
        {
          alias: 'route-b',
          headers: { Authorization: 'Bearer route-b-token' },
          secrets: { TOKEN_B: 'secret-b-value' },
          allowedEndpoints: [`${targetUrlB}/**`],
        },
      ],
      callers: {
        'test-client': { connections: ['route-a', 'route-b'] },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });

    await new Promise<void>((resolve) => {
      isolationServer = app.listen(0, '127.0.0.1', () => {
        const addr = isolationServer.address() as AddressInfo;
        isolationUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        targetServerA.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        targetServerB.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        isolationServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  });

  async function isolationHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${isolationUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${isolationUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  async function sendIsolationRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${isolationUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should inject route-level headers for route A', async () => {
    const channel = await isolationHandshake();
    const response = await sendIsolationRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlA}/anything`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { server: string; auth: string } };
    expect(result.body.server).toBe('A');
    expect(result.body.auth).toBe('Bearer route-a-token');
  });

  it('should inject route-level headers for route B', async () => {
    const channel = await isolationHandshake();
    const response = await sendIsolationRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlB}/anything`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { server: string; auth: string } };
    expect(result.body.server).toBe('B');
    expect(result.body.auth).toBe('Bearer route-b-token');
  });

  it('should only resolve secrets from the matched route (route A)', async () => {
    const channel = await isolationHandshake();
    // TOKEN_A belongs to route A, TOKEN_B belongs to route B
    // Requesting route A's endpoint should only resolve route A's secrets
    const response = await sendIsolationRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlA}/anything`,
      headers: { 'X-Token-A': '${TOKEN_A}', 'X-Token-B': '${TOKEN_B}' },
    });

    expect(response.success).toBe(true);
    // Route A's Authorization header is injected by the server
    // X-Token-A should resolve, X-Token-B should NOT (left as placeholder)
  });

  it('should reject request when client header conflicts with route header', async () => {
    const channel = await isolationHandshake();
    const response = await sendIsolationRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlA}/anything`,
      headers: { Authorization: 'Bearer client-override-attempt' },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Header conflict');
    expect(response.error).toContain('Authorization');
  });

  it('should reject request when client header conflicts with route header (case-insensitive)', async () => {
    const channel = await isolationHandshake();
    const response = await sendIsolationRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlA}/anything`,
      headers: { authorization: 'Bearer client-override-attempt' },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Header conflict');
  });

  it('should reject requests to unmatched endpoints', async () => {
    const channel = await isolationHandshake();
    const response = await sendIsolationRequest(channel, 'http_request', {
      method: 'GET',
      url: 'https://evil.example.com/steal-secrets',
      headers: {},
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Endpoint not allowed');
  });

  it('should list all routes with metadata', async () => {
    const channel = await isolationHandshake();
    const response = await sendIsolationRequest(channel, 'list_routes', {});

    expect(response.success).toBe(true);
    const routes = response.result as Record<string, unknown>[];
    expect(routes).toHaveLength(2);

    // Route 0 — targets server A
    expect(routes[0].index).toBe(0);
    expect(routes[0].secretNames).toContain('TOKEN_A');
    expect(routes[0].autoHeaders).toContain('Authorization');

    // Route 1 — targets server B
    expect(routes[1].index).toBe(1);
    expect(routes[1].secretNames).toContain('TOKEN_B');
    expect(routes[1].autoHeaders).toContain('Authorization');
  });
});

// ── Route metadata ─────────────────────────────────────────────────────────

describe('Route metadata in list_routes', () => {
  let metadataServer: Server;
  let metadataUrl: string;

  beforeAll(async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'github',
          name: 'GitHub API',
          description: 'Access to GitHub REST API v3',
          docsUrl: 'https://docs.github.com/en/rest',
          openApiUrl:
            'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
          secrets: { GH_TOKEN: 'ghp_test123' },
          headers: { Authorization: 'Bearer ${GH_TOKEN}' },
          allowedEndpoints: ['https://api.github.com/**'],
        },
        {
          alias: 'stripe',
          // Route without metadata — should still work
          secrets: { STRIPE_KEY: 'sk_test_abc' },
          allowedEndpoints: ['https://api.stripe.com/**'],
        },
        {
          alias: 'internal',
          name: 'Internal API',
          // description and docsUrl intentionally omitted
          secrets: {},
          allowedEndpoints: ['https://internal.example.com/**'],
        },
      ],
      callers: {
        'test-client': { connections: ['github', 'stripe', 'internal'] },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });

    await new Promise<void>((resolve) => {
      metadataServer = app.listen(0, '127.0.0.1', () => {
        const addr = metadataServer.address() as AddressInfo;
        metadataUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      metadataServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function metadataHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${metadataUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${metadataUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  async function sendMetadataRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${metadataUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should return route metadata fields when present', async () => {
    const channel = await metadataHandshake();
    const response = await sendMetadataRequest(channel, 'list_routes', {});

    expect(response.success).toBe(true);
    const routes = response.result as Record<string, unknown>[];
    expect(routes).toHaveLength(3);

    // Route 0 — full metadata
    expect(routes[0].name).toBe('GitHub API');
    expect(routes[0].description).toBe('Access to GitHub REST API v3');
    expect(routes[0].docsUrl).toBe('https://docs.github.com/en/rest');
    expect(routes[0].openApiUrl).toBe(
      'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    );
    expect(routes[0].allowedEndpoints).toEqual(['https://api.github.com/**']);
    expect(routes[0].secretNames).toEqual(['GH_TOKEN']);
    expect(routes[0].autoHeaders).toEqual(['Authorization']);

    // Route 1 — no metadata
    expect(routes[1].name).toBeUndefined();
    expect(routes[1].description).toBeUndefined();
    expect(routes[1].docsUrl).toBeUndefined();
    expect(routes[1].openApiUrl).toBeUndefined();
    expect(routes[1].secretNames).toEqual(['STRIPE_KEY']);

    // Route 2 — partial metadata (name only)
    expect(routes[2].name).toBe('Internal API');
    expect(routes[2].description).toBeUndefined();
    expect(routes[2].docsUrl).toBeUndefined();
    expect(routes[2].openApiUrl).toBeUndefined();
    expect(routes[2].secretNames).toEqual([]);
    expect(routes[2].autoHeaders).toEqual([]);
  });
});

// ── Handshake finish edge cases ────────────────────────────────────────────

describe('Handshake finish edge cases', () => {
  it('should reject a finish with an invalid payload (bad verification)', async () => {
    // Perform a normal handshake init to get a valid session
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);

    // Send a finish with garbage payload instead of the real encrypted finish
    const resp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify({
        type: 'handshake_finish',
        payload: crypto.randomBytes(64).toString('hex'),
      }),
    });

    // Should fail — either 403 (finish verification failed) or the verify threw
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBeDefined();
  });
});

// ── loadAuthorizedPeers (disk-based) ───────────────────────────────────────

describe('loadCallerPeers via createApp', () => {
  let tmpConfigDir: string;
  const originalConfigDir = process.env.MCP_CONFIG_DIR;

  beforeAll(() => {
    // Create temp config dir with proper key structure
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
    const serverKeysPath = path.join(tmpConfigDir, 'keys', 'server');
    const callerKeysPath = path.join(tmpConfigDir, 'keys', 'callers', 'client1');
    fs.mkdirSync(serverKeysPath, { recursive: true });
    fs.mkdirSync(callerKeysPath, { recursive: true });

    // Save server keys to disk so createApp can load them
    saveKeyBundle(serverKeys, serverKeysPath);

    // Save one valid peer's public keys
    const serialized = serializeKeyBundle(clientKeys);
    fs.writeFileSync(path.join(callerKeysPath, 'signing.pub.pem'), serialized.signing.publicKey);
    fs.writeFileSync(path.join(callerKeysPath, 'exchange.pub.pem'), serialized.exchange.publicKey);

    process.env.MCP_CONFIG_DIR = tmpConfigDir;
  });

  afterAll(() => {
    if (originalConfigDir) {
      process.env.MCP_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.MCP_CONFIG_DIR;
    }
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('should load peers from disk and allow authorized handshakes', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      connectors: [
        {
          alias: 'disk-test',
          secrets: { TEST: 'loaded-from-disk' },
          allowedEndpoints: [],
        },
      ],
      callers: {
        client1: { connections: ['disk-test'] },
      },
      rateLimitPerMinute: 60,
    };

    // Only pass config — let createApp load keys and peers from disk
    const app = createApp({ config });
    const diskServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const addr = diskServer.address() as AddressInfo;
      const diskUrl = `http://127.0.0.1:${addr.port}`;

      // Handshake from the authorized client should succeed
      const initiator = new HandshakeInitiator(clientKeys, serverPub);
      const initMsg = initiator.createInit();
      const initResp = await fetch(`${diskUrl}/handshake/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initMsg),
      });
      expect(initResp.ok).toBe(true);

      const reply = (await initResp.json()) as HandshakeReply;
      const sessionKeys = initiator.processReply(reply);
      const channel = new EncryptedChannel(sessionKeys);

      const finishMsg = initiator.createFinish(sessionKeys);
      const finishResp = await fetch(`${diskUrl}/handshake/finish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionKeys.sessionId,
        },
        body: JSON.stringify(finishMsg),
      });
      expect(finishResp.ok).toBe(true);

      // Verify we can list routes (confirms the session is usable)
      const request: ProxyRequest = {
        type: 'proxy_request',
        id: crypto.randomUUID(),
        toolName: 'list_routes',
        toolInput: {},
        timestamp: Date.now(),
      };
      const encrypted = channel.encryptJSON(request);
      const resp = await fetch(`${diskUrl}/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Session-Id': channel.sessionId,
        },
        body: new Uint8Array(encrypted),
      });
      expect(resp.ok).toBe(true);
      const decrypted = channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
      expect(decrypted.success).toBe(true);
      const routes = decrypted.result as Record<string, unknown>[];
      expect(routes).toHaveLength(1);
      expect(routes[0].secretNames).toContain('TEST');
    } finally {
      await new Promise<void>((resolve) => {
        diskServer.close(() => resolve());
      });
    }
  });

  it('should handle non-existent peers directory gracefully', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      callers: {
        ghost: {
          connections: [],
        },
      },
      rateLimitPerMinute: 60,
    };

    // Should not throw — loadCallerPeers skips missing dirs
    // (ghost has no keys in keys/callers/ghost/)
    expect(() =>
      createApp({
        config,
        ownKeys: serverKeys,
        // authorizedPeers not passed, so it'll call loadCallerPeers
      }),
    ).not.toThrow();
  });
});

// ── Handshake without finish (pending handshake coverage) ──────────────────

describe('Pending handshake state', () => {
  it('should create a pending handshake on init that can be completed later', async () => {
    // Start a handshake but don't finish — verifies the pending state is created
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);

    // Completing it later should still work (pending handshake is stored)
    const channel = new EncryptedChannel(sessionKeys);
    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    expect(finishResp.ok).toBe(true);

    // And the session should be usable
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_routes',
      toolInput: {},
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
  });
});

// ── Per-caller access control ──────────────────────────────────────────────

describe('Per-caller access control', () => {
  let targetServerX: Server;
  let targetUrlX: string;
  let targetServerY: Server;
  let targetUrlY: string;
  let accessServer: Server;
  let accessUrl: string;

  // Two separate clients with different key pairs
  let client2Keys: KeyBundle;
  let client2Pub: PublicKeyBundle;

  beforeAll(async () => {
    client2Keys = generateKeyBundle();
    client2Pub = extractPublicKeys(client2Keys);

    // Two target servers
    targetServerX = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ server: 'X', auth: req.headers.authorization ?? null }));
    });
    targetServerY = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ server: 'Y', auth: req.headers.authorization ?? null }));
    });

    await Promise.all([
      new Promise<void>((resolve) => {
        targetServerX.listen(0, '127.0.0.1', () => {
          const addr = targetServerX.address() as AddressInfo;
          targetUrlX = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        targetServerY.listen(0, '127.0.0.1', () => {
          const addr = targetServerY.address() as AddressInfo;
          targetUrlY = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
    ]);

    // Configure: caller "full" gets both connectors, caller "limited" gets only X
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'service-x',
          name: 'Service X',
          headers: { Authorization: 'Bearer token-x' },
          secrets: {},
          allowedEndpoints: [`${targetUrlX}/**`],
        },
        {
          alias: 'service-y',
          name: 'Service Y',
          headers: { Authorization: 'Bearer token-y' },
          secrets: {},
          allowedEndpoints: [`${targetUrlY}/**`],
        },
      ],
      callers: {
        full: { connections: ['service-x', 'service-y'] },
        limited: { connections: ['service-x'] },
      },
      rateLimitPerMinute: 60,
    };

    const authorizedPeers: AuthorizedPeer[] = [
      { alias: 'full', keys: clientPub },
      { alias: 'limited', keys: client2Pub },
    ];

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers,
    });

    await new Promise<void>((resolve) => {
      accessServer = app.listen(0, '127.0.0.1', () => {
        const addr = accessServer.address() as AddressInfo;
        accessUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        targetServerX.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        targetServerY.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        accessServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  });

  async function handshakeAs(keys: KeyBundle): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(keys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${accessUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${accessUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  async function sendAccessRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${accessUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should show different routes for different callers', async () => {
    const fullChannel = await handshakeAs(clientKeys);
    const limitedChannel = await handshakeAs(client2Keys);

    const fullRoutes = await sendAccessRequest(fullChannel, 'list_routes', {});
    const limitedRoutes = await sendAccessRequest(limitedChannel, 'list_routes', {});

    expect(fullRoutes.success).toBe(true);
    expect(limitedRoutes.success).toBe(true);

    const fullList = fullRoutes.result as Record<string, unknown>[];
    const limitedList = limitedRoutes.result as Record<string, unknown>[];

    // Full caller sees both connectors
    expect(fullList).toHaveLength(2);
    expect(fullList[0].name).toBe('Service X');
    expect(fullList[1].name).toBe('Service Y');

    // Limited caller sees only service-x
    expect(limitedList).toHaveLength(1);
    expect(limitedList[0].name).toBe('Service X');
  });

  it('should allow full caller to access both services', async () => {
    const channel = await handshakeAs(clientKeys);

    const respX = await sendAccessRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlX}/test`,
      headers: {},
    });
    expect(respX.success).toBe(true);
    expect((respX.result as { body: { server: string } }).body.server).toBe('X');

    const respY = await sendAccessRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlY}/test`,
      headers: {},
    });
    expect(respY.success).toBe(true);
    expect((respY.result as { body: { server: string } }).body.server).toBe('Y');
  });

  it('should block limited caller from accessing service Y', async () => {
    const channel = await handshakeAs(client2Keys);

    // Service X should work
    const respX = await sendAccessRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlX}/test`,
      headers: {},
    });
    expect(respX.success).toBe(true);

    // Service Y should be blocked
    const respY = await sendAccessRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrlY}/test`,
      headers: {},
    });
    expect(respY.success).toBe(false);
    expect(respY.error).toContain('Endpoint not allowed');
  });
});

// ── Per-caller env overrides ───────────────────────────────────────────────

describe('Per-caller env overrides', () => {
  let echoServer: Server;
  let echoUrl: string;
  let envServer: Server;
  let envUrl: string;

  // Three separate clients
  let aliceKeys: KeyBundle;
  let alicePub: PublicKeyBundle;
  let bobKeys: KeyBundle;
  let bobPub: PublicKeyBundle;
  let charlieKeys: KeyBundle;
  let charliePub: PublicKeyBundle;

  const originalEnv = process.env;

  beforeAll(async () => {
    // Set up env vars for the test
    process.env = { ...originalEnv };
    process.env.ALICE_GH_TOKEN = 'ghp_alice';
    process.env.BOB_GH_TOKEN = 'ghp_bob';

    aliceKeys = generateKeyBundle();
    alicePub = extractPublicKeys(aliceKeys);
    bobKeys = generateKeyBundle();
    bobPub = extractPublicKeys(bobKeys);
    charlieKeys = generateKeyBundle();
    charliePub = extractPublicKeys(charlieKeys);

    // Echo server that returns the Authorization header it receives
    echoServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    });

    await new Promise<void>((resolve) => {
      echoServer.listen(0, '127.0.0.1', () => {
        const addr = echoServer.address() as AddressInfo;
        echoUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Config: one connector, three callers with different env overrides
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'api',
          name: 'Shared API',
          secrets: { GH_TOKEN: '${GH_TOKEN}' },
          headers: { Authorization: 'Bearer ${GH_TOKEN}' },
          allowedEndpoints: [`${echoUrl}/**`],
        },
      ],
      callers: {
        alice: {
          connections: ['api'],
          env: { GH_TOKEN: '${ALICE_GH_TOKEN}' },
        },
        bob: {
          connections: ['api'],
          env: { GH_TOKEN: '${BOB_GH_TOKEN}' },
        },
        charlie: {
          connections: ['api'],
          env: { GH_TOKEN: 'literal-hardcoded-token' },
        },
      },
      rateLimitPerMinute: 60,
    };

    const authorizedPeers: AuthorizedPeer[] = [
      { alias: 'alice', keys: alicePub },
      { alias: 'bob', keys: bobPub },
      { alias: 'charlie', keys: charliePub },
    ];

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers,
    });

    await new Promise<void>((resolve) => {
      envServer = app.listen(0, '127.0.0.1', () => {
        const addr = envServer.address() as AddressInfo;
        envUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    process.env = originalEnv;
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        echoServer.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        envServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  });

  async function handshakeAs(keys: KeyBundle): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(keys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${envUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${envUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  async function sendEnvRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${envUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should give alice her own GitHub token via env redirect', async () => {
    const channel = await handshakeAs(aliceKeys);
    const response = await sendEnvRequest(channel, 'http_request', {
      method: 'GET',
      url: `${echoUrl}/test`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    expect(result.body.auth).toBe('Bearer ghp_alice');
  });

  it('should give bob his own GitHub token via env redirect', async () => {
    const channel = await handshakeAs(bobKeys);
    const response = await sendEnvRequest(channel, 'http_request', {
      method: 'GET',
      url: `${echoUrl}/test`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    expect(result.body.auth).toBe('Bearer ghp_bob');
  });

  it('should give charlie a literal hardcoded token via env injection', async () => {
    const channel = await handshakeAs(charlieKeys);
    const response = await sendEnvRequest(channel, 'http_request', {
      method: 'GET',
      url: `${echoUrl}/test`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    expect(result.body.auth).toBe('Bearer literal-hardcoded-token');
  });
});

// ── Ingestor tools (poll_events / ingestor_status) ──────────────────────

describe('Ingestor tools', () => {
  it('should return empty array from poll_events when no ingestors configured', async () => {
    const { channel } = await performHttpHandshake();
    const response = await sendToolRequest(channel, 'poll_events', {});

    expect(response.success).toBe(true);
    expect(response.result).toEqual([]);
  });

  it('should return empty array from poll_events with connection filter', async () => {
    const { channel } = await performHttpHandshake();
    const response = await sendToolRequest(channel, 'poll_events', {
      connection: 'discord-bot',
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual([]);
  });

  it('should return empty array from poll_events with after_id cursor', async () => {
    const { channel } = await performHttpHandshake();
    const response = await sendToolRequest(channel, 'poll_events', {
      after_id: 5,
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual([]);
  });

  it('should return empty array from ingestor_status when no ingestors configured', async () => {
    const { channel } = await performHttpHandshake();
    const response = await sendToolRequest(channel, 'ingestor_status', {});

    expect(response.success).toBe(true);
    expect(response.result).toEqual([]);
  });
});

// ── Webhook ingestor (POST /webhooks/:path → poll_events) ───────────────

describe('Webhook ingestor', () => {
  let webhookServer: Server;
  let webhookBaseUrl: string;
  let webhookClientKeys: KeyBundle;
  let webhookServerKeys: KeyBundle;

  const webhookSecret = 'e2e-test-webhook-secret';

  beforeAll(async () => {
    webhookClientKeys = generateKeyBundle();
    webhookServerKeys = generateKeyBundle();
    const clientPub = extractPublicKeys(webhookClientKeys);

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'github',
          secrets: {
            GITHUB_TOKEN: 'ghp_test_token',
            GITHUB_WEBHOOK_SECRET: webhookSecret,
          },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'webhook-client': { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: webhookServerKeys,
      authorizedPeers: [{ alias: 'webhook-client', keys: clientPub }],
    });

    // Start ingestors (creates the webhook ingestor instance)
    const mgr = app.locals.ingestorManager as import('./ingestors/index.js').IngestorManager;
    await mgr.startAll();

    await new Promise<void>((resolve) => {
      webhookServer = app.listen(0, '127.0.0.1', () => {
        const addr = webhookServer.address() as AddressInfo;
        webhookBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      webhookServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  function signPayload(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `sha256=${hmac}`;
  }

  async function webhookHandshake(): Promise<{
    channel: EncryptedChannel;
    sessionId: string;
  }> {
    const initiator = new HandshakeInitiator(
      webhookClientKeys,
      extractPublicKeys(webhookServerKeys),
    );

    const initMsg = initiator.createInit();
    const initResp = await fetch(`${webhookBaseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${webhookBaseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    expect(finishResp.ok).toBe(true);

    return { channel, sessionId: sessionKeys.sessionId };
  }

  async function sendWebhookToolRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };

    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${webhookBaseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });

    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should accept a webhook with valid signature and make event available via poll_events', async () => {
    const body = JSON.stringify({ action: 'opened', number: 1 });
    const sig = signPayload(body, webhookSecret);

    const webhookResp = await fetch(`${webhookBaseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': sig,
        'X-GitHub-Delivery': 'delivery-001',
      },
      body,
    });

    expect(webhookResp.status).toBe(200);
    const webhookResult = (await webhookResp.json()) as { received: boolean };
    expect(webhookResult.received).toBe(true);

    // Now retrieve the event via poll_events
    const { channel } = await webhookHandshake();
    const response = await sendWebhookToolRequest(channel, 'poll_events', {
      connection: 'github',
    });

    expect(response.success).toBe(true);
    const events = response.result as {
      id: number;
      source: string;
      eventType: string;
      data: { deliveryId: string; event: string; payload: unknown };
    }[];
    expect(events.length).toBeGreaterThanOrEqual(1);

    const event = events[0];
    expect(event.source).toBe('github');
    expect(event.eventType).toBe('pull_request');
    expect(event.data.deliveryId).toBe('delivery-001');
    expect(event.data.event).toBe('pull_request');
    expect(event.data.payload).toEqual({ action: 'opened', number: 1 });
  });

  it('should reject a webhook with invalid signature (403)', async () => {
    const body = JSON.stringify({ action: 'closed' });
    const badSig = signPayload(body, 'wrong-secret');

    const resp = await fetch(`${webhookBaseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': badSig,
      },
      body,
    });

    expect(resp.status).toBe(403);
  });

  it('should reject a webhook with missing signature header (403)', async () => {
    const body = JSON.stringify({ action: 'opened' });

    const resp = await fetch(`${webhookBaseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        // No X-Hub-Signature-256 header
      },
      body,
    });

    expect(resp.status).toBe(403);
  });

  it('should return 404 for an unregistered webhook path', async () => {
    const resp = await fetch(`${webhookBaseUrl}/webhooks/nonexistent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(resp.status).toBe(404);
  });

  it('should respond 200 to HEAD request for a registered webhook path (Trello verification)', async () => {
    const resp = await fetch(`${webhookBaseUrl}/webhooks/github`, {
      method: 'HEAD',
    });

    expect(resp.status).toBe(200);
  });

  it('should respond 404 to HEAD request for an unregistered webhook path', async () => {
    const resp = await fetch(`${webhookBaseUrl}/webhooks/nonexistent`, {
      method: 'HEAD',
    });

    expect(resp.status).toBe(404);
  });

  it('should report webhook ingestor in ingestor_status', async () => {
    const { channel } = await webhookHandshake();
    const response = await sendWebhookToolRequest(channel, 'ingestor_status', {});

    expect(response.success).toBe(true);
    const statuses = response.result as {
      connection: string;
      type: string;
      state: string;
    }[];
    expect(statuses).toHaveLength(1);
    expect(statuses[0].connection).toBe('github');
    expect(statuses[0].type).toBe('webhook');
    expect(statuses[0].state).toBe('connected');
  });

  it('should support cursor-based polling with after_id', async () => {
    // Send two more webhook events
    for (let i = 0; i < 2; i++) {
      const body = JSON.stringify({ index: i });
      const sig = signPayload(body, webhookSecret);
      await fetch(`${webhookBaseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': `test_event_${i}`,
          'X-Hub-Signature-256': sig,
        },
        body,
      });
    }

    const { channel } = await webhookHandshake();

    // Get all events first
    const allResponse = await sendWebhookToolRequest(channel, 'poll_events', {
      connection: 'github',
    });
    const allEvents = allResponse.result as { id: number }[];
    expect(allEvents.length).toBeGreaterThanOrEqual(2);

    // Now poll with a cursor to get only newer events
    const lastButOneId = allEvents[allEvents.length - 2].id;
    const cursorResponse = await sendWebhookToolRequest(channel, 'poll_events', {
      connection: 'github',
      after_id: lastButOneId,
    });
    const cursorEvents = cursorResponse.result as { id: number }[];
    expect(cursorEvents.length).toBeGreaterThanOrEqual(1);
    expect(cursorEvents.every((e) => e.id > lastButOneId)).toBe(true);
  });
});

// ── New tool handler tests ──────────────────────────────────────────────

describe('test_connection tool', () => {
  let testServer: Server;
  let testServerUrl: string;

  let echoServer: Server;
  let echoUrl: string;

  let tcClientKeys: KeyBundle;
  let tcServerKeys: KeyBundle;

  beforeAll(async () => {
    tcClientKeys = generateKeyBundle();
    tcServerKeys = generateKeyBundle();
    const tcClientPub = extractPublicKeys(tcClientKeys);
    const _tcServerPub = extractPublicKeys(tcServerKeys);

    // Create a simple echo server that returns 200 for GET requests
    const echoApp = http.createServer((req, res) => {
      if (req.url === '/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: 'test-user', id: 123 }));
      } else if (req.url === '/auth.test' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: 'bot-user' }));
      } else if (req.url === '/fail') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => {
      echoServer = echoApp.listen(0, '127.0.0.1', () => {
        const addr = echoServer.address() as AddressInfo;
        echoUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'test-api',
          name: 'Test API',
          secrets: { TOKEN: 'test-token' },
          headers: { Authorization: 'Bearer ${TOKEN}' },
          allowedEndpoints: [`${echoUrl}/**`],
          testConnection: {
            url: `${echoUrl}/me`,
            description: 'Fetches the authenticated user',
          },
        },
        {
          alias: 'test-api-post',
          name: 'Test API Post',
          secrets: { TOKEN: 'test-token' },
          headers: { Authorization: 'Bearer ${TOKEN}' },
          allowedEndpoints: [`${echoUrl}/**`],
          testConnection: {
            method: 'POST',
            url: `${echoUrl}/auth.test`,
            description: 'Tests auth via POST',
          },
        },
        {
          alias: 'test-api-fail',
          name: 'Test API Fail',
          secrets: { TOKEN: 'bad-token' },
          headers: { Authorization: 'Bearer ${TOKEN}' },
          allowedEndpoints: [`${echoUrl}/**`],
          testConnection: {
            url: `${echoUrl}/fail`,
            description: 'Expected to fail',
            expectedStatus: [200],
          },
        },
        {
          alias: 'no-test',
          name: 'No Test API',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          // No testConnection
        },
      ],
      callers: {
        'tc-client': {
          connections: ['test-api', 'test-api-post', 'test-api-fail', 'no-test'],
        },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: tcServerKeys,
      authorizedPeers: [{ alias: 'tc-client', keys: tcClientPub }],
    });

    await new Promise<void>((resolve) => {
      testServer = app.listen(0, '127.0.0.1', () => {
        const addr = testServer.address() as AddressInfo;
        testServerUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r, j) => testServer.close((e) => (e ? j(e) : r()))),
      new Promise<void>((r, j) => echoServer.close((e) => (e ? j(e) : r()))),
    ]);
  });

  async function tcHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(tcClientKeys, extractPublicKeys(tcServerKeys));
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${testServerUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${testServerUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    expect(finishResp.ok).toBe(true);
    return channel;
  }

  async function tcSendRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${testServerUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should successfully test a connection with GET', async () => {
    const channel = await tcHandshake();
    const response = await tcSendRequest(channel, 'test_connection', { connection: 'test-api' });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.connection).toBe('test-api');
    expect(result.status).toBe(200);
    expect(result.description).toBe('Fetches the authenticated user');
  });

  it('should successfully test a connection with POST', async () => {
    const channel = await tcHandshake();
    const response = await tcSendRequest(channel, 'test_connection', {
      connection: 'test-api-post',
    });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  it('should report failure when test connection returns unexpected status', async () => {
    const channel = await tcHandshake();
    const response = await tcSendRequest(channel, 'test_connection', {
      connection: 'test-api-fail',
    });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain('Unexpected status');
  });

  it('should return error for connection without testConnection config', async () => {
    const channel = await tcHandshake();
    const response = await tcSendRequest(channel, 'test_connection', { connection: 'no-test' });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain('does not have a test configuration');
  });

  it('should return error for unknown connection', async () => {
    const channel = await tcHandshake();
    const response = await tcSendRequest(channel, 'test_connection', { connection: 'nonexistent' });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown connection');
  });
});

describe('test_ingestor tool', () => {
  let tiServer: Server;
  let tiServerUrl: string;

  let echoServer: Server;
  let echoUrl: string;

  let tiClientKeys: KeyBundle;
  let tiServerKeys: KeyBundle;

  beforeAll(async () => {
    tiClientKeys = generateKeyBundle();
    tiServerKeys = generateKeyBundle();
    const tiClientPub = extractPublicKeys(tiClientKeys);

    // Create an echo server for HTTP-based ingestor tests
    const echoApp = http.createServer((req, res) => {
      if (req.url?.includes('webhooks') || req.url === '/connections.open') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => {
      echoServer = echoApp.listen(0, '127.0.0.1', () => {
        const addr = echoServer.address() as AddressInfo;
        echoUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'webhook-conn',
          name: 'Webhook Connection',
          secrets: { TOKEN: 'tok', WEBHOOK_SECRET: 'wh-secret' },
          allowedEndpoints: [`${echoUrl}/**`],
          ingestor: { type: 'webhook', webhook: { path: 'test' } },
          testIngestor: {
            description: 'Verify webhook secrets',
            strategy: 'webhook_verify',
            requireSecrets: ['WEBHOOK_SECRET'],
          },
        },
        {
          alias: 'http-conn',
          name: 'HTTP Ingestor Connection',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          ingestor: { type: 'webhook', webhook: { path: 'test2' } },
          testIngestor: {
            description: 'Test via HTTP request',
            strategy: 'http_request',
            request: {
              url: `${echoUrl}/webhooks`,
              expectedStatus: [200],
            },
          },
        },
        {
          alias: 'null-test-conn',
          name: 'Null Test Connection',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          ingestor: { type: 'webhook', webhook: { path: 'test3' } },
          testIngestor: null,
        },
        {
          alias: 'no-ingestor-conn',
          name: 'No Ingestor Connection',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          // No ingestor at all
        },
        {
          alias: 'no-test-ingestor',
          name: 'No Test Ingestor',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          ingestor: { type: 'webhook', webhook: { path: 'test4' } },
          // No testIngestor
        },
        {
          alias: 'missing-secret-conn',
          name: 'Missing Secret Connection',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          ingestor: { type: 'webhook', webhook: { path: 'test5' } },
          testIngestor: {
            description: 'Verify secrets that are missing',
            strategy: 'webhook_verify',
            requireSecrets: ['NONEXISTENT_SECRET'],
          },
        },
      ],
      callers: {
        'ti-client': {
          connections: [
            'webhook-conn',
            'http-conn',
            'null-test-conn',
            'no-ingestor-conn',
            'no-test-ingestor',
            'missing-secret-conn',
          ],
        },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: tiServerKeys,
      authorizedPeers: [{ alias: 'ti-client', keys: tiClientPub }],
    });

    await new Promise<void>((resolve) => {
      tiServer = app.listen(0, '127.0.0.1', () => {
        const addr = tiServer.address() as AddressInfo;
        tiServerUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r, j) => tiServer.close((e) => (e ? j(e) : r()))),
      new Promise<void>((r, j) => echoServer.close((e) => (e ? j(e) : r()))),
    ]);
  });

  async function tiHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(tiClientKeys, extractPublicKeys(tiServerKeys));
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${tiServerUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);
    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${tiServerUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    return channel;
  }

  async function tiSendRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${tiServerUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should pass webhook_verify strategy when all secrets present', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', { connection: 'webhook-conn' });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('webhook_verify');
    expect(result.message).toContain('secrets are configured');
  });

  it('should fail webhook_verify strategy when secrets are missing', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', {
      connection: 'missing-secret-conn',
    });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.strategy).toBe('webhook_verify');
    expect(result.error).toContain('Missing required secrets');
    expect(result.error).toContain('NONEXISTENT_SECRET');
  });

  it('should pass http_request strategy with valid endpoint', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', { connection: 'http-conn' });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('http_request');
    expect(result.status).toBe(200);
    expect(result.message).toContain('Listener test passed');
  });

  it('should return not-testable for null testIngestor', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', {
      connection: 'null-test-conn',
    });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain('does not support testing');
  });

  it('should return error for connection without ingestor', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', {
      connection: 'no-ingestor-conn',
    });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain('does not have an event listener');
  });

  it('should return error for connection with ingestor but no testIngestor', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', {
      connection: 'no-test-ingestor',
    });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain('does not have a test configuration');
  });

  it('should return error for unknown connection', async () => {
    const channel = await tiHandshake();
    const response = await tiSendRequest(channel, 'test_ingestor', { connection: 'nonexistent' });
    expect(response.success).toBe(true);

    const result = response.result as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown connection');
  });
});

describe('list_listener_configs, resolve_listener_options, control_listener, and enhanced list_routes', () => {
  let lcServer: Server;
  let lcServerUrl: string;

  let echoServer: Server;
  let echoUrl: string;

  let lcClientKeys: KeyBundle;
  let lcServerKeys: KeyBundle;

  beforeAll(async () => {
    lcClientKeys = generateKeyBundle();
    lcServerKeys = generateKeyBundle();
    const lcClientPub = extractPublicKeys(lcClientKeys);

    // Create a server that returns dynamic options for resolve_listener_options
    const echoApp = http.createServer((req, res) => {
      if (req.url?.includes('boards')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            { id: 'board-1', name: 'Board One' },
            { id: 'board-2', name: 'Board Two' },
          ]),
        );
      } else if (req.url?.includes('nested')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              items: [
                { code: 'A', title: 'Alpha' },
                { code: 'B', title: 'Beta' },
              ],
            },
          }),
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    await new Promise<void>((resolve) => {
      echoServer = echoApp.listen(0, '127.0.0.1', () => {
        const addr = echoServer.address() as AddressInfo;
        echoUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,

      connectors: [
        {
          alias: 'with-listener',
          name: 'Listener API',
          description: 'An API with a full listener config',
          secrets: { TOKEN: 'tok', WEBHOOK_SECRET: 'ws' },
          headers: { Authorization: 'Bearer ${TOKEN}' },
          allowedEndpoints: [`${echoUrl}/**`],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'listener-test',
              signatureHeader: 'X-Sig',
              signatureSecret: 'WEBHOOK_SECRET',
            },
          },
          testConnection: {
            url: `${echoUrl}/me`,
            description: 'Test connection',
          },
          testIngestor: {
            description: 'Verify webhook',
            strategy: 'webhook_verify',
            requireSecrets: ['WEBHOOK_SECRET'],
          },
          listenerConfig: {
            name: 'Test Listener',
            description: 'Configurable webhook listener',
            fields: [
              {
                key: 'boardId',
                label: 'Board ID',
                description: 'Board to watch',
                type: 'text',
                required: true,
                dynamicOptions: {
                  url: `${echoUrl}/boards`,
                  labelField: 'name',
                  valueField: 'id',
                },
                group: 'Connection',
              },
              {
                key: 'nestedField',
                label: 'Nested Options',
                type: 'select',
                dynamicOptions: {
                  url: `${echoUrl}/nested`,
                  responsePath: 'data.items',
                  labelField: 'title',
                  valueField: 'code',
                },
                group: 'Connection',
              },
              {
                key: 'eventFilter',
                label: 'Event Types',
                type: 'multiselect',
                default: [],
                options: [
                  { value: 'create', label: 'Created' },
                  { value: 'update', label: 'Updated' },
                ],
                group: 'Filtering',
              },
              {
                key: 'bufferSize',
                label: 'Buffer Size',
                type: 'number',
                default: 200,
                min: 10,
                max: 1000,
                group: 'Advanced',
              },
            ],
          },
        },
        {
          alias: 'no-listener',
          name: 'No Listener API',
          secrets: { TOKEN: 'tok' },
          allowedEndpoints: [`${echoUrl}/**`],
          testConnection: {
            url: `${echoUrl}/me`,
            description: 'Test connection only',
          },
        },
      ],
      callers: {
        'lc-client': {
          connections: ['with-listener', 'no-listener'],
        },
      },
      rateLimitPerMinute: 60,
    };

    const app = createApp({
      config,
      ownKeys: lcServerKeys,
      authorizedPeers: [{ alias: 'lc-client', keys: lcClientPub }],
    });

    // Start ingestors (for control_listener tests)
    const mgr = app.locals.ingestorManager as import('./ingestors/index.js').IngestorManager;
    await mgr.startAll();

    await new Promise<void>((resolve) => {
      lcServer = app.listen(0, '127.0.0.1', () => {
        const addr = lcServer.address() as AddressInfo;
        lcServerUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r, j) => lcServer.close((e) => (e ? j(e) : r()))),
      new Promise<void>((r, j) => echoServer.close((e) => (e ? j(e) : r()))),
    ]);
  });

  async function lcHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(lcClientKeys, extractPublicKeys(lcServerKeys));
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${lcServerUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);
    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${lcServerUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    return channel;
  }

  async function lcSendRequest(
    channel: EncryptedChannel,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${lcServerUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  // ── list_listener_configs ───────────────────────────────────────────────

  it('should return listener configs for connections with listenerConfig', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'list_listener_configs', {});
    expect(response.success).toBe(true);

    const configs = response.result as {
      connection: string;
      name: string;
      description?: string;
      fields: { key: string; label: string; type: string }[];
      ingestorType?: string;
    }[];

    // Only connections with listenerConfig should appear
    expect(configs).toHaveLength(1);
    expect(configs[0].connection).toBe('with-listener');
    expect(configs[0].name).toBe('Test Listener');
    expect(configs[0].description).toBe('Configurable webhook listener');
    expect(configs[0].ingestorType).toBe('webhook');
    expect(configs[0].fields).toHaveLength(4);
    expect(configs[0].fields.map((f) => f.key)).toEqual([
      'boardId',
      'nestedField',
      'eventFilter',
      'bufferSize',
    ]);
  });

  // ── resolve_listener_options ────────────────────────────────────────────

  it('should resolve dynamic options for a field with top-level array response', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'resolve_listener_options', {
      connection: 'with-listener',
      paramKey: 'boardId',
    });
    expect(response.success).toBe(true);

    const result = response.result as {
      success: boolean;
      connection: string;
      paramKey: string;
      options: { value: string; label: string }[];
    };

    expect(result.success).toBe(true);
    expect(result.options).toHaveLength(2);
    expect(result.options[0]).toEqual({ value: 'board-1', label: 'Board One' });
    expect(result.options[1]).toEqual({ value: 'board-2', label: 'Board Two' });
  });

  it('should resolve dynamic options with nested response path', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'resolve_listener_options', {
      connection: 'with-listener',
      paramKey: 'nestedField',
    });
    expect(response.success).toBe(true);

    const result = response.result as {
      success: boolean;
      options: { value: string; label: string }[];
    };

    expect(result.success).toBe(true);
    expect(result.options).toHaveLength(2);
    expect(result.options[0]).toEqual({ value: 'A', label: 'Alpha' });
    expect(result.options[1]).toEqual({ value: 'B', label: 'Beta' });
  });

  it('should return error for field without dynamic options', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'resolve_listener_options', {
      connection: 'with-listener',
      paramKey: 'eventFilter', // This field has static options, not dynamic
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('No dynamic options');
  });

  it('should return error for unknown connection in resolve_listener_options', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'resolve_listener_options', {
      connection: 'nonexistent',
      paramKey: 'boardId',
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('No listener config');
  });

  it('should return error for connection without listenerConfig', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'resolve_listener_options', {
      connection: 'no-listener',
      paramKey: 'boardId',
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('No listener config');
  });

  // ── control_listener ───────────────────────────────────────────────────

  it('should stop a running listener', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'control_listener', {
      connection: 'with-listener',
      action: 'stop',
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; connection: string; state?: string };
    expect(result.success).toBe(true);
    expect(result.state).toBe('stopped');
  });

  it('should start a stopped listener', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'control_listener', {
      connection: 'with-listener',
      action: 'start',
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; connection: string; state?: string };
    expect(result.success).toBe(true);
    expect(result.state).toBe('connected');
  });

  it('should restart a listener', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'control_listener', {
      connection: 'with-listener',
      action: 'restart',
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; connection: string; state?: string };
    expect(result.success).toBe(true);
    expect(result.connection).toBe('with-listener');
  });

  it('should return error for stop on non-ingestor connection', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'control_listener', {
      connection: 'no-listener',
      action: 'stop',
    });
    expect(response.success).toBe(true);

    const result = response.result as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('No ingestor running');
  });

  // ── Enhanced list_routes ───────────────────────────────────────────────

  it('should include new metadata fields in list_routes', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'list_routes', {});
    expect(response.success).toBe(true);

    const routes = response.result as Record<string, unknown>[];
    expect(routes).toHaveLength(2);

    // Connection with full config
    const withListener = routes.find((r) => r.alias === 'with-listener')!;
    expect(withListener).toBeDefined();
    expect(withListener.hasTestConnection).toBe(true);
    expect(withListener.hasIngestor).toBe(true);
    expect(withListener.ingestorType).toBe('webhook');
    expect(withListener.hasTestIngestor).toBe(true);
    expect(withListener.hasListenerConfig).toBe(true);
    expect(withListener.listenerParamKeys).toEqual([
      'boardId',
      'nestedField',
      'eventFilter',
      'bufferSize',
    ]);

    // Connection without listener
    const noListener = routes.find((r) => r.alias === 'no-listener')!;
    expect(noListener).toBeDefined();
    expect(noListener.hasTestConnection).toBe(true);
    expect(noListener.hasIngestor).toBe(false);
    // hasTestIngestor and hasListenerConfig should not be set for non-ingestor connections
    expect(noListener.hasTestIngestor).toBeUndefined();
    expect(noListener.hasListenerConfig).toBeUndefined();
  });

  it('should include alias in list_routes', async () => {
    const channel = await lcHandshake();
    const response = await lcSendRequest(channel, 'list_routes', {});
    expect(response.success).toBe(true);

    const routes = response.result as Record<string, unknown>[];
    expect(routes[0].alias).toBeTruthy();
    expect(routes[1].alias).toBeTruthy();
  });
});

// ── Scoped Google templates (live; skipped unless .env.e2e has credentials) ──
//
// Needs GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN, with the
// refresh token consented for the superset of the user templates' scopes (see
// CONNECTIONS.md "Google (scoped)"). This is also the live check of scope
// narrowing on refresh: if Google ignores the requested scope, every template
// fails with "granted scopes broader than this connection allows".
// Optional: GOOGLE_SERVICE_ACCOUNT_KEY (base64 key file) for the -sa
// templates, and GOOGLE_E2E_SUBJECT (a domain user the service account may
// impersonate via domain-wide delegation) for google-gmail-readonly-sa.

loadE2EEnv();
const GOOGLE_USER_VARS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
];
const googleMissing = checkEnvVars(GOOGLE_USER_VARS);
const googleSaKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const googleSubject = process.env.GOOGLE_E2E_SUBJECT;

const GOOGLE_USER_TEMPLATES: Record<string, string> = {
  'google-gmail-metadata': 'gmail.metadata',
  'google-gmail-readonly': 'gmail.readonly',
  'google-calendar-freebusy': 'calendar.freebusy',
  'google-calendar-readonly': 'calendar.readonly',
  'google-drive-readonly': 'drive.readonly',
  'google-drive-file': 'drive.file',
  'google-sheets-readonly': 'spreadsheets.readonly',
  'google-sheets': 'spreadsheets',
};
const GOOGLE_SA_TEMPLATES: Record<string, string> = {
  'google-calendar-readonly-sa': 'calendar.readonly',
  'google-drive-readonly-sa': 'drive.readonly',
  'google-sheets-readonly-sa': 'spreadsheets.readonly',
  'google-sheets-sa': 'spreadsheets',
  ...(googleSubject && { 'google-gmail-readonly-sa': 'gmail.readonly' }),
};

describe.skipIf(googleMissing.length > 0)('Scoped Google templates (live)', () => {
  let googleServer: Server;
  let googleUrl: string;
  /** Every decrypted response, for the no-credential sweep at the end. */
  const outputs: unknown[] = [];

  beforeAll(async () => {
    const connections = [
      ...Object.keys(GOOGLE_USER_TEMPLATES),
      ...(googleSaKey ? Object.keys(GOOGLE_SA_TEMPLATES) : []),
      'google-scope-probe',
    ];
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      connectors: [
        {
          // A Calendar-scoped token pointed at a Gmail URL: Google must refuse.
          alias: 'google-scope-probe',
          secrets: {
            GOOGLE_OAUTH_CLIENT_ID: '${GOOGLE_OAUTH_CLIENT_ID}',
            GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}',
            GOOGLE_OAUTH_REFRESH_TOKEN: '${GOOGLE_OAUTH_REFRESH_TOKEN}',
          },
          oauth2: {
            tokenUrl: 'https://oauth2.googleapis.com/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: {
              clientId: 'GOOGLE_OAUTH_CLIENT_ID',
              clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
              refreshToken: 'GOOGLE_OAUTH_REFRESH_TOKEN',
            },
            scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          },
          allowedEndpoints: ['https://gmail.googleapis.com/gmail/v1/users/me/profile'],
          testConnection: {
            url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
            expectedStatus: [403],
          },
        },
      ],
      callers: {
        'test-client': {
          connections,
          env: {
            GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID!,
            GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
            GOOGLE_OAUTH_REFRESH_TOKEN: process.env.GOOGLE_OAUTH_REFRESH_TOKEN!,
            ...(googleSaKey && { GOOGLE_SERVICE_ACCOUNT_KEY: googleSaKey }),
          },
          ...(googleSubject && {
            oauth2Overrides: { 'google-gmail-readonly-sa': { subject: googleSubject } },
          }),
        },
      },
      rateLimitPerMinute: 600,
    };
    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });
    await new Promise<void>((resolve) => {
      googleServer = app.listen(0, '127.0.0.1', () => {
        googleUrl = `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => googleServer.close(() => resolve()));
  });

  async function googleRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ProxyResponse> {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initResp = await fetch(`${googleUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initiator.createInit()),
    });
    const sessionKeys = initiator.processReply((await initResp.json()) as HandshakeReply);
    const channel = new EncryptedChannel(sessionKeys);
    await fetch(`${googleUrl}/handshake/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionKeys.sessionId },
      body: JSON.stringify(initiator.createFinish(sessionKeys)),
    });
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };
    const resp = await fetch(`${googleUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': channel.sessionId },
      body: new Uint8Array(channel.encryptJSON(request)),
    });
    expect(resp.ok).toBe(true);
    const response = channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
    outputs.push(response);
    return response;
  }

  const SCOPE = 'https://www.googleapis.com/auth/';

  it.each(Object.entries(GOOGLE_USER_TEMPLATES))(
    '%s: test_connection mints a token for exactly %s',
    async (alias, scope) => {
      const { result } = await googleRequest('test_connection', { connection: alias });
      const r = result as Record<string, unknown> & { oauth2?: Record<string, unknown> };
      expect(r.error).toBeUndefined();
      expect(r.success).toBe(true);
      expect(r.oauth2).toMatchObject({ tokenMinted: true, grantedScopes: [SCOPE + scope] });
    },
  );

  it.skipIf(!googleSaKey).each(Object.entries(GOOGLE_SA_TEMPLATES))(
    '%s: test_connection mints a service-account token for %s',
    async (alias, scope) => {
      const { result } = await googleRequest('test_connection', { connection: alias });
      const r = result as Record<string, unknown> & { oauth2?: Record<string, unknown> };
      expect(r.error).toBeUndefined();
      expect(r.success).toBe(true);
      expect(r.oauth2).toMatchObject({ tokenMinted: true });
      const granted = r.oauth2?.grantedScopes as string[] | undefined;
      if (granted) expect(granted).toEqual([SCOPE + scope]);
    },
  );

  it('a token for one scope is refused by another Google API (403)', async () => {
    const { result } = await googleRequest('test_connection', {
      connection: 'google-scope-probe',
    });
    expect(result).toMatchObject({ success: true, status: 403 });
  });

  it('list_routes reports the auth of every Google connection, names only', async () => {
    const { result } = await googleRequest('list_routes', {});
    const routes = result as { alias: string; auth?: { grant: string; scopes: string[] } }[];
    for (const [alias, scope] of Object.entries(GOOGLE_USER_TEMPLATES)) {
      const route = routes.find((r) => r.alias === alias);
      expect(route?.auth).toMatchObject({ grant: 'refresh_token', scopes: [SCOPE + scope] });
    }
  });

  it('no credential or access token appears in any tool output', () => {
    const text = JSON.stringify(outputs);
    for (const name of GOOGLE_USER_VARS) expect(text).not.toContain(process.env[name]!);
    if (googleSaKey) expect(text).not.toContain(googleSaKey.slice(0, 64));
    expect(text).not.toMatch(/ya29\.[\w-]{10,}/);
  });
});
