/**
 * Vault admin API (src/remote/admin-vault.ts).
 *
 * Covers the plan's admin API items: auth required, `Cache-Control:
 * no-store` on every response, the reveal rate limit (its own limiter), the
 * reveal audit line written before the response and fail-closed, `If-Match`,
 * and `__proto__` → 404. Plus admin-only loosening, `vaultItems` on
 * GET /callers, and no value in any response but reveal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const hooks = vi.hoisted(() => ({
  /** When set, replaces the real audit append for vault events. */
  append: null as null | ((owner: string, event: string) => Promise<void>),
}));

vi.mock('./vault/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vault/audit.js')>();
  return {
    ...actual,
    appendVaultEvent: (...args: Parameters<typeof actual.appendVaultEvent>) =>
      hooks.append ? hooks.append(args[0], args[1]) : actual.appendVaultEvent(...args),
  };
});

import { createAdminRouter } from './admin.js';
import { createApp } from './server.js';
import { IngestorManager } from './ingestors/manager.js';
import { resetAuditLogState } from './audit-log.js';
import { loadRemoteConfig, saveRemoteConfig, type RemoteServerConfig } from '../shared/config.js';
import { generateKeyBundle } from '../shared/crypto/index.js';
import { generateSalt, hashPassword } from '../auth/password.js';
import { SESSION_COOKIE_NAME } from '../auth/auth.js';
import { createSession } from '../auth/sessions.js';
import { createItem, requestAccess, updateItem } from './vault/service.js';
import { VAULT_KEY_LABEL, readVault, resetVaultCache } from './vault/store.js';
import type {
  AdminCaller,
  AdminVaultDecision,
  AdminVaultGrant,
  AdminVaultItems,
  AdminVaultRequest,
  AdminVaultRevoke,
  AdminVaultStatus,
} from './admin-types.js';

const CANARY = `admin-canary-${crypto.randomUUID()}`;
const CANARY2 = `admin-canary2-${crypto.randomUUID()}`;

let configDir: string;
let server: Server | undefined;
let base: string;
let audited: { action: string; details?: Record<string, unknown> }[];
let mgr: IngestorManager;

function config(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    connectors: [],
    callers: {
      alice: { connections: ['github', 'slack'] },
      bob: { connections: [] },
    },
    rateLimitPerMinute: 1000,
  };
}

async function listen(app: express.Express): Promise<void> {
  await new Promise<void>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/admin`;
      resolve();
    });
    server = s;
  });
}

/** An admin router on its own app (the requireAuth gate is tested via createApp). */
async function startRouter(): Promise<void> {
  audited = [];
  const router = createAdminRouter({
    getSessionsSnapshot: () => [],
    ingestorManager: () => mgr,
    loadConfig: () => loadRemoteConfig(),
    resolveRoutesForCaller: () => [],
    refreshCaller: () => undefined,
    reloadPeer: () => undefined,
    removePeer: () => undefined,
    audit: (action, details) => audited.push({ action, details }),
    version: 'test',
    port: 0,
    startedAt: Date.now(),
  });
  const app = express();
  app.use('/api/admin', express.json(), router);
  await listen(app);
}

async function req(
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function auditLines(owner: string): Record<string, unknown>[] {
  const dir = path.join(configDir, 'audit', owner);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const injectItem = {
  name: 'gh',
  kind: 'token',
  values: { value: CANARY },
  connections: ['github'],
};

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-admin-vault-'));
  process.env.MCP_CONFIG_DIR = configDir;
  resetAuditLogState();
  resetVaultCache();
  hooks.append = null;
  saveRemoteConfig(config());
  mgr = new IngestorManager(config());
});

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await mgr.stopAll();
  resetVaultCache();
  delete process.env.MCP_CONFIG_DIR;
  fs.rmSync(configDir, { recursive: true, force: true });
});

// ── Auth ───────────────────────────────────────────────────────────────────

describe('auth', () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_PASSWORD_SALT;
  });

  it('every vault endpoint needs a dashboard session (401 without, 200 with)', async () => {
    const salt = generateSalt();
    process.env.AUTH_PASSWORD_SALT = salt;
    process.env.AUTH_PASSWORD_HASH = await hashPassword('fake-admin-pass', salt);
    await createItem('alice', { ...injectItem }, 'admin');
    const { requestId } = await requestAccess('bob', { owner: 'alice', name: 'gh', reason: 'r' });
    const app = createApp({
      config: config(),
      ownKeys: generateKeyBundle(),
      authorizedPeers: [],
      ingestorManager: mgr,
      disableRateLimiting: true,
    });
    await listen(app);

    const endpoints: [string, string, unknown?][] = [
      ['GET', '/vault/status'],
      ['GET', '/callers/alice/vault/items'],
      [
        'POST',
        '/callers/alice/vault/items',
        { name: 'x', kind: 'token', values: { value: 'abcd' } },
      ],
      ['PATCH', '/callers/alice/vault/items/gh', { tags: ['t'] }],
      ['POST', '/callers/alice/vault/items/gh/reveal', {}],
      ['DELETE', '/callers/alice/vault/items/gh'],
      ['GET', '/vault/requests'],
      ['POST', `/vault/requests/${requestId}/grant`, {}],
      ['POST', `/vault/requests/${requestId}/deny`, {}],
      ['GET', '/vault/grants'],
      ['DELETE', '/vault/grants/some-id'],
    ];
    for (const [method, p, body] of endpoints) {
      const res = await req(method, p, body);
      expect(res.status, `${method} ${p}`).toBe(401);
      expect(res.text).not.toContain(CANARY);
    }
    // Nothing changed.
    expect(Object.keys(readVault().callers.alice.items)).toEqual(['gh']);
    expect(readVault().requests[0].status).toBe('pending');

    const token = crypto.randomBytes(16).toString('hex');
    createSession(token, Date.now() + 60_000);
    const cookie = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
    expect((await req('GET', '/vault/status', undefined, cookie)).status).toBe(200);
    expect((await req('GET', '/callers/alice/vault/items', undefined, cookie)).status).toBe(200);
  });
});

// ── Router behaviour ───────────────────────────────────────────────────────

describe('vault admin router', () => {
  beforeEach(async () => {
    await startRouter();
  });

  it('GET /vault/status reports files and counts, never the key; creates nothing', async () => {
    const before = await req('GET', '/vault/status');
    expect(before.body).toEqual({
      keyPresent: false,
      keyId: null,
      fileExists: false,
      revision: null,
      callers: {},
      pendingRequests: 0,
    });
    expect(fs.existsSync(path.join(configDir, 'keys'))).toBe(false);

    await createItem('alice', { ...injectItem }, 'admin');
    const after = (await req('GET', '/vault/status')).body as AdminVaultStatus;
    expect(after).toMatchObject({ keyPresent: true, fileExists: true, callers: { alice: 1 } });
    expect(after.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(after.revision).toBeGreaterThan(0);
    const keyB64 = fs.readFileSync(path.join(configDir, VAULT_KEY_LABEL), 'utf8').trim();
    const text = JSON.stringify(after);
    expect(text).not.toContain(keyB64);
    expect(text).not.toContain(Buffer.from(keyB64, 'base64').toString('hex'));
  });

  it('GET /vault/status and items report a missing key without failing the status call', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    fs.rmSync(path.join(configDir, VAULT_KEY_LABEL));
    resetVaultCache();
    const status = (await req('GET', '/vault/status')).body as AdminVaultStatus;
    expect(status).toMatchObject({ keyPresent: false, fileExists: true, revision: null });
    expect(status.error).toMatch(/is missing; restore it from backup/);
    const items = await req('GET', '/callers/alice/vault/items');
    expect(items.status).toBe(503);
    const callers = (await req('GET', '/callers')).body as AdminCaller[];
    expect(callers.map((c) => c.vaultItems)).toEqual([null, null]);
    // Every item endpoint is 503 while the file exists without its key, and
    // none of them creates a new key.
    const body = { name: 'x', kind: 'token', values: { value: 'abcd' } };
    expect((await req('POST', '/callers/alice/vault/items', body)).status).toBe(503);
    expect((await req('PATCH', '/callers/alice/vault/items/gh', { tags: [] })).status).toBe(503);
    expect((await req('DELETE', '/callers/alice/vault/items/gh')).status).toBe(503);
    expect((await req('POST', '/callers/alice/vault/items/gh/reveal', {})).status).toBe(503);
    expect(fs.existsSync(path.join(configDir, VAULT_KEY_LABEL))).toBe(false);
  });

  it('with no vault file the item endpoints work: empty list, and the first create makes the key', async () => {
    const list = await req('GET', '/callers/alice/vault/items');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ revision: 0, items: [] });
    expect((await req('PATCH', '/callers/alice/vault/items/gh', { tags: [] })).status).toBe(404);
    expect((await req('DELETE', '/callers/alice/vault/items/gh')).status).toBe(404);
    expect((await req('POST', '/callers/alice/vault/items/gh/reveal', {})).status).toBe(404);
    expect(fs.existsSync(path.join(configDir, VAULT_KEY_LABEL))).toBe(false);
    expect((await req('POST', '/callers/alice/vault/items', injectItem)).status).toBe(201);
    expect(fs.existsSync(path.join(configDir, VAULT_KEY_LABEL))).toBe(true);
  });

  it('GET /callers gains vaultItems per caller', async () => {
    expect(((await req('GET', '/callers')).body as AdminCaller[]).map((c) => c.vaultItems)).toEqual(
      [0, 0],
    );
    await createItem('alice', { ...injectItem }, 'admin');
    await createItem('alice', { name: 'n', kind: 'note', values: { value: CANARY2 } }, 'agent');
    const callers = (await req('GET', '/callers')).body as AdminCaller[];
    expect(Object.fromEntries(callers.map((c) => [c.alias, c.vaultItems]))).toEqual({
      alice: 2,
      bob: 0,
    });
  });

  it('GET items returns metadata, field names, empty grants and the revision; no values', async () => {
    await createItem(
      'alice',
      {
        name: 'login',
        kind: 'password',
        values: { value: CANARY, username: CANARY2 },
        tags: ['ci'],
        metadata: { url: 'https://forgejo.example.com' },
        notes: 'fake note',
      },
      'agent',
    );
    const res = await req('GET', '/callers/alice/vault/items');
    expect(res.status).toBe(200);
    const body = res.body as AdminVaultItems;
    expect(body.revision).toBe(readVault().revision);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: 'login',
      kind: 'password',
      exposure: 'inject',
      fields: ['username', 'value'],
      grants: [],
      tags: ['ci'],
      createdBy: 'agent',
    });
    expect(body.items[0]).not.toHaveProperty('values');
    expect(res.text).not.toContain(CANARY);
    expect(res.text).not.toContain(CANARY2);
    expect(((await req('GET', '/callers/bob/vault/items')).body as AdminVaultItems).items).toEqual(
      [],
    );
  });

  it('POST creates an admin item (createdBy admin, audited as admin); no value in the response', async () => {
    const res = await req('POST', '/callers/alice/vault/items', injectItem);
    expect(res.status).toBe(201);
    expect(res.text).not.toContain(CANARY);
    expect((res.body as { item: { createdBy: string; connections: string[] } }).item).toMatchObject(
      { createdBy: 'admin', connections: ['github'], exposure: 'inject' },
    );
    expect(audited).toEqual([
      { action: 'vault_item_create', details: { caller: 'alice', item: 'gh' } },
    ]);
    const line = auditLines('alice').find((l) => l['drawlatch.event'] === 'vault.item.created');
    expect(line).toMatchObject({ 'vault.actor': 'admin', 'vault.via': 'admin' });

    const dup = await req('POST', '/callers/alice/vault/items', injectItem);
    expect(dup.status).toBe(409);
    const bad = await req('POST', '/callers/alice/vault/items', {
      name: 'short',
      kind: 'token',
      values: { value: 'ab' },
    });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain('"ab"');
  });

  it('PATCH lets the admin loosen exposure and widen or remove the binding', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    const loosen = await req('PATCH', '/callers/alice/vault/items/gh', {
      exposure: 'reveal',
      connections: ['github', 'slack'],
    });
    expect(loosen.status).toBe(200);
    expect(loosen.body).toMatchObject({
      item: { exposure: 'reveal', connections: ['github', 'slack'] },
    });
    const unbind = await req('PATCH', '/callers/alice/vault/items/gh', { connections: null });
    expect(unbind.status).toBe(200);
    expect((unbind.body as { item: object }).item).not.toHaveProperty('connections');

    const replace = await req('PATCH', '/callers/alice/vault/items/gh', {
      values: { value: CANARY2 },
      rename: 'gh2',
    });
    expect(replace.status).toBe(200);
    expect(replace.text).not.toContain(CANARY2);
    expect(readVault().callers.alice.items.gh2.values.value).toBe(CANARY2);
    expect(audited.at(-1)).toEqual({
      action: 'vault_item_update',
      details: { caller: 'alice', item: 'gh', renamedTo: 'gh2', changed: ['values', 'rename'] },
    });
    const updates = auditLines('alice').filter(
      (l) => l['drawlatch.event'] === 'vault.item.updated',
    );
    expect(updates.every((l) => l['vault.actor'] === 'admin')).toBe(true);
    expect(JSON.stringify(auditLines('alice'))).not.toContain(CANARY);

    expect((await req('PATCH', '/callers/alice/vault/items/nope', { tags: [] })).status).toBe(404);
    // A body can't smuggle a different item name: the path wins.
    const smuggle = await req('PATCH', '/callers/alice/vault/items/gh2', {
      name: 'other',
      tags: ['x'],
    });
    expect(smuggle.status).toBe(200);
    expect((smuggle.body as { item: { name: string } }).item.name).toBe('gh2');
  });

  it('If-Match: a matching revision applies, a stale one is 409 and changes nothing', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    const rev = ((await req('GET', '/callers/alice/vault/items')).body as AdminVaultItems).revision;

    const ok = await req(
      'PATCH',
      '/callers/alice/vault/items/gh',
      { tags: ['a'] },
      {
        'if-match': `"${rev}"`,
      },
    );
    expect(ok.status).toBe(200);

    const stale = await req(
      'PATCH',
      '/callers/alice/vault/items/gh',
      { tags: ['b'] },
      {
        'if-match': String(rev),
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ revision: rev + 1 });
    expect(readVault().callers.alice.items.gh.tags).toEqual(['a']);

    const staleDelete = await req('DELETE', '/callers/alice/vault/items/gh', undefined, {
      'if-match': String(rev),
    });
    expect(staleDelete.status).toBe(409);
    expect(Object.hasOwn(readVault().callers.alice.items, 'gh')).toBe(true);

    const bad = await req(
      'PATCH',
      '/callers/alice/vault/items/gh',
      { tags: [] },
      {
        'if-match': 'not-a-revision',
      },
    );
    expect(bad.status).toBe(400);

    // Absent If-Match: last write wins.
    expect((await req('PATCH', '/callers/alice/vault/items/gh', { tags: ['c'] })).status).toBe(200);
  });

  it('DELETE removes the item, audited as admin', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    const res = await req('DELETE', '/callers/alice/vault/items/gh');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      deleted: 'gh',
      revokedGrants: 0,
      withdrawnRequests: 0,
    });
    expect(Object.keys(readVault().callers.alice.items)).toEqual([]);
    expect(audited.at(-1)).toEqual({
      action: 'vault_item_delete',
      details: { caller: 'alice', item: 'gh' },
    });
    expect((await req('DELETE', '/callers/alice/vault/items/gh')).status).toBe(404);
  });

  it('reveal returns the values (any exposure) after writing an admin vault.reveal line', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    const res = await req('POST', '/callers/alice/vault/items/gh/reveal', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'gh',
      owner: 'alice',
      kind: 'token',
      values: { value: CANARY },
    });
    const one = await req('POST', '/callers/alice/vault/items/gh/reveal', { field: 'value' });
    expect(one.body).toMatchObject({ field: 'value', value: CANARY });
    const reveals = auditLines('alice').filter((l) => l['drawlatch.event'] === 'vault.reveal');
    expect(reveals).toHaveLength(2);
    expect(reveals[0]).toMatchObject({
      'vault.actor': 'admin',
      'vault.via': 'admin',
      'vault.item': 'gh',
      'vault.fields': ['value'],
    });
    expect(JSON.stringify(reveals)).not.toContain(CANARY);
    expect(audited.filter((a) => a.action === 'vault_reveal')).toHaveLength(2);

    const noField = await req('POST', '/callers/alice/vault/items/gh/reveal', { field: 'nope' });
    expect(noField.status).toBe(400);
    expect(noField.text).not.toContain(CANARY);
    expect((await req('POST', '/callers/alice/vault/items/none/reveal', {})).status).toBe(404);
  });

  it('reveal waits for the audit line: the response arrives only after the append resolves', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    const order: string[] = [];
    let release!: () => void;
    hooks.append = (_owner, event) => {
      order.push(`append:${event}`);
      return new Promise<void>((resolve) => {
        release = () => {
          order.push('appended');
          resolve();
        };
      });
    };
    const pending = req('POST', '/callers/alice/vault/items/gh/reveal', {}).then((r) => {
      order.push('response');
      return r;
    });
    await vi.waitFor(() => expect(order).toEqual(['append:vault.reveal']));
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['append:vault.reveal']);
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(order).toEqual(['append:vault.reveal', 'appended', 'response']);
  });

  it('reveal fails closed when the audit append fails: 500 and no value', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    hooks.append = () => Promise.reject(new Error('disk full'));
    const res = await req('POST', '/callers/alice/vault/items/gh/reveal', {});
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(CANARY);
    expect((res.body as { error: string }).error).toMatch(/reveal refused.*not returned/);
    expect(audited.filter((a) => a.action === 'vault_reveal')).toEqual([]);
  });

  it('reveal is limited to 10/min by its own limiter, not shared with issuance', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    for (let i = 0; i < 10; i++) {
      expect((await req('POST', '/callers/alice/vault/items/gh/reveal', {})).status).toBe(200);
    }
    const limited = await req('POST', '/callers/alice/vault/items/gh/reveal', {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(limited.text).not.toContain(CANARY);
    // The issuance limiter still has its own budget (400 from validation, not 429).
    const issue = await req('POST', '/callers/bad alias!/issue', {});
    expect(issue.status).toBe(400);
  });

  it('every vault response is Cache-Control: no-store, errors included', async () => {
    await createItem('alice', { ...injectItem }, 'agent');
    const calls: [string, string, unknown?, Record<string, string>?][] = [
      ['GET', '/vault/status'],
      ['GET', '/callers/alice/vault/items'],
      ['GET', '/callers/nobody/vault/items'],
      [
        'POST',
        '/callers/alice/vault/items',
        { name: 'n2', kind: 'note', values: { value: 'abcd' } },
      ],
      ['POST', '/callers/alice/vault/items', { name: '' }],
      ['PATCH', '/callers/alice/vault/items/gh', { tags: ['t'] }],
      ['PATCH', '/callers/alice/vault/items/gh', { tags: [] }, { 'if-match': '0' }],
      ['PATCH', '/callers/alice/vault/items/gh', { tags: [] }, { 'if-match': 'x' }],
      ['POST', '/callers/alice/vault/items/gh/reveal', {}],
      ['POST', '/callers/alice/vault/items/missing/reveal', {}],
      ['DELETE', '/callers/alice/vault/items/n2'],
      ['DELETE', '/callers/alice/vault/items/n2'],
      ['GET', '/vault/requests'],
      ['GET', '/vault/requests?status=nope'],
      ['POST', '/vault/requests/nope/grant', {}],
      ['POST', '/vault/requests/nope/deny', {}],
      ['GET', '/vault/grants?status=active'],
      ['DELETE', '/vault/grants/nope'],
    ];
    for (const [method, p, body, headers] of calls) {
      const res = await req(method, p, body, headers);
      expect(res.headers.get('cache-control'), `${method} ${p} (${res.status})`).toBe('no-store');
    }
  });

  it('caller aliases are own properties only: __proto__ and constructor are 404', async () => {
    for (const alias of ['__proto__', 'constructor', 'toString', 'nobody']) {
      expect((await req('GET', `/callers/${alias}/vault/items`)).status, alias).toBe(404);
      expect(
        (
          await req('POST', `/callers/${alias}/vault/items`, {
            name: 'x',
            kind: 'token',
            values: { value: 'abcd' },
          })
        ).status,
      ).toBe(404);
      expect((await req('PATCH', `/callers/${alias}/vault/items/x`, { tags: [] })).status).toBe(
        404,
      );
      expect((await req('DELETE', `/callers/${alias}/vault/items/x`)).status).toBe(404);
      expect((await req('POST', `/callers/${alias}/vault/items/x/reveal`, {})).status).toBe(404);
    }
    // Nothing was written, so no vault (or key) was created.
    expect(fs.existsSync(path.join(configDir, 'keys'))).toBe(false);
    expect({}.constructor).toBe(Object);
  });
});

// ── Access requests and grants ─────────────────────────────────────────────

describe('access requests and grants', () => {
  beforeEach(async () => {
    await startRouter();
  });

  const ask = (name: string, extra: Record<string, unknown> = {}) =>
    requestAccess('bob', { owner: 'alice', name, reason: 'Need to push release tags', ...extra });

  it('GET /vault/requests lists every request with the agent reason and the item as it is now', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    const a = await ask('gh');
    const b = await ask('missing');
    const all = (await req('GET', '/vault/requests')).body as AdminVaultRequest[];
    expect(all.map((r) => r.id).sort()).toEqual([a.requestId, b.requestId].sort());
    const byId = Object.fromEntries(all.map((r) => [r.id, r]));
    expect(byId[a.requestId]).toMatchObject({
      requester: 'bob',
      owner: 'alice',
      itemName: 'gh',
      itemId: expect.any(String) as string,
      reason: 'Need to push release tags',
      status: 'pending',
      item: { name: 'gh', kind: 'token', exposure: 'inject' },
    });
    expect(byId[b.requestId]).toMatchObject({ itemId: null, item: null });
    expect(((await req('GET', '/vault/status')).body as AdminVaultStatus).pendingRequests).toBe(2);
    expect(JSON.stringify(all)).not.toContain(CANARY);
    expect((await req('GET', '/vault/requests?status=denied')).body).toEqual([]);
    expect((await req('GET', '/vault/requests?status=bogus')).status).toBe(400);
  });

  it('grant defaults to inject, shows in items and grants, and is audited (daemon log and file)', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    const { requestId } = await ask('gh', { mode: 'reveal' });
    const res = await req('POST', `/vault/requests/${requestId}/grant`, {});
    expect(res.status).toBe(200);
    const body = res.body as AdminVaultDecision;
    expect(body.request).toMatchObject({ id: requestId, status: 'granted' });
    expect(body.grant).toMatchObject({ grantee: 'bob', owner: 'alice', mode: 'inject' });
    expect(audited.at(-1)).toEqual({
      action: 'vault_grant',
      details: {
        requestId,
        grantId: body.grant?.id,
        owner: 'alice',
        grantee: 'bob',
        mode: 'inject',
      },
    });
    expect(auditLines('alice').at(-1)).toMatchObject({
      'drawlatch.event': 'vault.grant.created',
      'vault.actor': 'admin',
    });
    const items = (await req('GET', '/callers/alice/vault/items')).body as AdminVaultItems;
    expect(items.items[0].grants).toEqual([
      { grantee: 'bob', mode: 'inject', effectiveMode: 'inject' },
    ]);
    const grants = (await req('GET', '/vault/grants?status=active')).body as AdminVaultGrant[];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      id: body.grant?.id,
      effectiveMode: 'inject',
      item: { name: 'gh', exposure: 'inject' },
    });
    expect(JSON.stringify([body, items, grants])).not.toContain(CANARY);
  });

  it('reveal is allowed only on a reveal item', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    await createItem(
      'alice',
      { name: 'pw', kind: 'token', values: { value: CANARY2 }, exposure: 'reveal' },
      'admin',
    );
    const a = await ask('gh', { mode: 'reveal' });
    const refused = await req('POST', `/vault/requests/${a.requestId}/grant`, { mode: 'reveal' });
    expect(refused.status).toBe(400);
    expect(readVault().requests.find((r) => r.id === a.requestId)?.status).toBe('pending');
    const b = await ask('pw', { mode: 'reveal' });
    const ok = await req('POST', `/vault/requests/${b.requestId}/grant`, { mode: 'reveal' });
    expect(ok.status).toBe(200);
    expect((ok.body as AdminVaultDecision).grant?.mode).toBe('reveal');
    expect(ok.text).not.toContain(CANARY2);
    // The item tightens later: the grant reports the effective mode.
    await updateItem('alice', { name: 'pw', exposure: 'inject' }, 'agent');
    const items = (await req('GET', '/callers/alice/vault/items')).body as AdminVaultItems;
    expect(items.items.find((i) => i.name === 'pw')?.grants).toEqual([
      { grantee: 'bob', mode: 'reveal', effectiveMode: 'inject' },
    ]);
    expect((await req('POST', `/vault/requests/${a.requestId}/grant`, { mode: 'x' })).status).toBe(
      400,
    );
  });

  it('grant or deny on a non-pending request is 409 with the current status; unknown is 404', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    const { requestId } = await ask('gh');
    expect((await req('POST', `/vault/requests/${requestId}/deny`, { note: 'no' })).status).toBe(
      200,
    );
    for (const action of ['grant', 'deny']) {
      const res = await req('POST', `/vault/requests/${requestId}/${action}`, {});
      expect(res.status, action).toBe(409);
      expect(res.body).toMatchObject({ status: 'denied' });
    }
    expect((await req('POST', '/vault/requests/nope/grant', {})).status).toBe(404);
    expect((await req('POST', '/vault/requests/nope/deny', {})).status).toBe(404);
    expect(readVault().grants).toEqual([]);
  });

  it('a "no such item" request: grant is 409, deny with a note works', async () => {
    const { requestId } = await ask('nothing');
    const res = await req('POST', `/vault/requests/${requestId}/grant`, {});
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/deny/);
    const denied = await req('POST', `/vault/requests/${requestId}/deny`, {
      note: 'no such item; ask for "gh"',
    });
    expect(denied.status).toBe(200);
    expect((denied.body as AdminVaultDecision).request).toMatchObject({
      status: 'denied',
      decidedNote: 'no such item; ask for "gh"',
    });
    expect(audited.at(-1)?.action).toBe('vault_deny');
  });

  it('granting again on an active grant updates its mode rather than adding one', async () => {
    await createItem(
      'alice',
      { name: 'pw', kind: 'token', values: { value: CANARY2 }, exposure: 'reveal' },
      'admin',
    );
    const a = await ask('pw');
    await req('POST', `/vault/requests/${a.requestId}/grant`, {});
    const b = await ask('pw', { mode: 'reveal' });
    expect(b.status).toBe('pending');
    const res = await req('POST', `/vault/requests/${b.requestId}/grant`, { mode: 'reveal' });
    const grants = (await req('GET', '/vault/grants')).body as AdminVaultGrant[];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      id: (res.body as AdminVaultDecision).grant?.id,
      mode: 'reveal',
    });
  });

  it('DELETE /vault/grants/:id revokes; again is a no-op 200; unknown is 404', async () => {
    await createItem('alice', { ...injectItem }, 'admin');
    const { requestId } = await ask('gh');
    const granted = (await req('POST', `/vault/requests/${requestId}/grant`, {}))
      .body as AdminVaultDecision;
    const id = granted.grant?.id ?? '';
    const first = await req('DELETE', `/vault/grants/${id}`);
    expect(first.status).toBe(200);
    expect(first.body as AdminVaultRevoke).toMatchObject({
      changed: true,
      grant: { status: 'revoked', revokedReason: 'admin' },
    });
    expect(audited.at(-1)).toEqual({
      action: 'vault_revoke',
      details: { grantId: id, owner: 'alice', grantee: 'bob' },
    });
    const n = audited.length;
    const again = await req('DELETE', `/vault/grants/${id}`);
    expect(again.status).toBe(200);
    expect((again.body as AdminVaultRevoke).changed).toBe(false);
    expect(audited).toHaveLength(n);
    expect((await req('DELETE', '/vault/grants/nope')).status).toBe(404);
    expect((await req('GET', '/vault/grants?status=active')).body).toEqual([]);
    expect(((await req('GET', '/vault/grants?status=revoked')).body as unknown[]).length).toBe(1);
    const items = (await req('GET', '/callers/alice/vault/items')).body as AdminVaultItems;
    expect(items.items[0].grants).toEqual([]);
  });

  it('reads create nothing: no vault and no key before the first write', async () => {
    expect((await req('GET', '/vault/requests')).body).toEqual([]);
    expect((await req('GET', '/vault/grants')).body).toEqual([]);
    expect(fs.existsSync(path.join(configDir, 'keys'))).toBe(false);
  });
});
