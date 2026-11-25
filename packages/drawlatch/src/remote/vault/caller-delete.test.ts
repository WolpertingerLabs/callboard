/**
 * Caller deletion purges the caller's vault, on every path that deletes a
 * caller (deleteCaller directly, and DELETE /api/admin/callers/:alias).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { loadRemoteConfig, saveRemoteConfig, getServerKeysDir } from '../../shared/config.js';
import { generateKeyBundle, saveKeyBundle } from '../../shared/crypto/keys.js';
import { resetAuditLogState } from '../audit-log.js';
import { createAdminRouter } from '../admin.js';
import { createCallerWithKeys, deleteCaller } from '../caller-bootstrap.js';
import type { IngestorManager } from '../ingestors/index.js';
import { createItem, listItems } from './service.js';
import { MISSING_KEY_MESSAGE, readVault, resetVaultCache } from './store.js';

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-delete-'));
  process.env.MCP_CONFIG_DIR = dir;
  resetVaultCache();
  resetAuditLogState();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  saveRemoteConfig({
    host: '127.0.0.1',
    port: 0,
    callers: { default: { connections: [] } },
    rateLimitPerMinute: 60,
  });
  saveKeyBundle(generateKeyBundle(), getServerKeysDir());
});
afterEach(() => {
  vi.restoreAllMocks();
  resetVaultCache();
  if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
  else process.env.MCP_CONFIG_DIR = prevConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(alias: string): Promise<void> {
  createCallerWithKeys(alias, { connections: [] });
  await createItem(alias, { name: 'gh', kind: 'token', values: { value: 'fake-0000' } }, 'agent');
}

describe('deleteCaller purges the vault', () => {
  it('removes the caller items; a re-created alias inherits nothing', async () => {
    await seed('alice');
    await createItem(
      'default',
      { name: 'keep', kind: 'token', values: { value: 'fake-1111' } },
      'agent',
    );
    deleteCaller('alice');
    expect(Object.hasOwn(readVault().callers, 'alice')).toBe(false);
    expect(listItems('default', {}).items.map((i) => i.name)).toEqual(['keep']);
    createCallerWithKeys('alice', { connections: [] });
    expect(listItems('alice', {}).items).toEqual([]);
  });

  it('with no vault, deletes the caller and creates no vault files', () => {
    createCallerWithKeys('alice', { connections: [] });
    deleteCaller('alice');
    expect(Object.hasOwn(loadRemoteConfig().callers, 'alice')).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('vault'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'keys')).filter((n) => n.startsWith('vault'))).toEqual([]);
  });

  it('fails closed, leaving the caller intact, when the vault is unreadable', async () => {
    await seed('alice');
    fs.rmSync(path.join(dir, 'keys', 'vault.key'));
    resetVaultCache();
    expect(() => deleteCaller('alice')).toThrow(MISSING_KEY_MESSAGE);
    expect(Object.hasOwn(loadRemoteConfig().callers, 'alice')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keys', 'callers', 'alice'))).toBe(true);
  });

  it('DELETE /api/admin/callers/:alias purges too', async () => {
    await seed('temp');
    const app = express();
    app.use('/api/admin', express.json());
    app.use(
      '/api/admin',
      createAdminRouter({
        getSessionsSnapshot: () => [],
        ingestorManager: () => ({}) as unknown as IngestorManager,
        loadConfig: () => loadRemoteConfig(),
        resolveRoutesForCaller: () => [],
        refreshCaller: () => undefined,
        reloadPeer: () => undefined,
        removePeer: () => undefined,
        version: 'test',
        port: 0,
        startedAt: Date.now(),
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/callers/temp`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect(Object.hasOwn(readVault().callers, 'temp')).toBe(false);
    } finally {
      server.close();
    }
  });
});
