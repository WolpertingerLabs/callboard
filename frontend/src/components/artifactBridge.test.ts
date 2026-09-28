// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createArtifactBridge,
  makeBridgeToken,
  BRIDGE_HELLO,
  BRIDGE_INIT,
  BRIDGE_REPLY,
  BRIDGE_REQUEST,
  RATE_LIMITED,
  type ArtifactBridgeOptions,
  type BridgeStorageApi,
} from "./artifactBridge";
import {
  ARTIFACT_BRIDGE_LIMITS,
  ARTIFACT_BRIDGE_READ_RECHECK_MS,
  ARTIFACT_BRIDGE_WRITE_RECHECK_MS,
  ARTIFACT_BRIDGE_TOKEN_PATTERN,
  type ArtifactStorageAccess,
} from "../api";
import { createRequestBudget, createSharedLookup, createTabBudget, type RequestBudget } from "./artifactBudget";

/**
 * The host half of the artifact storage bridge, driven directly.
 *
 * Everything an artifact can reach goes through the one hello `handleMessage`
 * accepts and the port it binds, so this file is the security boundary's
 * test: the host never posts to the frame's window; it binds only to the
 * first hello from this mount's frame carrying this mount's token; it answers
 * only requests on that port carrying the token, before any second `load`, at
 * no more than the granted access, against the one bound key, for a valid
 * item name. Each rule gets a case that proves the refusal *and* that no
 * storage call was made — a refusal that still performed the write would pass
 * a reply-only assertion.
 *
 * Ports here are fakes whose `onmessage` the test calls directly (and
 * `bridge.settled()` awaits the answer), which keeps every case synchronous in
 * its ordering. tests/artifact-bridge.cross-boundary.test.ts runs the same
 * host against the served shim over a real MessageChannel.
 */

const BOUND = "bound-key";
const TOKEN = "0123456789abcdef0123456789abcdef";

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
}

function fakePort(): FakePort {
  return { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
}

function fakeApi(): BridgeStorageApi & { [K in keyof BridgeStorageApi]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => [{ name: "deck.json", mimeType: "application/json", size: 9, sha256: "x", created: "c", updated: "u" }]),
    readText: vi.fn(async () => '{"cards":1}'),
    readBlob: vi.fn(async () => ({ blob: new Blob(["hi"], { type: "image/png" }), recordedMimeType: "image/png" })),
    write: vi.fn(async (_k: string, name: string) => ({ name, mimeType: "text/plain", size: 2, sha256: "y", created: "c", updated: "u" })),
    remove: vi.fn(async () => undefined),
  };
}

function setup(
  access: ArtifactStorageAccess = "readwrite",
  storageKey: string | null = BOUND,
  extra: Pick<ArtifactBridgeOptions, "recheck" | "budget" | "budgetGroup" | "onAccessChange"> = {},
) {
  // The frame's window. The host must never post to it — every case checks.
  const frame = { postMessage: vi.fn() };
  const api = fakeApi();
  // A budget of its own unless the case shares one: the tab-wide default would leak between cases.
  const bridge = createArtifactBridge({
    getFrameWindow: () => frame as unknown as Window,
    storageKey,
    access,
    api,
    token: TOKEN,
    budget: createRequestBudget(),
    ...extra,
  });
  const port = fakePort();
  /** A hello as the window `message` event the host listens for. */
  const hello = (over: Record<string, unknown> = {}, source: unknown = frame, ports: unknown[] = [port]) =>
    bridge.handleMessage({ data: { __callboard: BRIDGE_HELLO, token: TOKEN, ...over }, source, ports } as unknown as MessageEvent);
  /** The shim's side of the port: post a request up it and wait for the answer. */
  const send = async (data: unknown, p: FakePort = port) => {
    p.onmessage?.({ data } as MessageEvent);
    await bridge.settled();
  };
  const req = (extra: Record<string, unknown>) => ({ __callboard: BRIDGE_REQUEST, token: TOKEN, id: "1", ...extra });
  const posted = (p: FakePort = port) => p.postMessage.mock.calls.map((c) => c[0]);
  /** Every reply posted down the port so far (the init excluded). */
  const replies = () => posted().filter((m) => m.__callboard === BRIDGE_REPLY);
  const inits = (p: FakePort = port) => posted(p).filter((m) => m.__callboard === BRIDGE_INIT);
  const storageCalls = () => Object.values(api).reduce((n, fn) => n + fn.mock.calls.length, 0);
  /** Bound, as after the shim's hello at parse time and the frame's first load. */
  const ready = () => {
    hello();
    bridge.handleLoad();
  };
  return { frame, api, bridge, port, hello, send, req, posted, replies, inits, storageCalls, ready };
}

describe("artifact bridge — handshake", () => {
  it("binds to a valid hello and sends init (key, access — no secret) down its port, never to the frame's window", () => {
    const t = setup("read");
    t.hello();
    expect(t.bridge.bound).toBe(true);
    expect(t.posted()).toEqual([{ __callboard: BRIDGE_INIT, storageKey: BOUND, access: "read" }]);
    expect(t.port.postMessage.mock.calls[0]).toHaveLength(1); // a port has no targetOrigin
    t.bridge.handleLoad();
    expect(t.posted()).toHaveLength(1);
    expect(t.frame.postMessage).not.toHaveBeenCalled();
  });

  it("a load never posts anything, to the frame or anywhere", () => {
    const t = setup();
    t.bridge.handleLoad();
    t.bridge.handleLoad();
    expect(t.frame.postMessage).not.toHaveBeenCalled();
    expect(t.port.postMessage).not.toHaveBeenCalled();
  });

  it("an unbound render is told access none, whatever access was passed", () => {
    const t = setup("readwrite", null);
    t.hello();
    expect(t.inits()).toEqual([{ __callboard: BRIDGE_INIT, storageKey: null, access: "none" }]);
  });

  it.each([
    ["wrong token", { token: "f".repeat(32) }],
    ["missing token", { token: undefined }],
    ["non-string token", { token: 12345 }],
    ["token of another shape", { token: TOKEN.toUpperCase() }],
    ["wrong message type", { __callboard: BRIDGE_REQUEST }],
  ])("a hello with a %s binds nothing and gets nothing", (_label, over) => {
    const t = setup();
    t.hello(over);
    expect(t.bridge.bound).toBe(false);
    expect(t.port.onmessage).toBeNull();
    expect(t.port.postMessage).not.toHaveBeenCalled();
    expect(t.frame.postMessage).not.toHaveBeenCalled();
    // The real one still binds afterwards.
    t.hello();
    expect(t.inits()).toHaveLength(1);
  });

  it("a correctly-tokened hello from any other source binds nothing", () => {
    const t = setup();
    const other = { postMessage: vi.fn() };
    for (const source of [other, null, window]) t.hello({}, source);
    expect(t.bridge.bound).toBe(false);
    expect(t.port.postMessage).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it("a hello without a port binds nothing", () => {
    const t = setup();
    t.hello({}, undefined, []);
    expect(t.bridge.bound).toBe(false);
  });

  it("only the first valid hello binds — a later one (another port) gets no init and is never listened to", () => {
    const t = setup();
    t.hello();
    const second = fakePort();
    t.hello({}, undefined, [second]);
    expect(second.postMessage).not.toHaveBeenCalled();
    expect(second.onmessage).toBeNull();
    expect(t.inits()).toHaveLength(1);
  });

  it("a hello after the second load binds nothing (the bridge is dead)", () => {
    const t = setup();
    t.bridge.handleLoad();
    t.bridge.handleLoad();
    t.hello();
    expect(t.bridge.bound).toBe(false);
    expect(t.port.postMessage).not.toHaveBeenCalled();
  });

  it("tokens come from the CSPRNG, 128 bits, lowercase hex, fresh per mount", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    const a = makeBridgeToken();
    const b = createArtifactBridge({ getFrameWindow: () => null, storageKey: BOUND, access: "read" }).token;
    expect(spy).toHaveBeenCalled();
    expect(a).toMatch(ARTIFACT_BRIDGE_TOKEN_PATTERN);
    expect(b).toMatch(ARTIFACT_BRIDGE_TOKEN_PATTERN);
    expect(a).not.toBe(b);
    spy.mockRestore();
  });
});

describe("artifact bridge — operations", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup("readwrite");
    t.ready();
  });

  it("read as text returns the item's text from the bound key", async () => {
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.api.readText).toHaveBeenCalledWith(BOUND, "deck.json");
    expect(t.replies()).toEqual([{ __callboard: BRIDGE_REPLY, id: "1", ok: true, result: '{"cards":1}' }]);
  });

  it("read as json parses", async () => {
    await t.send(t.req({ op: "read", name: "deck.json", as: "json" }));
    expect(t.replies()[0]).toMatchObject({ ok: true, result: { cards: 1 } });
  });

  it("read as dataUrl returns a data: URL", async () => {
    await t.send(t.req({ op: "read", name: "img-1.png", as: "dataUrl" }));
    expect(t.api.readBlob).toHaveBeenCalledWith(BOUND, "img-1.png");
    expect(t.replies()[0].result).toMatch(/^data:image\/png;base64,/);
  });

  it.each([
    ["an SVG (served as octet-stream) is re-typed with its recorded image type", "image/svg+xml", "image/svg+xml"],
    ["recorded type is case-normalised", "IMAGE/SVG+XML", "image/svg+xml"],
    ["any image/* recorded type is used", "image/bmp", "image/bmp"],
    ["a non-image recorded type is NOT used (html stays octet-stream)", "text/html", "application/octet-stream"],
    ["nor is javascript", "text/javascript", "application/octet-stream"],
    ["nor a type with parameters", "image/svg+xml; charset=utf-8", "application/octet-stream"],
    ["nor a header-smuggled value", "image/svg+xml\r\nX: y", "application/octet-stream"],
    ["no recorded type → as served", undefined, "application/octet-stream"],
  ])("dataUrl: %s", async (_label, recordedMimeType, expected) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    t.api.readBlob.mockResolvedValueOnce({ blob: new Blob([svg], { type: "application/octet-stream" }), recordedMimeType });
    await t.send(t.req({ op: "read", name: "logo.svg", as: "dataUrl" }));
    const url = t.replies()[0].result as string;
    expect(url.startsWith(`data:${expected};base64,`)).toBe(true);
    expect(atob(url.slice(url.indexOf(",") + 1))).toBe(svg);
  });

  it("list returns item metadata", async () => {
    await t.send(t.req({ op: "list" }));
    expect(t.api.list).toHaveBeenCalledWith(BOUND);
    expect(t.replies()[0]).toMatchObject({ ok: true, result: [{ name: "deck.json" }] });
  });

  it("write utf8 → content, base64 → content_base64, mimeType passed through", async () => {
    await t.send(t.req({ op: "write", name: "a.txt", data: "hi", mimeType: "text/plain" }));
    await t.send(t.req({ id: "2", op: "write", name: "b.bin", data: "aGk=", encoding: "base64" }));
    expect(t.api.write).toHaveBeenNthCalledWith(1, BOUND, "a.txt", { content: "hi", mimeType: "text/plain" });
    expect(t.api.write).toHaveBeenNthCalledWith(2, BOUND, "b.bin", { content_base64: "aGk=", mimeType: undefined });
    expect(t.replies().map((r) => r.ok)).toEqual([true, true]);
  });

  it("delete removes from the bound key", async () => {
    await t.send(t.req({ op: "delete", name: "a.txt" }));
    expect(t.api.remove).toHaveBeenCalledWith(BOUND, "a.txt");
    expect(t.replies()[0]).toMatchObject({ ok: true });
  });

  it("server errors come back as ok:false with the message", async () => {
    t.api.readText.mockRejectedValueOnce(new Error("Not found"));
    await t.send(t.req({ op: "read", name: "missing.txt" }));
    expect(t.replies()[0]).toEqual({ __callboard: BRIDGE_REPLY, id: "1", ok: false, error: "Not found" });
  });

  it.each([
    ["bad base64", { op: "write", name: "x", data: "@@@=", encoding: "base64" }],
    ["unknown encoding", { op: "write", name: "x", data: "a", encoding: "latin1" }],
    ["non-string data", { op: "write", name: "x", data: { a: 1 } }],
    ["bad mimeType", { op: "write", name: "x", data: "a", mimeType: "text/html\r\nX-Evil: 1" }],
    ["oversize", { op: "write", name: "x", data: "A".repeat(4 * 1024 * 1024 * 9) }],
    ["unknown op", { op: "rename", name: "x" }],
    ["unknown read format", { op: "read", name: "x", as: "arraybuffer" }],
  ])("refuses %s without touching storage", async (_label, extra) => {
    await t.send(t.req(extra));
    expect(t.replies()[0]).toMatchObject({ ok: false });
    expect(t.storageCalls()).toBe(0);
  });
});

describe("artifact bridge — access", () => {
  it.each(["write", "delete"])("%s is refused under read, and nothing is written", async (op) => {
    const t = setup("read");
    t.ready();
    await t.send(t.req({ op, name: "deck.json", data: "x" }));
    expect(t.replies()[0]).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(t.api.write).not.toHaveBeenCalled();
    expect(t.api.remove).not.toHaveBeenCalled();
  });

  it("read still works under read", async () => {
    const t = setup("read");
    t.ready();
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.replies()[0]).toMatchObject({ ok: true });
  });

  it.each(["list", "read", "write", "delete"])("%s is refused under none", async (op) => {
    const t = setup("none");
    t.ready();
    await t.send(t.req({ op, name: "deck.json", data: "x" }));
    expect(t.replies()[0]).toMatchObject({ ok: false });
    expect(t.storageCalls()).toBe(0);
  });

  it("everything is refused when unbound, even if readwrite was passed", async () => {
    const t = setup("readwrite", null);
    t.ready();
    await t.send(t.req({ op: "list" }));
    await t.send(t.req({ id: "2", op: "write", name: "a", data: "x" }));
    expect(t.replies().map((r) => r.ok)).toEqual([false, false]);
    expect(t.storageCalls()).toBe(0);
  });
});

describe("artifact bridge — who may ask", () => {
  it.each([
    ["wrong token", { token: "0".repeat(32) }],
    ["missing token", { token: undefined }],
    ["non-string token", { token: 12345 }],
  ])("a request on the bound port with a %s is ignored — no reply, no storage call", async (_label, override) => {
    const t = setup();
    t.ready();
    await t.send({ ...t.req({ op: "read", name: "deck.json" }), ...override });
    expect(t.replies()).toEqual([]);
    expect(t.storageCalls()).toBe(0);
  });

  it("a correctly-tokened request posted to the host window (not the port) is ignored, from any source", async () => {
    const t = setup();
    t.ready();
    for (const source of [t.frame, null, window]) t.bridge.handleMessage({ data: t.req({ op: "read", name: "deck.json" }), source, ports: [] } as unknown as MessageEvent);
    await t.bridge.settled();
    expect(t.replies()).toEqual([]);
    expect(t.storageCalls()).toBe(0);
  });

  it("requests before a valid hello have nowhere to go", async () => {
    const t = setup();
    t.hello({ token: "f".repeat(32) }); // rejected: its port is never listened to
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.storageCalls()).toBe(0);
    expect(t.port.postMessage).not.toHaveBeenCalled();
  });

  it("non-request messages on the port are ignored", async () => {
    const t = setup();
    t.ready();
    await t.send({ type: "canvas-resize", height: 10 });
    await t.send({ __callboard: BRIDGE_REPLY, token: TOKEN, id: "1", ok: true });
    await t.send(null);
    expect(t.replies()).toEqual([]);
    expect(t.storageCalls()).toBe(0);
  });
});

describe("artifact bridge — revocation", () => {
  it("a second load revokes the bridge permanently and closes the port", async () => {
    const t = setup();
    t.ready();
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.replies()).toHaveLength(1);

    t.bridge.handleLoad(); // the frame navigated itself
    expect(t.bridge.revoked).toBe(true);
    expect(t.port.close).toHaveBeenCalled();
    await t.send(t.req({ id: "2", op: "read", name: "deck.json" }));
    t.bridge.handleLoad();
    await t.send(t.req({ id: "3", op: "write", name: "deck.json", data: "x" }));
    expect(t.replies()).toHaveLength(1);
    expect(t.api.readText).toHaveBeenCalledTimes(1);
    expect(t.api.write).not.toHaveBeenCalled();
    // …and nothing ever went to the frame's window, so the new document received nothing.
    expect(t.frame.postMessage).not.toHaveBeenCalled();
    expect(t.inits()).toHaveLength(1);
  });

  it("the artifact navigating away before its first load: the foreign page's load does not revoke, but it can bind nothing and receive nothing", async () => {
    const t = setup();
    t.hello(); // the artifact's shim ran, then it navigated before its own load fired
    t.bridge.handleLoad(); // the FOREIGN page's load is the frame's first
    const foreignPort = fakePort();
    t.hello({ token: undefined }, undefined, [foreignPort]);
    t.hello({ token: "f".repeat(32) }, undefined, [foreignPort]);
    expect(foreignPort.postMessage).not.toHaveBeenCalled();
    expect(foreignPort.onmessage).toBeNull();
    expect(t.frame.postMessage).not.toHaveBeenCalled();
  });

  it("a reply in flight when the frame navigates is never delivered", async () => {
    const t = setup();
    t.ready();
    let release!: (v: string) => void;
    t.api.readText.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    t.port.onmessage!({ data: t.req({ op: "read", name: "deck.json" }) } as MessageEvent);
    t.bridge.handleLoad();
    release("secret");
    await t.bridge.settled();
    expect(t.replies()).toEqual([]);
  });

  it("a reply in flight when the frame unmounts (revoke) is never delivered", async () => {
    const t = setup();
    t.ready();
    let release!: (v: string) => void;
    t.api.readText.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    t.port.onmessage!({ data: t.req({ op: "read", name: "deck.json" }) } as MessageEvent);
    t.bridge.revoke();
    release("secret");
    await t.bridge.settled();
    expect(t.replies()).toEqual([]);
    expect(t.port.close).toHaveBeenCalled();
  });

  it("revoke() refuses everything after it", async () => {
    const t = setup();
    t.ready();
    t.bridge.revoke();
    await t.send(t.req({ op: "list" }));
    expect(t.storageCalls()).toBe(0);
  });
});

describe("artifact bridge — names and keys", () => {
  it.each([
    ["..", ".."],
    [".", "."],
    ["leading dot", ".hidden"],
    ["slash", "a/b"],
    ["traversal", "../other-key/items/deck.json"],
    ["backslash", "a\\b"],
    ["NUL", "a\u0000b"],
    ["encoded dots", "%2e%2e"],
    ["unicode lookalike", "ｄeck.json"],
    ["empty", ""],
    ["over-length", "a".repeat(129)],
    ["non-string", 42],
    ["missing", undefined],
  ])("rejects item name: %s", async (_label, name) => {
    const t = setup();
    t.ready();
    for (const op of ["read", "write", "delete"]) await t.send(t.req({ op, name, data: "x" }));
    expect(t.replies().map((r) => [r.ok, r.error])).toEqual([
      [false, "Invalid item name"],
      [false, "Invalid item name"],
      [false, "Invalid item name"],
    ]);
    expect(t.storageCalls()).toBe(0);
  });

  it("accepts a 128-character name", async () => {
    const t = setup();
    t.ready();
    await t.send(t.req({ op: "read", name: "a".repeat(128) }));
    expect(t.replies()[0].ok).toBe(true);
  });

  it("a key in the request is ignored — every call addresses the bound key", async () => {
    const t = setup();
    t.ready();
    const other = { key: "other-key", storageKey: "other-key", storage_key: "other-key" };
    await t.send({ ...t.req({ op: "list" }), ...other });
    await t.send({ ...t.req({ id: "2", op: "read", name: "deck.json" }), ...other });
    await t.send({ ...t.req({ id: "3", op: "write", name: "deck.json", data: "x" }), ...other });
    await t.send({ ...t.req({ id: "4", op: "delete", name: "deck.json" }), ...other });
    const keysUsed = Object.values(t.api).flatMap((fn) => fn.mock.calls.map((c: unknown[]) => c[0]));
    expect(keysUsed).toHaveLength(4);
    expect(new Set(keysUsed)).toEqual(new Set([BOUND]));
  });
});

describe("artifact bridge — budget (host-side, before any request leaves)", () => {
  it(`at most ${ARTIFACT_BRIDGE_LIMITS.maxInFlight} requests in flight: the next fails at once with ${RATE_LIMITED}, touching nothing`, async () => {
    const t = setup("read");
    const gate: Array<() => void> = [];
    t.api.readText.mockImplementation(() => new Promise<string>((resolve) => gate.push(() => resolve("x"))));
    t.ready();
    for (let i = 0; i < ARTIFACT_BRIDGE_LIMITS.maxInFlight + 2; i++) t.port.onmessage?.({ data: t.req({ id: `r${i}`, op: "read", name: "a" }) } as MessageEvent);
    expect(t.api.readText).toHaveBeenCalledTimes(ARTIFACT_BRIDGE_LIMITS.maxInFlight);
    expect(t.replies()).toEqual([
      expect.objectContaining({ id: `r${ARTIFACT_BRIDGE_LIMITS.maxInFlight}`, ok: false, error: expect.stringMatching(new RegExp(`^${RATE_LIMITED}`)) }),
      expect.objectContaining({ id: `r${ARTIFACT_BRIDGE_LIMITS.maxInFlight + 1}`, ok: false, error: expect.stringMatching(new RegExp(`^${RATE_LIMITED}`)) }),
    ]);
    // A slot frees when one finishes.
    gate.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    t.port.onmessage?.({ data: t.req({ id: "later", op: "read", name: "a" }) } as MessageEvent);
    await new Promise((r) => setTimeout(r, 0));
    gate.forEach((g) => g());
    await t.bridge.settled();
    expect(t.api.readText).toHaveBeenCalledTimes(ARTIFACT_BRIDGE_LIMITS.maxInFlight + 1);
  });

  it(`a burst of ${ARTIFACT_BRIDGE_LIMITS.burst}, then ${ARTIFACT_BRIDGE_LIMITS.refillPerSecond}/s: over it, ${RATE_LIMITED} and no storage call`, async () => {
    let now = 0;
    const t = setup("read", BOUND, { budget: createRequestBudget(() => now) });
    t.ready();
    for (let i = 0; i < ARTIFACT_BRIDGE_LIMITS.burst + 5; i++) await t.send(t.req({ id: `l${i}`, op: "list" }));
    expect(t.api.list).toHaveBeenCalledTimes(ARTIFACT_BRIDGE_LIMITS.burst);
    expect(t.replies().filter((r) => !r.ok).map((r) => r.error.split(":")[0])).toEqual(Array(5).fill(RATE_LIMITED));
    now += 4000;
    for (let i = 0; i < 10; i++) await t.send(t.req({ id: `m${i}`, op: "list" }));
    expect(t.api.list).toHaveBeenCalledTimes(ARTIFACT_BRIDGE_LIMITS.burst + Math.floor(4 * ARTIFACT_BRIDGE_LIMITS.refillPerSecond));
  });

  it("by default each mount has its own account of the ONE tab budget: the tab's burst is first-come, its rate is split evenly, and a revoked mount stops counting", async () => {
    // Far enough ahead that the module's budget has refilled to full, then frozen.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000);
    try {
      const mk = () => setup("read", BOUND, { budget: undefined });
      const a = mk();
      const b = mk();
      a.ready();
      b.ready();
      for (let i = 0; i < ARTIFACT_BRIDGE_LIMITS.burst; i++) await a.send(a.req({ id: `a${i}`, op: "list" }));
      expect(a.replies().every((r) => r.ok)).toBe(true);
      // Five bubbles of one artifact, say: the tab's burst is gone, and b is told when its share will have a token.
      await b.send(b.req({ id: "b0", op: "list" }));
      const [refusal] = b.replies();
      expect(refusal).toMatchObject({ id: "b0", ok: false, error: expect.stringMatching(new RegExp(`^${RATE_LIMITED}`)) });
      expect(refusal.retryAfterMs).toBeGreaterThan(0);
      expect(refusal.retryAfterMs).toBeLessThanOrEqual(Math.ceil(1000 / (ARTIFACT_BRIDGE_LIMITS.refillPerSecond / 2)));
      expect(b.api.list).not.toHaveBeenCalled();
      // Both over-asking for 60 s: a, which had the burst, no longer gets more than b.
      for (let s = 1; s <= 60; s++) {
        vi.setSystemTime(Date.now() + 1000);
        for (let i = 0; i < 3; i++) {
          await a.send(a.req({ id: `a${s}-${i}`, op: "list" }));
          await b.send(b.req({ id: `b${s}-${i}`, op: "list" }));
        }
      }
      const aLate = a.api.list.mock.calls.length - ARTIFACT_BRIDGE_LIMITS.burst;
      const bLate = b.api.list.mock.calls.length;
      expect(Math.abs(aLate - bLate)).toBeLessThanOrEqual(1);
      expect(aLate + bLate).toBeGreaterThanOrEqual(Math.floor(60 * ARTIFACT_BRIDGE_LIMITS.refillPerSecond) - 1);
      // a unmounts: b alone has the whole rate.
      a.bridge.revoke();
      const before = b.api.list.mock.calls.length;
      for (let s = 1; s <= 20; s++) {
        vi.setSystemTime(Date.now() + 1000);
        for (let i = 0; i < 3; i++) await b.send(b.req({ id: `c${s}-${i}`, op: "list" }));
      }
      expect(b.api.list.mock.calls.length - before).toBeGreaterThanOrEqual(Math.floor(20 * ARTIFACT_BRIDGE_LIMITS.refillPerSecond) - 1);
      b.bridge.revoke();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refusals that need no server cost nothing: a flood of invalid names does not spend the budget", async () => {
    const t = setup("read", BOUND, { budget: createRequestBudget(() => 0) });
    t.ready();
    for (let i = 0; i < 100; i++) await t.send(t.req({ id: `b${i}`, op: "read", name: "../x" }));
    for (let i = 0; i < 100; i++) await t.send(t.req({ id: `w${i}`, op: "write", name: "a", data: "x" }));
    await t.send(t.req({ id: "ok", op: "list" }));
    expect(t.replies().at(-1)).toMatchObject({ id: "ok", ok: true });
  });
});

describe("artifact bridge — the live grant", () => {
  /**
   * Bridges whose re-check is the real shared lookup over a fake artifact
   * fetch (`fetches` counts server round-trips), on one clock and one budget —
   * as every bubble in a tab shares them.
   */
  function world(current: ArtifactStorageAccess | Error) {
    let now = 0;
    const state = { current };
    const fetches = vi.fn(async () => {
      if (state.current instanceof Error) throw state.current;
      return state.current;
    });
    const clock = () => now;
    const lookup = createSharedLookup<ArtifactStorageAccess>(fetches, clock);
    const budget: RequestBudget = createRequestBudget(clock);
    const mount = (access: ArtifactStorageAccess = "readwrite") => {
      const onAccessChange = vi.fn();
      const recheck = (maxAgeMs: number, b: RequestBudget) => lookup.get("art", maxAgeMs, b);
      const t = setup(access, BOUND, { recheck, budget, onAccessChange });
      t.ready();
      return { ...t, onAccessChange };
    };
    return { state, fetches, lookup, budget, mount, tick: (ms: number) => (now += ms), at: () => now };
  }
  const write = (id: string) => ({ __callboard: BRIDGE_REQUEST, token: TOKEN, id, op: "write", name: "a", data: "x" });

  it(`a write or delete relies on a check under ${ARTIFACT_BRIDGE_WRITE_RECHECK_MS} ms old, else checks first; a downgrade to read refuses it before any storage call`, async () => {
    const w = world("readwrite");
    const t = w.mount();
    await t.send(write("w1"));
    expect(w.fetches).toHaveBeenCalledTimes(1);
    w.tick(ARTIFACT_BRIDGE_WRITE_RECHECK_MS - 1);
    await t.send(write("w2"));
    expect(w.fetches).toHaveBeenCalledTimes(1);
    expect(t.api.write).toHaveBeenCalledTimes(2);
    w.state.current = "read";
    w.tick(1);
    await t.send(write("w3"));
    await t.send(t.req({ id: "d1", op: "delete", name: "a" }));
    expect(w.fetches).toHaveBeenCalledTimes(2);
    expect(t.api.write).toHaveBeenCalledTimes(2);
    expect(t.api.remove).not.toHaveBeenCalled();
    expect(t.replies().slice(2)).toEqual([
      expect.objectContaining({ id: "w3", ok: false, error: expect.stringMatching(/read-only/) }),
      expect.objectContaining({ id: "d1", ok: false, error: expect.stringMatching(/read-only/) }),
    ]);
    expect(t.onAccessChange).toHaveBeenCalledWith("read");
    expect(t.bridge.access).toBe("read");
    // Reads still work, and the grant never rises back.
    w.state.current = "readwrite";
    w.tick(ARTIFACT_BRIDGE_READ_RECHECK_MS);
    await t.send(t.req({ id: "r", op: "read", name: "a" }));
    expect(t.replies().at(-1)).toMatchObject({ id: "r", ok: true });
    expect(t.bridge.access).toBe("read");
  });

  it("gone / replaced / lowered to none (the check says none): every call is refused from then on", async () => {
    const w = world("none");
    const t = w.mount();
    await t.send(write("w"));
    await t.send(t.req({ id: "r", op: "read", name: "a" }));
    expect(t.replies().map((r) => [r.id, r.ok, r.error])).toEqual([
      ["w", false, expect.stringMatching(/revoked/)],
      ["r", false, expect.stringMatching(/no storage access/)],
    ]);
    expect(t.storageCalls()).toBe(0);
  });

  it(`reads use a check for up to ${ARTIFACT_BRIDGE_READ_RECHECK_MS} ms, then check again first`, async () => {
    const w = world("read");
    const t = w.mount("read");
    await t.send(t.req({ id: "r1", op: "read", name: "a" }));
    expect(w.fetches).toHaveBeenCalledTimes(1);
    w.tick(ARTIFACT_BRIDGE_READ_RECHECK_MS - 1);
    await t.send(t.req({ id: "r2", op: "list" }));
    expect(w.fetches).toHaveBeenCalledTimes(1);
    w.tick(1);
    w.state.current = "none";
    await t.send(t.req({ id: "r3", op: "read", name: "a" }));
    expect(w.fetches).toHaveBeenCalledTimes(2);
    expect(t.replies().at(-1)).toMatchObject({ id: "r3", ok: false, error: expect.stringMatching(/revoked/) });
    expect(t.api.readText).toHaveBeenCalledTimes(1);
  });

  it("a check that cannot be made refuses that request but keeps the grant", async () => {
    const w = world(new Error("network down"));
    const t = w.mount();
    await t.send(write("w"));
    expect(t.replies().at(-1)).toMatchObject({ id: "w", ok: false, error: expect.stringMatching(/could not re-check/i) });
    expect(t.api.write).not.toHaveBeenCalled();
    // The failure was not cached: the next request looks again at once.
    w.state.current = "readwrite";
    await t.send(write("w2"));
    expect(t.replies().at(-1)).toMatchObject({ id: "w2", ok: true });
    expect(w.fetches).toHaveBeenCalledTimes(2);
  });

  it("a check the budget cannot pay for is a rate-limit refusal, and the grant is kept", async () => {
    const w = world("readwrite");
    const t = w.mount();
    while (w.budget.spend(1));
    await t.send(write("w"));
    expect(t.replies().at(-1)).toMatchObject({ id: "w", ok: false, error: expect.stringMatching(new RegExp(`^${RATE_LIMITED}`)) });
    expect(w.fetches).not.toHaveBeenCalled();
    expect(t.api.write).not.toHaveBeenCalled();
    expect(t.bridge.access).toBe("readwrite");
  });

  it("the check is paid for before the call, so a lone token is never wasted: under contention requests still get through", async () => {
    const w = world("read");
    const mounts = Array.from({ length: 5 }, () => w.mount("read"));
    while (w.budget.spend(1));
    // One token per 500 ms, five spinners, a read window long expired: were the
    // call paid first, each token would go to a call whose check it then could
    // not pay for, and nothing would ever succeed.
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      w.tick(1000 / ARTIFACT_BRIDGE_LIMITS.refillPerSecond);
      for (const m of mounts) await m.send(m.req({ id: `r${i}`, op: "list" }));
    }
    for (const m of mounts) ok += m.replies().filter((r) => r.ok).length;
    // 40 tokens over the run: ≤ 5 checks (one per 5 s window) and the rest are calls.
    expect(ok).toBeGreaterThanOrEqual(40 - 5);
    expect(w.fetches.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("checks are shared per artifact: mounts of one artifact reuse each other's, and concurrent requests share one in flight", async () => {
    const w = world("readwrite");
    const mounts = Array.from({ length: 5 }, () => w.mount());
    // Five bubbles each write at once: one check between them.
    mounts.forEach((m, i) => m.port.onmessage?.({ data: write(`w${i}`) } as MessageEvent));
    await Promise.all(mounts.map((m) => m.bridge.settled()));
    expect(w.fetches).toHaveBeenCalledTimes(1);
    expect(mounts.every((m) => m.replies().every((r) => r.ok))).toBe(true);
    // A lowering seen through one bubble's check reaches the others' next requests without another fetch.
    w.tick(ARTIFACT_BRIDGE_WRITE_RECHECK_MS);
    w.state.current = "read";
    await mounts[0].send(write("x"));
    expect(w.fetches).toHaveBeenCalledTimes(2);
    await mounts[1].send(write("y"));
    expect(w.fetches).toHaveBeenCalledTimes(2);
    expect(mounts[1].replies().at(-1)).toMatchObject({ id: "y", ok: false, error: expect.stringMatching(/read-only/) });
  });

  it(`refresh() (the page became visible) is gated by the ${ARTIFACT_BRIDGE_READ_RECHECK_MS} ms read window and shared: 10 bubbles × 60 switches in 12 s cost 3 checks`, async () => {
    const w = world("readwrite");
    const mounts = Array.from({ length: 10 }, () => w.mount());
    for (let i = 0; i < 60; i++) {
      await Promise.all(mounts.map((m) => m.bridge.refresh()));
      w.tick(200);
    }
    expect(w.fetches).toHaveBeenCalledTimes(3); // t = 0, 5 s, 10 s
    // And it still lowers the grant when a check does happen.
    w.state.current = "read";
    w.tick(ARTIFACT_BRIDGE_READ_RECHECK_MS);
    await Promise.all(mounts.map((m) => m.bridge.refresh()));
    expect(w.fetches).toHaveBeenCalledTimes(4);
    expect(mounts.every((m) => m.bridge.access === "read")).toBe(true);
  });

  it("refresh() out of budget skips the fetch and leaves the next request to check instead", async () => {
    const w = world("readwrite");
    const t = w.mount();
    while (w.budget.spend(1));
    await t.bridge.refresh();
    expect(w.fetches).not.toHaveBeenCalled();
    w.tick(2000);
    w.state.current = "none";
    await t.send(t.req({ id: "r", op: "read", name: "a" }));
    expect(w.fetches).toHaveBeenCalledTimes(1);
    expect(t.replies().at(-1)).toMatchObject({ id: "r", ok: false, error: expect.stringMatching(/revoked/) });
  });

  it("a writer at 1 write/s for 120 s, after a 10-write burst on load, loses no write", async () => {
    const w = world("readwrite");
    const t = w.mount();
    await t.send(t.req({ id: "load", op: "read", name: "deck.json" }));
    // The shim keeps ≤ 4 in flight and queues the rest: the burst arrives in waves.
    for (let i = 0; i < 10; i++) {
      t.port.onmessage?.({ data: write(`b${i}`) } as MessageEvent);
      if (i % ARTIFACT_BRIDGE_LIMITS.maxInFlight === ARTIFACT_BRIDGE_LIMITS.maxInFlight - 1) await t.bridge.settled();
    }
    await t.bridge.settled();
    for (let i = 0; i < 120; i++) {
      w.tick(1000);
      await t.send(write(`s${i}`));
    }
    const failed = t.replies().filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(t.api.write).toHaveBeenCalledTimes(130);
    // A check on at most every other write: ≤ 1.5 tokens a write (90/min), under the refill.
    expect(w.fetches.mock.calls.length).toBeLessThanOrEqual(62);
  });

  it("beside three spinners a writer still gets its quarter of the tab through: it never pays for a check it cannot follow with the write", async () => {
    // Its share refills a token every ~2.3 s — slower than the 2 s write window. Paying
    // for the check alone would spend each token on a check that is stale again before
    // the write's token arrives: every write refused, for ever.
    let now = 0;
    const clock = () => now;
    const tab = createTabBudget(clock);
    const spinners = [tab.open("spam"), tab.open("spam"), tab.open("spam")];
    const fetches = vi.fn(async () => "readwrite" as ArtifactStorageAccess);
    const lookup = createSharedLookup<ArtifactStorageAccess>(fetches, clock);
    const t = setup("readwrite", BOUND, { recheck: (maxAgeMs, b) => lookup.get("art", maxAgeMs, b), budget: tab.open("art") });
    t.ready();
    for (now = 0; now < 120_000; now += 50) {
      for (const sp of spinners) while (sp.spend(1));
      if (now % 1000 === 0 && now > 0) await t.send(write(`s${now}`));
    }
    const ok = t.replies().filter((r) => r.ok).length;
    // A quarter of 1.75/s for 120 s is 52 tokens; writes this far apart each need a check: 2 tokens a write.
    expect(ok).toBeGreaterThanOrEqual(24);
    expect(fetches.mock.calls.length).toBeLessThanOrEqual(ok + 1);
  });
});

describe("artifact bridge — revoke", () => {
  it("closes the host's end of the port and drops its handler", () => {
    const t = setup();
    t.ready();
    expect(t.port.onmessage).not.toBeNull();
    t.bridge.revoke();
    expect(t.port.close).toHaveBeenCalled();
    expect(t.port.onmessage).toBeNull();
  });
});

