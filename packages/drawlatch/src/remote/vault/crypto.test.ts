import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  aadFor,
  computeKeyId,
  createKeyFile,
  openEnvelope,
  readKeyFile,
  sealDocument,
} from './crypto.js';

const LABEL = 'keys/vault.key';
const CANARY = `canary-${crypto.randomUUID()}`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-crypto-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function key(): Buffer {
  return crypto.randomBytes(32);
}

function plaintext(): Buffer {
  return Buffer.from(JSON.stringify({ secret: CANARY }));
}

describe('envelope', () => {
  it('round-trips and records the key id', () => {
    const k = key();
    const env = sealDocument(k, plaintext());
    expect(env).toMatchObject({
      format: 'drawlatch-vault',
      version: 1,
      alg: 'aes-256-gcm',
      keyId: computeKeyId(k),
    });
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(env.tag, 'base64')).toHaveLength(16);
    expect(JSON.stringify(env)).not.toContain(CANARY);
    expect(openEnvelope(k, env).toString()).toBe(plaintext().toString());
  });

  it('uses a fresh IV for every seal', () => {
    const k = key();
    const a = sealDocument(k, plaintext());
    const b = sealDocument(k, plaintext());
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('key id is the first 8 bytes of SHA-256 over a label and the key', () => {
    const k = key();
    const expected = crypto
      .createHash('sha256')
      .update('drawlatch-vault-key-id')
      .update(k)
      .digest()
      .subarray(0, 8)
      .toString('hex');
    expect(computeKeyId(k)).toBe(expected);
    expect(computeKeyId(k)).toMatch(/^[0-9a-f]{16}$/);
  });

  function flip(b64: string): string {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 0x01;
    return buf.toString('base64');
  }

  it.each(['ciphertext', 'iv', 'tag'] as const)('fails authentication on a tampered %s', (f) => {
    const k = key();
    const env = sealDocument(k, plaintext());
    const bad = { ...env, [f]: flip(env[f]) };
    expect(() => openEnvelope(k, bad)).toThrow(/failed authentication/);
  });

  it('binds format, version and key id through the AAD', () => {
    const k = key();
    const env = sealDocument(k, plaintext());
    // Decrypt by hand with an AAD naming another version or key id: GCM fails.
    for (const aad of [aadFor(2, env.keyId), aadFor(1, '0000000000000000')]) {
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64'));
      d.setAAD(aad);
      d.setAuthTag(Buffer.from(env.tag, 'base64'));
      d.update(Buffer.from(env.ciphertext, 'base64'));
      expect(() => d.final()).toThrow();
    }
    expect(aadFor(1, env.keyId).toString()).toBe(`drawlatch-vault|v1|${env.keyId}`);
  });

  it('refuses an edited key id or version in the header', () => {
    const k = key();
    const env = sealDocument(k, plaintext());
    expect(() => openEnvelope(k, { ...env, keyId: '0000000000000000' })).toThrow(/key id/);
    expect(() => openEnvelope(k, { ...env, version: 2 })).toThrow(
      'vault file version 2 is newer than this drawlatch',
    );
    expect(() => openEnvelope(k, { ...env, version: 0 })).toThrow(/version/);
  });

  it('gives a key-id mismatch message for the wrong key', () => {
    const env = sealDocument(key(), plaintext());
    const other = key();
    expect(() => openEnvelope(other, env)).toThrow(
      new RegExp(`key id ${env.keyId}.*key id ${computeKeyId(other)}`),
    );
  });

  it('refuses an unknown format or algorithm', () => {
    const k = key();
    const env = sealDocument(k, plaintext());
    expect(() => openEnvelope(k, { ...env, format: 'other' })).toThrow(/not a drawlatch vault/);
    expect(() => openEnvelope(k, { ...env, alg: 'aes-128-gcm' })).toThrow(/algorithm/);
    expect(() => openEnvelope(k, null)).toThrow(/not a drawlatch vault/);
    expect(() => openEnvelope(k, { ...env, iv: 'AAAA' })).toThrow(/iv/);
  });
});

describe('key file', () => {
  it('creates a 0600 file holding one base64 line of 32 bytes', () => {
    const file = path.join(dir, 'keys', 'vault.key');
    const { key: k, created } = createKeyFile(file, LABEL);
    expect(created).toBe(true);
    expect(k).toHaveLength(32);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(readKeyFile(file, LABEL).equals(k)).toBe(true);
  });

  it('a second creator (O_EXCL loser) gets the winner key, not a new one', () => {
    const file = path.join(dir, 'keys', 'vault.key');
    const first = createKeyFile(file, LABEL);
    const second = createKeyFile(file, LABEL);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it('undoes umask: the key is 0600 even under umask 0277', () => {
    const prev = process.umask(0o277);
    try {
      const file = path.join(dir, 'vault.key');
      createKeyFile(file, LABEL);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(prev);
    }
  });

  it('refuses a key file readable by group or others, and says why', () => {
    const file = path.join(dir, 'vault.key');
    createKeyFile(file, LABEL);
    fs.chmodSync(file, 0o640);
    expect(() => readKeyFile(file, LABEL)).toThrow(
      'keys/vault.key is readable by group or others (mode 0640); ' +
        'run chmod 600 on keys/vault.key in the drawlatch config dir',
    );
  });

  it('refuses a malformed key without echoing it', () => {
    const file = path.join(dir, 'vault.key');
    fs.writeFileSync(file, `${CANARY}\n`, { mode: 0o600 });
    let message = '';
    try {
      readKeyFile(file, LABEL);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a base64 32-byte key/);
    expect(message).not.toContain(CANARY);
  });

  it('reports a read failure by code and label, never the absolute path', () => {
    const file = path.join(dir, 'keys', 'vault.key');
    fs.mkdirSync(file, { recursive: true, mode: 0o700 }); // a directory: read gives EISDIR
    let message = '';
    try {
      readKeyFile(file, LABEL);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('could not read keys/vault.key (EISDIR)');
    expect(message).not.toContain(dir);
  });
});
