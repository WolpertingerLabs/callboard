import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, verifyPassword, generateSalt } from './password.js';
import { updateEnvFile } from './env-writer.js';
import {
  createSession,
  getSession,
  deleteSession,
  extendSession,
  deleteAllSessionsExcept,
  cleanupExpiredSessions,
} from './sessions.js';
import {
  loginHandler,
  logoutHandler,
  checkAuthHandler,
  changePasswordHandler,
  requireAuth,
  isPasswordConfigured,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './auth.js';

// ── Test scaffolding ────────────────────────────────────────────────
//
// Ported from drawlatch-ui's backend auth.test.ts. The only adaptations:
//   - the data dir is the daemon's config dir (MCP_CONFIG_DIR), not the
//     standalone backend's DRAWLATCH_UI_DATA_DIR;
//   - the 503 hint now points at `drawlatch set-password`.

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'drawlatch-auth-'));
  process.env.MCP_CONFIG_DIR = tmpDataDir;
  delete process.env.AUTH_PASSWORD_HASH;
  delete process.env.AUTH_PASSWORD_SALT;
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.MCP_CONFIG_DIR;
  delete process.env.AUTH_PASSWORD_HASH;
  delete process.env.AUTH_PASSWORD_SALT;
});

// Build a minimal mock req/res pair sufficient for the auth handlers.
// We capture status, json body, and Set-Cookie state for assertions.
interface MockRes {
  statusCode: number;
  body: unknown;
  cookies: Record<string, { value: string; opts: Record<string, unknown> }>;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
  send(payload: unknown): MockRes;
  cookie(name: string, value: string, opts?: Record<string, unknown>): MockRes;
  clearCookie(name: string, opts?: Record<string, unknown>): MockRes;
  setHeader(): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    cookies: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    cookie(name, value, opts = {}) {
      this.cookies[name] = { value, opts };
      return this;
    },
    clearCookie(name) {
      this.cookies[name] = { value: '', opts: { maxAge: 0 } };
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res;
}

function mockReq(opts: { body?: unknown; cookies?: Record<string, string>; ip?: string } = {}) {
  return {
    body: opts.body ?? {},
    cookies: opts.cookies ?? {},
    ip: opts.ip ?? '127.0.0.1',
    headers: {} as Record<string, string>,
  };
}

// Helper that bypasses the CLI and stores a hashed password directly into
// process.env (the same place the running server reads it from after dotenv).
async function configurePassword(plain: string) {
  const salt = generateSalt();
  const hash = await hashPassword(plain, salt);
  process.env.AUTH_PASSWORD_HASH = hash;
  process.env.AUTH_PASSWORD_SALT = salt;
}

// ── Password utils ──────────────────────────────────────────────────

describe('password utils', () => {
  it('hashes and verifies a password', async () => {
    const salt = generateSalt();
    const hash = await hashPassword('hunter2!!', salt);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(await verifyPassword('hunter2!!', hash, salt)).toBe(true);
    expect(await verifyPassword('wrong', hash, salt)).toBe(false);
  });

  it('rejects a hash with the wrong salt', async () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const hash = await hashPassword('hunter2!!', salt1);
    expect(await verifyPassword('hunter2!!', hash, salt2)).toBe(false);
  });

  it('salts are unique per call', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).not.toBe(b);
  });
});

// ── Sessions CRUD ───────────────────────────────────────────────────

describe('sessions service', () => {
  it('round-trips create / get / delete', () => {
    const expiry = Date.now() + 60_000;
    createSession('tok-a', expiry, '127.0.0.1');
    const s = getSession('tok-a');
    expect(s).toBeDefined();
    expect(s?.expires_at).toBe(expiry);
    expect(s?.ip).toBe('127.0.0.1');

    deleteSession('tok-a');
    expect(getSession('tok-a')).toBeUndefined();
  });

  it('extendSession updates expiry in place', () => {
    createSession('tok-b', Date.now() + 1_000);
    const newExpiry = Date.now() + 99_999;
    extendSession('tok-b', newExpiry);
    expect(getSession('tok-b')?.expires_at).toBe(newExpiry);
  });

  it('deleteAllSessionsExcept preserves only the named token', () => {
    const expiry = Date.now() + 60_000;
    createSession('keep', expiry);
    createSession('drop1', expiry);
    createSession('drop2', expiry);
    deleteAllSessionsExcept('keep');
    expect(getSession('keep')).toBeDefined();
    expect(getSession('drop1')).toBeUndefined();
    expect(getSession('drop2')).toBeUndefined();
  });

  it('cleanupExpiredSessions removes only expired entries', () => {
    createSession('fresh', Date.now() + 60_000);
    createSession('stale', Date.now() - 1_000);
    expect(cleanupExpiredSessions()).toBe(1);
    expect(getSession('fresh')).toBeDefined();
    expect(getSession('stale')).toBeUndefined();
  });

  it('persists sessions file with mode 0600', () => {
    createSession('perm', Date.now() + 60_000);
    const file = join(tmpDataDir, 'data', 'sessions.json');
    const stat = statSync(file);
    // Lower 9 bits should be rw------- = 0o600.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ── env-writer ──────────────────────────────────────────────────────

describe('env-writer', () => {
  it('creates and updates keys with mode 0600', () => {
    updateEnvFile({ AUTH_PASSWORD_HASH: 'abc', AUTH_PASSWORD_SALT: 'def' });
    const envFile = join(tmpDataDir, '.env');
    const content = readFileSync(envFile, 'utf-8');
    expect(content).toContain('AUTH_PASSWORD_HASH=abc');
    expect(content).toContain('AUTH_PASSWORD_SALT=def');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    updateEnvFile({ AUTH_PASSWORD_HASH: 'xyz' });
    const updated = readFileSync(envFile, 'utf-8');
    expect(updated).toContain('AUTH_PASSWORD_HASH=xyz');
    expect(updated).not.toContain('AUTH_PASSWORD_HASH=abc');
    // Salt stays.
    expect(updated).toContain('AUTH_PASSWORD_SALT=def');
  });

  it('removes keys listed in keysToRemove', () => {
    updateEnvFile({ AUTH_PASSWORD: 'plaintext-leftover', AUTH_PASSWORD_HASH: 'h' });
    updateEnvFile({ AUTH_PASSWORD_HASH: 'h2' }, ['AUTH_PASSWORD']);
    const content = readFileSync(join(tmpDataDir, '.env'), 'utf-8');
    expect(content).not.toContain('AUTH_PASSWORD=');
    expect(content).toContain('AUTH_PASSWORD_HASH=h2');
  });
});

// ── Login / logout / check handlers ─────────────────────────────────

describe('login handler', () => {
  it('returns 503 with the CLI hint when no password is configured', async () => {
    expect(isPasswordConfigured()).toBe(false);
    const req = mockReq({ body: { password: 'anything' } });
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loginHandler(req as any, res as any);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).toContain('drawlatch set-password');
  });

  it('returns 401 on wrong password and 200 + cookie on right password', async () => {
    await configurePassword('hunter2!!');

    const bad = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loginHandler(mockReq({ body: { password: 'wrong' } }) as any, bad as any);
    expect(bad.statusCode).toBe(401);

    const good = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loginHandler(mockReq({ body: { password: 'hunter2!!' } }) as any, good as any);
    expect(good.statusCode).toBe(200);
    expect(good.cookies[SESSION_COOKIE_NAME]).toBeDefined();
    const opts = good.cookies[SESSION_COOKIE_NAME].opts;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
    // Strict-always: no `secure` flag — we run over plain HTTP on loopback/LAN.
    expect(opts.secure).toBeUndefined();
  });

  it('logoutHandler clears the cookie and deletes the server-side session', () => {
    const token = 'tok-logout';
    createSession(token, Date.now() + 60_000);
    expect(getSession(token)).toBeDefined();
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logoutHandler(mockReq({ cookies: { [SESSION_COOKIE_NAME]: token } }) as any, res as any);
    expect(getSession(token)).toBeUndefined();
    expect(res.cookies[SESSION_COOKIE_NAME].opts.maxAge).toBe(0);
  });

  it('checkAuthHandler reports authenticated for a valid cookie and unauth for missing', async () => {
    await configurePassword('hunter2!!');
    const token = 'tok-check';
    createSession(token, Date.now() + 60_000);

    const yes = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkAuthHandler(mockReq({ cookies: { [SESSION_COOKIE_NAME]: token } }) as any, yes as any);
    expect(yes.statusCode).toBe(200);
    expect(yes.body).toMatchObject({ authenticated: true });

    const no = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkAuthHandler(mockReq() as any, no as any);
    expect(no.statusCode).toBe(401);
  });
});

// ── requireAuth middleware ─────────────────────────────────────────

describe('requireAuth middleware', () => {
  it('rejects with 503 when no password is configured', () => {
    const res = mockRes();
    let called = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requireAuth(mockReq() as any, res as any, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('rejects with 401 when no cookie is present', async () => {
    await configurePassword('hunter2!!');
    const res = mockRes();
    let called = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requireAuth(mockReq() as any, res as any, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 on expired cookie and removes the session', async () => {
    await configurePassword('hunter2!!');
    const token = 'tok-expired';
    createSession(token, Date.now() - 1_000);
    const res = mockRes();
    let called = false;
    requireAuth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReq({ cookies: { [SESSION_COOKIE_NAME]: token } }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      () => {
        called = true;
      },
    );
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(getSession(token)).toBeUndefined();
  });

  it('calls next() and rolls the session for a valid cookie', async () => {
    await configurePassword('hunter2!!');
    const token = 'tok-valid';
    // Session created with 1 day remaining — should be rolled to ~7 days.
    const oneDayAhead = Date.now() + 24 * 60 * 60 * 1000;
    createSession(token, oneDayAhead);

    const res = mockRes();
    let called = false;
    requireAuth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReq({ cookies: { [SESSION_COOKIE_NAME]: token } }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);

    // Rolling expiry: server-side and cookie both ~SESSION_TTL_MS ahead.
    const sixDaysFromNow = Date.now() + 6 * 24 * 60 * 60 * 1000;
    expect(getSession(token)?.expires_at).toBeGreaterThan(sixDaysFromNow);

    const cookie = res.cookies[SESSION_COOKIE_NAME];
    expect(cookie).toBeDefined();
    expect(cookie.opts.maxAge).toBe(SESSION_TTL_MS);
    expect(cookie.opts.httpOnly).toBe(true);
    expect(cookie.opts.sameSite).toBe('strict');
  });
});

// ── Rolling expiry (acceptance criterion: 6 days later, still authed) ──

describe('rolling expiry', () => {
  it('a session aged 6 days is still valid and gets refreshed by middleware', async () => {
    await configurePassword('hunter2!!');
    const token = 'tok-aged';
    // 1 day of TTL remaining (i.e. ~6 days old in real time terms).
    createSession(token, Date.now() + 24 * 60 * 60 * 1000);

    const res = mockRes();
    let called = false;
    requireAuth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReq({ cookies: { [SESSION_COOKIE_NAME]: token } }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
    // After this request the session expires_at must be reset to ~7 days ahead.
    const after = getSession(token)!;
    expect(after.expires_at).toBeGreaterThan(Date.now() + 6.5 * 24 * 60 * 60 * 1000);
  });
});

// ── Change password round-trip ─────────────────────────────────────

describe('changePasswordHandler', () => {
  it('rejects when the current password is wrong', async () => {
    await configurePassword('old-password-1');
    const res = mockRes();
    await changePasswordHandler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReq({ body: { currentPassword: 'WRONG', newPassword: 'new-password-1' } }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects new passwords shorter than 8 characters', async () => {
    await configurePassword('old-password-1');
    const res = mockRes();
    await changePasswordHandler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReq({ body: { currentPassword: 'old-password-1', newPassword: 'short' } }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rotates the password — old fails, new succeeds, and other sessions are invalidated', async () => {
    await configurePassword('old-password-1');

    // Two sessions exist: caller's, and a "stale" one on another device.
    const callerToken = 'caller-session';
    const otherToken = 'other-device-session';
    createSession(callerToken, Date.now() + SESSION_TTL_MS);
    createSession(otherToken, Date.now() + SESSION_TTL_MS);

    const res = mockRes();
    await changePasswordHandler(
      mockReq({
        body: { currentPassword: 'old-password-1', newPassword: 'new-password-2' },
        cookies: { [SESSION_COOKIE_NAME]: callerToken },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.statusCode).toBe(200);

    // Old password no longer logs in; new one does.
    const oldLogin = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loginHandler(mockReq({ body: { password: 'old-password-1' } }) as any, oldLogin as any);
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loginHandler(mockReq({ body: { password: 'new-password-2' } }) as any, newLogin as any);
    expect(newLogin.statusCode).toBe(200);

    // The caller's session is preserved; other devices are signed out.
    expect(getSession(callerToken)).toBeDefined();
    expect(getSession(otherToken)).toBeUndefined();

    // .env on disk now has the new hash.
    const envContent = readFileSync(join(tmpDataDir, '.env'), 'utf-8');
    expect(envContent).toMatch(/^AUTH_PASSWORD_HASH=[0-9a-f]+$/m);
    expect(envContent).toMatch(/^AUTH_PASSWORD_SALT=[0-9a-f]+$/m);
  });
});
