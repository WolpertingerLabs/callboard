// @vitest-environment jsdom
/**
 * The two halves of the artifact storage bridge, wired to each other.
 *
 * - iframe side: the shim extracted from a document served by the REAL
 *   `GET /api/artifacts/:id/versions/:n/render` route (not the exported
 *   constant), run in a `vm` context as the frame's `window`;
 * - host side: the REAL frontend `createArtifactBridge` with its default
 *   `restBridgeApi`, i.e. the real `api.ts` calls;
 * - server: the real storage + artifact routers on an ephemeral socket over a
 *   scratch `CALLBOARD_DATA_DIR`.
 *
 * Two stand-ins, both transport rather than logic:
 * - jsdom's `postMessage` never sets `event.source`, and the bridge's security
 *   rests on it, so the two windows are joined by a tiny message bus that
 *   delivers `{ data: structuredClone(msg), source }` exactly as a browser
 *   would between a parent and its sandboxed child;
 * - `fetch` is the real Node fetch with `/api` rebased onto the socket; its
 *   `blob()` is re-wrapped as a jsdom `Blob` so jsdom's `FileReader` (what the
 *   host uses for `dataUrl`) accepts it.
 *
 * jsdom is here only for `FileReader`/`Blob`, which the host needs and Node lacks.
 *
 * Lives outside both workspaces on purpose: backend and frontend each compile
 * their tests under `rootDir: src`, so neither can import the other's source.
 * Vitest's `node` project picks it up from here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStorageAccess } from "shared/types/index.js";
import { listenRaw, type RawServer } from "../backend/src/routes/__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-bridge-xb-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { storageRouter } = await import("../backend/src/routes/storage.js");
const { artifactsRouter } = await import("../backend/src/routes/artifacts.js");
const storage = await import("../backend/src/services/storage-service.js");
const artifacts = await import("../backend/src/services/artifact-service.js");
const { createArtifactBridge } = await import("../frontend/src/components/artifactBridge.js");

// 1×1 transparent PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DECK = { topic: "birds", cards: [{ id: "c1", front: "Robin?", seenCount: 0 }] };

let server: RawServer;
let shimSource: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/storage", storageRouter);
  app.use("/api/artifacts", artifactsRouter);
  server = await listenRaw(app);

  await storage.createStorageKey("deck");
  await storage.saveStorageItem("deck", "deck.json", Buffer.from(JSON.stringify(DECK)));
  await storage.saveStorageItem("deck", "img-c1.png", Buffer.from(PNG_B64, "base64"));
  await storage.createStorageKey("other");
  await storage.saveStorageItem("other", "secret.txt", Buffer.from("not yours"));
  await artifacts.saveArtifact(
    { id: "study", name: "Study", contentType: "html", storageAccess: "readwrite", content: "<!doctype html><html><head><title>t</title></head><body>hi</body></html>" },
    "create",
  );

  // The shim exactly as the browser receives it: first inline script of the served page.
  const res = await realFetch(`${server.origin}/api/artifacts/study/versions/1/render`);
  const html = await res.text();
  const m = /<head[^>]*><script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("served render has no shim right after <head>");
  shimSource = m[1];

  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/api/") ? server.origin + input : input;
    const r = await realFetch(url, init);
    return {
      ok: r.ok,
      status: r.status,
      headers: r.headers,
      json: () => r.json(),
      text: () => r.text(),
      blob: async () => new Blob([await r.arrayBuffer()], { type: r.headers.get("content-type") ?? "" }),
    };
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
  rmSync(DATA, { recursive: true, force: true });
});

type Listener = (e: { data: unknown; source: unknown }) => void;

/** Mount: a frame window running the served shim, and the real host bridge for it. */
function mount(storageKey: string | null, access: ArtifactStorageAccess) {
  const frameListeners: Listener[] = [];
  const pending: Promise<void>[] = [];
  const hostWindow = {
    // frame → host: the host's window `message` listener, with source = the frame.
    postMessage(msg: unknown, target: string) {
      expect(target).toBe("*");
      pending.push(bridge.handleMessage({ data: structuredClone(msg), source: frameWindow } as unknown as MessageEvent));
    },
  };
  const frameWindow: Record<string, unknown> = {
    parent: hostWindow,
    addEventListener: (type: string, fn: Listener) => type === "message" && frameListeners.push(fn),
    // host → frame: the shim's listener, with source = its parent.
    postMessage(msg: unknown) {
      const data = structuredClone(msg);
      queueMicrotask(() => frameListeners.forEach((l) => l({ data, source: hostWindow })));
    },
  };
  const bridge = createArtifactBridge({ getFrameWindow: () => frameWindow as unknown as Window, storageKey, access });
  vm.runInContext(
    shimSource,
    vm.createContext({ window: frameWindow, Promise, Object, JSON, Math, String, Error, TypeError, ArrayBuffer, Uint8Array, btoa }),
  );
  bridge.handleLoad();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { cb: frameWindow.callboard as any, settle: () => Promise.all(pending) };
}

describe("artifact bridge: served shim ⇄ frontend host ⇄ storage REST", () => {
  it("list returns the bound key's items (with names), and nothing from other keys", async () => {
    const { cb } = mount("deck", "readwrite");
    await expect(cb.ready).resolves.toEqual({ storageKey: "deck", access: "readwrite" });
    const items = await cb.storage.list();
    expect(items.map((i: { name: string }) => i.name)).toEqual(["deck.json", "img-c1.png"]);
    expect(items[0]).toMatchObject({ mimeType: "application/json", size: JSON.stringify(DECK).length, sha256: expect.any(String) });
  });

  it("read as json returns the parsed value; as text the raw string", async () => {
    const { cb } = mount("deck", "read");
    await expect(cb.storage.read("deck.json", { as: "json" })).resolves.toEqual(DECK);
    await expect(cb.storage.read("deck.json", { as: "text" })).resolves.toBe(JSON.stringify(DECK));
  });

  it("read as dataUrl returns a data: URL of the exact bytes, typed by the served Content-Type", async () => {
    const { cb } = mount("deck", "read");
    await expect(cb.storage.read("img-c1.png", { as: "dataUrl" })).resolves.toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it("write under readwrite lands on disk through PUT, for strings and JSON values", async () => {
    const { cb } = mount("deck", "readwrite");
    const saved = await cb.storage.write("notes.txt", "hello", { mimeType: "text/plain" });
    expect(saved).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: 5 });
    expect(storage.readStorageItemBytes("deck", "notes.txt").data.toString()).toBe("hello");

    await cb.storage.write("progress.json", { c1: { seenCount: 3 } });
    expect(storage.getStorageItem("deck", "progress.json").mimeType).toBe("application/json");
    await expect(cb.storage.read("progress.json", { as: "json" })).resolves.toEqual({ c1: { seenCount: 3 } });

    await cb.storage.write("blob.bin", new Uint8Array([1, 2, 3]));
    expect([...storage.readStorageItemBytes("deck", "blob.bin").data]).toEqual([1, 2, 3]);

    await cb.storage.delete("blob.bin");
    expect(storage.listStorageItems("deck").some((i) => i.name === "blob.bin")).toBe(false);
  });

  it("write under read is refused, and the host refuses it too when the shim is bypassed", async () => {
    const { cb, settle } = mount("deck", "read");
    await expect(cb.storage.write("pwned.txt", "x")).rejects.toThrow(/read-only/);
    await expect(cb.storage.delete("deck.json")).rejects.toThrow(/read-only/);
    await settle();
    expect(storage.listStorageItems("deck").some((i) => i.name === "pwned.txt")).toBe(false);
    expect(storage.listStorageItems("deck").some((i) => i.name === "deck.json")).toBe(true);
  });

  it("a hostile shim cannot write under read or reach another key: the host is the boundary", async () => {
    // Same mount, but the frame skips the shim and posts raw requests with the real nonce.
    const replies: unknown[] = [];
    const frameWindow = { postMessage: (m: unknown) => replies.push(m) };
    const bridge = createArtifactBridge({ getFrameWindow: () => frameWindow as unknown as Window, storageKey: "deck", access: "read" });
    bridge.handleLoad();
    const init = replies.shift() as { nonce: string };
    const send = (data: Record<string, unknown>) =>
      bridge.handleMessage({ data: { __callboard: "artifact-bridge-request", nonce: init.nonce, ...data }, source: frameWindow } as unknown as MessageEvent);

    await send({ id: "w", op: "write", name: "pwned.txt", data: "x", encoding: "utf8" });
    await send({ id: "k", op: "read", name: "secret.txt", key: "other", as: "text" });
    await send({ id: "t", op: "read", name: "../other/items/secret.txt", as: "text" });
    expect(replies).toEqual([
      { __callboard: "artifact-bridge-reply", id: "w", ok: false, error: expect.stringMatching(/read-only/) },
      { __callboard: "artifact-bridge-reply", id: "k", ok: false, error: expect.stringMatching(/not found/i) },
      { __callboard: "artifact-bridge-reply", id: "t", ok: false, error: "Invalid item name" },
    ]);
    expect(storage.listStorageItems("deck").some((i) => i.name === "pwned.txt")).toBe(false);
  });

  it("an unbound render resolves ready as unbound and every call rejects", async () => {
    const { cb } = mount(null, "readwrite");
    await expect(cb.ready).resolves.toEqual({ storageKey: null, access: "none" });
    await expect(cb.storage.list()).rejects.toThrow(/without a storage key/);
  });
});
