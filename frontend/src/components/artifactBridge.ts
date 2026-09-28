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
 * - Every request that would reach the server is metered first, against ONE
 *   budget shared by every bridge in the tab ({@link tabBudget},
 *   {@link ARTIFACT_BRIDGE_LIMITS}), plus ≤ 4 in flight per mount. Over the
 *   limit it fails at once with a `rate limited` error and never leaves the
 *   browser — artifacts, however many are open, must not spend the per-client
 *   API budget the whole UI shares.
 * - The grant is live, not frozen at mount: every request is judged against a
 *   check of the artifact (it still exists, its current declared access, the
 *   pinned sha256) that started at most {@link ARTIFACT_BRIDGE_WRITE_RECHECK_MS}
 *   ago for a write or delete, {@link ARTIFACT_BRIDGE_READ_RECHECK_MS} for a
 *   read or list, via `recheck` — and so is the page becoming visible again.
 *   Checks are shared per artifact across the tab (artifactGrant's lookup), so
 *   one that is fresh enough costs nothing; one that goes to the server is
 *   metered like any other request. A downgrade lowers the grant for the rest
 *   of the mount (read ⇒ writes refused; none, deleted or replaced ⇒ every call
 *   refused); it never rises again.
 *
 * Accepted, by design: the artifact itself knows its token and can hand it to
 * a page it navigates to (which would then bind nothing — the host is bound
 * already — unless it wins the race to be first). That is no more than the
 * artifact exfiltrating data it can already read, which it can do anyway
 * (navigation URLs, WebRTC): granting read on a key means the artifact's
 * author can read that key.
 */

import {
  ARTIFACT_BRIDGE_LIMITS,
  ARTIFACT_BRIDGE_READ_RECHECK_MS,
  ARTIFACT_BRIDGE_WRITE_RECHECK_MS,
  deleteStorageItem,
  fetchStorageItem,
  getStorageKey,
  isValidStorageItemName,
  minArtifactStorageAccess,
  putStorageItem,
  STORAGE_ITEM_MIME_HEADER,
  STORAGE_MAX_ITEM_BYTES,
} from "../api";
import type { ArtifactBridgeInit, ArtifactBridgeOp, ArtifactBridgeReply, ArtifactStorageAccess, StorageItem } from "../api";
import { RATE_LIMITED, RateLimitedError, tabBudget, type RequestBudget } from "./artifactBudget";

export { RATE_LIMITED };

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
 * fetch and remote loads; `frame-src 'none'` stops it framing a `data:` URL
 * as a document (it does NOT stop `srcdoc` frames — measured — but a srcdoc
 * child is only more of the artifact's own code in the same sandbox, and its
 * messages never pass the bridge's source check); `<img>` never runs script
 * in an SVG; and the artifact could already read the same bytes as text and
 * build this URL itself. The same-origin REST response is untouched — still
 * an octet-stream attachment under nosniff and a sandbox CSP.
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

/** Built on use, not at import: tests that mock ../api wholesale import this module too. */
const rateLimitMessage = () =>
  `${RATE_LIMITED}: the artifacts in this tab share at most ${Math.round(ARTIFACT_BRIDGE_LIMITS.refillPerSecond * 60)} storage requests a minute ` +
  `(burst ${ARTIFACT_BRIDGE_LIMITS.burst}; a write also spends one on re-checking access at most every ${ARTIFACT_BRIDGE_WRITE_RECHECK_MS / 1000} s, ` +
  `a read every ${ARTIFACT_BRIDGE_READ_RECHECK_MS / 1000} s); slow down and retry`;

export interface ArtifactBridgeOptions {
  /** The frame window this mount rendered — read fresh on every check. */
  getFrameWindow: () => Window | null | undefined;
  storageKey: string | null;
  access: ArtifactStorageAccess;
  api?: BridgeStorageApi;
  /** Test seam; production mints one per mount. */
  token?: string;
  /**
   * The artifact's grant as of a check that started at most `maxAgeMs` ago
   * (shared per artifact; a fresh enough one is reused, otherwise one is made
   * and metered against `budget`): the most this mount may still do — "none"
   * if it is gone, replaced (sha256 differs from the served one) or lowered to
   * none. Throws when it could not look — {@link RateLimitedError} if the
   * budget refused the fetch, anything else for the network; the request that
   * needed the check is then refused, but the grant is kept. Omitted ⇒ the
   * grant is never re-checked (tests only).
   */
  recheck?: (maxAgeMs: number, budget: RequestBudget) => Promise<ArtifactStorageAccess>;
  /** Told whenever a re-check lowers the grant (the renderer's badge follows it). */
  onAccessChange?: (access: ArtifactStorageAccess) => void;
  /** The budget this bridge spends. Production: {@link tabBudget}, shared by every bridge in the tab. Test seam. */
  budget?: RequestBudget;
}

export interface ArtifactBridge {
  /** Goes in the frame's src (`artifactRenderUrl(…, token)`) and nowhere else. */
  readonly token: string;
  readonly revoked: boolean;
  /** True once a valid hello has bound the bridge to its port (and it is not revoked). */
  readonly bound: boolean;
  /** Call on every `load` of the frame. The first is a no-op; any later one revokes. */
  handleLoad(): void;
  /** Window `message` listener: accepts the one valid hello, ignores everything else. */
  handleMessage(e: MessageEvent): void;
  /** The grant now — the mount's, lowered by any re-check since. */
  readonly access: ArtifactStorageAccess;
  /** Resolves once every request received so far has been answered (or dropped). Test seam. */
  settled(): Promise<void>;
  /** Host-initiated re-check (the page became visible again). Shared and metered like a read's: free if one under ARTIFACT_BRIDGE_READ_RECHECK_MS exists; errors (over budget included) are ignored — the next request checks. */
  refresh(): Promise<void>;
  /** Kill the bridge: nothing more is answered, and the host's end of the port is closed. */
  revoke(): void;
}

export function createArtifactBridge(opts: ArtifactBridgeOptions): ArtifactBridge {
  const api = opts.api ?? restBridgeApi;
  const token = opts.token ?? makeBridgeToken();
  // Unbound renders get no authority at all, whatever access was passed.
  const storageKey = opts.storageKey ?? null;
  let access: ArtifactStorageAccess = storageKey ? opts.access : "none";
  const budget = opts.budget ?? tabBudget;
  let loads = 0;
  let revoked = false;
  let port: MessagePort | null = null;
  const inFlight = new Set<Promise<void>>();
  let active = 0;

  const granted = (): ArtifactStorageAccess => access;

  function lower(to: ArtifactStorageAccess): void {
    const next = minArtifactStorageAccess(access, to);
    if (next === access) return;
    access = next;
    opts.onAccessChange?.(access);
  }

  /** Lower the grant to a check at most `maxAgeMs` old. Rejects if the check could not be made. */
  async function check(recheck: NonNullable<ArtifactBridgeOptions["recheck"]>, maxAgeMs: number): Promise<void> {
    lower(await recheck(maxAgeMs, budget));
  }

  /**
   * Everything a request is checked for that needs no server — access, op,
   * name, payload — so that a refusal costs nothing. Returns the call to make.
   */
  function prepare(req: Record<string, unknown>, key: string): { mutating: boolean; run: () => Promise<unknown> } {
    const op = req.op as BridgeOp;
    if (op === "list") return { mutating: false, run: () => api.list(key) };
    if (op !== "read" && op !== "write" && op !== "delete") throw new BridgeRefusal("Unknown operation");

    const name = req.name;
    if (!isValidStorageItemName(name)) throw new BridgeRefusal("Invalid item name");

    if (op === "read") {
      const as = req.as ?? "text";
      if (as === "text") return { mutating: false, run: () => api.readText(key, name) };
      if (as === "json") {
        return {
          mutating: false,
          run: async () => {
            const text = await api.readText(key, name);
            try {
              return JSON.parse(text);
            } catch {
              throw new BridgeRefusal(`Item "${name}" is not valid JSON`);
            }
          },
        };
      }
      if (as === "dataUrl") {
        return {
          mutating: false,
          run: async () => {
            const { blob, recordedMimeType } = await api.readBlob(key, name);
            return blobToDataUrl(retypeForDataUrl(blob, recordedMimeType));
          },
        };
      }
      throw new BridgeRefusal("Invalid read format");
    }

    if (access !== "readwrite") throw new BridgeRefusal("This artifact has read-only storage access");
    if (op === "delete") {
      return {
        mutating: true,
        run: async () => {
          await api.remove(key, name);
          return null;
        },
      };
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
    return { mutating: true, run: () => api.write(key, name, body) };
  }

  async function perform(req: Record<string, unknown>): Promise<unknown> {
    if (access === "none" || !storageKey) throw new BridgeRefusal("This artifact has no storage access");
    const { mutating, run } = prepare(req, storageKey);

    // From here on the request reaches the server, so everything is metered.
    // The re-check comes first, metered by the shared lookup and only if it has
    // to fetch (no check of this artifact fresh enough for this op, from any
    // mount); then the call. That order matters under contention: paying for
    // the call first let a token trickling in go to a call whose stale check
    // could then not be paid for — every time, so a few spinning artifacts
    // starved each other forever. A check paid for is shared and kept, so the
    // next attempt needs only the call's token.
    const recheck = opts.recheck;
    if (recheck) {
      try {
        await check(recheck, mutating ? ARTIFACT_BRIDGE_WRITE_RECHECK_MS : ARTIFACT_BRIDGE_READ_RECHECK_MS);
      } catch (err) {
        if (err instanceof RateLimitedError) throw new BridgeRefusal(rateLimitMessage());
        throw new BridgeRefusal("Could not re-check the artifact's storage access; try again");
      }
      // Read through a call: TS narrowed `access` above and cannot see that the check may have lowered it.
      const current = granted();
      if (current === "none") throw new BridgeRefusal("This artifact's storage access has been revoked");
      if (mutating && current !== "readwrite") throw new BridgeRefusal("This artifact has read-only storage access");
    }
    if (!budget.spend(1)) throw new BridgeRefusal(rateLimitMessage());
    return run();
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
    if (active >= ARTIFACT_BRIDGE_LIMITS.maxInFlight) {
      const reply: BridgeReplyMessage = {
        __callboard: BRIDGE_REPLY,
        id: msg.id,
        ok: false,
        error: `${RATE_LIMITED}: at most ${ARTIFACT_BRIDGE_LIMITS.maxInFlight} storage requests may be in flight at once; wait for one to finish`,
      };
      p.postMessage(reply);
      return;
    }
    active += 1;
    const done = answer(p, msg).finally(() => {
      active -= 1;
    });
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
  }

  function revoke(): void {
    revoked = true;
    if (port) {
      port.onmessage = null;
      port.close();
    }
    port = null; // nothing of the bridge keeps the dead port alive
  }

  return {
    token,
    get revoked() {
      return revoked;
    },
    get bound() {
      return port !== null;
    },
    get access() {
      return access;
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
    async refresh() {
      const recheck = opts.recheck;
      if (revoked || !port || !recheck || access === "none") return;
      // Over budget or could not look: nothing recorded, so the next request checks instead.
      await check(recheck, ARTIFACT_BRIDGE_READ_RECHECK_MS).catch(() => undefined);
    },
    revoke,
  };
}
