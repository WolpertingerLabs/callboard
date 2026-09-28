/**
 * Host side of the artifact storage bridge (plan §3, "The storage bridge").
 *
 * An artifact runs in `<iframe sandbox="allow-scripts">` — an opaque origin
 * with no cookies and, under the render route's CSP, no fetch/XHR and no
 * remote subresources. Its one capability is this bridge: requests that the
 * host performs against the authenticated REST API, scoped to the single
 * storage key the render bound, at the access level the render granted.
 *
 * Protocol (typed in shared/types/artifact.ts; the in-iframe shim lives in
 * backend/src/services/artifact-bridge-shim.ts and speaks exactly this):
 *
 *   host: mints `token`, frame src = …/render?bridge=<token>
 *   frame → host window:  { __callboard: "artifact-bridge-hello", token }  + transferred MessagePort
 *   host → port, once:    { __callboard: "artifact-bridge-init", storageKey, access }
 *   frame → port:         { __callboard: "artifact-bridge-request", token, id, op, name?, as?, data?, encoding?, mimeType? }
 *   host → port:          { __callboard: "artifact-bridge-reply", id, ok, result?, error? }
 *
 * The rules that make it safe, each of which has a test:
 *
 * - The host never pushes anything to the frame's window. It binds to the
 *   FIRST hello whose `e.source` is this mount's frame window AND whose token
 *   matches, and talks only over the port that hello carried. The token was
 *   injected by the server into the one (no-store) document rendered for this
 *   mount, so a document the artifact navigates to cannot produce a valid
 *   hello; and a port belongs to the document that created it, so nothing the
 *   host sends — init or reply — can reach a document that later replaces the
 *   artifact in the frame. (`contentWindow.postMessage(…, "*")` would deliver
 *   to whichever document is current when the message lands; with an opaque
 *   origin there is no targetOrigin to pin it.)
 * - Any `load` after the first revokes the bridge for good and closes the
 *   port. The revocation is re-checked before every reply.
 * - Every request must carry the token, as well as arrive on the bound port.
 * - The request has no key field. The bound key is fixed at construction and is
 *   the only key any operation addresses; a `key` in the payload is ignored.
 * - Names are re-validated here (the server validates again) and writes are
 *   size-checked here (the server enforces again).
 *
 * Accepted, by design: the artifact itself knows its token and can hand it to
 * a page it navigates to (which would then bind nothing — the host is bound
 * already — unless it wins the race to be first). That is no more than the
 * artifact exfiltrating data it can already read, which it can do anyway
 * (navigation URLs, WebRTC): granting read on a key means the artifact's
 * author can read that key.
 */

import {
  deleteStorageItem,
  fetchStorageItem,
  getStorageKey,
  isValidStorageItemName,
  putStorageItem,
  STORAGE_ITEM_MIME_HEADER,
  STORAGE_MAX_ITEM_BYTES,
} from "../api";
import type { ArtifactBridgeInit, ArtifactBridgeOp, ArtifactBridgeReply, ArtifactStorageAccess, StorageItem } from "../api";

export const BRIDGE_HELLO = "artifact-bridge-hello";
export const BRIDGE_INIT = "artifact-bridge-init";
export const BRIDGE_REQUEST = "artifact-bridge-request";
export const BRIDGE_REPLY = "artifact-bridge-reply";

/** Aliases kept for readability here; the protocol types live in shared/types/artifact.ts. */
export type BridgeOp = ArtifactBridgeOp;
export type BridgeInitMessage = ArtifactBridgeInit;
export type BridgeReplyMessage = ArtifactBridgeReply;

/** The storage operations the bridge may perform — injectable for tests. Every one takes the bound key from the bridge, never from the frame. */
export interface BridgeStorageApi {
  list(key: string): Promise<StorageItem[]>;
  readText(key: string, name: string): Promise<string>;
  /** The bytes as served, plus the item's recorded MIME type when the server reports it. */
  readBlob(key: string, name: string): Promise<{ blob: Blob; recordedMimeType?: string }>;
  write(key: string, name: string, body: { content: string; mimeType?: string } | { content_base64: string; mimeType?: string }): Promise<StorageItem>;
  remove(key: string, name: string): Promise<void>;
}

export const restBridgeApi: BridgeStorageApi = {
  list: async (key) => (await getStorageKey(key)).items,
  readText: async (key, name) => (await fetchStorageItem(key, name)).text(),
  readBlob: async (key, name) => {
    const res = await fetchStorageItem(key, name);
    return { blob: await res.blob(), recordedMimeType: res.headers.get(STORAGE_ITEM_MIME_HEADER) ?? undefined };
  },
  write: (key, name, body) => putStorageItem(key, name, body),
  remove: (key, name) => deleteStorageItem(key, name),
};

/** 128 bits from the platform CSPRNG, lowercase hex (ARTIFACT_BRIDGE_TOKEN_PATTERN). One per mount. */
export function makeBridgeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(;[ -~]{0,200})?$/i;

/** Decoded byte length of a utf-8 string or a base64 payload, without materialising it. */
function payloadBytes(data: string, encoding: "utf8" | "base64"): number {
  if (encoding === "base64") {
    const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.floor((data.length * 3) / 4) - pad;
  }
  return new TextEncoder().encode(data).length;
}

/** `image/<subtype>` and nothing else — the only recorded types a dataUrl read is re-typed with. */
const IMAGE_MIME_RE = /^image\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The server serves every non-raster item (SVG included) as
 * application/octet-stream, so a data URL built from the response would be
 * unusable in `<img>`. Re-type the bytes with the item's RECORDED type when —
 * and only when — that is `image/*`.
 *
 * Safe because this data URL only ever exists inside the artifact's frame:
 * an opaque-origin sandbox with no cookies and no /api, whose CSP forbids
 * fetch and remote loads and sets `frame-src 'none'` (so it cannot frame the
 * URL as a document); `<img>` never runs script in an SVG; and the artifact
 * could already read the same bytes as text and build this URL itself. The
 * same-origin REST response is untouched — still an octet-stream attachment
 * under nosniff and a sandbox CSP.
 */
function retypeForDataUrl(blob: Blob, recordedMimeType: string | undefined): Blob {
  const recorded = recordedMimeType?.trim().toLowerCase();
  if (!recorded || !IMAGE_MIME_RE.test(recorded) || blob.type === recorded) return blob;
  return new Blob([blob], { type: recorded });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read item"));
    reader.readAsDataURL(blob);
  });
}

class BridgeRefusal extends Error {}

export interface ArtifactBridgeOptions {
  /** The frame window this mount rendered — read fresh on every check. */
  getFrameWindow: () => Window | null | undefined;
  storageKey: string | null;
  access: ArtifactStorageAccess;
  api?: BridgeStorageApi;
  /** Test seam; production mints one per mount. */
  token?: string;
}

export interface ArtifactBridge {
  /** Goes in the frame's src (`artifactRenderUrl(…, token)`) and nowhere else. */
  readonly token: string;
  readonly revoked: boolean;
  /** True once a valid hello has bound the bridge to its port. */
  readonly bound: boolean;
  /** Call on every `load` of the frame. The first is a no-op; any later one revokes. */
  handleLoad(): void;
  /** Window `message` listener: accepts the one valid hello, ignores everything else. */
  handleMessage(e: MessageEvent): void;
  /** Resolves once every request received so far has been answered (or dropped). Test seam. */
  settled(): Promise<void>;
  revoke(): void;
}

export function createArtifactBridge(opts: ArtifactBridgeOptions): ArtifactBridge {
  const api = opts.api ?? restBridgeApi;
  const token = opts.token ?? makeBridgeToken();
  // Unbound renders get no authority at all, whatever access was passed.
  const storageKey = opts.storageKey ?? null;
  const access: ArtifactStorageAccess = storageKey ? opts.access : "none";
  let loads = 0;
  let revoked = false;
  let port: MessagePort | null = null;
  const inFlight = new Set<Promise<void>>();

  async function perform(req: Record<string, unknown>): Promise<unknown> {
    if (access === "none" || !storageKey) throw new BridgeRefusal("This artifact has no storage bound");
    const op = req.op as BridgeOp;
    if (op === "list") return api.list(storageKey);

    const name = req.name;
    if (!isValidStorageItemName(name)) throw new BridgeRefusal("Invalid item name");

    if (op === "read") {
      const as = req.as ?? "text";
      if (as === "text") return api.readText(storageKey, name);
      if (as === "json") {
        const text = await api.readText(storageKey, name);
        try {
          return JSON.parse(text);
        } catch {
          throw new BridgeRefusal(`Item "${name}" is not valid JSON`);
        }
      }
      if (as === "dataUrl") {
        const { blob, recordedMimeType } = await api.readBlob(storageKey, name);
        return blobToDataUrl(retypeForDataUrl(blob, recordedMimeType));
      }
      throw new BridgeRefusal("Invalid read format");
    }

    if (op === "write" || op === "delete") {
      if (access !== "readwrite") throw new BridgeRefusal("This artifact has read-only storage access");
      if (op === "delete") {
        await api.remove(storageKey, name);
        return null;
      }
      const data = req.data;
      const encoding = req.encoding ?? "utf8";
      if (typeof data !== "string") throw new BridgeRefusal("Write data must be a string");
      if (encoding !== "utf8" && encoding !== "base64") throw new BridgeRefusal("Invalid encoding");
      if (encoding === "base64" && (data.length % 4 !== 0 || !BASE64_RE.test(data))) throw new BridgeRefusal("Invalid base64 data");
      if (payloadBytes(data, encoding) > STORAGE_MAX_ITEM_BYTES) throw new BridgeRefusal("Item exceeds the 25 MB item limit");
      let mimeType: string | undefined;
      if (req.mimeType !== undefined) {
        if (typeof req.mimeType !== "string" || !MIME_RE.test(req.mimeType)) throw new BridgeRefusal("Invalid mimeType");
        mimeType = req.mimeType;
      }
      const body = encoding === "utf8" ? { content: data, mimeType } : { content_base64: data, mimeType };
      return api.write(storageKey, name, body);
    }

    throw new BridgeRefusal("Unknown operation");
  }

  async function answer(p: MessagePort, msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string;
    let reply: BridgeReplyMessage;
    try {
      const result = await perform(msg);
      reply = { __callboard: BRIDGE_REPLY, id, ok: true, result };
    } catch (err) {
      reply = { __callboard: BRIDGE_REPLY, id, ok: false, error: err instanceof Error ? err.message : "Storage request failed" };
    }
    // Re-check after the await: a frame that navigated (or unmounted) while
    // the request was in flight must not receive the answer.
    if (revoked || port !== p) return;
    p.postMessage(reply);
  }

  function onPortMessage(p: MessagePort, e: MessageEvent): void {
    if (revoked || port !== p) return;
    const msg = e.data;
    if (!msg || typeof msg !== "object" || msg.__callboard !== BRIDGE_REQUEST) return;
    if (msg.token !== token || typeof msg.id !== "string") return;
    const done = answer(p, msg);
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
  }

  function revoke(): void {
    revoked = true;
    port?.close();
  }

  return {
    token,
    get revoked() {
      return revoked;
    },
    get bound() {
      return port !== null;
    },
    handleLoad() {
      loads += 1;
      if (loads > 1) revoke();
    },
    handleMessage(e: MessageEvent) {
      if (revoked || port !== null) return;
      const frame = opts.getFrameWindow();
      if (!frame || e.source !== frame) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object" || msg.__callboard !== BRIDGE_HELLO || msg.token !== token) return;
      const p = e.ports?.[0];
      if (!p) return;
      port = p;
      p.onmessage = (ev) => onPortMessage(p, ev);
      const init: BridgeInitMessage = { __callboard: BRIDGE_INIT, storageKey, access };
      p.postMessage(init);
    },
    async settled() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
    revoke,
  };
}
