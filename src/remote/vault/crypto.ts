/**
 * Vault crypto: the key file and the AES-256-GCM envelope. node:crypto only.
 *
 * Paths come in as arguments (store.ts is the only module that names the
 * vault files). Error messages use the caller-supplied `label`, a path
 * relative to the config dir, and never include key bytes or plaintext.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const VAULT_FORMAT = 'drawlatch-vault';
export const VAULT_VERSION = 1;
const ALG = 'aes-256-gcm';

/** A vault error whose message is safe to return to a caller. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultEnvelope {
  format: typeof VAULT_FORMAT;
  version: typeof VAULT_VERSION;
  alg: typeof ALG;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Public fingerprint of a key: first 8 bytes (hex) of SHA-256("drawlatch-vault-key-id" || key). */
export function computeKeyId(key: Buffer): string {
  return crypto
    .createHash('sha256')
    .update('drawlatch-vault-key-id')
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString('hex');
}

/** Additional authenticated data: binds format, version and key id. */
export function aadFor(version: number, keyId: string): Buffer {
  return Buffer.from(`${VAULT_FORMAT}|v${version}|${keyId}`, 'utf8');
}

/** Encrypt a whole document under `key` with a fresh random IV. */
export function sealDocument(key: Buffer, plaintext: Buffer): VaultEnvelope {
  const keyId = computeKeyId(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(aadFor(VAULT_VERSION, keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    alg: ALG,
    keyId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decodeExact(value: unknown, bytes: number, name: string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (buf.length !== bytes) throw new VaultError(`vault file has a malformed ${name}`);
  return buf;
}

/** Check the header, then decrypt. Throws VaultError with a safe message on any failure. */
export function openEnvelope(key: Buffer, envelope: unknown): Buffer {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new VaultError('not a drawlatch vault file');
  }
  const env = envelope as Record<string, unknown>;
  if (env.format !== VAULT_FORMAT) throw new VaultError('not a drawlatch vault file');
  const version = env.version;
  if (typeof version === 'number' && version > VAULT_VERSION) {
    throw new VaultError(`vault file version ${version} is newer than this drawlatch`);
  }
  if (version !== VAULT_VERSION) throw new VaultError('vault file has an unsupported version');
  if (env.alg !== ALG) throw new VaultError('vault file uses an unsupported algorithm');
  const ours = computeKeyId(key);
  if (env.keyId !== ours) {
    const theirs = typeof env.keyId === 'string' ? env.keyId.slice(0, 32) : '(none)';
    throw new VaultError(
      `vault file was written with key id ${theirs}, but the vault key has key id ${ours}; ` +
        'restore the matching key',
    );
  }
  const iv = decodeExact(env.iv, IV_BYTES, 'iv');
  const tag = decodeExact(env.tag, TAG_BYTES, 'tag');
  if (typeof env.ciphertext !== 'string') throw new VaultError('vault file has no ciphertext');
  try {
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAAD(aadFor(version, ours));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new VaultError('vault file failed authentication: it was modified or is corrupt');
  }
}

/** Read and check a key file: owner-only mode, one base64 line of KEY_BYTES bytes. */
export function readKeyFile(file: string, label: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const mode = fs.fstatSync(fd).mode & 0o777;
    if (mode & 0o077) {
      throw new VaultError(
        `${label} is readable by group or others (mode 0${mode.toString(8)}); ` +
          `run: chmod 600 ${label}`,
      );
    }
    const text = fs.readFileSync(fd, 'utf8').trim();
    const key = Buffer.from(text, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== text) {
      throw new VaultError(`${label} is not a base64 ${KEY_BYTES}-byte key`);
    }
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create a new random key file with O_EXCL (mode 0600, fsync'd with its
 * directory). If another writer won the race, read and return its key.
 */
export function createKeyFile(file: string, label: string): { key: Buffer; created: boolean } {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const key = crypto.randomBytes(KEY_BYTES);
  let fd: number;
  try {
    const { O_CREAT, O_EXCL, O_WRONLY } = fs.constants;
    fd = fs.openSync(file, O_CREAT | O_EXCL | O_WRONLY, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return { key: readKeyFile(file, label), created: false };
  }
  try {
    fs.writeSync(fd, `${key.toString('base64')}\n`);
    fs.fsyncSync(fd);
    // open()'s mode is umask-filtered; make it exactly 0600.
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(dir);
  return { key, created: true };
}

export { fsyncDir };
