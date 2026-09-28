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
 * The artifact request budget, enforced host-side before any request reaches
 * the server. It is ONE budget per browser tab, capping every artifact
 * rendered in it together — not one per render: the server's API limit (300
 * requests/min per client) is shared by the whole UI, and a per-render budget
 * let a handful of copies of one polling artifact spend it all.
 *
 * Within that cap it is divided FAIRLY between renders, not first come: each
 * render has its own share, which no other render can spend, and the tab's
 * refill is dealt out evenly to the renders that are making requests (a
 * render that wants less than an even split gets what it asks for, and the
 * rest goes to the others). A render that retries the instant it is refused
 * therefore holds exactly its share and cannot take anyone else's.
 *
 * "Gets what it asks for" includes a render that asks rarely: one quiet for
 * `activeWindowMs` hands its share back to the tab, so a busy neighbour may
 * have spent everything by the time it asks again. Its call is then held
 * host-side — answered late, not refused — until its share can pay, for up to
 * `maxHoldMs` (a check and a call beside up to seven busy renders). The host
 * holds a call only for a render whose recent spending is under an even
 * split and that has no other call held; a render asking for its share or
 * more is refused as below.
 *
 * What costs a token: every storage call (list/read/write/delete), plus every
 * re-check of an artifact's grant that actually goes to the server. Re-checks
 * are shared per artifact across the tab (see the two `*_RECHECK_MS` windows
 * below), so they are at most one per artifact per window, not one per call:
 * a read reuses a check under 5 s old, a write or delete one under 2 s old.
 * A re-check serves every render of its artifact, so its cost is split
 * between those that are in use.
 *
 * Effective rates, for the whole tab: a sustained 105 tokens/min with a burst
 * of 20 (≤ 125 in any one minute). The rest of the server's 300 is the UI's:
 * opening a chat alone costs ~55 requests, so ~175 is about three chat opens
 * a minute on top of artifacts running flat out. Hence, for ONE render that
 * is the only one in the tab making requests:
 *  - writes sustain up to ~75/min (≤ 30 re-checks/min at one per 2 s); at 1
 *    write/s a check lands on every other write, so a write costs 1.5 tokens
 *    on average (90/min, under the 105 refill) and it never runs dry;
 *  - reads sustain up to ~93/min (≤ 12 re-checks/min at one per 5 s);
 *  - a load-time burst of ~15 calls fits.
 * With N renders all asking for more than an even split, each is guaranteed
 * 1/N of the rate and no more: 52.5 tokens/min beside one other busy render
 * (~35 writes/min, one per ~1.7 s; or ~40 reads), 26 beside three (~13
 * writes/min — writes that far apart each need a check of their own, 2 tokens
 * a write — or ~14 reads). So 1 write/s is safe only while no other render in
 * the tab is busy. The burst above an
 * even share is the tab's unclaimed pool, first come.
 *
 * Each render also holds at most 4 requests in flight (the shim queues the
 * rest). Over the limit (and not held as above), a call fails at once with a
 * `rate limited` error and never leaves the browser; the refusal carries
 * `retryAfterMs` (when that render's share will next hold a token), and the
 * shim holds back every call of the render not yet sent — those queued
 * before the refusal and those made after it — until then: they wait rather
 * than fail, so a retry loop costs a round trip per token instead of
 * spinning. That hold-off is a courtesy of the shim, which runs inside the
 * artifact; the cap is enforced by the host whatever the artifact does.
 */
export const ARTIFACT_BRIDGE_LIMITS = {
  maxInFlight: 4,
  burst: 20,
  refillPerSecond: 1.75,
  /** The most tokens one mount's own share holds; above it, a lone mount draws on the tab's unclaimed pool. */
  shareBurst: 5,
  /** A mount counts toward the division for this long after its last request (or after a retry hint it was given runs out). */
  activeWindowMs: 5000,
  /** The longest `retryAfterMs` the host sends, and the longest the shim holds a render's calls back. */
  maxRetryAfterMs: 5000,
  /**
   * The longest the host holds a refused request of a mount that is not over
   * its share (not already holding one, not refused within activeWindowMs)
   * until its share can pay, instead of refusing it: a check and a call (2
   * tokens) beside up to seven other busy mounts.
   */
  maxHoldMs: 10_000,
} as const;

/**
 * How old a check of the artifact (current declared access, existence, pinned
 * sha256) a `read`/`list` — or the re-check when the page becomes visible
 * again — may rely on. Checks are shared per artifact across the tab, so this
 * is also the most often any one artifact is re-checked for reads.
 */
export const ARTIFACT_BRIDGE_READ_RECHECK_MS = 5000;

/**
 * How old a check a `write`/`delete` may rely on — measured from when the
 * check STARTED (the earliest moment it could have read the server), and
 * shared per artifact like the read window. 2 s: well under the time it takes
 * anyone to lower an artifact's access in Settings and expect it to have
 * taken effect, yet long enough that a writer at 1/s pays for a check on at
 * most every other write (the old "every write checks first" rule made a
 * write cost 2 tokens, so the documented rate was really half).
 */
export const ARTIFACT_BRIDGE_WRITE_RECHECK_MS = 2000;

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
  /**
   * On a `rate limited` refusal by the budget: about how long, in ms, until
   * this render's share holds a token again. The shim holds the render's next
   * calls back until then (waiting, not failing), so a retry loop costs one
   * round trip per token rather than spinning.
   */
  retryAfterMs?: number;
}
