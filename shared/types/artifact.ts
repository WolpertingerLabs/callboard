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
 * `storage_access` is the most the render may be granted: the artifact's
 * declared `storageAccess` when `storage_key` is bound, `"none"` when unbound.
 * It is a ceiling, not a grant — the host re-reads the artifact on mount and
 * grants the lesser of this and the artifact's *current* declared access, and
 * binds nothing if `sha256` no longer matches the stored version (the
 * artifact was deleted and recreated, or the version was pruned).
 */
export interface RenderArtifactToolResult {
  type: "render_artifact";
  artifact_id: string;
  version: number;
  /** sha256 of the rendered version's source. Absent only on results written before it existed. */
  sha256?: string;
  name: string;
  content_type: ArtifactContentType;
  storage_key?: string;
  storage_access: ArtifactStorageAccess;
  caption?: string;
  display_mode?: "inline" | "fullscreen";
}

// ─── Storage bridge protocol (iframe ⇄ host renderer) ──────────────────────
//
// The shim injected into rendered HTML (backend/src/services/artifact-bridge-shim.ts)
// implements the iframe side; the host renderer implements the other.
//
// The handshake never hands a secret to a document the server did not render:
//
//  1. The host mints a per-mount token ({@link ARTIFACT_BRIDGE_TOKEN_PATTERN})
//     and puts it in the frame's src (`…/render?bridge=<token>`). The server
//     validates it and injects it into the shim of that one no-store response.
//  2. The shim creates a `MessageChannel` and posts a {@link ArtifactBridgeHello}
//     carrying the token to `window.parent`, transferring one port.
//  3. The host accepts the FIRST hello whose `source` is its frame's window and
//     whose token matches, and from then on speaks only over that port: the
//     {@link ArtifactBridgeInit} and every {@link ArtifactBridgeReply} go down it,
//     and every {@link ArtifactBridgeRequest} must come up it carrying the token.
//
// A port belongs to the document that created it, so nothing sent down it can
// reach a document that later replaces the artifact in the frame — unlike
// `frame.contentWindow.postMessage(…, "*")`, which delivers to whatever
// document is current when the message lands. The host also revokes the
// bridge (and closes the port) on the frame's second `load`.

/** A bridge token: 128 bits, lowercase hex. The render route rejects anything else. */
export const ARTIFACT_BRIDGE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The `?sha256=` pin of a render request: the version sha256 the host checked
 * before mounting. The render route hashes the bytes it is about to serve and
 * refuses (409, a readable error page) when they differ — so the code that runs
 * is the code the grant was judged for, not whatever the version holds by the
 * time the frame's GET lands. Required whenever `?bridge=` is present.
 */
export const ARTIFACT_RENDER_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Per-bridge request budget, enforced host-side before any request reaches the
 * server (every storage call — and every re-check of the artifact the bridge
 * makes on the artifact's behalf — costs one token). The server's per-client
 * API limit is 300 requests/min, shared by the whole UI in every tab, so one
 * artifact must stay well clear of it: a bridge sustains at most 60/min with a
 * burst of 30 (≤ 90 in any one minute — under a third of the global budget,
 * leaving room for the UI and a couple of other open artifacts), and holds at
 * most 4 requests in flight. Over the limit, a request fails at once with a
 * `rate limited` error and never leaves the browser.
 */
export const ARTIFACT_BRIDGE_LIMITS = {
  maxInFlight: 4,
  burst: 30,
  refillPerSecond: 1,
} as const;

/**
 * How long a `read`/`list` may rely on the last check of the artifact (current
 * declared access, existence, pinned sha256). Writes and deletes never use the
 * cache: each is preceded by a fresh check.
 */
export const ARTIFACT_BRIDGE_READ_RECHECK_MS = 5000;

/** The shim resolves `ready` as unbound if no init has arrived by then (see the shim's doc). */
export const ARTIFACT_BRIDGE_READY_TIMEOUT_MS = 10_000;

export type ArtifactBridgeOp = "list" | "read" | "write" | "delete";

/** iframe → host, once, via `window.parent.postMessage(hello, "*", [port])`. */
export interface ArtifactBridgeHello {
  __callboard: "artifact-bridge-hello";
  token: string;
}

/** host → iframe over the port, once, in reply to a valid hello. `storageKey: null` ⇒ unbound; every call rejects. */
export interface ArtifactBridgeInit {
  __callboard: "artifact-bridge-init";
  storageKey: string | null;
  access: ArtifactStorageAccess;
}

/**
 * iframe → host over the port. `token` is the one from the render URL; the
 * host ignores a request without it.
 *
 * Expected `result` in the reply, per op:
 *  - `list`   → the bound key's items (e.g. {@link StorageItem}[])
 *  - `read`   → `as: "text"` a string; `as: "json"` the parsed value (the shim
 *               also accepts a JSON string and parses it); `as: "dataUrl"` a
 *               `data:` URL string, typed with the item's recorded MIME type
 *               when that is `image/*`, else as served
 *  - `write` / `delete` → anything (ignored beyond ok/error)
 */
export interface ArtifactBridgeRequest {
  __callboard: "artifact-bridge-request";
  token: string;
  id: string;
  op: ArtifactBridgeOp;
  name?: string;
  as?: "text" | "json" | "dataUrl";
  data?: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
}

/**
 * What `window.callboard.ready` resolves to inside the artifact. `reason` is
 * set only when the shim gave up waiting for the host (no init within
 * {@link ARTIFACT_BRIDGE_READY_TIMEOUT_MS}) and resolved as unbound.
 */
export interface ArtifactBridgeReady {
  storageKey: string | null;
  access: ArtifactStorageAccess;
  reason?: string;
}

/** host → iframe over the port, one per request, matched by `id`. */
export interface ArtifactBridgeReply {
  __callboard: "artifact-bridge-reply";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
