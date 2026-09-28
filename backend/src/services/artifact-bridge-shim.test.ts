/**
 * The iframe side of the artifact storage bridge, executed for real.
 *
 * The shim is a string served inside artifact HTML, so it is run here in a
 * `vm` context against a fake `window` whose `parent` records every
 * postMessage. That exercises the exact bytes the browser gets, rather than a
 * re-implementation of them.
 */
import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { ARTIFACT_BRIDGE_SHIM_JS } from "./artifact-bridge-shim.js";

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: any;
  posted: Record<string, unknown>[];
  parent: { postMessage: ReturnType<typeof vi.fn> };
  dispatch(data: unknown, source?: unknown): void;
}

function boot(): Harness {
  const listeners: ((e: { data: unknown; source: unknown }) => void)[] = [];
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: vi.fn((msg: Record<string, unknown>) => posted.push(msg)) };
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: (e: { data: unknown; source: unknown }) => void) => {
      if (type === "message") listeners.push(fn);
    },
  };
  // Host intrinsics, so promises and typed arrays interoperate with the test.
  vm.runInContext(
    ARTIFACT_BRIDGE_SHIM_JS,
    vm.createContext({ window: win, Promise, Object, JSON, Math, String, Error, TypeError, ArrayBuffer, Uint8Array, btoa }),
  );
  return {
    cb: win.callboard,
    posted,
    parent,
    dispatch: (data, source = parent) => listeners.forEach((l) => l({ data, source })),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const init = (over: Record<string, unknown> = {}) => ({ __callboard: "artifact-bridge-init", nonce: "n-1", storageKey: "deck", access: "readwrite", ...over });
const reply = (id: unknown, over: Record<string, unknown> = {}) => ({ __callboard: "artifact-bridge-reply", id, ok: true, result: "R", ...over });

describe("artifact bridge shim", () => {
  it("queues requests made before init, then sends them with the nonce", async () => {
    const h = boot();
    const pending = h.cb.storage.read("deck.json", { as: "text" });
    await flush();
    expect(h.posted).toEqual([]);
    h.dispatch(init());
    await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "readwrite" });
    await flush();
    expect(h.posted).toEqual([{ __callboard: "artifact-bridge-request", nonce: "n-1", id: expect.any(String), op: "read", name: "deck.json", as: "text" }]);
    h.dispatch(reply(h.posted[0].id, { result: "hello" }));
    await expect(pending).resolves.toBe("hello");
    expect(h.parent.postMessage).toHaveBeenCalledWith(expect.anything(), "*");
  });

  it("ignores an init without a nonce, and one not from window.parent", async () => {
    const h = boot();
    const settled = vi.fn();
    h.cb.ready.then(settled);
    h.dispatch(init({ nonce: undefined }));
    h.dispatch(init({ nonce: "" }));
    h.dispatch(init({ nonce: 42 }));
    h.dispatch(init({ nonce: "evil" }), { postMessage() {} });
    h.dispatch(init({ nonce: "evil" }), null);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    h.dispatch(init({ nonce: "real" }));
    await flush();
    expect(settled).toHaveBeenCalledOnce();
    void h.cb.storage.list();
    await flush();
    expect(h.posted[0].nonce).toBe("real");
  });

  it("honours only the first init — a later one cannot rebind the key, raise access or swap the nonce", async () => {
    const h = boot();
    h.dispatch(init({ access: "read" }));
    h.dispatch(init({ nonce: "n-2", storageKey: "other", access: "readwrite" }));
    await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "read" });
    await expect(h.cb.storage.write("x.txt", "y")).rejects.toThrow(/read-only/);
    void h.cb.storage.list();
    await flush();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].nonce).toBe("n-1");
  });

  it("only accepts replies from window.parent, for ids it issued", async () => {
    const h = boot();
    h.dispatch(init());
    const p = h.cb.storage.list();
    await flush();
    const id = h.posted[0].id;
    const done = vi.fn();
    p.then(done, done);
    h.dispatch(reply(id, { result: ["forged"] }), { postMessage() {} });
    h.dispatch(reply("r999-unknown"));
    h.dispatch(reply("hasOwnProperty"));
    await flush();
    expect(done).not.toHaveBeenCalled();
    h.dispatch(reply(id, { result: [{ name: "deck.json" }] }));
    await expect(p).resolves.toEqual([{ name: "deck.json" }]);
    // A reply is consumed once.
    h.dispatch(reply(id, { result: "again" }));
  });

  it("rejects with the host's error message", async () => {
    const h = boot();
    h.dispatch(init());
    const p = h.cb.storage.delete("gone.txt");
    await flush();
    h.dispatch(reply(h.posted[0].id, { ok: false, error: "Item not found" }));
    await expect(p).rejects.toThrow("Item not found");
  });

  it("unbound: ready resolves {storageKey: null, access: 'none'} and every call rejects without messaging", async () => {
    const h = boot();
    h.dispatch(init({ storageKey: null, access: "readwrite" }));
    await expect(h.cb.ready).resolves.toEqual({ storageKey: null, access: "none" });
    for (const call of [() => h.cb.storage.list(), () => h.cb.storage.read("a"), () => h.cb.storage.write("a", "b"), () => h.cb.storage.delete("a")]) {
      await expect(call()).rejects.toThrow(/without a storage key/);
    }
    expect(h.posted).toEqual([]);
  });

  it("access none (or anything unrecognised) behaves as unbound", async () => {
    for (const access of ["none", "admin", undefined]) {
      const h = boot();
      h.dispatch(init({ access }));
      await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "none" });
      await expect(h.cb.storage.list()).rejects.toThrow(/not available/);
      expect(h.posted).toEqual([]);
    }
  });

  it("read access: reads go out, writes and deletes are refused locally", async () => {
    const h = boot();
    h.dispatch(init({ access: "read" }));
    await expect(h.cb.storage.write("a.txt", "b")).rejects.toThrow(/read-only/);
    await expect(h.cb.storage.delete("a.txt")).rejects.toThrow(/read-only/);
    void h.cb.storage.read("a.txt");
    await flush();
    expect(h.posted.map((m) => m.op)).toEqual(["read"]);
  });

  it("write: strings as utf8; objects as JSON with application/json; bytes as base64", async () => {
    const h = boot();
    h.dispatch(init());
    void h.cb.storage.write("a.txt", "héllo", { mimeType: "text/plain" });
    void h.cb.storage.write("deck.json", { seen: 3 });
    void h.cb.storage.write("img.png", new Uint8Array([1, 2, 3]), { mimeType: "image/png" });
    await flush();
    expect(h.posted.map(({ op, name, data, encoding, mimeType }) => ({ op, name, data, encoding, mimeType }))).toEqual([
      { op: "write", name: "a.txt", data: "héllo", encoding: "utf8", mimeType: "text/plain" },
      { op: "write", name: "deck.json", data: '{"seen":3}', encoding: "utf8", mimeType: "application/json" },
      { op: "write", name: "img.png", data: "AQID", encoding: "base64", mimeType: "image/png" },
    ]);
  });

  it("read as json parses a string result and passes a parsed one through", async () => {
    const h = boot();
    h.dispatch(init());
    const a = h.cb.storage.read("deck.json", { as: "json" });
    const b = h.cb.storage.read("deck.json", { as: "json" });
    await flush();
    h.dispatch(reply(h.posted[0].id, { result: '{"cards":[1]}' }));
    h.dispatch(reply(h.posted[1].id, { result: { cards: [2] } }));
    await expect(a).resolves.toEqual({ cards: [1] });
    await expect(b).resolves.toEqual({ cards: [2] });
  });

  it("rejects a non-string name, and window.callboard cannot be replaced", async () => {
    const h = boot();
    h.dispatch(init());
    await expect(h.cb.storage.read(42)).rejects.toThrow(TypeError);
    expect(Object.isFrozen(h.cb)).toBe(true);
    expect(Object.isFrozen(h.cb.storage)).toBe(true);
  });
});
