/**
 * The vault document: load, cache, and atomic save.
 *
 * This is the only module that names the vault files:
 *
 *   <config dir>/vault.enc.json   AES-256-GCM envelope over one JSON document
 *   <config dir>/keys/vault.key   32-byte key, base64, mode 0600
 *
 * Everything is synchronous (like saveRemoteConfig), so a read-modify-write
 * in mutateVault() can't interleave with another one on the main thread and
 * needs no lock. One daemon per config dir, which the PID file enforces.
 *
 * The key is created on the first write that succeeds validation, and never
 * while a vault file exists: a missing key with a vault file is an error that
 * every vault operation reports, because a new key would orphan the data.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigDir, getKeysDir } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import {
  KeyModeError,
  VaultError,
  computeKeyId,
  createKeyFile,
  fsyncDir,
  openEnvelope,
  readFailure,
  readKeyFile,
  sealDocument,
} from './crypto.js';

const log = createLogger('vault');

const VAULT_FILE = 'vault.enc.json';
const KEY_FILE = 'vault.key';
/** Paths as shown in messages: relative to the config dir. */
export const VAULT_FILE_LABEL = VAULT_FILE;
export const VAULT_KEY_LABEL = `keys/${KEY_FILE}`;

/** Ceiling on the serialized (plaintext) document. */
export const MAX_VAULT_BYTES = 32 * 1024 * 1024;
/** Ceiling on the file read from disk (base64 of MAX_VAULT_BYTES plus the header). */
const MAX_VAULT_FILE_BYTES = Math.ceil((MAX_VAULT_BYTES * 4) / 3) + 64 * 1024;

export const MISSING_KEY_MESSAGE =
  `Vault key ${VAULT_KEY_LABEL} is missing; restore it from backup. ` +
  "The vault file can't be read without it.";

// ── Document schema ────────────────────────────────────────────────────────

export type ItemKind = 'password' | 'token' | 'note' | 'key-value';
export type Exposure = 'inject' | 'reveal';
export type Actor = 'agent' | 'admin';

export interface VaultItem {
  /** Stable across renames; grants and requests bind to it. */
  id: string;
  name: string;
  kind: ItemKind;
  exposure: Exposure;
  /** SECRET. Only field names ever leave the store. */
  values: Record<string, string>;
  /** Not secret: returned by vault_list. */
  notes?: string;
  tags: string[];
  metadata: Record<string, string>;
  /** Connection aliases this item may be injected on; absent = any. */
  connections?: string[];
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  valueUpdatedAt: string;
}

export type RequestStatus = 'pending' | 'granted' | 'denied' | 'cancelled' | 'withdrawn';

export interface AccessRequest {
  id: string;
  requester: string;
  owner: string;
  itemName: string;
  itemId: string | null;
  mode: Exposure;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  decidedAt?: string;
  decidedNote?: string;
  grantId?: string;
}

export interface Grant {
  id: string;
  owner: string;
  itemId: string;
  grantee: string;
  mode: Exposure;
  status: 'active' | 'revoked';
  requestId?: string;
  grantedAt: string;
  revokedAt?: string;
  revokedReason?: 'admin' | 'item_deleted' | 'caller_deleted';
}

export interface CallerVault {
  items: Record<string, VaultItem>;
}

export interface VaultDocument {
  schema: 1;
  /** Incremented on every write (diagnostics, optimistic concurrency). */
  revision: number;
  callers: Record<string, CallerVault>;
  requests: AccessRequest[];
  grants: Grant[];
}

export function emptyDocument(): VaultDocument {
  return {
    schema: 1,
    revision: 0,
    callers: Object.create(null) as Record<string, CallerVault>,
    requests: [],
    grants: [],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A null-prototype copy of a string-keyed map, so reserved keys stay plain data. */
function nullProtoMap<T>(v: unknown, each: (x: unknown) => T): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (!isPlainObject(v)) return out;
  for (const k of Object.keys(v)) out[k] = each(v[k]);
  return out;
}

const asString = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Parse decrypted JSON into a VaultDocument with null-prototype maps. */
function parseDocument(text: string): VaultDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError('vault document is not valid JSON');
  }
  if (!isPlainObject(raw) || raw.schema !== 1) {
    throw new VaultError('vault document has an unsupported schema');
  }
  const callers = nullProtoMap(raw.callers, (c) => ({
    items: nullProtoMap(isPlainObject(c) ? c.items : undefined, (i) => {
      const item = { ...(isPlainObject(i) ? i : {}) } as unknown as VaultItem;
      item.values = nullProtoMap(item.values, asString);
      item.metadata = nullProtoMap(item.metadata, asString);
      if (!Array.isArray(item.tags)) item.tags = [];
      return item;
    }),
  }));
  return {
    schema: 1,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    callers,
    requests: Array.isArray(raw.requests) ? (raw.requests as AccessRequest[]) : [],
    grants: Array.isArray(raw.grants) ? (raw.grants as Grant[]) : [],
  };
}

// ── Files ──────────────────────────────────────────────────────────────────

function vaultFile(): string {
  return path.join(getConfigDir(), VAULT_FILE);
}

function keyFile(): string {
  return path.join(getKeysDir(), KEY_FILE);
}

/** Whether a vault file exists (nothing is created by asking). */
export function vaultExists(): boolean {
  return fs.existsSync(vaultFile());
}

/** Load the key for a read: required when the vault file exists. */
function loadKey(): Buffer {
  if (!fs.existsSync(keyFile())) throw new VaultError(MISSING_KEY_MESSAGE);
  return readKeyFile(keyFile(), VAULT_KEY_LABEL);
}

/**
 * Load the key for a write, creating it only when no vault file exists yet:
 * never a new key next to an existing vault file, which would orphan its data.
 * Exported so that guard is tested on its own, not only behind loadText().
 */
export function ensureWriteKey(): Buffer {
  if (fs.existsSync(keyFile()) || vaultExists()) return loadKey();
  const { key, created } = createKeyFile(keyFile(), VAULT_KEY_LABEL);
  if (created) log.info(`Created vault key ${VAULT_KEY_LABEL} (key id ${computeKeyId(key)})`);
  return key;
}

// ── Cache ──────────────────────────────────────────────────────────────────

/** The decrypted document text, valid while the file's identity is unchanged. */
interface Cached {
  file: string;
  ino: number;
  size: number;
  mtimeMs: number;
  keyId: string;
  text: string;
}
let cache: Cached | undefined;

/** Forget the decrypted document (tests). */
export function resetVaultCache(): void {
  cache = undefined;
}

function sameFile(c: Cached, file: string, st: fs.Stats, keyId: string): boolean {
  return (
    c.file === file &&
    c.ino === st.ino &&
    c.size === st.size &&
    c.mtimeMs === st.mtimeMs &&
    c.keyId === keyId
  );
}

/** The current document text and key, or undefined text when no vault file exists. */
function loadText(): { text: string | undefined; key: Buffer | undefined } {
  const file = vaultFile();
  if (!fs.existsSync(file)) {
    cache = undefined;
    return { text: undefined, key: undefined };
  }
  // The key is read on every operation, so its loss is noticed at once.
  const key = loadKey();
  const keyId = computeKeyId(key);
  let st: fs.Stats;
  let raw: string | undefined;
  try {
    st = fs.statSync(file);
    if (cache && sameFile(cache, file, st, keyId)) return { text: cache.text, key };
    if (st.size > MAX_VAULT_FILE_BYTES) throw new VaultError('vault file is larger than 32 MiB');
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Node's messages carry the absolute path: report the code and relative name only.
    throw readFailure(err, VAULT_FILE_LABEL);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new VaultError(`${VAULT_FILE_LABEL} is not valid JSON`);
  }
  const text = openEnvelope(key, envelope).toString('utf8');
  cache = { file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, keyId, text };
  return { text, key };
}

/** A fresh copy of the vault document. An absent vault reads as empty and creates nothing. */
export function readVault(): VaultDocument {
  const { text } = loadText();
  return text === undefined ? emptyDocument() : parseDocument(text);
}

// ── Atomic write ───────────────────────────────────────────────────────────

const TMP_PREFIX = `${VAULT_FILE}.tmp-`;

/** Remove temp files a crashed write left behind. They hold only ciphertext. */
function sweepTemps(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Best effort; the next write tries again.
    }
  }
}

function writeAtomic(file: string, data: string): fs.Stats {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepTemps(dir);
  const tmp = path.join(
    dir,
    `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  const { O_CREAT, O_EXCL, O_WRONLY } = fs.constants;
  const fd = fs.openSync(tmp, O_CREAT | O_EXCL | O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Left for the next write's sweep.
    }
    throw err;
  }
  fsyncDir(dir);
  return fs.statSync(file);
}

/**
 * Read the document, apply `fn` to a copy, and write the result atomically
 * (revision + 1). If `fn` throws, nothing is written and no key is created.
 */
export function mutateVault<T>(fn: (doc: VaultDocument) => T): T {
  const { text, key: existingKey } = loadText();
  const doc = text === undefined ? emptyDocument() : parseDocument(text);
  const result = fn(doc);
  doc.revision += 1;
  const plaintext = JSON.stringify(doc);
  if (Buffer.byteLength(plaintext) > MAX_VAULT_BYTES) {
    throw new VaultError('vault would exceed its 32 MiB limit');
  }
  const file = vaultFile();
  try {
    const key = existingKey ?? ensureWriteKey();
    const envelope = sealDocument(key, Buffer.from(plaintext, 'utf8'));
    const st = writeAtomic(file, JSON.stringify(envelope) + '\n');
    cache = {
      file,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      keyId: envelope.keyId,
      text: plaintext,
    };
  } catch (err) {
    if (err instanceof VaultError) throw err;
    // fs errors carry absolute paths; the caller gets the code only.
    log.error('vault write failed:', err);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new VaultError(`vault write failed${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  return result;
}

// ── Diagnostics (drawlatch doctor) ─────────────────────────────────────────

export interface VaultCheck {
  label: string;
  ok: boolean;
  /** What to do when the check fails. */
  fix?: string;
  /** Extra detail for a passing check (never key material). */
  info?: string;
}

/** Health of the vault files, for `drawlatch doctor`. Creates nothing. */
export function vaultDiagnostics(): VaultCheck[] {
  const fileExists = vaultExists();
  const keyExists = fs.existsSync(keyFile());
  if (!fileExists && !keyExists) {
    return [{ label: 'Vault (not created yet)', ok: true }];
  }
  if (!keyExists) {
    return [{ label: `Vault key (${VAULT_KEY_LABEL})`, ok: false, fix: MISSING_KEY_MESSAGE }];
  }
  const checks: VaultCheck[] = [];
  let key: Buffer;
  try {
    key = readKeyFile(keyFile(), VAULT_KEY_LABEL);
  } catch (err) {
    // doctor is local CLI output, so the fix can name the full path and run from anywhere.
    const fix = err instanceof KeyModeError ? `run: chmod 600 ${keyFile()}` : safeMessage(err);
    return [{ label: `Vault key (${VAULT_KEY_LABEL})`, ok: false, fix }];
  }
  checks.push({
    label: `Vault key (${VAULT_KEY_LABEL})`,
    ok: true,
    info: `Key id: ${computeKeyId(key)}`,
  });
  if (!fileExists) return checks;
  try {
    const doc = readVault();
    const items = Object.values(doc.callers).reduce((n, c) => n + Object.keys(c.items).length, 0);
    checks.push({
      label: `Vault file decrypts (${VAULT_FILE_LABEL})`,
      ok: true,
      info: `${items} item(s), revision ${doc.revision}`,
    });
  } catch (err) {
    checks.push({
      label: `Vault file decrypts (${VAULT_FILE_LABEL})`,
      ok: false,
      fix: safeMessage(err),
    });
  }
  return checks;
}

function safeMessage(err: unknown): string {
  if (err instanceof VaultError) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return `could not read the vault${typeof code === 'string' ? ` (${code})` : ''}`;
}

export { VaultError };
