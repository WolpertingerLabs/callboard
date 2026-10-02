/**
 * Storage service — the key-catalogued blob store behind `/api/storage` and the
 * `*_storage_*` tools.
 *
 *   DATA_DIR/storage/<key>/meta.json            StorageKeyMetaFile
 *   DATA_DIR/storage/<key>/items/<name>~<hex>   raw bytes (meta's `file`; legacy items: items/<name>)
 *
 * **This module is the traversal chokepoint.** Routes and tools may validate
 * too, but every path this service builds goes through {@link assertStorageKey}
 * / {@link assertItemName} first, and every resolved directory is re-checked by
 * realpath to sit where it should (a symlinked key or items directory is
 * refused, not followed). Items are flat — there is no way to name a
 * subdirectory, so there is nothing to walk out of.
 *
 * **meta.json is the commit point.** A save writes the new bytes to a fresh,
 * never-before-used file, then atomically replaces meta.json to point at it,
 * and only then removes the previous file (fsynced in that order, so it holds
 * across a power loss too — see "Atomic, durable writes"). A failure (or crash) at any step
 * before the meta rename leaves the previous committed state exactly as it
 * was; after it, at worst an unreferenced file is left behind. Unreferenced
 * files are removed by {@link sweepUnreferenced} at the start of the key's next
 * mutation, so they never outlive it — and they are never counted against the
 * limits, which are computed from meta.
 *
 * Every mutation of one key runs on that key's promise chain, so two
 * concurrent saves cannot lose each other's meta entry. Limits are checked
 * before any bytes land on disk. Reads are not serialized: they resolve the
 * file from meta and open it, retrying once if a concurrent save removed it
 * between the two.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  STORAGE_ITEM_NAME_PATTERN,
  STORAGE_KEY_PATTERN,
  STORAGE_MAX_ITEM_BYTES,
  STORAGE_MAX_ITEMS_PER_KEY,
  STORAGE_MAX_KEY_BYTES,
  STORAGE_MAX_STORE_BYTES,
} from "shared/types/index.js";
import type { StorageItem, StorageItemRecord, StorageKeyDetail, StorageKeyMetaFile, StorageKeySummary } from "shared/types/index.js";
import { ARTIFACT_ID_PATTERN, applyStorageKeyArtifactsDelta, normalizeStorageKeyArtifactIds, normalizeStorageKeyArtifacts } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("storage-service");

export { STORAGE_MAX_ITEM_BYTES, STORAGE_MAX_KEY_BYTES, STORAGE_MAX_STORE_BYTES, STORAGE_MAX_ITEMS_PER_KEY };

export const STORAGE_ROOT = path.join(DATA_DIR, "storage");

/** Max length of a key description. */
export const STORAGE_MAX_DESCRIPTION = 2000;

// ── Errors ───────────────────────────────────────────────────────────

export type StorageErrorCode = "invalid" | "not_found" | "conflict" | "limit";

/** A caller-facing failure. `code` maps to an HTTP status in the routes. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** HTTP status for a {@link StorageErrorCode}. Shared by the storage and artifact routes. */
export function httpStatusFor(code: StorageErrorCode): number {
  return code === "invalid" ? 400 : code === "not_found" ? 404 : code === "conflict" ? 409 : 413;
}

// ── Validation (the chokepoint) ──────────────────────────────────────

function quote(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value.length > 80 ? value.slice(0, 80) + "…" : value) : typeof value;
}

/** Throws unless `key` is a valid storage key. */
export function assertStorageKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key === "." || key === ".." || !STORAGE_KEY_PATTERN.test(key)) {
    throw new StorageError("invalid", `Invalid storage key ${quote(key)}: must match ${STORAGE_KEY_PATTERN.source}`);
  }
}

/** Throws unless `name` is a valid item name. */
export function assertItemName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name === "." || name === ".." || !STORAGE_ITEM_NAME_PATTERN.test(name)) {
    throw new StorageError("invalid", `Invalid item name ${quote(name)}: must match ${STORAGE_ITEM_NAME_PATTERN.source}`);
  }
}

export function isValidStorageKey(key: unknown): key is string {
  try {
    assertStorageKey(key);
    return true;
  } catch {
    return false;
  }
}

export function isValidItemName(name: unknown): name is string {
  try {
    assertItemName(name);
    return true;
  } catch {
    return false;
  }
}

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Normalize an explicit MIME type (parameters are dropped), or throw. */
function normalizeMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (!MIME_PATTERN.test(base)) throw new StorageError("invalid", `Invalid MIME type ${quote(mimeType)}`);
  return base;
}

const EXTENSION_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".ndjson": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** MIME type implied by a file name's extension, if known. */
export function sniffMimeType(name: string): string | undefined {
  return EXTENSION_MIME[path.extname(name).toLowerCase()];
}

/** Explicit MIME type → extension sniff → `application/octet-stream`. */
export function resolveMimeType(name: string, explicit?: string): string {
  if (explicit) return normalizeMimeType(explicit);
  return sniffMimeType(name) ?? "application/octet-stream";
}

// ── Paths ────────────────────────────────────────────────────────────

const keyDir = (key: string) => path.join(STORAGE_ROOT, key);
const metaPath = (key: string) => path.join(keyDir(key), "meta.json");
const itemsDir = (key: string) => path.join(keyDir(key), "items");

function realRoot(): string {
  mkdirSync(STORAGE_ROOT, { recursive: true });
  return realpathSync(STORAGE_ROOT);
}

/**
 * Belt and braces behind the regexes: the key dir and its items dir must be
 * real directories (not symlinks) whose realpath is exactly where the key says.
 */
function assertContainedKeyDir(key: string): void {
  const root = realRoot();
  for (const [dir, expected] of [
    [keyDir(key), path.join(root, key)],
    [itemsDir(key), path.join(root, key, "items")],
  ] as const) {
    if (!existsSync(dir)) continue;
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== expected) {
      throw new StorageError("invalid", `Storage path for key "${key}" escapes the store`);
    }
  }
}

const BLOB_SUFFIX = /^~[0-9a-f]{16}$/;

/** A fresh blob file name for item `name`. `~` is outside the item-name alphabet, so it can never collide with a legacy `items/<name>`. */
function newBlobName(name: string): string {
  return `${name}~${randomBytes(8).toString("hex")}`;
}

/** The file under items/ that holds `name`'s bytes, per its record — or null when the record names any other file (corrupt; never followed). */
function blobNameOrNull(name: string, record: StorageItemRecord): string | null {
  if (record.file === undefined) return name;
  if (typeof record.file !== "string" || !record.file.startsWith(name) || !BLOB_SUFFIX.test(record.file.slice(name.length))) return null;
  return record.file;
}

/** {@link blobNameOrNull}, throwing on a corrupt record — for reads, which have nothing safe to fall back to. */
function blobNameOf(name: string, record: StorageItemRecord): string {
  const blob = blobNameOrNull(name, record);
  if (blob === null) throw new Error(`Corrupt storage meta: item "${name}" points at "${String(record.file)}"`);
  return blob;
}

/** Could `fileName` under items/ hold the bytes of item `name` (its legacy file, or any of its `~<hex>` blobs)? */
function mayBelongTo(fileName: string, name: string): boolean {
  return fileName === name || (fileName.startsWith(`${name}~`) && BLOB_SUFFIX.test(fileName.slice(name.length)));
}

/**
 * Absolute path of a file directly under the key's items/ dir, after
 * containment checks. Does not require the file to exist; if it does, it must
 * be a regular file (not a symlink) whose realpath is in that dir.
 */
function containedItemsFile(key: string, fileName: string): string {
  assertContainedKeyDir(key);
  const file = path.join(itemsDir(key), fileName);
  if (path.dirname(file) !== itemsDir(key)) throw new StorageError("invalid", "Item path escapes its key");
  if (existsSync(file)) {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new StorageError("invalid", `Item file "${fileName}" is not a regular file`);
    if (path.dirname(realpathSync(file)) !== path.join(realRoot(), key, "items")) {
      throw new StorageError("invalid", "Item path escapes its key");
    }
  }
  return file;
}

// ── Atomic, durable writes ───────────────────────────────────────────
//
// "meta is the commit point" has to hold across a power loss, not just a
// process crash: without fsync the kernel may persist the meta rename before
// the new blob's bytes (committed meta → a blob of zeros or a missing file)
// or the old blob's unlink before the rename (meta → a file already gone).
// So: the new file's data is fsynced before it is renamed or referenced, the
// directory holding a new name is fsynced before anything depends on that
// name, and meta's directory is fsynced after the rename, before the previous
// blob is removed. A handful of fsyncs per save; the store is not hot.

/** Write a new file (`wx`) and fsync its data before returning (fsync flushes the inode, whichever descriptor asks). */
export function writeFileDurableSync(file: string, data: string | Buffer): void {
  writeFileSync(file, data, { flag: "wx" });
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * fsync a directory so the names created or removed in it are durable. Best
 * effort: some platforms (Windows) cannot open a directory for fsync, and
 * there it is skipped — the ordering then holds for process crashes only.
 */
export function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* not supported here */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write `data` to `target` via a pid-suffixed dot-prefixed tmp file + rename,
 * durably (tmp fsynced before the rename, the directory after). The tmp is
 * unlinked on failure; one orphaned by a crash matches {@link STALE_TMP_RE}.
 */
export function atomicWriteFileSync(target: string, data: string | Buffer): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileDurableSync(tmp, data);
    renameSync(tmp, target);
    fsyncDirSync(path.dirname(target));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

// ── Per-key serialization ────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier mutation of the same chain id has settled. */
export function serialize<T>(chainId: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = chains.get(chainId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  chains.set(chainId, tail);
  void tail.then(() => {
    if (chains.get(chainId) === tail) chains.delete(chainId);
  });
  return next;
}

/**
 * Bytes promised to in-flight saves on other keys. The store-wide limit spans
 * keys, and per-key chains do not serialize across keys, so each save reserves
 * its size here for the duration of its write.
 *
 * Today this is always 0 when read: a save's limit check and its writes run in
 * one synchronous stretch (no `await` between them), so no other save can
 * interleave. It is correct only for as long as that stays true — if the
 * check and the write are ever split by an `await` (async fs, streaming), the
 * reservation has to be taken in the same synchronous step as the check, as
 * it is below, and released only after meta is committed.
 */
let reservedBytes = 0;

// ── Meta ─────────────────────────────────────────────────────────────

function readMeta(key: string): StorageKeyMetaFile {
  assertContainedKeyDir(key);
  if (!existsSync(metaPath(key))) throw new StorageError("not_found", `Storage key not found: ${key}`);
  const meta = JSON.parse(readFileSync(metaPath(key), "utf-8")) as StorageKeyMetaFile;
  if (!meta || typeof meta !== "object" || typeof meta.items !== "object" || meta.items === null) {
    throw new Error(`Corrupt storage meta for key "${key}"`);
  }
  return meta;
}

function writeMeta(key: string, meta: StorageKeyMetaFile): void {
  atomicWriteFileSync(metaPath(key), JSON.stringify(meta, null, 2));
}

function totalSize(meta: StorageKeyMetaFile): number {
  let total = 0;
  for (const item of Object.values(meta.items)) total += item.size;
  return total;
}

/**
 * The key's artifact list as recorded. A meta written before the field existed
 * has none; a malformed field (not an array) counts as none and malformed
 * entries are dropped — this list only ever grants by inclusion, so reading
 * too little fails closed.
 */
function artifactsOf(meta: StorageKeyMetaFile): string[] {
  if (!Array.isArray(meta.artifacts)) return [];
  return meta.artifacts.filter((id, i, all): id is string => typeof id === "string" && ARTIFACT_ID_PATTERN.test(id) && all.indexOf(id) === i);
}

function summarize(meta: StorageKeyMetaFile): StorageKeySummary {
  return {
    key: meta.key,
    ...(meta.description ? { description: meta.description } : {}),
    artifacts: artifactsOf(meta),
    itemCount: Object.keys(meta.items).length,
    totalSize: totalSize(meta),
    created: meta.created,
    updated: meta.updated,
  };
}

/** The public view of one record — never the blob file name. */
function publicItem(name: string, record: StorageItemRecord): StorageItem {
  const { file: _file, ...item } = record;
  return { name, ...item };
}

function itemsOf(meta: StorageKeyMetaFile): StorageItem[] {
  return Object.keys(meta.items)
    .sort()
    .map((name) => publicItem(name, meta.items[name]));
}

/** Best-effort removal of a file meta no longer references; a failure is left for the next sweep. */
function removeUnreferenced(key: string, fileName: string): void {
  try {
    rmSync(path.join(itemsDir(key), fileName), { force: true });
  } catch (err) {
    log.warn(`Could not remove unreferenced ${key}/items/${fileName} (will retry on the key's next mutation): ${(err as Error).message}`);
  }
}

/** A meta.json tmp file {@link atomicWriteFileSync} left behind (crash between write and rename). */
const STALE_TMP_RE = /^\.meta\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
/** Old enough that no live write (of any process sharing the data dir) can still own it. */
export const STALE_TMP_AGE_MS = 10 * 60 * 1000;

/**
 * Remove every entry of the key's items/ dir that meta does not reference —
 * a blob whose save failed or crashed before its meta commit, the previous
 * blob of an overwrite that crashed before its cleanup, a tmp file — and any
 * meta.json tmp file in the key dir older than {@link STALE_TMP_AGE_MS}. Runs
 * at the start of each mutation of the key (on its chain, so nothing in flight
 * for this key can be swept). Best effort: a file that will not go is retried
 * next time. Returns the names removed.
 *
 * A record whose `file` is corrupt does not stop the sweep (or the key): it is
 * skipped, and every file that could be its bytes is kept, so the item can
 * still be deleted or overwritten — after which those files are unreferenced
 * and the next sweep takes them.
 */
export function sweepUnreferenced(key: string, meta: StorageKeyMetaFile): string[] {
  assertContainedKeyDir(key);
  const removed: string[] = [];
  if (existsSync(keyDir(key))) {
    const cutoff = Date.now() - STALE_TMP_AGE_MS;
    for (const entry of readdirSync(keyDir(key), { withFileTypes: true })) {
      if (!entry.isFile() || !STALE_TMP_RE.test(entry.name)) continue;
      try {
        if (lstatSync(path.join(keyDir(key), entry.name)).mtimeMs > cutoff) continue;
        unlinkSync(path.join(keyDir(key), entry.name));
        removed.push(entry.name);
      } catch {
        /* retried next time */
      }
    }
  }
  if (!existsSync(itemsDir(key))) return removed;
  const referenced = new Set<string>();
  const corrupt: string[] = [];
  for (const [name, record] of Object.entries(meta.items)) {
    const blob = blobNameOrNull(name, record);
    if (blob === null) corrupt.push(name);
    else referenced.add(blob);
  }
  if (corrupt.length) log.warn(`Storage key "${key}" has corrupt item records (${corrupt.join(", ")}); keeping their files, sweeping the rest`);
  for (const entry of readdirSync(itemsDir(key), { withFileTypes: true })) {
    if (referenced.has(entry.name) || !(entry.isFile() || entry.isSymbolicLink())) continue;
    if (corrupt.some((name) => mayBelongTo(entry.name, name))) continue;
    try {
      unlinkSync(path.join(itemsDir(key), entry.name));
      removed.push(entry.name);
    } catch {
      /* retried on the next mutation */
    }
  }
  return removed;
}

function validateDescription(description: unknown): string | undefined {
  if (description === undefined || description === null) return undefined;
  if (typeof description !== "string") throw new StorageError("invalid", "description must be a string");
  if (description.length > STORAGE_MAX_DESCRIPTION) {
    throw new StorageError("invalid", `description too long (max ${STORAGE_MAX_DESCRIPTION} characters)`);
  }
  return description.trim() || undefined;
}

function validateArtifacts(artifacts: unknown): string[] | undefined {
  if (artifacts === undefined) return undefined;
  const result = normalizeStorageKeyArtifacts(artifacts);
  if (!result.ok) throw new StorageError("invalid", result.reason);
  return result.artifacts;
}

/** The add/remove delta, validated; undefined when neither side is given. An id on both sides is ambiguous. */
function validateArtifactsDelta(add: unknown, remove: unknown): { add: string[]; remove: string[] } | undefined {
  if (add === undefined && remove === undefined) return undefined;
  const sides = { add: [] as string[], remove: [] as string[] };
  for (const [side, value, field] of [["add", add, "artifacts to add"], ["remove", remove, "artifacts to remove"]] as const) {
    if (value === undefined) continue;
    const result = normalizeStorageKeyArtifactIds(value, field);
    if (!result.ok) throw new StorageError("invalid", result.reason);
    sides[side] = result.ids;
  }
  const both = sides.add.find((id) => sides.remove.includes(id));
  if (both) throw new StorageError("invalid", `artifact id ${JSON.stringify(both)} is both added and removed`);
  return sides;
}

/** Every key's meta that parses. Directories that are not valid keys, or have no meta, are skipped. */
function allMetas(): StorageKeyMetaFile[] {
  if (!existsSync(STORAGE_ROOT)) return [];
  const metas: StorageKeyMetaFile[] = [];
  for (const entry of readdirSync(STORAGE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidStorageKey(entry.name)) continue;
    try {
      metas.push(readMeta(entry.name));
    } catch {
      /* not a key, or unreadable — not listed */
    }
  }
  return metas;
}

/** Total bytes recorded across the whole store. */
export function storeTotalBytes(): number {
  return allMetas().reduce((sum, meta) => sum + totalSize(meta), 0);
}

// ── Public API: keys ─────────────────────────────────────────────────

export function listStorageKeys(): StorageKeySummary[] {
  return allMetas()
    .map(summarize)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function storageKeyExists(key: string): boolean {
  assertStorageKey(key);
  assertContainedKeyDir(key);
  return existsSync(metaPath(key));
}

export function getStorageKey(key: string): StorageKeyDetail {
  assertStorageKey(key);
  const meta = readMeta(key);
  return { ...summarize(meta), items: itemsOf(meta) };
}

/**
 * The ids of the artifacts `key` binds (see `artifacts` on StorageKeyMetaFile)
 * — only meta is read, not the item list. Throws not_found for a missing key.
 */
export function getStorageKeyArtifacts(key: string): string[] {
  assertStorageKey(key);
  return artifactsOf(readMeta(key));
}

function createKeySync(key: string, description?: string, artifacts?: string[]): StorageKeyDetail {
  assertContainedKeyDir(key);
  if (existsSync(metaPath(key))) throw new StorageError("conflict", `Storage key already exists: ${key}`);
  mkdirSync(itemsDir(key), { recursive: true });
  assertContainedKeyDir(key);
  const now = new Date().toISOString();
  const meta: StorageKeyMetaFile = {
    version: 1,
    key,
    ...(description ? { description } : {}),
    ...(artifacts?.length ? { artifacts } : {}),
    created: now,
    updated: now,
    items: {},
  };
  writeMeta(key, meta);
  return { ...summarize(meta), items: [] };
}

/** `artifacts`: ids of the artifacts designed for the key (validated: artifact-id shaped, deduplicated, ≤ STORAGE_KEY_MAX_ARTIFACTS). */
export async function createStorageKey(key: string, description?: string, artifacts?: unknown): Promise<StorageKeyDetail> {
  assertStorageKey(key);
  const desc = validateDescription(description);
  const list = validateArtifacts(artifacts);
  return serialize(`storage:${key}`, () => createKeySync(key, desc, list));
}

/**
 * Change a key's metadata. A field left undefined is untouched; an empty
 * description clears it. The list changes either by delta — `addArtifacts` /
 * `removeArtifacts`, applied on the key's chain to the list as stored then, so
 * concurrent editors each land their own change — or by `artifacts`, which
 * replaces the whole list (`[]` ⇒ the key binds no artifact). The two forms are
 * mutually exclusive. Callers are the user (REST) and agents (tools) — never
 * an artifact: the bridge has no key-level operation.
 */
export async function updateStorageKey(
  key: string,
  patch: { description?: unknown; artifacts?: unknown; addArtifacts?: unknown; removeArtifacts?: unknown },
): Promise<StorageKeyDetail> {
  assertStorageKey(key);
  const changeDescription = patch.description !== undefined;
  const desc = validateDescription(patch.description);
  const list = validateArtifacts(patch.artifacts);
  const delta = validateArtifactsDelta(patch.addArtifacts, patch.removeArtifacts);
  if (list !== undefined && delta) throw new StorageError("invalid", "artifacts replaces the whole list; it cannot be combined with artifacts to add or remove");
  return serialize(`storage:${key}`, () => {
    const meta = readMeta(key);
    if (changeDescription) {
      if (desc) meta.description = desc;
      else delete meta.description;
    }
    let next = list;
    if (delta) {
      const applied = applyStorageKeyArtifactsDelta(artifactsOf(meta), delta.add, delta.remove);
      if (!applied.ok) throw new StorageError("invalid", applied.reason);
      next = applied.artifacts;
    }
    if (next !== undefined) {
      if (next.length) meta.artifacts = next;
      else delete meta.artifacts;
    }
    meta.updated = new Date().toISOString();
    writeMeta(key, meta);
    return { ...summarize(meta), items: itemsOf(meta) };
  });
}

export async function deleteStorageKey(key: string): Promise<void> {
  assertStorageKey(key);
  return serialize(`storage:${key}`, () => {
    readMeta(key); // not_found / containment
    rmSync(keyDir(key), { recursive: true, force: true });
  });
}

// ── Public API: items ────────────────────────────────────────────────

export function listStorageItems(key: string): StorageItem[] {
  assertStorageKey(key);
  return itemsOf(readMeta(key));
}

/** An item's meta plus the absolute path of the file holding its bytes. */
export function getStorageItem(key: string, name: string): StorageItem & { filePath: string } {
  assertStorageKey(key);
  assertItemName(name);
  const meta = readMeta(key);
  const record = Object.prototype.hasOwnProperty.call(meta.items, name) ? meta.items[name] : undefined;
  if (!record) throw new StorageError("not_found", `Item not found: ${key}/${name}`);
  const filePath = containedItemsFile(key, blobNameOf(name, record));
  if (!existsSync(filePath)) throw new StorageError("not_found", `Item not found: ${key}/${name}`);
  return { ...publicItem(name, record), filePath };
}

/** An open item: its meta, its file, an fd, and the size of what that fd actually holds. The caller closes `fd`. */
export interface OpenStorageItem {
  item: StorageItem;
  filePath: string;
  fd: number;
  /** From fstat of `fd` — the bytes a reader will get, whatever meta says. */
  size: number;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Resolve and open an item for reading. Reads are not serialized with saves,
 * so a concurrent overwrite can remove the file between resolving it from meta
 * and opening it; that is retried once against the fresh meta. Once open, the
 * fd keeps the bytes readable even if the file is then removed.
 */
export function openStorageItem(key: string, name: string): OpenStorageItem {
  for (let attempt = 0; ; attempt++) {
    const { filePath, ...item } = getStorageItem(key, name);
    let fd: number;
    try {
      fd = openSync(filePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (attempt === 0) continue;
        throw new StorageError("not_found", `Item not found: ${key}/${name}`);
      }
      throw err;
    }
    try {
      return { item, filePath, fd, size: fstatSync(fd).size };
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }
}

export function readStorageItemBytes(key: string, name: string): { item: StorageItem; filePath: string; data: Buffer } {
  const { item, filePath, fd } = openStorageItem(key, name);
  try {
    return { item, filePath, data: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

export interface SaveStorageItemOptions {
  mimeType?: string;
  /** Create the key if it does not exist (otherwise a missing key is not_found). */
  createKey?: boolean;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Create or overwrite one item. Limits are checked before any bytes are
 * written; meta is committed before the previous bytes are touched (see the
 * module doc), so a failure leaves the previous state intact.
 */
export async function saveStorageItem(key: string, name: string, data: Buffer, opts: SaveStorageItemOptions = {}): Promise<StorageItem> {
  assertStorageKey(key);
  assertItemName(name);
  const mimeType = resolveMimeType(name, opts.mimeType);
  if (data.length > STORAGE_MAX_ITEM_BYTES) {
    throw new StorageError("limit", `Item too large (${formatMb(data.length)}); the per-item limit is ${formatMb(STORAGE_MAX_ITEM_BYTES)}`);
  }

  return serialize(`storage:${key}`, () => {
    if (opts.createKey && !existsSync(metaPath(key))) createKeySync(key);
    const meta = readMeta(key);
    const existing = Object.prototype.hasOwnProperty.call(meta.items, name) ? meta.items[name] : undefined;

    if (!existing) {
      const lower = name.toLowerCase();
      const clash = Object.keys(meta.items).find((other) => other.toLowerCase() === lower);
      if (clash) {
        throw new StorageError(
          "conflict",
          `Key "${key}" already has an item named "${clash}"; item names in one key may not differ only by case (save to "${clash}" to overwrite it)`,
        );
      }
    }
    if (!existing && Object.keys(meta.items).length >= STORAGE_MAX_ITEMS_PER_KEY) {
      throw new StorageError("limit", `Key "${key}" already holds ${STORAGE_MAX_ITEMS_PER_KEY} items (the per-key item limit)`);
    }
    const keyAfter = totalSize(meta) - (existing?.size ?? 0) + data.length;
    if (keyAfter > STORAGE_MAX_KEY_BYTES) {
      throw new StorageError("limit", `Key "${key}" would hold ${formatMb(keyAfter)}; the per-key limit is ${formatMb(STORAGE_MAX_KEY_BYTES)}`);
    }
    const storeAfter = storeTotalBytes() + reservedBytes - (existing?.size ?? 0) + data.length;
    if (storeAfter > STORAGE_MAX_STORE_BYTES) {
      throw new StorageError("limit", `The store would hold ${formatMb(storeAfter)}; the whole-store limit is ${formatMb(STORAGE_MAX_STORE_BYTES)}`);
    }

    sweepUnreferenced(key, meta);
    // A corrupt previous record has no file we trust to remove; its bytes are swept once this commit unreferences them.
    const previousBlob = existing ? (blobNameOrNull(name, existing) ?? undefined) : undefined;
    const blob = newBlobName(name);
    const blobPath = containedItemsFile(key, blob);

    reservedBytes += data.length;
    try {
      mkdirSync(itemsDir(key), { recursive: true });
      try {
        // 1. The bytes, under a name nothing references yet — durable, name included, before meta can point at them.
        writeFileDurableSync(blobPath, data);
        fsyncDirSync(itemsDir(key));
        // 2. The commit: meta now points at the new file.
        const now = new Date().toISOString();
        meta.items[name] = {
          mimeType,
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
          created: existing?.created ?? now,
          updated: now,
          file: blob,
        };
        meta.updated = now;
        writeMeta(key, meta);
      } catch (err) {
        // Not committed: the previous meta and bytes are untouched. The new file is ours to drop.
        rmSync(blobPath, { force: true });
        throw err;
      }
    } finally {
      reservedBytes -= data.length;
    }
    // 3. Committed; the previous bytes are unreferenced. If this fails, the next sweep takes them —
    //    the save itself has succeeded and must not report otherwise.
    if (previousBlob !== undefined) removeUnreferenced(key, previousBlob);
    return publicItem(name, meta.items[name]);
  });
}

/**
 * Save from a local file. Same checks as `render_file`: absolute, no NUL,
 * realpath'd, a regular file, within the item limit — checked before reading.
 */
export async function saveStorageItemFromFile(key: string, name: string, sourcePath: string, opts: SaveStorageItemOptions = {}): Promise<StorageItem> {
  assertStorageKey(key);
  assertItemName(name);
  const resolved = resolveSourcePath(sourcePath, STORAGE_MAX_ITEM_BYTES);
  return saveStorageItem(key, name, readFileSync(resolved), { ...opts, mimeType: opts.mimeType ?? sniffMimeType(name) ?? sniffMimeType(resolved) });
}

export async function deleteStorageItem(key: string, name: string): Promise<void> {
  assertStorageKey(key);
  assertItemName(name);
  return serialize(`storage:${key}`, () => {
    const meta = readMeta(key);
    if (!Object.prototype.hasOwnProperty.call(meta.items, name)) throw new StorageError("not_found", `Item not found: ${key}/${name}`);
    sweepUnreferenced(key, meta);
    // A corrupt record names no file we trust; drop the entry and let the next sweep take its bytes.
    const blob = blobNameOrNull(name, meta.items[name]);
    const file = blob === null ? null : containedItemsFile(key, blob);
    delete meta.items[name];
    meta.updated = new Date().toISOString();
    writeMeta(key, meta);
    // Committed; the file is unreferenced now. Best effort — the next mutation sweeps it otherwise.
    if (file !== null) removeUnreferenced(key, path.basename(file));
  });
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strictly decode base64 (whitespace tolerated), or throw. */
export function decodeBase64Strict(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!BASE64.test(compact)) throw new StorageError("invalid", "content_base64 is not valid base64");
  return Buffer.from(compact, "base64");
}

// ── source_path ──────────────────────────────────────────────────────

/**
 * Validate a caller-supplied local file for reading: absolute, no NUL, exists,
 * realpath'd, a regular file, at most `maxBytes`. Returns the realpath.
 */
export function resolveSourcePath(sourcePath: string, maxBytes: number): string {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw new StorageError("invalid", "source_path must be an absolute path");
  if (sourcePath.includes("\0")) throw new StorageError("invalid", "Invalid source_path");
  if (!existsSync(sourcePath)) throw new StorageError("not_found", `File not found: ${sourcePath}`);
  const resolved = realpathSync(sourcePath);
  const st = statSync(resolved);
  if (!st.isFile()) throw new StorageError("invalid", "source_path is not a regular file");
  if (st.size > maxBytes) throw new StorageError("limit", `File too large (${formatMb(st.size)}, max ${formatMb(maxBytes)})`);
  return resolved;
}
