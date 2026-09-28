// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createArtifactBridge, makeBridgeNonce, BRIDGE_INIT, BRIDGE_REPLY, BRIDGE_REQUEST, type BridgeStorageApi } from "./artifactBridge";
import type { ArtifactStorageAccess } from "../api";

/**
 * The host half of the artifact storage bridge, driven directly.
 *
 * Everything an artifact can reach goes through `handleMessage`, so this file
 * is the security boundary's test: a request is honoured only from this mount's
 * frame, with this mount's nonce, before any second `load`, at no more than the
 * granted access, against the one bound key, for a valid item name. Each rule
 * gets a case that proves the refusal *and* that no storage call was made —
 * a refusal that still performed the write would pass a reply-only assertion.
 */

const BOUND = "bound-key";

interface FakeFrame {
  postMessage: ReturnType<typeof vi.fn>;
}

function fakeApi(): BridgeStorageApi & { [K in keyof BridgeStorageApi]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => [{ name: "deck.json", mimeType: "application/json", size: 9, sha256: "x", created: "c", updated: "u" }]),
    readText: vi.fn(async () => '{"cards":1}'),
    readBlob: vi.fn(async () => new Blob(["hi"], { type: "image/png" })),
    write: vi.fn(async (_k: string, name: string) => ({ name, mimeType: "text/plain", size: 2, sha256: "y", created: "c", updated: "u" })),
    remove: vi.fn(async () => undefined),
  };
}

function setup(access: ArtifactStorageAccess = "readwrite", storageKey: string | null = BOUND) {
  const frame: FakeFrame = { postMessage: vi.fn() };
  let current: FakeFrame | null = frame;
  const api = fakeApi();
  const bridge = createArtifactBridge({ getFrameWindow: () => current as unknown as Window, storageKey, access, api });
  const send = (data: unknown, source: unknown = frame) => bridge.handleMessage({ data, source } as unknown as MessageEvent);
  const req = (extra: Record<string, unknown>) => ({ __callboard: BRIDGE_REQUEST, nonce: bridge.nonce, id: "1", ...extra });
  /** Every reply posted so far (the init message excluded). */
  const replies = () => frame.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.__callboard === BRIDGE_REPLY);
  const storageCalls = () => Object.values(api).reduce((n, fn) => n + fn.mock.calls.length, 0);
  return {
    frame,
    api,
    bridge,
    send,
    req,
    replies,
    storageCalls,
    detach: () => {
      current = null;
    },
  };
}

describe("artifact bridge — init", () => {
  it("posts init with nonce, key and access on the first load only", () => {
    const t = setup("read");
    t.bridge.handleLoad();
    expect(t.frame.postMessage).toHaveBeenCalledTimes(1);
    expect(t.frame.postMessage).toHaveBeenCalledWith({ __callboard: BRIDGE_INIT, nonce: t.bridge.nonce, storageKey: BOUND, access: "read" }, "*");
    t.bridge.handleLoad();
    expect(t.frame.postMessage).toHaveBeenCalledTimes(1);
  });

  it("an unbound render is told access none, whatever access was passed", () => {
    const t = setup("readwrite", null);
    t.bridge.handleLoad();
    expect(t.frame.postMessage.mock.calls[0][0]).toMatchObject({ storageKey: null, access: "none" });
  });

  it("nonces come from the CSPRNG, 128 bits, fresh per mount", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    const a = makeBridgeNonce();
    const b = createArtifactBridge({ getFrameWindow: () => null, storageKey: BOUND, access: "read" }).nonce;
    expect(spy).toHaveBeenCalled();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    spy.mockRestore();
  });
});

describe("artifact bridge — operations", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup("readwrite");
    t.bridge.handleLoad();
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
    t.bridge.handleLoad();
    await t.send(t.req({ op, name: "deck.json", data: "x" }));
    expect(t.replies()[0]).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(t.api.write).not.toHaveBeenCalled();
    expect(t.api.remove).not.toHaveBeenCalled();
  });

  it("read still works under read", async () => {
    const t = setup("read");
    t.bridge.handleLoad();
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.replies()[0]).toMatchObject({ ok: true });
  });

  it.each(["list", "read", "write", "delete"])("%s is refused under none", async (op) => {
    const t = setup("none");
    t.bridge.handleLoad();
    await t.send(t.req({ op, name: "deck.json", data: "x" }));
    expect(t.replies()[0]).toMatchObject({ ok: false });
    expect(t.storageCalls()).toBe(0);
  });

  it("everything is refused when unbound, even if readwrite was passed", async () => {
    const t = setup("readwrite", null);
    t.bridge.handleLoad();
    await t.send(t.req({ op: "list" }));
    await t.send(t.req({ id: "2", op: "write", name: "a", data: "x" }));
    expect(t.replies().map((r) => r.ok)).toEqual([false, false]);
    expect(t.storageCalls()).toBe(0);
  });
});

describe("artifact bridge — who may ask", () => {
  it.each([
    ["wrong nonce", { nonce: "0".repeat(32) }],
    ["missing nonce", { nonce: undefined }],
    ["non-string nonce", { nonce: 12345 }],
  ])("a request with a %s is ignored — no reply, no storage call", async (_label, override) => {
    const t = setup();
    t.bridge.handleLoad();
    await t.send({ ...t.req({ op: "read", name: "deck.json" }), ...override });
    expect(t.replies()).toEqual([]);
    expect(t.storageCalls()).toBe(0);
  });

  it("a correctly-nonced request from a different source is ignored", async () => {
    const t = setup();
    t.bridge.handleLoad();
    const other = { postMessage: vi.fn() };
    await t.send(t.req({ op: "read", name: "deck.json" }), other);
    await t.send(t.req({ op: "read", name: "deck.json" }), null);
    await t.send(t.req({ op: "read", name: "deck.json" }), window);
    expect(t.replies()).toEqual([]);
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(t.storageCalls()).toBe(0);
  });

  it("requests before the first load are ignored", async () => {
    const t = setup();
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.storageCalls()).toBe(0);
  });

  it("non-request messages (e.g. the size reporter) are ignored", async () => {
    const t = setup();
    t.bridge.handleLoad();
    await t.send({ type: "canvas-resize", height: 10 });
    await t.send({ __callboard: BRIDGE_REPLY, nonce: t.bridge.nonce, id: "1", ok: true });
    expect(t.replies()).toEqual([]);
    expect(t.storageCalls()).toBe(0);
  });
});

describe("artifact bridge — revocation", () => {
  it("a second load revokes the bridge permanently", async () => {
    const t = setup();
    t.bridge.handleLoad();
    await t.send(t.req({ op: "read", name: "deck.json" }));
    expect(t.replies()).toHaveLength(1);

    t.bridge.handleLoad(); // the frame navigated itself
    expect(t.bridge.revoked).toBe(true);
    await t.send(t.req({ id: "2", op: "read", name: "deck.json" }));
    t.bridge.handleLoad();
    await t.send(t.req({ id: "3", op: "write", name: "deck.json", data: "x" }));
    expect(t.replies()).toHaveLength(1);
    expect(t.api.readText).toHaveBeenCalledTimes(1);
    expect(t.api.write).not.toHaveBeenCalled();
    // …and the new document never received an init.
    expect(t.frame.postMessage.mock.calls.filter((c) => c[0].__callboard === BRIDGE_INIT)).toHaveLength(1);
  });

  it("a reply in flight when the frame navigates is never delivered", async () => {
    const t = setup();
    t.bridge.handleLoad();
    let release!: (v: string) => void;
    t.api.readText.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const pending = t.send(t.req({ op: "read", name: "deck.json" }));
    t.bridge.handleLoad();
    release("secret");
    await pending;
    expect(t.replies()).toEqual([]);
  });

  it("a reply in flight when the frame unmounts is never delivered", async () => {
    const t = setup();
    t.bridge.handleLoad();
    let release!: (v: string) => void;
    t.api.readText.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const pending = t.send(t.req({ op: "read", name: "deck.json" }));
    t.detach();
    release("secret");
    await pending;
    expect(t.replies()).toEqual([]);
  });

  it("revoke() refuses everything after it", async () => {
    const t = setup();
    t.bridge.handleLoad();
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
    t.bridge.handleLoad();
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
    t.bridge.handleLoad();
    await t.send(t.req({ op: "read", name: "a".repeat(128) }));
    expect(t.replies()[0].ok).toBe(true);
  });

  it("a key in the request is ignored — every call addresses the bound key", async () => {
    const t = setup();
    t.bridge.handleLoad();
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
