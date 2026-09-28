/**
 * Host side of the artifact storage bridge (plan §3, "The storage bridge").
 *
 * An artifact runs in `<iframe sandbox="allow-scripts">` — an opaque origin
 * with no cookies and, under the render route's CSP, no network. Its one
 * capability is this bridge: postMessage requests that the host performs
 * against the authenticated REST API, scoped to the single storage key the
 * render bound, at the access level the render granted.
 *
 * Protocol (typed in shared/types/artifact.ts; the in-iframe shim lives in
 * backend/src/services/artifact-bridge-shim.ts and speaks exactly this):
 *
 *   host → frame, first `load` only:
 *     { __callboard: "artifact-bridge-init", nonce, storageKey, access }
 *   frame → host:
 *     { __callboard: "artifact-bridge-request", nonce, id, op, name?, as?, data?, encoding?, mimeType? }
 *   host → frame:
 *     { __callboard: "artifact-bridge-reply", id, ok, result?, error? }
 *
 * The rules that make it safe, each of which has a test:
 *
 * - A request counts only when `e.source` is *this* mount's frame window AND it
 *   carries this mount's nonce. The init goes out with targetOrigin "*" because
 *   the frame's origin is opaque and cannot be named, so the nonce and the
 *   source check are what stand in for an origin check.
 * - Any `load` after the first revokes the bridge for good. CSP cannot stop a
 *   frame navigating itself, and whatever it navigates to must not inherit the
 *   data grant. The revocation is also re-checked before every reply, so a read
 *   that was in flight when the frame navigated is never delivered to the new
 *   document.
 * - The request has no key field. The bound key is fixed at construction and is
 *   the only key any operation addresses; a `key` in the payload is ignored.
 * - Names are re-validated here (the server validates again) and writes are
 *   size-checked here (the server enforces again).
 */

import { deleteStorageItem, fetchStorageItem, getStorageKey, isValidStorageItemName, putStorageItem, STORAGE_MAX_ITEM_BYTES } from "../api";
import type { ArtifactBridgeInit, ArtifactBridgeOp, ArtifactBridgeReply, ArtifactStorageAccess, StorageItem } from "../api";

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
  readBlob(key: string, name: string): Promise<Blob>;
  write(key: string, name: string, body: { content: string; mimeType?: string } | { content_base64: string; mimeType?: string }): Promise<StorageItem>;
  remove(key: string, name: string): Promise<void>;
}

export const restBridgeApi: BridgeStorageApi = {
  list: async (key) => (await getStorageKey(key)).items,
  readText: async (key, name) => (await fetchStorageItem(key, name)).text(),
  readBlob: async (key, name) => (await fetchStorageItem(key, name)).blob(),
  write: (key, name, body) => putStorageItem(key, name, body),
  remove: (key, name) => deleteStorageItem(key, name),
};

/** 128 bits from the platform CSPRNG, hex-encoded. One per mount. */
export function makeBridgeNonce(): string {
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
  nonce?: string;
}

export interface ArtifactBridge {
  readonly nonce: string;
  readonly revoked: boolean;
  /** Call on every `load` of the frame. The first delivers init; any later one revokes. */
  handleLoad(): void;
  /** Window `message` listener. Resolves once any reply has been posted (or dropped). */
  handleMessage(e: MessageEvent): Promise<void>;
  revoke(): void;
}

export function createArtifactBridge(opts: ArtifactBridgeOptions): ArtifactBridge {
  const api = opts.api ?? restBridgeApi;
  const nonce = opts.nonce ?? makeBridgeNonce();
  // Unbound renders get no authority at all, whatever access was passed.
  const storageKey = opts.storageKey ?? null;
  const access: ArtifactStorageAccess = storageKey ? opts.access : "none";
  let loads = 0;
  let revoked = false;

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
      if (as === "dataUrl") return blobToDataUrl(await api.readBlob(storageKey, name));
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

  return {
    nonce,
    get revoked() {
      return revoked;
    },
    handleLoad() {
      loads += 1;
      if (loads > 1) {
        revoked = true;
        return;
      }
      const frame = opts.getFrameWindow();
      if (!frame || revoked) return;
      const init: BridgeInitMessage = { __callboard: BRIDGE_INIT, nonce, storageKey, access };
      // "*" is unavoidable: the sandboxed frame has an opaque origin that cannot
      // be named. The nonce plus the source check are the origin check.
      frame.postMessage(init, "*");
    },
    async handleMessage(e: MessageEvent) {
      const frame = opts.getFrameWindow();
      if (revoked || loads === 0 || !frame || e.source !== frame) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object" || msg.__callboard !== BRIDGE_REQUEST) return;
      if (typeof msg.nonce !== "string" || msg.nonce !== nonce) return;
      const id = msg.id;
      if (typeof id !== "string") return;

      let reply: BridgeReplyMessage;
      try {
        const result = await perform(msg);
        reply = { __callboard: BRIDGE_REPLY, id, ok: true, result };
      } catch (err) {
        reply = { __callboard: BRIDGE_REPLY, id, ok: false, error: err instanceof Error ? err.message : "Storage request failed" };
      }
      // Re-check after the await: a frame that navigated (or unmounted) while
      // the request was in flight must not receive the answer.
      if (revoked || opts.getFrameWindow() !== frame) return;
      frame.postMessage(reply, "*");
    },
    revoke() {
      revoked = true;
    },
  };
}
