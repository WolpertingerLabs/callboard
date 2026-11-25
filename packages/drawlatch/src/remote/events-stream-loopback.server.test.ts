/**
 * Route-level test for the loopback-only `GET /events/stream` SSE feed.
 *
 * The feed carries every ingested event, unauthenticated, so its only gate is
 * `requireLoopback`. A reverse proxy on the same host connects from loopback;
 * these tests prove a request that announces a proxy hop is refused even though
 * its socket is 127.0.0.1, while a direct local client still gets the stream.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from './server.js';
import type { RemoteServerConfig } from '../shared/config.js';
import { generateKeyBundle } from '../shared/crypto/index.js';

let server: Server;
let url: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-events-stream-'));
  process.env.MCP_CONFIG_DIR = tmpDir;
  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0,
    callers: {},
    rateLimitPerMinute: 60,
  };
  const app = createApp({
    config,
    ownKeys: generateKeyBundle(),
    authorizedPeers: [],
    disableRateLimiting: true,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MCP_CONFIG_DIR;
});

describe('GET /events/stream loopback guard', () => {
  it('streams to a direct loopback client (control)', async () => {
    const controller = new AbortController();
    const res = await fetch(`${url}/events/stream`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('refuses a loopback request carrying X-Forwarded-For', async () => {
    const res = await fetch(`${url}/events/stream`, {
      headers: { 'X-Forwarded-For': '192.168.1.50' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: local access only' });
  });

  it('refuses a request shaped like the cloudflared tunnel (CF-Connecting-IP)', async () => {
    // cloudflared connects from loopback; Cloudflare's edge adds these.
    for (const headers of [
      { 'CF-Connecting-IP': '203.0.113.7' },
      { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7' },
    ]) {
      const res = await fetch(`${url}/events/stream`, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden: local access only' });
    }
  });

  it('refuses a loopback request carrying Forwarded or Via', async () => {
    for (const headers of [{ Forwarded: 'for=192.168.1.50' }, { Via: '1.1 caddy' }]) {
      const res = await fetch(`${url}/events/stream`, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      await res.body?.cancel();
    }
  });
});
