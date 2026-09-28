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
 * and speaks the protocol typed in shared/types/artifact.ts over postMessage
 * to the host renderer, which performs each op against the ONE bound key.
 *
 * What the shim enforces (the host enforces all of it again — the shim runs
 * inside the artifact, so it is convenience, never the boundary):
 *  - only messages whose `source` is `window.parent` are read;
 *  - only the FIRST init is honoured, and only if it carries a nonce — a later
 *    init cannot rebind the key or raise access;
 *  - every request carries that nonce; requests made before init are queued
 *    (they wait on `ready`);
 *  - unbound or `access: "none"` ⇒ every call rejects; `read` ⇒ writes and
 *    deletes reject.
 *
 * `ready` resolves (never rejects), with `{ storageKey: null, access: "none" }`
 * for an unbound render. ES2019, no dependencies.
 */
export const ARTIFACT_BRIDGE_SHIM_JS = `(function(){
  "use strict";
  var host = window.parent;
  var nonce = null, key = null, access = "none", seq = 0, pending = {};
  var resolveReady;
  var ready = new Promise(function(resolve){ resolveReady = resolve; });
  var ACCESS = { none: 1, read: 1, readwrite: 1 };

  window.addEventListener("message", function(e){
    if (e.source !== host || host === window) return;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.__callboard === "artifact-bridge-init") {
      if (nonce !== null || typeof d.nonce !== "string" || !d.nonce) return;
      nonce = d.nonce;
      key = typeof d.storageKey === "string" && d.storageKey ? d.storageKey : null;
      access = key && ACCESS[d.access] === 1 ? d.access : "none";
      resolveReady(Object.freeze({ storageKey: key, access: access }));
    } else if (d.__callboard === "artifact-bridge-reply") {
      if (nonce === null || typeof d.id !== "string" || !Object.prototype.hasOwnProperty.call(pending, d.id)) return;
      var p = pending[d.id];
      delete pending[d.id];
      if (d.ok === true) p.resolve(d.result);
      else p.reject(new Error(typeof d.error === "string" && d.error ? d.error : "callboard storage request failed"));
    }
  });

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
        var id = "r" + (++seq) + "-" + Math.random().toString(36).slice(2);
        pending[id] = { resolve: resolve, reject: reject };
        var msg = { __callboard: "artifact-bridge-request", nonce: nonce, id: id, op: op };
        for (var k in fields) if (fields[k] !== undefined) msg[k] = fields[k];
        host.postMessage(msg, "*");
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
})();`;

/** The shim wrapped in a script tag, ready for injection. */
export const ARTIFACT_BRIDGE_SHIM_SCRIPT = `<script>${ARTIFACT_BRIDGE_SHIM_JS}</script>`;
