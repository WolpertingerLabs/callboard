import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateKeyLayout } from '../../shared/migrations.js';
import { computeKeyId } from './crypto.js';
import {
  MAX_VAULT_BYTES,
  MISSING_KEY_MESSAGE,
  ensureWriteKey,
  mutateVault,
  readVault,
  resetVaultCache,
  vaultDiagnostics,
  vaultExists,
  type VaultItem,
} from './store.js';

const CANARY = `canary-${crypto.randomUUID()}`;

let dir: string;
let prevConfigDir: string | undefined;
const file = () => path.join(dir, 'vault.enc.json');
const keyFile = () => path.join(dir, 'keys', 'vault.key');

beforeEach(() => {
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-store-'));
  process.env.MCP_CONFIG_DIR = dir;
  resetVaultCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetVaultCache();
  if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
  else process.env.MCP_CONFIG_DIR = prevConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function item(name: string, value: string): VaultItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    kind: 'token',
    exposure: 'inject',
    values: { value },
    tags: [],
    metadata: {},
    createdBy: 'agent',
    createdAt: now,
    updatedAt: now,
    valueUpdatedAt: now,
  };
}

function put(caller: string, name: string, value: string): void {
  mutateVault((doc) => {
    doc.callers[caller] ??= { items: {} };
    doc.callers[caller].items[name] = item(name, value);
  });
}

function tmpFiles(): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith('vault.enc.json.tmp-'));
}

describe('vault store', () => {
  it('reads an empty vault without creating a key or a file', () => {
    const doc = readVault();
    expect(doc).toMatchObject({ schema: 1, revision: 0, requests: [], grants: [] });
    expect(Object.keys(doc.callers)).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(vaultExists()).toBe(false);
  });

  it('first write creates a 0600 key and a 0600 vault file, and round-trips', () => {
    put('alice', 'gh', CANARY);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(vaultExists()).toBe(true);
    resetVaultCache();
    const doc = readVault();
    expect(doc.revision).toBe(1);
    expect(doc.callers.alice.items.gh.values.value).toBe(CANARY);
  });

  it('does not create a key when the mutation throws', () => {
    expect(() =>
      mutateVault(() => {
        throw new Error('validation failed');
      }),
    ).toThrow('validation failed');
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('never writes plaintext to disk', () => {
    put('alice', 'gh', CANARY);
    put('alice', 'other', 'fake-0000-second');
    const raw = fs.readFileSync(file());
    expect(raw.includes(CANARY)).toBe(false);
    expect(raw.includes('alice')).toBe(false);
    for (const t of tmpFiles())
      expect(fs.readFileSync(path.join(dir, t)).includes(CANARY)).toBe(false);
  });

  it('increments the revision and records the key id on every write', () => {
    put('alice', 'a', 'fake-0001');
    put('alice', 'b', 'fake-0002');
    const env = JSON.parse(fs.readFileSync(file(), 'utf8')) as { keyId: string };
    const key = Buffer.from(fs.readFileSync(keyFile(), 'utf8').trim(), 'base64');
    expect(env.keyId).toBe(computeKeyId(key));
    expect(readVault().revision).toBe(2);
  });

  it('refuses every operation when the key is missing but the file exists, and makes no key', () => {
    put('alice', 'gh', CANARY);
    fs.rmSync(keyFile());
    resetVaultCache();
    expect(() => readVault()).toThrow(MISSING_KEY_MESSAGE);
    expect(() => put('alice', 'x', 'fake-0003')).toThrow(MISSING_KEY_MESSAGE);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it('refuses even with a warm cache once the key is gone', () => {
    put('alice', 'gh', CANARY);
    readVault();
    fs.rmSync(keyFile());
    expect(() => readVault()).toThrow(MISSING_KEY_MESSAGE);
  });

  it('gives the key-id mismatch message for a different key', () => {
    put('alice', 'gh', CANARY);
    fs.writeFileSync(keyFile(), `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    resetVaultCache();
    expect(() => readVault()).toThrow(/key id/);
  });

  it('refuses a group-readable key', () => {
    put('alice', 'gh', CANARY);
    fs.chmodSync(keyFile(), 0o644);
    resetVaultCache();
    expect(() => readVault()).toThrow(/readable by group or others/);
  });

  it('refuses a newer file version', () => {
    put('alice', 'gh', CANARY);
    const env = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file(), JSON.stringify({ ...env, version: 2 }));
    expect(() => readVault()).toThrow('vault file version 2 is newer than this drawlatch');
  });

  it('a throw between write and rename leaves the old file intact; the temp goes next write', () => {
    put('alice', 'gh', CANARY);
    const before = fs.readFileSync(file());
    // A crash: the rename never happens and nothing cleans up after it.
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated crash');
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('simulated crash');
    });
    expect(() => put('alice', 'second', 'fake-0004')).toThrow(/vault write failed/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(tmpFiles()).toHaveLength(1);
    // The cache wasn't advanced either.
    expect(Object.keys(readVault().callers.alice.items)).toEqual(['gh']);

    put('alice', 'third', 'fake-0005');
    expect(tmpFiles()).toEqual([]);
    expect(Object.keys(readVault().callers.alice.items).sort()).toEqual(['gh', 'third']);
  });

  it('picks up a file replaced behind its back (restore from backup)', () => {
    put('alice', 'one', 'fake-0006');
    const backup = path.join(dir, 'backup.json');
    fs.copyFileSync(file(), backup);
    put('alice', 'two', 'fake-0007');
    expect(Object.keys(readVault().callers.alice.items)).toHaveLength(2);
    const staged = path.join(dir, 'staged.json');
    fs.copyFileSync(backup, staged);
    fs.renameSync(staged, file());
    expect(Object.keys(readVault().callers.alice.items)).toEqual(['one']);
  });

  it('reads return copies: mutating one does not change the store', () => {
    put('alice', 'gh', CANARY);
    const doc = readVault();
    doc.callers.alice.items.gh.values.value = 'changed';
    expect(readVault().callers.alice.items.gh.values.value).toBe(CANARY);
  });

  it('keeps reserved names as plain data in its maps', () => {
    mutateVault((doc) => {
      doc.callers.alice = { items: {} };
      doc.callers.alice.items.constructor = item('constructor', 'fake-0008');
    });
    resetVaultCache();
    const doc = readVault();
    expect(Object.getPrototypeOf(doc.callers)).toBeNull();
    expect(Object.hasOwn(doc.callers.alice.items, 'constructor')).toBe(true);
    expect(Object.hasOwn(doc.callers, 'constructor')).toBe(false);
  });

  it(`refuses a write past ${MAX_VAULT_BYTES} bytes without echoing values`, () => {
    let message = '';
    try {
      put('alice', 'big', CANARY + 'x'.repeat(MAX_VAULT_BYTES));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/32 MiB/);
    expect(message).not.toContain(CANARY);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('migrateKeyLayout leaves keys/vault.key alone', () => {
    put('alice', 'gh', CANARY);
    const key = fs.readFileSync(keyFile());
    fs.mkdirSync(path.join(dir, 'keys', 'local', 'bob'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'keys', 'remote'), { recursive: true });
    migrateKeyLayout(path.join(dir, 'keys'));
    expect(fs.existsSync(path.join(dir, 'keys', 'callers', 'bob'))).toBe(true);
    expect(fs.readFileSync(keyFile()).equals(key)).toBe(true);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    resetVaultCache();
    expect(readVault().callers.alice.items.gh.values.value).toBe(CANARY);
  });
});

describe('read-path errors', () => {
  const asRoot = process.getuid?.() === 0;

  function messageOf(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected a throw');
  }

  it('reduces an unreadable vault file to its code and relative name', () => {
    put('alice', 'gh', CANARY);
    fs.rmSync(file());
    fs.mkdirSync(file()); // stat works, read gives EISDIR
    resetVaultCache();
    const msg = messageOf(() => readVault());
    expect(msg).toBe('could not read vault.enc.json (EISDIR)');
    expect(msg).not.toContain(dir);
  });

  it('reduces an unreadable key to its code and relative name', () => {
    put('alice', 'gh', CANARY);
    fs.rmSync(keyFile());
    fs.mkdirSync(keyFile(), { mode: 0o700 });
    resetVaultCache();
    const msg = messageOf(() => readVault());
    expect(msg).toBe('could not read keys/vault.key (EISDIR)');
    expect(msg).not.toContain(dir);
  });

  it.skipIf(asRoot)('reduces EACCES on the vault file the same way', () => {
    put('alice', 'gh', CANARY);
    fs.chmodSync(file(), 0o000);
    resetVaultCache();
    try {
      const msg = messageOf(() => readVault());
      expect(msg).toBe('could not read vault.enc.json (EACCES)');
      expect(msg).not.toContain(dir);
    } finally {
      fs.chmodSync(file(), 0o600);
    }
  });
});

describe('ensureWriteKey', () => {
  it('creates a key when neither file exists', () => {
    expect(ensureWriteKey()).toHaveLength(32);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  it('never creates a key while the vault file exists, even called directly', () => {
    put('alice', 'gh', CANARY);
    const vaultBytes = fs.readFileSync(file());
    fs.rmSync(keyFile());
    expect(() => ensureWriteKey()).toThrow(MISSING_KEY_MESSAGE);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.readFileSync(file()).equals(vaultBytes)).toBe(true);
  });

  it('reuses an existing key', () => {
    put('alice', 'gh', CANARY);
    const key = fs.readFileSync(keyFile(), 'utf8').trim();
    expect(ensureWriteKey().toString('base64')).toBe(key);
  });
});

describe('vaultDiagnostics', () => {
  it('passes with nothing created yet', () => {
    expect(vaultDiagnostics().every((c) => c.ok)).toBe(true);
  });

  it('passes with a healthy vault and reports the key id, never the key', () => {
    put('alice', 'gh', CANARY);
    const checks = vaultDiagnostics();
    expect(checks.every((c) => c.ok)).toBe(true);
    const key = fs.readFileSync(keyFile(), 'utf8').trim();
    const text = JSON.stringify(checks);
    expect(text).toContain(computeKeyId(Buffer.from(key, 'base64')));
    expect(text).not.toContain(key);
    expect(text).not.toContain(CANARY);
  });

  it('flags a missing key with an existing file', () => {
    put('alice', 'gh', CANARY);
    fs.rmSync(keyFile());
    const failed = vaultDiagnostics().filter((c) => !c.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].fix).toBe(MISSING_KEY_MESSAGE);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it('flags a group-readable key and a file that will not decrypt', () => {
    put('alice', 'gh', CANARY);
    fs.chmodSync(keyFile(), 0o640);
    // doctor is local CLI output: its fix carries the full path, runnable from anywhere.
    expect(vaultDiagnostics().some((c) => !c.ok && c.fix === `run: chmod 600 ${keyFile()}`)).toBe(
      true,
    );
    fs.chmodSync(keyFile(), 0o600);
    const env = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, string>;
    fs.writeFileSync(file(), JSON.stringify({ ...env, tag: Buffer.alloc(16).toString('base64') }));
    resetVaultCache();
    expect(vaultDiagnostics().some((c) => !c.ok && (c.fix ?? '').includes('authentication'))).toBe(
      true,
    );
  });
});
