/**
 * Vault canary sweep, modelled on audit-log.server.test.ts.
 *
 * Boots the real Express app, stores an `inject` canary and a `reveal`
 * canary for alice through the encrypted `/request` path, then calls every
 * `toolHandlers` entry as alice and as bob with inputs aimed at the items and
 * the vault files. No response may carry the inject canary, the key, or the
 * ciphertext; the reveal canary may appear only in alice's own vault_get.
 * Every admin GET endpoint is swept the same way. Plus source scans for the
 * invariants that are about code shape (who names the vault files, which
 * tools exist).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import {
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
  saveRemoteConfig,
  loadRemoteConfig,
  type RemoteServerConfig,
  type ResolvedRoute,
} from '../../shared/config.js';
import {
  generateKeyBundle,
  extractPublicKeys,
  EncryptedChannel,
  type KeyBundle,
  type PublicKeyBundle,
} from '../../shared/crypto/index.js';
import {
  HandshakeInitiator,
  type HandshakeReply,
  type ProxyRequest,
  type ProxyResponse,
} from '../../shared/protocol/index.js';
import { IngestorManager } from '../ingestors/manager.js';
import { toolHandlers } from '../tool-dispatch.js';
import { createAdminRouter } from '../admin.js';
import { resetAuditLogState } from '../audit-log.js';
import { createItem, grantRequest, requestAccess } from './service.js';
import { mutateVault, readVault, resetVaultCache } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const INJECT_CANARY = `inject-canary-${crypto.randomUUID()}`;
const REVEAL_CANARY = `reveal-canary-${crypto.randomUUID()}`;

let server: Server;
let baseUrl: string;
let serverPub: PublicKeyBundle;
let aliceKeys: KeyBundle;
let bobKeys: KeyBundle;
let mgr: IngestorManager;
let configDir: string;
let prevConfigDir: string | undefined;
let config: RemoteServerConfig;

const vaultFile = () => path.join(configDir, 'vault.enc.json');
const keyFile = () => path.join(configDir, 'keys', 'vault.key');

beforeAll(async () => {
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-http-'));
  process.env.MCP_CONFIG_DIR = configDir;
  resetAuditLogState();
  resetVaultCache();

  aliceKeys = generateKeyBundle();
  bobKeys = generateKeyBundle();
  const serverKeys = generateKeyBundle();
  serverPub = extractPublicKeys(serverKeys);

  config = {
    host: '127.0.0.1',
    port: 0,
    connectors: [],
    callers: { alice: { connections: [] }, bob: { connections: [] } },
    rateLimitPerMinute: 1000,
  };
  saveRemoteConfig(config);
  mgr = new IngestorManager(config);

  const app = createApp({
    config,
    ownKeys: serverKeys,
    authorizedPeers: [
      { alias: 'alice', keys: extractPublicKeys(aliceKeys) },
      { alias: 'bob', keys: extractPublicKeys(bobKeys) },
    ],
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
  resetVaultCache();
  if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
  else process.env.MCP_CONFIG_DIR = prevConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function handshake(keys: KeyBundle): Promise<EncryptedChannel> {
  const initiator = new HandshakeInitiator(keys, serverPub);
  const initResp = await fetch(`${baseUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initiator.createInit()),
  });
  const sessionKeys = initiator.processReply((await initResp.json()) as HandshakeReply);
  const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionKeys.sessionId },
    body: JSON.stringify(initiator.createFinish(sessionKeys)),
  });
  expect(finishResp.ok).toBe(true);
  return new EncryptedChannel(sessionKeys);
}

async function call(
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
  const resp = await fetch(`${baseUrl}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': channel.sessionId },
    body: new Uint8Array(channel.encryptJSON(request)),
  });
  expect(resp.ok).toBe(true);
  return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
}

/** Make sure alice's two canary items exist (the sweep's vault_delete removes them). */
async function seedItems(): Promise<void> {
  const doc = readVault();
  const items = Object.hasOwn(doc.callers, 'alice') ? doc.callers.alice.items : {};
  if (!Object.hasOwn(items, 'inj')) {
    await createItem(
      'alice',
      { name: 'inj', kind: 'token', values: { value: INJECT_CANARY } },
      'agent',
    );
  }
  if (!Object.hasOwn(items, 'rev')) {
    await createItem(
      'alice',
      { name: 'rev', kind: 'token', values: { value: REVEAL_CANARY }, exposure: 'reveal' },
      'agent',
    );
  }
}

/** Strings no response may contain: key (base64, hex) and ciphertext pieces. */
function forbidden(): string[] {
  const out: string[] = [INJECT_CANARY];
  const keyB64 = fs.readFileSync(keyFile(), 'utf8').trim();
  out.push(keyB64, Buffer.from(keyB64, 'base64').toString('hex'));
  const env = JSON.parse(fs.readFileSync(vaultFile(), 'utf8')) as Record<string, string>;
  out.push(env.iv, env.tag);
  const ct = env.ciphertext;
  for (let i = 0; i + 24 <= ct.length; i += 12) out.push(ct.slice(i, i + 24));
  return out;
}

function leaksIn(text: string, banned: string[]): string | undefined {
  return banned.find((b) => text.includes(b));
}

describe('vault tools over /request', () => {
  it('first vault_create creates the key and the vault file; neither exists before', async () => {
    expect(fs.existsSync(vaultFile())).toBe(false);
    expect(fs.existsSync(keyFile())).toBe(false);
    const alice = await handshake(aliceKeys);
    // Listing an empty vault creates nothing.
    const listed = await call(alice, 'vault_list', {});
    expect(listed.result).toEqual({ items: [], shared: [] });
    expect(fs.existsSync(keyFile())).toBe(false);

    const created = await call(alice, 'vault_create', {
      name: 'inj',
      kind: 'token',
      values: { value: INJECT_CANARY },
    });
    expect(created.success).toBe(true);
    expect(JSON.stringify(created)).not.toContain(INJECT_CANARY);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(vaultFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(vaultFile(), 'utf8')).not.toContain(INJECT_CANARY);
  });

  it('agent can create, list, update, reveal and delete its own items; bob sees none', async () => {
    const alice = await handshake(aliceKeys);
    const bob = await handshake(bobKeys);
    const r = await call(alice, 'vault_create', {
      name: 'tmp',
      kind: 'password',
      values: { value: 'fake-0000-pass', username: 'fake-user' },
      exposure: 'reveal',
      tags: ['t'],
    });
    expect(r.success).toBe(true);
    const list = (await call(alice, 'vault_list', { tag: 't' })).result as {
      items: { name: string; fields: string[] }[];
    };
    expect(list.items.map((i) => [i.name, i.fields])).toEqual([['tmp', ['username', 'value']]]);
    expect(JSON.stringify(list)).not.toContain('fake-0000-pass');

    const got = await call(alice, 'vault_get', { name: 'tmp', field: 'value' });
    expect(got.result).toMatchObject({ name: 'tmp', owner: 'alice', value: 'fake-0000-pass' });

    const up = await call(alice, 'vault_update', { name: 'tmp', exposure: 'inject' });
    expect(up.success).toBe(true);
    const refused = await call(alice, 'vault_get', { name: 'tmp' });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/inject-only/);
    const loosen = await call(alice, 'vault_update', { name: 'tmp', exposure: 'reveal' });
    expect(loosen.success).toBe(false);
    expect(loosen.error).toMatch(/dashboard/);

    expect(((await call(bob, 'vault_list', {})).result as { items: unknown[] }).items).toEqual([]);
    const bobGet = await call(bob, 'vault_get', { name: 'tmp', owner: 'alice' });
    expect(bobGet.success).toBe(false);
    const bobOwn = await call(bob, 'vault_get', { name: 'tmp' });
    expect(bobOwn.error).toBe('No vault item "tmp"');
    const bobDel = await call(bob, 'vault_delete', { name: 'tmp' });
    expect(bobDel.success).toBe(false);

    const del = await call(alice, 'vault_delete', { name: 'tmp' });
    expect(del.result).toEqual({
      success: true,
      deleted: 'tmp',
      revokedGrants: 0,
      withdrawnRequests: 0,
    });
  });
});

describe('vault canary sweep', () => {
  it('no tool returns a vault value (except alice’s own reveal), the key, or ciphertext', async () => {
    await seedItems();
    const now = new Date().toISOString();
    const injId = readVault().callers.alice.items.inj.id;
    const revId = readVault().callers.alice.items.rev.id;
    // A pending request by carol (so bob's own cancel can't touch it), an
    // inject grant and a reveal grant to bob.
    const pendingId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    const revealGrantId = crypto.randomUUID();
    mutateVault((doc) => {
      doc.grants.push(
        {
          id: grantId,
          owner: 'alice',
          itemId: injId,
          grantee: 'bob',
          mode: 'inject',
          status: 'active',
          grantedAt: now,
        },
        {
          id: revealGrantId,
          owner: 'alice',
          itemId: revId,
          grantee: 'bob',
          mode: 'reveal',
          status: 'active',
          grantedAt: now,
        },
      );
      doc.requests.push({
        id: pendingId,
        requester: 'carol',
        owner: 'alice',
        itemName: 'rev',
        itemId: revId,
        mode: 'reveal',
        reason: 'sweep',
        status: 'pending',
        createdAt: now,
      });
    });

    const logged: string[] = [];
    for (const level of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
      });
    }

    const targets = (name: string): Record<string, unknown> => ({
      timeout_ms: 0,
      name,
      owner: 'alice',
      field: 'value',
      caller: 'alice',
      alias: 'alice',
      connection: 'vault',
      path: vaultFile(),
      file: keyFile(),
      dir: configDir,
      url: `file://${vaultFile()}`,
      method: 'GET',
      requestId: pendingId,
      request_id: pendingId,
      request: pendingId,
      id: pendingId,
      grantId,
      grant_id: grantId,
      grant: grantId,
      grantee: 'bob',
      requester: 'bob',
      instanceId: grantId,
      mode: 'reveal',
      status: 'granted',
      decision: 'grant',
      action: 'revoke',
      note: 'approved',
      reason: 'sweep',
    });
    const inputs: Record<string, unknown>[] = [
      { timeout_ms: 0 },
      targets('inj'),
      targets('rev'),
      // The grant id in every id-shaped param, and a revoked/denied status.
      { ...targets('inj'), requestId: grantId, id: grantId, status: 'revoked' },
      { ...targets('rev'), status: 'denied', mode: 'inject' },
      { timeout_ms: 0, name: 'vault.key', path: keyFile(), url: `file://${keyFile()}` },
      { timeout_ms: 0, name: 'rev' },
    ];

    const leaks: string[] = [];
    const reveals: string[] = [];
    for (const [who, keys] of [
      ['bob', bobKeys],
      ['alice', aliceKeys],
    ] as const) {
      for (const toolName of Object.keys(toolHandlers)) {
        const channel = await handshake(keys);
        for (const input of inputs) {
          await seedItems();
          const before = forbidden();
          const response = JSON.stringify(await call(channel, toolName, input));
          const hit = leaksIn(response, [...before, ...forbidden()]);
          if (hit !== undefined) leaks.push(`${who}:${toolName}:${JSON.stringify(input)}`);
          if (response.includes(REVEAL_CANARY))
            reveals.push(`${who}:${toolName}:${String(input.name)}`);
        }
      }
      if (who === 'bob') {
        // Invariant 6 by behaviour: nothing bob can call decides a request or
        // revokes or changes a grant.
        const doc = readVault();
        expect(doc.requests.find((r) => r.id === pendingId)).toMatchObject({
          status: 'pending',
          mode: 'reveal',
        });
        expect(doc.requests.find((r) => r.id === pendingId)?.decidedAt).toBeUndefined();
        expect(doc.grants.find((g) => g.id === grantId)).toMatchObject({
          status: 'active',
          mode: 'inject',
        });
        expect(doc.grants.find((g) => g.id === revealGrantId)).toMatchObject({
          status: 'active',
          mode: 'reveal',
        });
        // bob's own requests are the only ones he could create, and none is decided.
        expect(
          doc.requests.filter(
            (r) => r.id !== pendingId && r.status !== 'pending' && r.status !== 'cancelled',
          ),
        ).toEqual([]);
        expect(doc.grants).toHaveLength(2);
      }
    }
    vi.restoreAllMocks();

    expect(leaks).toEqual([]);
    // The reveal canary: alice's own vault_get, and bob's only through his reveal grant.
    expect(new Set(reveals)).toEqual(new Set(['alice:vault_get:rev', 'bob:vault_get:rev']));
    // Nothing logged carries a value.
    expect(logged.filter((l) => l.includes(INJECT_CANARY) || l.includes(REVEAL_CANARY))).toEqual(
      [],
    );
  }, 60_000);

  it('alice’s audit log records the reveals but holds no value', () => {
    const dir = path.join(configDir, 'audit', 'alice');
    const text = fs
      .readdirSync(dir)
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('');
    const events = text
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as Record<string, unknown>)['drawlatch.event']);
    expect(events).toContain('vault.reveal');
    expect(events).toContain('vault.item.created');
    expect(text).not.toContain(INJECT_CANARY);
    expect(text).not.toContain(REVEAL_CANARY);
  });

  it('no admin GET endpoint returns a vault value, the key, or ciphertext', async () => {
    await seedItems();
    const resolveRoutesForCaller = (alias: string): ResolvedRoute[] => {
      const cfg = loadRemoteConfig();
      if (!Object.hasOwn(cfg.callers, alias)) return [];
      return resolveRoutes(
        resolveCallerRoutes(cfg, alias),
        resolveSecrets(cfg.callers[alias].env ?? {}),
        alias,
      );
    };
    const router = createAdminRouter({
      getSessionsSnapshot: () => [],
      ingestorManager: () => mgr,
      loadConfig: () => loadRemoteConfig(),
      resolveRoutesForCaller,
      refreshCaller: () => undefined,
      reloadPeer: () => undefined,
      removePeer: () => undefined,
      version: 'test',
      port: 0,
      startedAt: Date.now(),
    });
    const getPaths = (
      router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]
    )
      .filter((l) => l.route?.methods.get)
      .map((l) => l.route?.path ?? '');
    expect(getPaths.length).toBeGreaterThan(5);
    // The vault's own read endpoints are part of the sweep.
    expect(getPaths).toEqual(
      expect.arrayContaining([
        '/vault/status',
        '/callers/:alias/vault/items',
        '/vault/requests',
        '/vault/grants',
      ]),
    );

    const app = express();
    app.use('/api/admin', express.json(), router);
    const admin = app.listen(0, '127.0.0.1');
    await new Promise((r) => admin.once('listening', r));
    const port = (admin.address() as AddressInfo).port;
    const leaks: string[] = [];
    try {
      for (const alias of ['alice', 'bob']) {
        for (const p of getPaths) {
          const url = p.replace(':alias', alias).replace(':connection', 'vault');
          const res = await fetch(
            `http://127.0.0.1:${port}/api/admin${url}?name=rev&path=${encodeURIComponent(vaultFile())}`,
          );
          const text = await res.text();
          if (leaksIn(text, [...forbidden(), REVEAL_CANARY]) !== undefined) leaks.push(url);
        }
      }
    } finally {
      admin.close();
    }
    expect(leaks).toEqual([]);
  });

  it('no admin vault write returns a value; only POST …/reveal does', async () => {
    await seedItems();
    const router = createAdminRouter({
      getSessionsSnapshot: () => [],
      ingestorManager: () => mgr,
      loadConfig: () => loadRemoteConfig(),
      resolveRoutesForCaller: () => [],
      refreshCaller: () => undefined,
      reloadPeer: () => undefined,
      removePeer: () => undefined,
      version: 'test',
      port: 0,
      startedAt: Date.now(),
    });
    const vaultRoutes = (
      router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]
    )
      .filter((l) => l.route?.path.includes('vault'))
      .flatMap((l) =>
        Object.keys(l.route?.methods ?? {}).map((m) => [m.toUpperCase(), l.route?.path ?? '']),
      );
    expect(vaultRoutes.map(([m, p]) => `${m} ${p}`).sort()).toEqual([
      'DELETE /callers/:alias/vault/items/:name',
      'DELETE /vault/grants/:id',
      'GET /callers/:alias/vault/items',
      'GET /vault/grants',
      'GET /vault/requests',
      'GET /vault/status',
      'PATCH /callers/:alias/vault/items/:name',
      'POST /callers/:alias/vault/items',
      'POST /callers/:alias/vault/items/:name/reveal',
      'POST /vault/requests/:id/deny',
      'POST /vault/requests/:id/grant',
    ]);

    const app = express();
    app.use('/api/admin', express.json(), router);
    const admin = app.listen(0, '127.0.0.1');
    await new Promise((r) => admin.once('listening', r));
    const port = (admin.address() as AddressInfo).port;
    const leaks: string[] = [];
    const reveals: string[] = [];
    const bodies: Record<string, unknown>[] = [
      {},
      { name: 'rev', field: 'value', path: vaultFile(), file: keyFile() },
      { tags: ['x'], rename: 'rev' },
      { name: 'inj', kind: 'token', values: { value: 'fake-0000-new' } },
    ];
    try {
      for (const [method, p] of vaultRoutes) {
        for (const name of ['inj', 'rev']) {
          for (const body of bodies) {
            await seedItems();
            const before = forbidden();
            // A live id, so request/grant routes answer for real: a fresh
            // pending request from carol, or an active grant to her.
            let id = 'none';
            if (p.includes(':id')) {
              const { requestId } = await requestAccess('carol', {
                owner: 'alice',
                name,
                reason: 'sweep',
                mode: 'inject',
              });
              id = requestId;
              if (p.startsWith('/vault/grants')) {
                const g = readVault().grants.find(
                  (x) => x.grantee === 'carol' && x.status === 'active',
                );
                id = g?.id ?? (await grantRequest(requestId)).grant.id;
              }
            }
            const res = await fetch(
              `http://127.0.0.1:${port}/api/admin${p.replace(':alias', 'alice').replace(':name', name).replace(':id', id)}`,
              {
                method,
                headers: { 'content-type': 'application/json' },
                ...(method !== 'GET' && { body: JSON.stringify(body) }),
              },
            );
            const text = await res.text();
            const banned = [...before, ...forbidden(), REVEAL_CANARY];
            if (p.endsWith('/reveal')) {
              // Reveal returns the value it was asked for; still never key or ciphertext.
              if (text.includes(INJECT_CANARY) || text.includes(REVEAL_CANARY)) reveals.push(name);
              const keyOrCiphertext = banned.filter(
                (b) => b !== INJECT_CANARY && b !== REVEAL_CANARY,
              );
              if (leaksIn(text, keyOrCiphertext) !== undefined)
                leaks.push(`${method} ${p} ${name}`);
            } else if (leaksIn(text, banned) !== undefined) {
              leaks.push(`${method} ${p} ${name} ${JSON.stringify(body)}`);
            }
          }
        }
      }
    } finally {
      admin.close();
    }
    expect(leaks).toEqual([]);
    expect(new Set(reveals)).toEqual(new Set(['inj', 'rev']));
  });
});

describe('vault code-shape invariants', () => {
  it('no file outside src/remote/vault/ names the vault files', () => {
    const offenders: string[] = [];
    const vaultDir = path.join(repoRoot, 'src', 'remote', 'vault');
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.isDirectory()) {
          if (full !== vaultDir) walk(full);
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('vault.enc.json') || text.includes('vault.key')) {
            offenders.push(path.relative(repoRoot, full));
          }
        }
      }
    };
    for (const d of ['src', 'bin', path.join('frontend', 'src')]) {
      const full = path.join(repoRoot, d);
      if (fs.existsSync(full)) walk(full);
    }
    expect(offenders).toEqual([]);
  });

  it('no toolHandlers entry grants, denies, revokes or approves (invariant 6)', () => {
    expect(
      Object.keys(toolHandlers).filter((n) => /grant|deny|revoke|approve|decide/i.test(n)),
    ).toEqual([]);
    // By source, too: only the admin router calls the operator decisions.
    const decisions = /\b(grantRequest|denyRequest|revokeGrant)\b/;
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (decisions.test(fs.readFileSync(full, 'utf8'))) {
            callers.push(path.relative(repoRoot, full));
          }
        }
      }
    };
    walk(path.join(repoRoot, 'src'));
    expect(callers.sort()).toEqual(['src/remote/admin-vault.ts', 'src/remote/vault/service.ts']);
  });

  it('vault code never builds a path to the audit directory', () => {
    for (const f of fs
      .readdirSync(here)
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(fs.readFileSync(path.join(here, f), 'utf8')).not.toMatch(/['"`]audit['"`/]/);
    }
  });

  it('every vault tool is registered in the local MCP server', () => {
    const mcp = fs.readFileSync(path.join(repoRoot, 'src', 'mcp', 'server.ts'), 'utf8');
    const vaultTools = Object.keys(toolHandlers).filter((n) => n.startsWith('vault_'));
    expect(vaultTools.sort()).toEqual(
      [
        'vault_cancel_request',
        'vault_create',
        'vault_delete',
        'vault_get',
        'vault_list',
        'vault_list_requests',
        'vault_request_access',
        'vault_update',
      ].sort(),
    );
    for (const t of vaultTools) expect(mcp).toContain(`'${t}'`);
  });
});
