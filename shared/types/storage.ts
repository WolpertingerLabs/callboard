/**
 * Storage — a key-catalogued blob store agents and humans can both browse.
 *
 * A **key** is a named bucket; it holds flat, named **items** (no
 * subdirectories — hierarchy lives in the item name, e.g. `img-card-12.jpg`).
 *
 * On disk (see backend/src/services/storage-service.ts):
 *
 *   DATA_DIR/storage/<key>/meta.json            {@link StorageKeyMetaFile}
 *   DATA_DIR/storage/<key>/items/<name>~<hex>   raw bytes of item <name> (see {@link StorageItemRecord.file})
 *
 * **Which artifacts a key is for.** A key's `artifacts` lists the ids of the
 * artifacts designed to use it, and an artifact that is not on the list does
 * not bind to the key at all — no read, no write. A key with no list (absent
 * or empty) binds nothing. The list is metadata the user (Settings → Storage)
 * or an agent (`create_storage_key` / `update_storage_key`, REST) sets; an
 * artifact can never change it — the bridge has no key-level operation. It
 * only narrows: a listed artifact still gets no more than its declared
 * `storageAccess` and, outside chat, the per-browser write choice.
 *
 * These types are REST/tool shapes, not stream wire types — they deliberately
 * live outside `stream.ts`.
 */

import { ARTIFACT_ID_PATTERN } from "./artifact.js";

/** Key: lowercase slug. `.` and `..` are rejected separately (the regex alone admits them). */
export const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * Item name: no `/`, `\`, NUL or leading dot. `.` and `..` are rejected
 * separately. Case is preserved, but two names in one key may not differ only
 * by case (the service refuses the second) — on a case-insensitive filesystem
 * they would be one file.
 */
export const STORAGE_ITEM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True iff `key` is a valid storage key. The backend service is the enforcing chokepoint; clients use this to fail early. */
export function isValidStorageKey(key: unknown): key is string {
  return typeof key === "string" && key !== "." && key !== ".." && STORAGE_KEY_PATTERN.test(key);
}

/** True iff `name` is a valid item name. The backend service is the enforcing chokepoint; clients use this to fail early. */
export function isValidStorageItemName(name: unknown): name is string {
  return typeof name === "string" && name !== "." && name !== ".." && STORAGE_ITEM_NAME_PATTERN.test(name);
}

/**
 * Response header on `GET /api/storage/:key/items/:name` carrying the item's
 * RECORDED MIME type. The body's Content-Type is deliberately not that (every
 * non-raster, non-text item is served as application/octet-stream); this lets
 * a client that knows what it is doing — the artifact bridge's dataUrl read —
 * see the recorded type without trusting it for serving.
 */
export const STORAGE_ITEM_MIME_HEADER = "X-Callboard-Mime-Type";

/** Hard limits, enforced by the service before any bytes are written. */
export const STORAGE_MAX_ITEM_BYTES = 25 * 1024 * 1024;
export const STORAGE_MAX_KEY_BYTES = 250 * 1024 * 1024;
export const STORAGE_MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024;
export const STORAGE_MAX_ITEMS_PER_KEY = 5000;

/** The most artifact ids one key's `artifacts` list may hold. */
export const STORAGE_KEY_MAX_ARTIFACTS = 32;

/**
 * Whether a key whose list is `artifacts` binds `artifactId`. Strict: no list
 * (undefined or empty) binds nothing. Matching is by id.
 */
export function storageKeyBindsArtifact(artifacts: readonly string[] | undefined | null, artifactId: string): boolean {
  return Array.isArray(artifacts) && artifacts.includes(artifactId);
}

/**
 * The refusal when a key does not list an artifact — the same words from the
 * render_artifact tool, the chat bubble, the standalone page and the Settings
 * preview, naming the fix.
 */
export function storageKeyBindingRefusal(storageKey: string, artifactId: string): string {
  return (
    `storage key "${storageKey}" is not designed for artifact "${artifactId}", so the artifact is not bound to it — ` +
    `add "${artifactId}" to storage key "${storageKey}"'s artifacts via update_storage_key or Settings → Storage`
  );
}

/**
 * Validate and normalise an `artifacts` list for a key: an array of artifact
 * ids ({@link ARTIFACT_ID_PATTERN}), deduplicated in order, at most
 * {@link STORAGE_KEY_MAX_ARTIFACTS}. Returns the list, or a reason it is
 * invalid. Ids that name no existing artifact are allowed (shown as missing).
 */
export function normalizeStorageKeyArtifacts(value: unknown): { ok: true; artifacts: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "artifacts must be an array of artifact ids" };
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !ARTIFACT_ID_PATTERN.test(id)) {
      return { ok: false, reason: `invalid artifact id in artifacts: ${JSON.stringify(id)} (must match ${ARTIFACT_ID_PATTERN})` };
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > STORAGE_KEY_MAX_ARTIFACTS) return { ok: false, reason: `too many artifacts (max ${STORAGE_KEY_MAX_ARTIFACTS} per key)` };
  return { ok: true, artifacts: out };
}

/**
 * Validate one side of an `artifacts` delta (`addArtifacts` / `removeArtifacts`
 * on REST, `add_artifacts` / `remove_artifacts` on the tool): an array of
 * artifact ids, deduplicated in order. No cap here — the cap applies to the
 * list that results once the delta is applied ({@link applyStorageKeyArtifactsDelta}).
 */
export function normalizeStorageKeyArtifactIds(value: unknown, field: string): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: `${field} must be an array of artifact ids` };
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !ARTIFACT_ID_PATTERN.test(id)) {
      return { ok: false, reason: `invalid artifact id in ${field}: ${JSON.stringify(id)} (must match ${ARTIFACT_ID_PATTERN})` };
    }
    if (!out.includes(id)) out.push(id);
  }
  return { ok: true, ids: out };
}

/**
 * Apply an add/remove delta to a key's stored list: removed ids go (an absent
 * one is a no-op), added ids are appended unless already present, order is
 * otherwise kept. Fails when adding takes the result past {@link STORAGE_KEY_MAX_ARTIFACTS}.
 * The caller is expected to have rejected an id that is in both `add` and `remove`.
 */
export function applyStorageKeyArtifactsDelta(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): { ok: true; artifacts: string[] } | { ok: false; reason: string } {
  const out = current.filter((id) => !remove.includes(id));
  const kept = out.length;
  for (const id of add) if (!out.includes(id)) out.push(id);
  // Only growth is refused: a delta that merely removes from an over-long list stays allowed.
  if (out.length > STORAGE_KEY_MAX_ARTIFACTS && out.length > kept) return { ok: false, reason: `too many artifacts (max ${STORAGE_KEY_MAX_ARTIFACTS} per key)` };
  return { ok: true, artifacts: out };
}

/** Per-item metadata as recorded in a key's `meta.json`. */
export interface StorageItemMeta {
  /** Recorded MIME type. Informational — never trusted for serving. */
  mimeType: string;
  size: number;
  sha256: string;
  created: string;
  updated: string;
}

/**
 * One item's record in `meta.json`: its public metadata plus the file that
 * holds its bytes. Never returned by the API or tools — {@link StorageItem} is.
 */
export interface StorageItemRecord extends StorageItemMeta {
  /**
   * The file under `items/` holding this item's bytes: `<name>~<16 hex>`, a
   * fresh name on every save so meta can be committed before the previous
   * bytes are touched. Absent ⇒ the original layout, `items/<name>`.
   */
  file?: string;
}

/** The exact shape of `DATA_DIR/storage/<key>/meta.json`. */
export interface StorageKeyMetaFile {
  version: 1;
  key: string;
  description?: string;
  /** Ids of the artifacts designed for this key. Absent (every key written before it existed) ⇒ none. */
  artifacts?: string[];
  created: string;
  updated: string;
  items: { [name: string]: StorageItemRecord };
}

/** One item, as listed by the REST API and tools. */
export interface StorageItem extends StorageItemMeta {
  name: string;
}

/** One key in the catalogue (`GET /api/storage` → `{ keys: StorageKeySummary[] }`). */
export interface StorageKeySummary {
  key: string;
  description?: string;
  /** Ids of the artifacts this key binds — the only ones that may read or write it. Empty ⇒ it binds none. */
  artifacts: string[];
  itemCount: number;
  totalSize: number;
  created: string;
  updated: string;
}

/** A key with its items (`GET /api/storage/:key` → `{ key: StorageKeyDetail }`). Items are sorted by name. */
export interface StorageKeyDetail extends StorageKeySummary {
  items: StorageItem[];
}

/** `POST /api/storage` body. */
export interface CreateStorageKeyInput {
  key: string;
  description?: string;
  /** Ids of the artifacts designed for this key (see the module doc). Omitted ⇒ none. */
  artifacts?: string[];
}

/**
 * `PATCH /api/storage/:key` body — at least one field. An omitted field is
 * left as it is; an empty description clears it.
 *
 * The list changes one of two ways, never both in one request (400):
 * - `addArtifacts` / `removeArtifacts` — a delta applied server-side to the
 *   list as stored at write time. Use this to toggle ids: two clients editing
 *   at once each land their own change instead of overwriting the other's.
 * - `artifacts` — replaces the whole list (`[]` ⇒ the key binds no artifact).
 *   Only for a deliberate replacement: a client with a stale copy of the list
 *   silently undoes whatever changed since it read it.
 */
export interface UpdateStorageKeyInput {
  description?: string;
  artifacts?: string[];
  /** Ids to add to the stored list (already present ⇒ no-op). */
  addArtifacts?: string[];
  /** Ids to remove from the stored list (absent ⇒ no-op). */
  removeArtifacts?: string[];
}

/**
 * `PUT /api/storage/:key/items/:name` JSON body. Exactly one of `content`
 * (utf-8 text) or `content_base64`. The alternative is multipart with a
 * `file` field (plus an optional `mimeType` form field).
 */
export interface PutStorageItemJsonBody {
  content?: string;
  content_base64?: string;
  mimeType?: string;
}
