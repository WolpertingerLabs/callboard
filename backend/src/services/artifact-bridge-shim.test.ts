/**
 * The iframe side of the artifact storage bridge, executed for real.
 *
 * The shim is a string served inside artifact HTML, so it is run here in a
 * `vm` context against a fake `window` whose `parent` records every
 * postMessage — with Node's real `MessageChannel`, so the port it transfers in
 * its hello is a real port the test then speaks the host side over. That
 * exercises the exact bytes the browser gets, rather than a re-implementation
 * of them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { ARTIFACT_BRIDGE_LIMITS, ARTIFACT_BRIDGE_READY_TIMEOUT_MS } from "shared/types/index.js";
import { ARTIFACT_BRIDGE_SHIM_JS, artifactBridgeShimScript } from "./artifact-bridge-shim.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: any;
  /** Everything the shim posted to window.parent, with what it transferred. */
  toParent: { msg: Record<string, unknown>; target: string; transfer?: unknown[] }[];
  /** Requests received on the host end of the port. */
  requests: Record<string, unknown>[];
  /** The host end of the port (undefined if no hello was sent). */
  port?: MessagePort;
  /** How many times the shim registered a listener on its own window — it must never. */
  windowListeners: number;
  send(data: unknown): void;
}

const ports: MessagePort[] = [];
afterEach(() => {
  while (ports.length) ports.pop()!.close();
});

/** The shim's timers, captured so a test can fire the ready timeout on demand. */
interface Timers {
  pending: Map<number, { fn: () => void; ms: number }>;
  fire(): void;
}

function fakeTimers(): Timers & { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (id: number) => void } {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => void pending.delete(id),
    fire() {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
  };
}

function boot(token: string | null = TOKEN, opts: { topLevel?: boolean; timers?: ReturnType<typeof fakeTimers>; clock?: { now: number } } = {}): Harness {
  const h: Harness = {
    cb: undefined,
    toParent: [],
    requests: [],
    windowListeners: 0,
    send(data) {
      if (!h.port) throw new Error("no port");
      h.port.postMessage(data);
    },
  };
  const parent = {
    postMessage: vi.fn((msg: Record<string, unknown>, target: string, transfer?: unknown[]) => {
      h.toParent.push({ msg, target, transfer });
      const p = transfer?.[0] as MessagePort | undefined;
      if (p) {
        h.port = p;
        ports.push(p);
        p.on("message", (m: Record<string, unknown>) => h.requests.push(m));
      }
    }),
  };
  const win: Record<string, unknown> = {
    addEventListener: () => {
      h.windowListeners += 1;
    },
  };
  win.parent = opts.topLevel ? win : parent;
  const timers = opts.timers ?? fakeTimers();
  const ctx = vm.createContext({
    window: win,
    Promise,
    Object,
    JSON,
    Math,
    String,
    Error,
    TypeError,
    ArrayBuffer,
    Uint8Array,
    btoa,
    MessageChannel,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Date: opts.clock ? { now: () => opts.clock!.now } : Date,
  });
  vm.runInContext(`${ARTIFACT_BRIDGE_SHIM_JS}(${JSON.stringify(token)});`, ctx);
  h.cb = win.callboard;
  return h;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const init = (over: Record<string, unknown> = {}) => ({ __callboard: "artifact-bridge-init", storageKey: "deck", access: "readwrite", ...over });
const reply = (id: unknown, over: Record<string, unknown> = {}) => ({ __callboard: "artifact-bridge-reply", id, ok: true, result: "R", ...over });

describe("artifact bridge shim", () => {
  it("says hello once to window.parent with its token, transferring exactly one port", () => {
    const h = boot();
    expect(h.toParent).toHaveLength(1);
    expect(h.toParent[0].msg).toEqual({ __callboard: "artifact-bridge-hello", token: TOKEN });
    expect(h.toParent[0].target).toBe("*");
    expect(h.toParent[0].transfer).toHaveLength(1);
  });

  it("never listens on its window: init and replies arrive only on the port", () => {
    const h = boot();
    expect(h.windowListeners).toBe(0);
  });

  it("queues requests made before init, then sends them over the port with the token", async () => {
    const h = boot();
    const pending = h.cb.storage.read("deck.json", { as: "text" });
    await flush();
    expect(h.requests).toEqual([]);
    h.send(init());
    await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "readwrite" });
    await flush();
    expect(h.requests).toEqual([{ __callboard: "artifact-bridge-request", token: TOKEN, id: expect.any(String), op: "read", name: "deck.json", as: "text" }]);
    h.send(reply(h.requests[0].id, { result: "hello" }));
    await expect(pending).resolves.toBe("hello");
    // Only the hello ever went to window.parent.
    expect(h.toParent).toHaveLength(1);
  });

  it("no token (opened outside the renderer): unbound at once, no hello, every call rejects", async () => {
    for (const token of [null, ""]) {
      const h = boot(token);
      await expect(h.cb.ready).resolves.toEqual({ storageKey: null, access: "none" });
      expect(h.toParent).toEqual([]);
      await expect(h.cb.storage.list()).rejects.toThrow(/without a storage key/);
    }
  });

  it(`ready never hangs: no init within ${ARTIFACT_BRIDGE_READY_TIMEOUT_MS} ms (a revisited document, a hello that lost the race) resolves it unbound, with a reason; a late init is ignored`, async () => {
    const timers = fakeTimers();
    const h = boot(TOKEN, { timers });
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([ARTIFACT_BRIDGE_READY_TIMEOUT_MS]);
    const early = h.cb.storage.list();
    timers.fire();
    const ready = await h.cb.ready;
    expect(ready).toMatchObject({ storageKey: null, access: "none" });
    expect(ready.reason).toMatch(/did not answer/);
    await expect(early).rejects.toThrow(/without a storage key/);
    h.send(init());
    await flush();
    await expect(h.cb.storage.write("x", "y")).rejects.toThrow(/without a storage key/);
    expect(h.requests).toEqual([]);
  });

  it(`keeps at most ${ARTIFACT_BRIDGE_LIMITS.maxInFlight} requests outstanding and queues the rest, so Promise.all over many reads works`, async () => {
    const h = boot();
    h.send(init());
    await h.cb.ready;
    const all = Promise.allSettled(Array.from({ length: 7 }, (_, i) => h.cb.storage.read(`n${i}`)));
    await flush();
    expect(h.requests.map((r) => r.name)).toEqual(["n0", "n1", "n2", "n3"]);
    h.send(reply(h.requests[0].id, { ok: false, error: "rate limited: x" }));
    h.send(reply(h.requests[1].id, { result: "one" }));
    await flush();
    expect(h.requests.map((r) => r.name)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5"]);
    for (const r of h.requests.slice(2)) h.send(reply(r.id));
    await flush();
    for (const r of h.requests.slice(6)) h.send(reply(r.id));
    const settled = await all;
    expect(settled.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect((settled[0] as PromiseRejectedResult).reason.message).toMatch(/rate limited/);
    expect(h.requests).toHaveLength(7);
  });

  it("an init before the timeout cancels it: ready resolves bound, with no reason", async () => {
    const timers = fakeTimers();
    const h = boot(TOKEN, { timers });
    h.send(init({ access: "read" }));
    await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "read" });
    expect(timers.pending.size).toBe(0);
  });

  it("opened top-level (no parent): unbound, no hello", async () => {
    const h = boot(TOKEN, { topLevel: true });
    await expect(h.cb.ready).resolves.toEqual({ storageKey: null, access: "none" });
    expect(h.toParent).toEqual([]);
  });

  it("honours only the first init — a later one cannot rebind the key or raise access", async () => {
    const h = boot();
    h.send(init({ access: "read" }));
    h.send(init({ storageKey: "other", access: "readwrite" }));
    await flush();
    await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "read" });
    await expect(h.cb.storage.write("x.txt", "y")).rejects.toThrow(/read-only/);
    void h.cb.storage.list();
    await flush();
    expect(h.requests).toHaveLength(1);
  });

  it("only settles ids it issued, once each", async () => {
    const h = boot();
    h.send(init());
    const p = h.cb.storage.list();
    await flush();
    const id = h.requests[0].id;
    const done = vi.fn();
    p.then(done, done);
    h.send(reply("r999-unknown"));
    h.send(reply("hasOwnProperty"));
    await flush();
    expect(done).not.toHaveBeenCalled();
    h.send(reply(id, { result: [{ name: "deck.json" }] }));
    await expect(p).resolves.toEqual([{ name: "deck.json" }]);
    h.send(reply(id, { result: "again" }));
    await flush();
    expect(done).toHaveBeenCalledOnce();
  });

  it("a reply before init is ignored", async () => {
    const h = boot();
    h.send(reply("r1-x"));
    await flush();
    const settled = vi.fn();
    h.cb.ready.then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
  });

  it("a rate-limit refusal carrying retryAfterMs holds the render's next calls back until then — they wait, not fail — and a bad hint is capped", async () => {
    const timers = fakeTimers();
    const clock = { now: 1_000_000 };
    const h = boot(TOKEN, { timers, clock });
    h.send(init());
    await h.cb.ready;
    timers.pending.clear(); // the ready timeout, settled already
    const first = h.cb.storage.list();
    await flush();
    h.send(reply(h.requests[0].id, { ok: false, error: "rate limited: slow down", retryAfterMs: 800 }));
    await expect(first).rejects.toThrow(/^rate limited/);
    // A retry at once, as a loop would: queued here, nothing sent.
    const retry = h.cb.storage.list();
    const other = h.cb.storage.read("a");
    await flush();
    expect(h.requests).toHaveLength(1);
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([800]);
    clock.now += 800;
    timers.fire();
    await flush();
    expect(h.requests.map((r) => r.op)).toEqual(["list", "list", "read"]);
    h.send(reply(h.requests[1].id, { result: [] }));
    h.send(reply(h.requests[2].id, { result: "A" }));
    expect(await retry).toEqual([]);
    expect(await other).toBe("A");
    // A success, or a failure without a hint, holds nothing back.
    h.send(reply("nope"));
    const next = h.cb.storage.read("b");
    await flush();
    expect(h.requests).toHaveLength(4);
    h.send(reply(h.requests[3].id, { ok: false, error: "Item not found" }));
    await expect(next).rejects.toThrow("Item not found");
    const c = h.cb.storage.read("c");
    await flush();
    expect(h.requests).toHaveLength(5);
    // An absurd hint is capped at ARTIFACT_BRIDGE_LIMITS.maxRetryAfterMs.
    h.send(reply(h.requests[4].id, { ok: false, error: "rate limited: x", retryAfterMs: 1e12 }));
    await expect(c).rejects.toThrow(/^rate limited/);
    await flush();
    void h.cb.storage.read("d");
    await flush();
    expect(h.requests).toHaveLength(5);
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([ARTIFACT_BRIDGE_LIMITS.maxRetryAfterMs]);
  });

  it("rejects with the host's error message", async () => {
    const h = boot();
    h.send(init());
    const p = h.cb.storage.delete("gone.txt");
    await flush();
    h.send(reply(h.requests[0].id, { ok: false, error: "Item not found" }));
    await expect(p).rejects.toThrow("Item not found");
  });

  it("unbound init: ready resolves {storageKey: null, access: 'none'} and every call rejects without messaging", async () => {
    const h = boot();
    h.send(init({ storageKey: null, access: "readwrite" }));
    await expect(h.cb.ready).resolves.toEqual({ storageKey: null, access: "none" });
    for (const call of [() => h.cb.storage.list(), () => h.cb.storage.read("a"), () => h.cb.storage.write("a", "b"), () => h.cb.storage.delete("a")]) {
      await expect(call()).rejects.toThrow(/without a storage key/);
    }
    await flush();
    expect(h.requests).toEqual([]);
  });

  it("access none (or anything unrecognised) behaves as unbound", async () => {
    for (const access of ["none", "admin", undefined]) {
      const h = boot();
      h.send(init({ access }));
      await expect(h.cb.ready).resolves.toEqual({ storageKey: "deck", access: "none" });
      await expect(h.cb.storage.list()).rejects.toThrow(/not available/);
      await flush();
      expect(h.requests).toEqual([]);
    }
  });

  it("read access: reads go out, writes and deletes are refused locally", async () => {
    const h = boot();
    h.send(init({ access: "read" }));
    await h.cb.ready;
    await expect(h.cb.storage.write("a.txt", "b")).rejects.toThrow(/read-only/);
    await expect(h.cb.storage.delete("a.txt")).rejects.toThrow(/read-only/);
    void h.cb.storage.read("a.txt");
    await flush();
    expect(h.requests.map((m) => m.op)).toEqual(["read"]);
  });

  it("write: strings as utf8; objects as JSON with application/json; bytes as base64", async () => {
    const h = boot();
    h.send(init());
    void h.cb.storage.write("a.txt", "héllo", { mimeType: "text/plain" });
    void h.cb.storage.write("deck.json", { seen: 3 });
    void h.cb.storage.write("img.png", new Uint8Array([1, 2, 3]), { mimeType: "image/png" });
    await flush();
    expect(h.requests.map(({ op, name, data, encoding, mimeType }) => ({ op, name, data, encoding, mimeType }))).toEqual([
      { op: "write", name: "a.txt", data: "héllo", encoding: "utf8", mimeType: "text/plain" },
      { op: "write", name: "deck.json", data: '{"seen":3}', encoding: "utf8", mimeType: "application/json" },
      { op: "write", name: "img.png", data: "AQID", encoding: "base64", mimeType: "image/png" },
    ]);
  });

  it("read as json parses a string result and passes a parsed one through", async () => {
    const h = boot();
    h.send(init());
    const a = h.cb.storage.read("deck.json", { as: "json" });
    const b = h.cb.storage.read("deck.json", { as: "json" });
    await flush();
    h.send(reply(h.requests[0].id, { result: '{"cards":[1]}' }));
    h.send(reply(h.requests[1].id, { result: { cards: [2] } }));
    await expect(a).resolves.toEqual({ cards: [1] });
    await expect(b).resolves.toEqual({ cards: [2] });
  });

  it("rejects a non-string name, and window.callboard cannot be replaced", async () => {
    const h = boot();
    h.send(init());
    await expect(h.cb.storage.read(42)).rejects.toThrow(TypeError);
    expect(Object.isFrozen(h.cb)).toBe(true);
    expect(Object.isFrozen(h.cb.storage)).toBe(true);
  });
});

describe("artifactBridgeShimScript", () => {
  it("binds the token as a JSON string argument, and nothing passed can close the script", () => {
    expect(artifactBridgeShimScript(TOKEN)).toBe(`<script>${ARTIFACT_BRIDGE_SHIM_JS}("${TOKEN}");</script>`);
    expect(artifactBridgeShimScript(null)).toBe(`<script>${ARTIFACT_BRIDGE_SHIM_JS}(null);</script>`);
    const hostile = artifactBridgeShimScript('</script><script>alert(1)</script>"');
    expect(hostile.match(/<\/script>/g)).toHaveLength(1);
    expect(hostile.endsWith("</script>")).toBe(true);
  });
});
