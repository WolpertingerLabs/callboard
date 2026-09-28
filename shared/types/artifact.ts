/**
 * Artifacts — named, versioned, reusable single-file apps (HTML), images (SVG)
 * or documents (markdown) that render in chat and in Settings.
 *
 * Unlike a canvas, an artifact is catalogued by a stable, creator-chosen slug
 * and can be **bound to one storage key at render time** through the bridge
 * described below. That binding is what turns it from a picture into an app.
 *
 * On disk (see backend/src/services/artifact-service.ts):
 *
 *   DATA_DIR/artifacts/<id>/meta.json          {@link ArtifactMetaFile}
 *   DATA_DIR/artifacts/<id>/versions/<n>.<ext> immutable source of version n
 *
 * These are REST/tool shapes, not stream wire types — they deliberately live
 * outside `stream.ts`.
 */

/** Artifact id: lowercase slug, e.g. `cramhouse`. */
export const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Maximum source size of one version, in utf-8 bytes. */
export const ARTIFACT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** Versions kept per artifact; older ones are pruned on save. */
export const ARTIFACT_MAX_VERSIONS = 50;

export const ARTIFACT_CONTENT_TYPES = ["html", "svg", "markdown"] as const;
export type ArtifactContentType = (typeof ARTIFACT_CONTENT_TYPES)[number];

/**
 * What an artifact may do with a bound storage key. On the artifact this is the
 * **maximum** it may ever be granted; on a render it is what was granted.
 */
export const ARTIFACT_STORAGE_ACCESS = ["none", "read", "readwrite"] as const;
export type ArtifactStorageAccess = (typeof ARTIFACT_STORAGE_ACCESS)[number];

/** The lesser of two access levels — a grant can never exceed what the artifact declares. */
export function minArtifactStorageAccess(a: ArtifactStorageAccess, b: ArtifactStorageAccess): ArtifactStorageAccess {
  return ARTIFACT_STORAGE_ACCESS[Math.min(ARTIFACT_STORAGE_ACCESS.indexOf(a), ARTIFACT_STORAGE_ACCESS.indexOf(b))];
}

export interface ArtifactVersion {
  version: number;
  created: string;
  note?: string;
  /** Source size in bytes. */
  size: number;
  sha256: string;
}

/** An artifact without its version list (`GET /api/artifacts` → `{ artifacts: ArtifactSummary[] }`). */
export interface ArtifactSummary {
  id: string;
  name: string;
  description?: string;
  contentType: ArtifactContentType;
  storageAccess: ArtifactStorageAccess;
  currentVersion: number;
  created: string;
  updated: string;
}

/** A full artifact (`GET /api/artifacts/:id` → `{ artifact: Artifact }`). Versions are oldest-first. */
export interface Artifact extends ArtifactSummary {
  versions: ArtifactVersion[];
}

/** The exact shape of `DATA_DIR/artifacts/<id>/meta.json`. */
export interface ArtifactMetaFile extends Artifact {
  schemaVersion: 1;
}

/** `POST /api/artifacts` body. */
export interface CreateArtifactInput {
  id: string;
  name: string;
  description?: string;
  contentType: ArtifactContentType;
  /** Defaults to `"none"`. */
  storageAccess?: ArtifactStorageAccess;
  content: string;
  note?: string;
}

/** `PATCH /api/artifacts/:id` body. An empty description clears it. */
export interface UpdateArtifactInput {
  name?: string;
  description?: string;
  storageAccess?: ArtifactStorageAccess;
}

/** `POST /api/artifacts/:id/versions` body. */
export interface NewArtifactVersionInput {
  content: string;
  note?: string;
}

/**
 * The JSON text of a successful `render_artifact` tool result.
 *
 * `storage_access` is what the render was granted: the artifact's declared
 * `storageAccess` when `storage_key` is bound, `"none"` when unbound.
 */
export interface RenderArtifactToolResult {
  type: "render_artifact";
  artifact_id: string;
  version: number;
  name: string;
  content_type: ArtifactContentType;
  storage_key?: string;
  storage_access: ArtifactStorageAccess;
  caption?: string;
  display_mode?: "inline" | "fullscreen";
}

// ─── Storage bridge protocol (iframe ⇄ host renderer, over postMessage) ──────
//
// The shim injected into rendered HTML (backend/src/services/artifact-bridge-shim.ts)
// implements the iframe side; the host renderer implements the other. The
// host sends ONE init on the iframe's first `load` and must revoke the bridge
// on any later `load`. The shim honours only the first init and only messages
// whose `source` is `window.parent`.

export type ArtifactBridgeOp = "list" | "read" | "write" | "delete";

/** host → iframe, once, on first load. `storageKey: null` ⇒ unbound; every call rejects. */
export interface ArtifactBridgeInit {
  __callboard: "artifact-bridge-init";
  nonce: string;
  storageKey: string | null;
  access: ArtifactStorageAccess;
}

/**
 * iframe → host. `nonce` echoes the init's.
 *
 * Expected `result` in the reply, per op:
 *  - `list`   → the bound key's items (e.g. {@link StorageItem}[])
 *  - `read`   → `as: "text"` a string; `as: "json"` the parsed value (the shim
 *               also accepts a JSON string and parses it); `as: "dataUrl"` a
 *               `data:` URL string
 *  - `write` / `delete` → anything (ignored beyond ok/error)
 */
export interface ArtifactBridgeRequest {
  __callboard: "artifact-bridge-request";
  nonce: string;
  id: string;
  op: ArtifactBridgeOp;
  name?: string;
  as?: "text" | "json" | "dataUrl";
  data?: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
}

/** host → iframe, one per request, matched by `id`. */
export interface ArtifactBridgeReply {
  __callboard: "artifact-bridge-reply";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
