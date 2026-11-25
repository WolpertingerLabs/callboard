/**
 * Integration tests for the merged dashboard surface.
 *
 * Boots the real Express app via createApp() and drives it over HTTP to prove
 * the loopback→password boundary swap and the Express-5 SPA fallback:
 *   - /api/auth/login | logout | check | change-password behaviour + rate limits
 *   - /api/admin/* returns 401 WITHOUT a session cookie and 200 WITH one
 *     (this is the security-critical invariant of the merge), and never leaks
 *     secret values even through the auth-gated mount
 *   - the SPA fallback serves index.html on a deep link under Express 5 while
 *     still letting /api/* return their own JSON status.
 *
 * Uses the same listen-on-port + fetch pattern as server.e2e.test.ts /
 * admin.test.ts rather than supertest, to avoid adding a test-only dependency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from './server.js';
import type { RemoteServerConfig } from '../shared/config.js';
import { generateKeyBundle } from '../shared/crypto/index.js';
import { hashPassword, generateSalt } from '../auth/password.js';
import { SESSION_COOKIE_NAME } from '../auth/auth.js';

// ── Helpers ──────────────────────────────────────────────────────────────

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Pull the `drawlatch_session=<token>` pair out of a Set-Cookie response. */
function extractSessionCookie(res: Response): string | undefined {
  const setCookies = res.headers.getSetCookie();
  for (const c of setCookies) {
    if (c.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return c.split(';')[0];
    }
  }
  return undefined;
}

async function configurePasswordAsync(plain: string): Promise<void> {
  const salt = generateSalt();
  const hash = await hashPassword(plain, salt);
  process.env.AUTH_PASSWORD_HASH = hash;
  process.env.AUTH_PASSWORD_SALT = salt;
}

function makeConfig(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    callers: {
      acme: {
        name: 'ACME Corp',
        connections: ['github'],
        env: { GITHUB_TOKEN: '${MY_VAR}' },
      },
    },
    rateLimitPerMinute: 60,
  };
}

const PASSWORD = 'integration-pass-1';
const SECRET_VALUE = 'sekret-must-not-leak-via-gated-mount-987';

// ── No password configured → 503 everywhere (daemon must NOT exit) ─────────

describe('dashboard surface with no password configured', () => {
  let server: Server;
  let url: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-int-nopw-'));
    process.env.MCP_CONFIG_DIR = tmpDir;
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_PASSWORD_SALT;

    const app = createApp({
      config: makeConfig(),
      ownKeys: generateKeyBundle(),
      authorizedPeers: [],
    });
    ({ server, url } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MCP_CONFIG_DIR;
  });

  it('login returns 503 with the set-password hint', async () => {
    const res = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'anything' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('drawlatch set-password');
  });

  it('check returns 503', async () => {
    const res = await fetch(`${url}/api/auth/check`);
    expect(res.status).toBe(503);
  });

  it('admin returns 503 (locked state, not a crash)', async () => {
    const res = await fetch(`${url}/api/admin/meta`);
    expect(res.status).toBe(503);
  });
});

// ── Password configured → full auth + admin gating flow ────────────────────

describe('dashboard surface with a password configured', () => {
  let server: Server;
  let url: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-int-pw-'));
    process.env.MCP_CONFIG_DIR = tmpDir;
    process.env.MY_VAR = SECRET_VALUE;
    await configurePasswordAsync(PASSWORD);

    const app = createApp({
      config: makeConfig(),
      ownKeys: generateKeyBundle(),
      authorizedPeers: [],
    });
    ({ server, url } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MCP_CONFIG_DIR;
    delete process.env.MY_VAR;
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_PASSWORD_SALT;
  });

  it('rejects a wrong password with 401 and no cookie', async () => {
    const res = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(extractSessionCookie(res)).toBeUndefined();
  });

  it('admin is 401 WITHOUT a session cookie', async () => {
    const res = await fetch(`${url}/api/admin/meta`);
    expect(res.status).toBe(401);
  });

  it('change-password is 401 WITHOUT a session cookie (requireAuth gate)', async () => {
    const res = await fetch(`${url}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'whatever-12' }),
    });
    expect(res.status).toBe(401);
  });

  it('logs in, then admin is 200 WITH the session cookie, and check confirms auth', async () => {
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = extractSessionCookie(login);
    expect(cookie).toBeDefined();

    // check → authenticated true (and rolls the cookie)
    const check = await fetch(`${url}/api/auth/check`, { headers: { cookie: cookie! } });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ authenticated: true });
    expect(extractSessionCookie(check)).toBeDefined(); // rolling refresh

    // admin meta → 200
    const meta = await fetch(`${url}/api/admin/meta`, { headers: { cookie: cookie! } });
    expect(meta.status).toBe(200);

    // admin secrets → 200 and must NEVER contain the secret value, even through
    // the auth-gated mount.
    const secrets = await fetch(`${url}/api/admin/secrets`, { headers: { cookie: cookie! } });
    expect(secrets.status).toBe(200);
    const raw = JSON.stringify(await secrets.json());
    expect(raw.includes(SECRET_VALUE)).toBe(false);
    expect(raw.includes('${MY_VAR}')).toBe(false);

    // logout clears the cookie; admin is gated again afterward.
    const logout = await fetch(`${url}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie! },
    });
    expect(logout.status).toBe(200);
    const after = await fetch(`${url}/api/admin/meta`, { headers: { cookie: cookie! } });
    expect(after.status).toBe(401);
  });
});

// ── Rate limits (fresh app so the limiters start empty) ────────────────────

describe('auth rate limits', () => {
  let server: Server;
  let url: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-int-rl-'));
    process.env.MCP_CONFIG_DIR = tmpDir;
    await configurePasswordAsync(PASSWORD);

    const app = createApp({
      config: makeConfig(),
      ownKeys: generateKeyBundle(),
      authorizedPeers: [],
    });
    ({ server, url } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MCP_CONFIG_DIR;
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_PASSWORD_SALT;
  });

  it('login is limited to 3/min — the 4th attempt is 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it('check is limited to 20/min — the 21st request is 429', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${url}/api/auth/check`);
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

// ── SPA fallback (Express 5 terminal middleware, production only) ───────────

describe('SPA fallback under Express 5', () => {
  let server: Server;
  let url: string;
  let tmpDir: string;
  let prevNodeEnv: string | undefined;
  let wrotePlaceholder = false;
  let indexFile: string;

  beforeAll(async () => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-int-spa-'));
    process.env.MCP_CONFIG_DIR = tmpDir;
    await configurePasswordAsync(PASSWORD);

    // The SPA mount serves frontend/dist relative to the compiled server module
    // (../../frontend/dist). This test file sits at the same depth, so resolve
    // it the same way. If the frontend hasn't been built (e.g. `npm test` with
    // no prior build), drop a minimal placeholder so the fallback is testable.
    const distDir = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
    indexFile = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexFile)) {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(indexFile, '<!doctype html><html><body><div id="root"></div></body></html>');
      wrotePlaceholder = true;
    }

    const app = createApp({
      config: makeConfig(),
      ownKeys: generateKeyBundle(),
      authorizedPeers: [],
    });
    ({ server, url } = await listen(app));
  });

  afterAll(async () => {
    await close(server);
    if (wrotePlaceholder) fs.rmSync(indexFile, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete process.env.MCP_CONFIG_DIR;
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_PASSWORD_SALT;
  });

  it('serves index.html on a client-side deep link', async () => {
    const res = await fetch(`${url}/connections/github`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<div id="root">');
  });

  it('does NOT swallow /api/* routes with the SPA fallback', async () => {
    const res = await fetch(`${url}/api/admin/meta`);
    // Gated, not authenticated → JSON 401, never the HTML shell.
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
