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
 * These types are REST/tool shapes, not stream wire types — they deliberately
 * live outside `stream.ts`.
 */

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
}

/** `PATCH /api/storage/:key` body. An empty string clears the description. */
export interface UpdateStorageKeyInput {
  description: string;
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
