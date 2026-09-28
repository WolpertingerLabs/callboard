/**
 * Storage + Artifacts wire types, mirrored locally from the plan
 * (`callboard-storage-artifacts.md` §2–§3) while `shared/` is being built on
 * the backend branch. Every name and field here is meant to match the shared
 * types one-for-one so the swap is an import change, not a rewrite.
 */

/** One item inside a storage key. Items are flat — the name is the whole path. */
export interface StorageItemMeta {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  created: string;
  updated: string;
}

/** A row of `GET /api/storage` — one catalogued key. */
export interface StorageKeySummary {
  key: string;
  description?: string;
  itemCount: number;
  totalSize: number;
  created?: string;
  updated: string;
}

/** `GET /api/storage/:key` — the key's meta with its items as an array. */
export interface StorageKeyDetail {
  version?: number;
  key: string;
  description?: string;
  created: string;
  updated: string;
  items: StorageItemMeta[];
}

export type ArtifactContentType = "html" | "svg" | "markdown";

/** The most a render may ever grant an artifact; the bridge enforces it. */
export type StorageAccess = "none" | "read" | "readwrite";

export interface ArtifactVersion {
  version: number;
  created: string;
  note?: string;
  size: number;
  sha256: string;
}

export interface Artifact {
  id: string;
  name: string;
  description?: string;
  contentType: ArtifactContentType;
  storageAccess: StorageAccess;
  currentVersion: number;
  versions: ArtifactVersion[];
  created?: string;
  updated?: string;
}

/** The `render_artifact` UI tool result, validated by `parseUiToolResult`. */
export interface RenderArtifactData {
  type: "render_artifact";
  artifact_id: string;
  version: number;
  name: string;
  content_type: ArtifactContentType;
  storage_key?: string;
  storage_access: StorageAccess;
  caption?: string;
  display_mode?: "inline" | "fullscreen";
}

/** Plan §2 — the per-item size limit, re-checked host-side by the bridge. */
export const STORAGE_ITEM_MAX_BYTES = 25 * 1024 * 1024;

/** Plan §2 — item names. `.`/`..` are excluded separately (the regex admits neither, but say so). */
export const STORAGE_ITEM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Plan §2 — key names. */
export const STORAGE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Plan §3 — artifact ids. */
export const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidStorageItemName(name: unknown): name is string {
  return typeof name === "string" && name !== "." && name !== ".." && STORAGE_ITEM_NAME_RE.test(name);
}

export function isValidStorageKey(key: unknown): key is string {
  return typeof key === "string" && key !== "." && key !== ".." && STORAGE_KEY_RE.test(key);
}

const ACCESS_RANK: Record<StorageAccess, number> = { none: 0, read: 1, readwrite: 2 };

/** The lesser of two grants — what the plan calls "effective access". */
export function minAccess(a: StorageAccess, b: StorageAccess): StorageAccess {
  return ACCESS_RANK[a] <= ACCESS_RANK[b] ? a : b;
}
