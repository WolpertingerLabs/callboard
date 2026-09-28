import { ARTIFACT_BRIDGE_LIMITS, ARTIFACT_BRIDGE_READY_TIMEOUT_MS } from "shared/types/index.js";

/**
 * The storage bridge shim — the iframe side of the artifact storage bridge.
 *
 * Injected into every rendered HTML artifact (routes/artifacts.ts). It exposes
 *
 *   window.callboard = {
 *     ready: Promise<{ storageKey: string | null, access: "none" | "read" | "readwrite" }>,
 *     storage: { list(), read(name, { as }), write(name, data, { mimeType, encoding }), delete(name) },
 *   }
 *
 * and speaks the protocol typed in shared/types/artifact.ts to the host
 * renderer, which performs each op against the ONE bound key.
 *
 * The handshake: the render route injects this mount's bridge token (from the
 * frame's `?bridge=` src) as the IIFE's argument. The shim creates a
 * `MessageChannel`, posts `{ artifact-bridge-hello, token }` to `window.parent`
 * transferring one port, and from then on talks ONLY over the other port: the
 * init and every reply arrive on it, every request (carrying the token) leaves
 * on it. The host never sends anything to the frame's window, so a document
 * that replaces this one in the frame has nothing to receive.
 *
 * What the shim enforces (the host enforces all of it again — the shim runs
 * inside the artifact, so it is convenience, never the boundary):
 *  - only the FIRST init is honoured — a later one cannot rebind or raise access;
 *  - requests made before init are queued (they wait on `ready`);
 *  - at most ARTIFACT_BRIDGE_LIMITS.maxInFlight requests are outstanding at
 *    once; the rest wait their turn here, so `Promise.all` over many reads
 *    works instead of tripping the host's in-flight refusal. Past the host's
 *    rate budget a call rejects with "rate limited"; when that refusal
 *    carries `retryAfterMs`, the render's calls made after it wait here
 *    until then (capped at ARTIFACT_BRIDGE_LIMITS.maxRetryAfterMs) before
 *    being sent — so a loop that retries at once costs a round trip per
 *    token, not millions of refusals a second;
 *  - unbound or `access: "none"` ⇒ every call rejects; `read` ⇒ writes and
 *    deletes reject.
 *
 * `ready` resolves (never rejects), with `{ storageKey: null, access: "none" }`
 * for an unbound render — including a render with no token (opened outside
 * the renderer) and a top-level open (no parent to talk to).
 *
 * It also settles when the host never answers. The host binds only the FIRST
 * valid hello of a mount and nothing after the frame's second load, so some
 * documents are (correctly) never answered: the artifact after the user
 * follows a link inside it and comes back (the frame refetches the same URL,
 * token and all, into a bridge that is already revoked), or a shim whose hello
 * lost the race to a hello the artifact's own code sent first. Rather than
 * hang, `ready` resolves unbound after {@link ARTIFACT_BRIDGE_READY_TIMEOUT_MS}
 * with a `reason`, and an init arriving later is ignored. Re-opening the chat
 * (a fresh mount) renders it bound again.
 *
 * ES2019, no dependencies.
 */
export const ARTIFACT_BRIDGE_SHIM_JS = `(function(token){
  "use strict";
  var host = window.parent;
  var port = null, bound = false, key = null, access = "none", seq = 0, pending = {};
  var MAX_IN_FLIGHT = ${ARTIFACT_BRIDGE_LIMITS.maxInFlight}, active = 0, waiting = [];
  var MAX_HOLD = ${ARTIFACT_BRIDGE_LIMITS.maxRetryAfterMs}, holdUntil = 0, holdTimer = null;
  var resolveReady;
  var ready = new Promise(function(resolve){ resolveReady = resolve; });
  var ACCESS = { none: 1, read: 1, readwrite: 1 };

  if (typeof token !== "string" || !token || host === window || typeof MessageChannel !== "function") {
    resolveReady(Object.freeze({ storageKey: null, access: "none" }));
  } else {
    var channel = new MessageChannel();
    port = channel.port1;
    var readyTimer = setTimeout(function(){
      if (bound) return;
      bound = true; /* a late init is ignored: ready has settled unbound */
      resolveReady(Object.freeze({ storageKey: null, access: "none", reason: "the host did not answer the storage bridge (this document was reloaded or revisited, or another hello came first); storage is unavailable until the artifact is rendered again" }));
    }, ${ARTIFACT_BRIDGE_READY_TIMEOUT_MS});
    port.onmessage = function(e){
      var d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.__callboard === "artifact-bridge-init") {
        if (bound) return;
        bound = true;
        clearTimeout(readyTimer);
        key = typeof d.storageKey === "string" && d.storageKey ? d.storageKey : null;
        access = key && ACCESS[d.access] === 1 ? d.access : "none";
        resolveReady(Object.freeze({ storageKey: key, access: access }));
      } else if (d.__callboard === "artifact-bridge-reply") {
        if (!bound || typeof d.id !== "string" || !Object.prototype.hasOwnProperty.call(pending, d.id)) return;
        var p = pending[d.id];
        delete pending[d.id];
        active--;
        if (d.ok !== true && typeof d.retryAfterMs === "number" && d.retryAfterMs > 0) {
          holdUntil = Math.max(holdUntil, Date.now() + Math.min(d.retryAfterMs, MAX_HOLD));
        }
        pump();
        if (d.ok === true) p.resolve(d.result);
        else p.reject(new Error(typeof d.error === "string" && d.error ? d.error : "callboard storage request failed"));
      }
    };
    host.postMessage({ __callboard: "artifact-bridge-hello", token: token }, "*", [channel.port2]);
  }

  /* Send what may go: nothing while held back by a retry hint, and never more than MAX_IN_FLIGHT at once. */
  function pump(){
    var wait = holdUntil - Date.now();
    if (wait > 0) {
      if (!holdTimer && waiting.length) holdTimer = setTimeout(function(){ holdTimer = null; pump(); }, wait);
      return;
    }
    while (waiting.length && active < MAX_IN_FLIGHT) waiting.shift()();
  }

  function toBase64(bytes){
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function call(op, fields){
    return ready.then(function(){
      if (!key || access === "none") throw new Error("callboard storage is not available: this artifact was rendered without a storage key");
      if ((op === "write" || op === "delete") && access !== "readwrite") throw new Error("callboard storage is read-only for this render");
      return new Promise(function(resolve, reject){
        function send(){
          active++;
          var id = "r" + (++seq) + "-" + Math.random().toString(36).slice(2);
          pending[id] = { resolve: resolve, reject: reject };
          var msg = { __callboard: "artifact-bridge-request", token: token, id: id, op: op };
          for (var k in fields) if (fields[k] !== undefined) msg[k] = fields[k];
          port.postMessage(msg);
        }
        waiting.push(send);
        pump();
      });
    });
  }

  function name(n){
    if (typeof n !== "string" || !n) throw new TypeError("callboard storage: item name must be a non-empty string");
    return n;
  }

  var storage = Object.freeze({
    list: function(){ return call("list", {}); },
    read: function(n, opts){
      var as = (opts && opts.as) || "text";
      return Promise.resolve().then(function(){ return call("read", { name: name(n), as: as }); }).then(function(result){
        return as === "json" && typeof result === "string" ? JSON.parse(result) : result;
      });
    },
    write: function(n, data, opts){
      opts = opts || {};
      return Promise.resolve().then(function(){
        var fields = { name: name(n), mimeType: opts.mimeType, encoding: opts.encoding };
        if (typeof data === "string") {
          fields.data = data;
          if (!fields.encoding) fields.encoding = "utf8";
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          var view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          fields.data = toBase64(view);
          fields.encoding = "base64";
        } else {
          fields.data = JSON.stringify(data);
          if (fields.data === undefined) throw new TypeError("callboard storage: cannot serialize " + typeof data);
          fields.encoding = "utf8";
          if (!fields.mimeType) fields.mimeType = "application/json";
        }
        return call("write", fields);
      });
    },
    delete: function(n){
      return Promise.resolve().then(function(){ return call("delete", { name: name(n) }); });
    }
  });

  try {
    Object.defineProperty(window, "callboard", { value: Object.freeze({ ready: ready, storage: storage }), enumerable: true });
  } catch (err) {
    /* already defined non-configurably — leave the page's own value */
  }
})`;

/**
 * The shim wrapped in a script tag with this render's token bound, ready for
 * injection. `token` must already be validated against
 * ARTIFACT_BRIDGE_TOKEN_PATTERN (the route does); it is JSON-encoded, and `<`
 * escaped, regardless — nothing the caller passes can close the script.
 */
export function artifactBridgeShimScript(token: string | null): string {
  const arg = JSON.stringify(token).replace(/</g, "\\u003c");
  return `<script>${ARTIFACT_BRIDGE_SHIM_JS}(${arg});</script>`;
}
