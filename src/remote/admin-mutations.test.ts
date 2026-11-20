/**
 * Tests for the self-managed surface:
 *   - caller bootstrap: createCallerWithKeys / deleteCaller
 *   - credential issuance: issueCallerBundle (public-only persist, bundle shape,
 *     secret non-leakage, passphrase wrap round-trip) + issueLocalCaller
 *   - key-layout migration (item G): migrateKeyLayout
 *   - mutating admin API (item A): create/delete/issue caller, enable/disable, secrets
 *
 * Every mutating admin test also asserts the security invariant that secret
 * VALUES never appear in any response body.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  loadRemoteConfig,
  saveRemoteConfig,
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
  getCallerKeysDir,
  getServerKeysDir,
  getKeysDir,
  type RemoteServerConfig,
  type ResolvedRoute,
} from '../shared/config.js';
import {
  createCallerWithKeys,
  deleteCaller,
  issueCallerBundle,
  issueLocalCaller,
} from './caller-bootstrap.js';
import { migrateKeyLayout } from '../shared/migrations.js';
import { createAdminRouter } from './admin.js';
import { createCaller } from '../shared/crypto/key-manager.js';
import { generateKeyBundle, saveKeyBundle } from '../shared/crypto/keys.js';
import { deriveBundleKey, decryptBundleField } from '../shared/protocol/caller-bundle-crypto.js';
import type { CallerBundleV1 } from '../shared/protocol/caller-bundle.js';
import type { IngestorManager } from './ingestors/index.js';
import type { IngestorStatus } from './ingestors/types.js';

function seedConfig(): void {
  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0,
    callers: {
      default: { name: 'Default', connections: ['github'] },
    },
    rateLimitPerMinute: 60,
  };
  saveRemoteConfig(config);
}

// ── caller bootstrap (item E) ──────────────────────────────────────────────

describe('caller bootstrap', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-boot-'));
    process.env.MCP_CONFIG_DIR = dir;
    seedConfig();
    // Issuance embeds the server public keys in the bundle — provision them.
    saveKeyBundle(generateKeyBundle(), getServerKeysDir());
  });
  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a caller with a keypair, cloning default connections', () => {
    const res = createCallerWithKeys('alice');
    expect(res.alias).toBe('alice');
    expect(res.fingerprint).toMatch(/.+/);
    expect(res.connections).toEqual(['github']);
    // Keypair written to disk
    expect(fs.existsSync(path.join(getCallerKeysDir(), 'alice', 'signing.key.pem'))).toBe(true);
    // Registered in config, locked against agent self-management
    expect('alice' in loadRemoteConfig().callers).toBe(true);
    expect(loadRemoteConfig().callers.alice.selfManage).toBe(false);
  });

  it('honors explicit connections + name', () => {
    const res = createCallerWithKeys('bob', { name: 'Bob', connections: [] });
    expect(res.name).toBe('Bob');
    expect(res.connections).toEqual([]);
  });

  it('rejects an invalid alias', () => {
    expect(() => createCallerWithKeys('bad alias!')).toThrow(/Invalid alias/);
  });

  it('rejects a duplicate caller', () => {
    createCallerWithKeys('alice');
    expect(() => createCallerWithKeys('alice')).toThrow(/already exists/);
  });

  it('deletes a caller and its key dir', () => {
    createCallerWithKeys('alice');
    deleteCaller('alice');
    expect('alice' in loadRemoteConfig().callers).toBe(false);
    expect(fs.existsSync(path.join(getCallerKeysDir(), 'alice'))).toBe(false);
  });

  it('refuses to delete the default caller', () => {
    expect(() => deleteCaller('default')).toThrow(/Cannot delete/);
  });
});

// ── credential issuance primitive ──────────────────────────────────────────

describe('issueCallerBundle', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-issue-'));
    process.env.MCP_CONFIG_DIR = dir;
    seedConfig();
    saveKeyBundle(generateKeyBundle(), getServerKeysDir());
  });
  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('locks a newly issued caller, but a re-issue keeps the existing setting', () => {
    issueCallerBundle({ alias: 'fresh', endpointUrl: 'https://drawlatch.example.com' });
    expect(loadRemoteConfig().callers.fresh.selfManage).toBe(false);

    // `default` predates the flag (absent = permissive); re-issuing keeps that.
    issueCallerBundle({ alias: 'default', endpointUrl: 'https://drawlatch.example.com' });
    expect(loadRemoteConfig().callers.default.selfManage).toBeUndefined();

    const cfg = loadRemoteConfig();
    cfg.callers.fresh.selfManage = true;
    saveRemoteConfig(cfg);
    issueCallerBundle({ alias: 'fresh', endpointUrl: 'https://drawlatch.example.com' });
    expect(loadRemoteConfig().callers.fresh.selfManage).toBe(true);
  });

  it('assembles a v1 bundle and persists ONLY the public keys to disk', () => {
    const bundle = issueCallerBundle({
      alias: 'cb',
      endpointUrl: 'https://drawlatch.example.com',
      connections: ['github'],
    });

    expect(bundle.version).toBe(1);
    expect(bundle.callerAlias).toBe('cb');
    expect(bundle.endpointUrl).toBe('https://drawlatch.example.com');
    expect(bundle.connections).toEqual(['github']);
    expect(bundle.fingerprint).toMatch(/.+/);
    expect(bundle.serverKeyFingerprint).toMatch(/.+/);
    // Caller priv+pub present; server is public-only (no priv field).
    expect(bundle.caller.signing.priv).toContain('PRIVATE KEY');
    expect(bundle.caller.exchange.priv).toContain('PRIVATE KEY');
    expect(bundle.server.signing.pub).toContain('PUBLIC KEY');
    expect(bundle.server.exchange.pub).toContain('PUBLIC KEY');
    expect((bundle.server.signing as Record<string, unknown>).priv).toBeUndefined();

    // Public-only on drawlatch disk — the caller private key is never written.
    const keyDir = path.join(getCallerKeysDir(), 'cb');
    expect(fs.existsSync(path.join(keyDir, 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keyDir, 'exchange.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keyDir, 'signing.key.pem'))).toBe(false);
    expect(fs.existsSync(path.join(keyDir, 'exchange.key.pem'))).toBe(false);

    // Registered with a source badge.
    expect(loadRemoteConfig().callers.cb.source).toBe('bundle-issued');
  });

  it('never serializes a connection-secret value into the bundle', () => {
    // A secret that, if leaked, would appear verbatim in the bundle JSON.
    process.env.CB_GITHUB_TOKEN = 'ghp_must_not_leak_0123456789';
    try {
      const bundle = issueCallerBundle({
        alias: 'cb',
        endpointUrl: 'https://x.example',
        connections: ['github'],
      });
      expect(JSON.stringify(bundle)).not.toContain('ghp_must_not_leak_0123456789');
      // connections is a name list only.
      expect(bundle.connections).toEqual(['github']);
    } finally {
      delete process.env.CB_GITHUB_TOKEN;
    }
  });

  it('re-issue mints a fresh keypair and overwrites the stored public key', () => {
    const first = issueCallerBundle({ alias: 'cb', endpointUrl: 'https://x' });
    const firstPub = fs.readFileSync(
      path.join(getCallerKeysDir(), 'cb', 'signing.pub.pem'),
      'utf-8',
    );
    const second = issueCallerBundle({ alias: 'cb', endpointUrl: 'https://x' });
    const secondPub = fs.readFileSync(
      path.join(getCallerKeysDir(), 'cb', 'signing.pub.pem'),
      'utf-8',
    );

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(secondPub).not.toBe(firstPub);
    // Connections are preserved across a rotation.
    expect(second.connections).toEqual(first.connections);
  });

  it('passphrase-wraps ONLY the caller private keys (round-trip)', () => {
    const bundle = issueCallerBundle({
      alias: 'cb',
      endpointUrl: 'https://x',
      passphrase: 'correct horse battery staple',
    });

    expect(bundle.encryption).not.toBeNull();
    expect(bundle.encryption?.kdf).toBe('scrypt');
    expect(bundle.encryption?.alg).toBe('aes-256-gcm');
    // Public halves stay plaintext; private halves are ciphertext.
    expect(bundle.caller.signing.pub).toContain('PUBLIC KEY');
    expect(bundle.caller.signing.priv).not.toContain('PRIVATE KEY');
    expect(bundle.caller.exchange.priv).not.toContain('PRIVATE KEY');

    const key = deriveBundleKey('correct horse battery staple', bundle.encryption!);
    expect(decryptBundleField(bundle.caller.signing.priv, key)).toContain('PRIVATE KEY');
    expect(decryptBundleField(bundle.caller.exchange.priv, key)).toContain('PRIVATE KEY');

    // Wrong passphrase fails (GCM auth).
    const wrong = deriveBundleKey('nope', bundle.encryption!);
    expect(() => decryptBundleField(bundle.caller.signing.priv, wrong)).toThrow();
  });

  it('rejects an invalid alias and a missing endpoint', () => {
    expect(() => issueCallerBundle({ alias: 'bad alias', endpointUrl: 'https://x' })).toThrow(
      /Invalid alias/,
    );
    expect(() => issueCallerBundle({ alias: 'cb', endpointUrl: '' })).toThrow(/endpointUrl/);
  });
});

// ── local write-to-path (auto-share) ───────────────────────────────────────

describe('issueLocalCaller', () => {
  let dir: string;
  let target: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-local-'));
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'callboard-keys-'));
    process.env.MCP_CONFIG_DIR = dir;
    seedConfig();
    saveKeyBundle(generateKeyBundle(), getServerKeysDir());
  });
  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('writes the UNPACKED key files into the target keys dir, keeping drawlatch public-only', () => {
    const res = issueLocalCaller({ alias: 'callboard-local', keysDir: target });

    // callboard gets the full keypair (priv+pub) plus server public keys.
    const cbDir = path.join(target, 'callers', 'callboard-local');
    expect(fs.existsSync(path.join(cbDir, 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(cbDir, 'exchange.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(cbDir, 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'server', 'signing.pub.pem'))).toBe(true);

    // drawlatch keeps ONLY the public key.
    const ownDir = path.join(getCallerKeysDir(), 'callboard-local');
    expect(fs.existsSync(path.join(ownDir, 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(ownDir, 'signing.key.pem'))).toBe(false);

    expect(loadRemoteConfig().callers['callboard-local'].source).toBe('local-auto');
    expect(loadRemoteConfig().callers['callboard-local'].selfManage).toBe(false);
    expect(res.fingerprint).toMatch(/.+/);
  });
});

// ── key-layout migration (item G) ──────────────────────────────────────────

describe('migrateKeyLayout', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-mig-'));
    process.env.MCP_CONFIG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates legacy keys/local + keys/remote + keys/peers to callers/server', () => {
    const keys = getKeysDir();
    // Legacy layout
    fs.mkdirSync(path.join(keys, 'local', 'alice'), { recursive: true });
    fs.writeFileSync(path.join(keys, 'local', 'alice', 'signing.key.pem'), 'x');
    fs.mkdirSync(path.join(keys, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(keys, 'remote', 'signing.key.pem'), 'y');
    fs.mkdirSync(path.join(keys, 'peers', 'remote-server'), { recursive: true });
    fs.writeFileSync(path.join(keys, 'peers', 'remote-server', 'signing.pub.pem'), 'z');

    migrateKeyLayout();

    expect(fs.existsSync(path.join(keys, 'callers', 'alice', 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keys, 'server', 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keys, 'server', 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keys, 'local'))).toBe(false);
    expect(fs.existsSync(path.join(keys, 'remote'))).toBe(false);
    expect(fs.existsSync(path.join(keys, 'peers'))).toBe(false);
  });

  it('is idempotent and a no-op when there is nothing to migrate', () => {
    expect(() => migrateKeyLayout()).not.toThrow();
    migrateKeyLayout();
  });
});

// ── mutating admin API (item A) ────────────────────────────────────────────

describe('mutating admin API', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  const SECRET_VALUE = 'token-must-not-leak-abcdef0123456789';

  const ingestorStub = {
    getAllStatuses: () => [] as (IngestorStatus & { callerAlias: string })[],
    getStatuses: () => [] as IngestorStatus[],
    getAllEvents: () => [],
    stopOne: () => Promise.resolve({ success: true }),
    has: () => false,
  } as unknown as IngestorManager;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-mut-'));
    process.env.MCP_CONFIG_DIR = dir;
    seedConfig();
    // The default caller needs keys so reloadPeer/removePeer have something real
    // to act on; create them directly.
    createCaller('default');
    // Issuance embeds the server public keys in the bundle.
    saveKeyBundle(generateKeyBundle(), getServerKeysDir());

    const resolveRoutesForCaller = (alias: string): ResolvedRoute[] => {
      const cfg = loadRemoteConfig();
      const caller = cfg.callers[alias] as RemoteServerConfig['callers'][string] | undefined;
      if (!caller) return [];
      return resolveRoutes(
        resolveCallerRoutes(cfg, alias),
        resolveSecrets(caller.env ?? {}),
        alias,
      );
    };

    const app = express();
    app.use('/api/admin', express.json());
    app.use(
      '/api/admin',
      createAdminRouter({
        getSessionsSnapshot: () => [],
        ingestorManager: () => ingestorStub,
        loadConfig: () => loadRemoteConfig(),
        resolveRoutesForCaller,
        refreshCaller: () => undefined,
        reloadPeer: () => undefined,
        removePeer: () => undefined,
        version: 'test',
        port: 0,
        startedAt: Date.now(),
      }),
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, text };
  }

  it('creates a caller (201) and rejects a duplicate (409) + bad alias (400)', async () => {
    const ok = await req('POST', '/api/admin/callers', { alias: 'team', name: 'Team' });
    expect(ok.status).toBe(201);
    expect((ok.json as { alias: string }).alias).toBe('team');

    const dup = await req('POST', '/api/admin/callers', { alias: 'team' });
    expect(dup.status).toBe(409);

    const bad = await req('POST', '/api/admin/callers', { alias: 'no good' });
    expect(bad.status).toBe(400);
  });

  it('enables and disables a connection for a caller', async () => {
    const off = await req('POST', '/api/admin/callers/default/connections/github', {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(loadRemoteConfig().callers.default.connections).not.toContain('github');

    const on = await req('POST', '/api/admin/callers/default/connections/github', {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(loadRemoteConfig().callers.default.connections).toContain('github');
  });

  it('rejects enable for an unknown caller (404)', async () => {
    const res = await req('POST', '/api/admin/callers/ghost/connections/github', {
      enabled: true,
    });
    expect(res.status).toBe(404);
  });

  it('sets secrets (boolean status only) and never echoes the value', async () => {
    const res = await req('PUT', '/api/admin/callers/default/connections/github/secrets', {
      secrets: { GITHUB_TOKEN: SECRET_VALUE },
    });
    expect(res.status).toBe(200);
    expect((res.json as { secretsSet: Record<string, boolean> }).secretsSet.GITHUB_TOKEN).toBe(
      true,
    );
    // The value must never appear anywhere in the response.
    expect(res.text.includes(SECRET_VALUE)).toBe(false);
  });

  it('deletes a caller (200) and blocks deleting default (400)', async () => {
    await req('POST', '/api/admin/callers', { alias: 'temp' });
    const del = await req('DELETE', '/api/admin/callers/temp');
    expect(del.status).toBe(200);
    expect('temp' in loadRemoteConfig().callers).toBe(false);

    const blocked = await req('DELETE', '/api/admin/callers/default');
    expect(blocked.status).toBe(400);
  });

  it('issues a caller bundle and never leaks a secret value', async () => {
    const res = await req('POST', '/api/admin/callers/default/issue', {
      endpointUrl: 'https://drawlatch.example.com',
      connections: ['github'],
    });
    expect(res.status).toBe(200);
    const bundle = res.json as CallerBundleV1;
    expect(bundle.version).toBe(1);
    expect(bundle.callerAlias).toBe('default');
    expect(bundle.caller.signing.priv).toContain('PRIVATE KEY');
    expect(bundle.connections).toEqual(['github']);
    // A secret was set earlier in this suite — it must not appear in the bundle.
    expect(res.text.includes(SECRET_VALUE)).toBe(false);
  });

  it('passphrase-wraps the private keys when requested', async () => {
    const res = await req('POST', '/api/admin/callers/default/issue', {
      endpointUrl: 'https://drawlatch.example.com',
      passphrase: 'pw-from-the-operator',
    });
    expect(res.status).toBe(200);
    const bundle = res.json as CallerBundleV1;
    expect(bundle.encryption).not.toBeNull();
    expect(bundle.caller.signing.priv).not.toContain('PRIVATE KEY');
  });

  it('rejects issue with no endpoint (none supplied, no default) — 400', async () => {
    const res = await req('POST', '/api/admin/callers/default/issue', {});
    expect(res.status).toBe(400);
  });

  it('toggles the tunnel flag (PUT /tunnel) and persists to config', async () => {
    // Sanity: not set initially.
    expect(loadRemoteConfig().tunnel).toBeUndefined();

    const on = await req('PUT', '/api/admin/tunnel', { enabled: true });
    expect(on.status).toBe(200);
    expect((on.json as { tunnel: boolean }).tunnel).toBe(true);
    expect(loadRemoteConfig().tunnel).toBe(true);

    const off = await req('PUT', '/api/admin/tunnel', { enabled: false });
    expect(off.status).toBe(200);
    expect((off.json as { tunnel: boolean }).tunnel).toBe(false);
    expect(loadRemoteConfig().tunnel).toBe(false);
  });

  it('locks a caller with PUT /self-manage; the admin path still mutates it', async () => {
    const list = async () =>
      (
        (await req('GET', '/api/admin/callers')).json as { alias: string; selfManage: boolean }[]
      ).find((c) => c.alias === 'default')!.selfManage;
    expect(await list()).toBe(true); // absent = permissive

    const lock = await req('PUT', '/api/admin/callers/default/self-manage', { enabled: false });
    expect(lock.status).toBe(200);
    expect(loadRemoteConfig().callers.default.selfManage).toBe(false);
    expect(await list()).toBe(false);

    // The dashboard acts for the operator, so the lock doesn't apply to it.
    const off = await req('POST', '/api/admin/callers/default/connections/github', {
      enabled: false,
    });
    expect(off.status).toBe(200);
    const on = await req('POST', '/api/admin/callers/default/connections/github', {
      enabled: true,
    });
    expect(on.status).toBe(200);
    const sec = await req('PUT', '/api/admin/callers/default/connections/github/secrets', {
      secrets: { GITHUB_TOKEN: SECRET_VALUE },
    });
    expect(sec.status).toBe(200);
    expect(sec.text.includes(SECRET_VALUE)).toBe(false);

    const unlock = await req('PUT', '/api/admin/callers/default/self-manage', { enabled: true });
    expect(unlock.status).toBe(200);
    expect(loadRemoteConfig().callers.default.selfManage).toBe(true);
  });

  it('rejects PUT /self-manage for an unknown caller (404) or a non-boolean (400)', async () => {
    expect(
      (await req('PUT', '/api/admin/callers/ghost/self-manage', { enabled: true })).status,
    ).toBe(404);
    expect(
      (await req('PUT', '/api/admin/callers/default/self-manage', { enabled: 'no' })).status,
    ).toBe(400);
  });

  it('rejects PUT /tunnel without a boolean enabled (400)', async () => {
    const bad = await req('PUT', '/api/admin/tunnel', { enabled: 'yes' });
    expect(bad.status).toBe(400);

    const empty = await req('PUT', '/api/admin/tunnel', {});
    expect(empty.status).toBe(400);
  });
});
