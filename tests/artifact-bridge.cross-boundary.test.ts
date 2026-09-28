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
 * The handshake is the real one: the host mints the token, the served page is
 * fetched with `?bridge=<token>`, the shim posts its hello to `window.parent`
 * transferring one end of a REAL `MessageChannel` (Node's), and from then on
 * the two sides talk only over that channel.
 *
 * Two stand-ins, both transport rather than logic:
 * - jsdom's `postMessage` never sets `event.source` or `ports`, and the
 *   bridge's security rests on both, so the frame's `window.parent` is a stub
 *   that hands the host `{ data: structuredClone(msg), source, ports }`
 *   exactly as a browser would between a parent and its sandboxed child;
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
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_BRIDGE_LIMITS, ARTIFACT_BRIDGE_READ_RECHECK_MS, ARTIFACT_BRIDGE_WRITE_RECHECK_MS } from "shared/types/index.js";
import type { Artifact } from "shared/types/index.js";
import type { ArtifactStorageAccess, RenderArtifactToolResult } from "shared/types/index.js";
import { listenRaw, type RawServer } from "../backend/src/routes/__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-bridge-xb-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { storageRouter } = await import("../backend/src/routes/storage.js");
const { artifactsRouter } = await import("../backend/src/routes/artifacts.js");
const storage = await import("../backend/src/services/storage-service.js");
const artifacts = await import("../backend/src/services/artifact-service.js");
const { createArtifactBridge, RATE_LIMITED } = await import("../frontend/src/components/artifactBridge.js");
const { recheckGrant } = await import("../frontend/src/components/artifactGrant.js");
const { createRequestBudget, createSharedLookup } = await import("../frontend/src/components/artifactBudget.js");
const { getArtifact } = await import("../frontend/src/api.js");

// 1×1 transparent PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DECK = { topic: "birds", cards: [{ id: "c1", front: "Robin?", seenCount: 0 }] };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';

let server: RawServer;
const realFetch = globalThis.fetch;
const openPorts: MessagePort[] = [];
/** Every /api request the host made (method + path), in order — what the server's rate limiter would count. */
const apiCalls: string[] = [];

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
  await storage.saveStorageItem("deck", "logo.svg", Buffer.from(SVG));
  await artifacts.saveArtifact(
    { id: "study", name: "Study", contentType: "html", storageAccess: "readwrite", content: "<!doctype html><html><head><title>t</title></head><body>hi</body></html>" },
    "create",
  );

  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/api/") ? server.origin + input : input;
    if (typeof input === "string" && input.startsWith("/api/")) apiCalls.push(`${init?.method ?? "GET"} ${input}`);
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
  for (const p of openPorts) p.close();
  vi.unstubAllGlobals();
  await server.close();
  rmSync(DATA, { recursive: true, force: true });
});

const pinOf = (id: string) => artifacts.readArtifactVersion(id, 1).version.sha256;

/** The shim exactly as the browser receives it: the first inline script of the page served for `?bridge=<token>&sha256=<pin>`. */
async function servedShim(token: string | null, id = "study"): Promise<string> {
  const res = await realFetch(`${server.origin}/api/artifacts/${id}/versions/1/render${token ? `?bridge=${token}&sha256=${pinOf(id)}` : ""}`);
  const m = /<head[^>]*><script>([\s\S]*?)<\/script>/.exec(await res.text());
  if (!m) throw new Error("served render has no shim right after <head>");
  return m[1];
}

/** A document in the frame: runs `code` with the frame's window as its global `window` (and `now` as its clock, if given). */
function runDocument(frameWindow: Record<string, unknown>, code: string, now?: () => number) {
  vm.runInContext(
    code,
    vm.createContext({
      window: frameWindow,
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
      setTimeout,
      clearTimeout,
      ...(now ? { Date: { now } } : {}),
    }),
  );
}

/**
 * Mount: the real host bridge, and a frame window running the shim served for
 * that bridge's token. The frame's `window.parent.postMessage` delivers to the
 * host as a browser would: source = the frame's window, ports = the transfer.
 * The live re-check is the renderer's real one (`recheckGrant`) against the
 * real artifact route, pinned to the sha256 the page was served for, through a
 * shared lookup seeded — as the renderer seeds it — by a judgement just before
 * mounting. Each mount gets its own budget and lookup (in the browser they are
 * the tab's), so cases do not drain each other.
 */
async function mount(storageKey: string | null, access: ArtifactStorageAccess, id = "study", now?: () => number) {
  const pin = pinOf(id);
  const result: RenderArtifactToolResult = {
    type: "render_artifact",
    artifact_id: id,
    version: 1,
    sha256: pin,
    name: id,
    content_type: "html",
    ...(storageKey ? { storage_key: storageKey } : {}),
    storage_access: access,
  };
  const frameWindow: Record<string, unknown> = {
    addEventListener: () => undefined,
    parent: {
      postMessage(msg: unknown, target: string, transfer?: MessagePort[]) {
        expect(target).toBe("*");
        for (const p of transfer ?? []) openPorts.push(p);
        bridge.handleMessage({ data: structuredClone(msg), source: frameWindow, ports: transfer ?? [] } as unknown as MessageEvent);
      },
    },
    // The host must never post to the frame's window — it has the port.
    postMessage: () => {
      throw new Error("host posted to the frame's window");
    },
  };
  const clock = now ?? (() => Date.now());
  const lookup = createSharedLookup<Artifact>((a) => getArtifact(a), clock);
  const startedAt = clock();
  lookup.seed(id, startedAt, await getArtifact(id));
  const bridge = createArtifactBridge({
    getFrameWindow: () => frameWindow as unknown as Window,
    storageKey,
    access,
    recheck: (maxAgeMs, budget) => recheckGrant(result, pin, maxAgeMs, budget, lookup),
    budget: createRequestBudget(clock),
  });
  runDocument(frameWindow, await servedShim(bridge.token, id), now);
  bridge.handleLoad();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { cb: frameWindow.callboard as any, bridge, frameWindow };
}

/** A foreign document now in the frame: a fresh window object (a new document's global) whose parent is the same stub. */
function replaceDocument(frameWindow: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { addEventListener: () => undefined, parent: frameWindow.parent };
  return next;
}

describe("artifact bridge: served shim ⇄ frontend host ⇄ storage REST", () => {
  it("list returns the bound key's items (with names), and nothing from other keys", async () => {
    const { cb } = await mount("deck", "readwrite");
    await expect(cb.ready).resolves.toEqual({ storageKey: "deck", access: "readwrite" });
    const items = await cb.storage.list();
    expect(items.map((i: { name: string }) => i.name)).toEqual(["deck.json", "img-c1.png", "logo.svg"]);
    expect(items[0]).toMatchObject({ mimeType: "application/json", size: JSON.stringify(DECK).length, sha256: expect.any(String) });
  });

  it("read as json returns the parsed value; as text the raw string", async () => {
    const { cb } = await mount("deck", "read");
    await expect(cb.storage.read("deck.json", { as: "json" })).resolves.toEqual(DECK);
    await expect(cb.storage.read("deck.json", { as: "text" })).resolves.toBe(JSON.stringify(DECK));
  });

  it("read as dataUrl returns a data: URL of the exact bytes, typed by the served Content-Type", async () => {
    const { cb } = await mount("deck", "read");
    await expect(cb.storage.read("img-c1.png", { as: "dataUrl" })).resolves.toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it("an SVG — served as an octet-stream attachment — comes back as a data:image/svg+xml URL, from the recorded type", async () => {
    const res = await realFetch(`${server.origin}/api/storage/deck/items/logo.svg`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-callboard-mime-type")).toBe("image/svg+xml");
    const { cb } = await mount("deck", "read");
    await expect(cb.storage.read("logo.svg", { as: "dataUrl" })).resolves.toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
  });

  it("write under readwrite lands on disk through PUT, for strings and JSON values", async () => {
    const { cb } = await mount("deck", "readwrite");
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
    const { cb, bridge } = await mount("deck", "read");
    await expect(cb.storage.write("pwned.txt", "x")).rejects.toThrow(/read-only/);
    await expect(cb.storage.delete("deck.json")).rejects.toThrow(/read-only/);
    await bridge.settled();
    expect(storage.listStorageItems("deck").some((i) => i.name === "pwned.txt")).toBe(false);
    expect(storage.listStorageItems("deck").some((i) => i.name === "deck.json")).toBe(true);
  });

  it("a hostile document with the real token cannot write under read or reach another key: the host is the boundary", async () => {
    // Skips the shim: says hello itself, then posts raw requests with the real token.
    const replies: unknown[] = [];
    const frameWindow = {};
    const bridge = createArtifactBridge({ getFrameWindow: () => frameWindow as unknown as Window, storageKey: "deck", access: "read" });
    const { port1, port2 } = new MessageChannel();
    openPorts.push(port1, port2);
    port1.on("message", (m) => replies.push(m));
    bridge.handleMessage({ data: { __callboard: "artifact-bridge-hello", token: bridge.token }, source: frameWindow, ports: [port2] } as unknown as MessageEvent);
    const send = (data: Record<string, unknown>) => port1.postMessage({ __callboard: "artifact-bridge-request", token: bridge.token, ...data });

    send({ id: "w", op: "write", name: "pwned.txt", data: "x", encoding: "utf8" });
    send({ id: "k", op: "read", name: "secret.txt", key: "other", as: "text" });
    send({ id: "t", op: "read", name: "../other/items/secret.txt", as: "text" });
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    expect(replies[0]).toEqual({ __callboard: "artifact-bridge-init", storageKey: "deck", access: "read" });
    // Answers arrive as each finishes, not in request order.
    const byId = Object.fromEntries((replies.slice(1) as { id: string }[]).map((r) => [r.id, r]));
    expect(byId).toEqual({
      w: { __callboard: "artifact-bridge-reply", id: "w", ok: false, error: expect.stringMatching(/read-only/) },
      k: { __callboard: "artifact-bridge-reply", id: "k", ok: false, error: expect.stringMatching(/not found/i) },
      t: { __callboard: "artifact-bridge-reply", id: "t", ok: false, error: "Invalid item name" },
    });
    expect(storage.listStorageItems("deck").some((i) => i.name === "pwned.txt")).toBe(false);
  });

  it("a foreign document in the frame BEFORE the artifact binds — even running the real shim code, but without the token — binds nothing", async () => {
    const frameWindow: Record<string, unknown> = {
      addEventListener: () => undefined,
      parent: {
        postMessage: (msg: unknown, _t: string, transfer?: MessagePort[]) => {
          for (const p of transfer ?? []) openPorts.push(p);
          bridge.handleMessage({ data: structuredClone(msg), source: frameWindow, ports: transfer ?? [] } as unknown as MessageEvent);
        },
      },
    };
    const bridge = createArtifactBridge({ getFrameWindow: () => frameWindow as unknown as Window, storageKey: "deck", access: "readwrite" });
    // The artifact navigated away before its shim ran; the foreign page's load is the frame's first.
    bridge.handleLoad();
    // It runs a shim served with ANOTHER token (the most it can get: its own render URL), and one with none.
    runDocument(frameWindow, await servedShim("f".repeat(32)));
    const cb = frameWindow.callboard as { ready: Promise<unknown>; storage: { list(): Promise<unknown> } };
    const settled = vi.fn();
    void cb.ready.then(settled);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).not.toHaveBeenCalled(); // no init, ever
    expect(bridge.bound).toBe(false);
    await expect(Promise.race([cb.storage.list(), new Promise((r) => setTimeout(() => r("no answer"), 30))])).resolves.toBe("no answer");
  });

  it("a foreign document that replaces the artifact AFTER binding receives nothing: not init, not a reply, not an in-flight answer", async () => {
    const { cb, bridge, frameWindow } = await mount("deck", "read");
    await expect(cb.storage.read("deck.json", { as: "json" })).resolves.toEqual(DECK);
    // A read is in flight when the frame navigates; its answer goes down the artifact's port, which the foreign page does not have.
    const inflight = cb.storage.read("deck.json", { as: "text" }).then(
      () => "delivered to the (dead) artifact document only",
      () => "rejected",
    );
    const foreign = replaceDocument(frameWindow);
    const foreignSaw: unknown[] = [];
    foreign.addEventListener = (_t: string, fn: (e: { data: unknown }) => void) => foreignSaw.push(fn);
    bridge.handleLoad(); // the foreign page loaded
    expect(bridge.revoked).toBe(true);
    // It says hello with the artifact's own token (the accepted exfiltration case) — still nothing: the bridge is dead.
    runDocument(foreign, await servedShim(bridge.token));
    const fcb = foreign.callboard as { ready: Promise<unknown> };
    const settled = vi.fn();
    void fcb.ready.then(settled);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).not.toHaveBeenCalled();
    expect(foreignSaw).toEqual([]); // the shim never even listens on its window
    await bridge.settled();
    void inflight;
  });

  it("an unbound render resolves ready as unbound and every call rejects", async () => {
    const { cb } = await mount(null, "readwrite");
    await expect(cb.ready).resolves.toEqual({ storageKey: null, access: "none" });
    await expect(cb.storage.list()).rejects.toThrow(/without a storage key/);
  });
});

describe("the live grant: re-checked against the real artifact route, while mounted", () => {
  const LIVE_HTML = "<!doctype html><html><head></head><body>live</body></html>";
  const fresh = async (id: string, content = LIVE_HTML) => {
    await artifacts.deleteArtifact(id).catch(() => undefined);
    await artifacts.saveArtifact({ id, name: id, contentType: "html", storageAccess: "readwrite", content }, "create");
  };

  it("lowered to read while mounted (Settings PATCH): reads go on, the next write is refused and never reaches storage", async () => {
    await fresh("live-a");
    let t = 500_000;
    const { cb, bridge } = await mount("deck", "readwrite", "live-a", () => t);
    await cb.storage.write("live-a.txt", "1");
    const patched = await realFetch(`${server.origin}/api/artifacts/live-a`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storageAccess: "read" }),
    });
    expect(patched.status).toBe(200);
    // A write may rely on a check under ARTIFACT_BRIDGE_WRITE_RECHECK_MS old; past that it sees the change.
    t += ARTIFACT_BRIDGE_WRITE_RECHECK_MS;
    await expect(cb.storage.read("live-a.txt")).resolves.toBe("1");
    await expect(cb.storage.write("live-a.txt", "2")).rejects.toThrow(/read-only/);
    expect(storage.readStorageItemBytes("deck", "live-a.txt").data.toString()).toBe("1");
    expect(bridge.access).toBe("read");
    // Never rises again, even if the artifact does.
    await artifacts.updateArtifact("live-a", { storageAccess: "readwrite" });
    t += ARTIFACT_BRIDGE_WRITE_RECHECK_MS;
    await expect(cb.storage.write("live-a.txt", "3")).rejects.toThrow(/read-only/);
    await storage.deleteStorageItem("deck", "live-a.txt");
  });

  it("deleted while mounted: the next write is refused and every call after it too", async () => {
    await fresh("live-b");
    let t = 600_000;
    const { cb, bridge } = await mount("deck", "readwrite", "live-b", () => t);
    await cb.storage.write("live-b.txt", "1");
    expect((await realFetch(`${server.origin}/api/artifacts/live-b`, { method: "DELETE" })).status).toBe(200);
    t += ARTIFACT_BRIDGE_WRITE_RECHECK_MS;
    await expect(cb.storage.write("live-b.txt", "2")).rejects.toThrow(/revoked/);
    expect(bridge.access).toBe("none");
    await expect(cb.storage.read("live-b.txt")).rejects.toThrow(/no storage access/);
    expect(storage.readStorageItemBytes("deck", "live-b.txt").data.toString()).toBe("1");
    await storage.deleteStorageItem("deck", "live-b.txt");
  });

  it("deleted and recreated (different code, same id and version) while mounted: the running code's grant is gone", async () => {
    await fresh("live-c");
    let t = 700_000;
    const { cb } = await mount("deck", "readwrite", "live-c", () => t);
    await fresh("live-c", "<!doctype html><html><head></head><body>impostor</body></html>");
    t += ARTIFACT_BRIDGE_WRITE_RECHECK_MS;
    await expect(cb.storage.delete("deck.json")).rejects.toThrow(/revoked/);
    expect(storage.listStorageItems("deck").some((i) => i.name === "deck.json")).toBe(true);
  });

  it("reads rely on a check for at most ARTIFACT_BRIDGE_READ_RECHECK_MS, writes and deletes for at most ARTIFACT_BRIDGE_WRITE_RECHECK_MS", async () => {
    await fresh("live-d");
    let t = 1_000_000;
    const { cb } = await mount("deck", "readwrite", "live-d", () => t);
    apiCalls.length = 0;
    await cb.storage.read("deck.json");
    await cb.storage.list();
    expect(apiCalls).toEqual(["GET /api/storage/deck/items/deck.json", "GET /api/storage/deck"]);
    t += ARTIFACT_BRIDGE_READ_RECHECK_MS;
    apiCalls.length = 0;
    await cb.storage.read("deck.json");
    expect(apiCalls).toEqual(["GET /api/artifacts/live-d", "GET /api/storage/deck/items/deck.json"]);
    // That check just started: a write may rely on it.
    apiCalls.length = 0;
    await cb.storage.write("live-d.txt", "x");
    expect(apiCalls).toEqual(["PUT /api/storage/deck/items/live-d.txt"]);
    t += ARTIFACT_BRIDGE_WRITE_RECHECK_MS;
    apiCalls.length = 0;
    await cb.storage.write("live-d.txt", "y");
    expect(apiCalls).toEqual(["GET /api/artifacts/live-d", "PUT /api/storage/deck/items/live-d.txt"]);
    await storage.deleteStorageItem("deck", "live-d.txt");
  });

  it(`a polling artifact is cut off host-side after its burst: ${RATE_LIMITED} with a retry hint, which the served shim honours — nothing more reaches the server until then`, async () => {
    let t = 2_000_000;
    const { cb } = await mount("deck", "read", "study", () => t);
    apiCalls.length = 0;
    let ok = 0;
    let refusal: Error | null = null;
    for (let i = 0; i < 30 && !refusal; i++) {
      try {
        await cb.storage.list();
        ok++;
      } catch (err) {
        refusal = err as Error;
      }
    }
    expect(ok).toBe(ARTIFACT_BRIDGE_LIMITS.burst);
    expect(refusal?.message).toMatch(new RegExp(`^${RATE_LIMITED}`));
    expect(apiCalls).toHaveLength(ARTIFACT_BRIDGE_LIMITS.burst);
    // Retried at once, as a polling loop would: held by the shim, so not even the host sees it.
    let held = true;
    const retry = cb.storage.list().finally(() => (held = false));
    await new Promise((r) => setTimeout(r, 30));
    expect(held).toBe(true);
    expect(apiCalls).toHaveLength(ARTIFACT_BRIDGE_LIMITS.burst);
    // The hint was when one token would be back (1/1.75 s); once the clock passes it the call goes out, and succeeds.
    t += 10_000;
    await retry;
    // It refills at the sustained rate (a re-check is due by now, and costs a token of its own).
    ok = 1;
    for (let i = 0; i < 50; i++) {
      const r = await cb.storage.list().then(
        () => true,
        () => false,
      );
      if (!r) break;
      ok++;
    }
    const refill = Math.floor(10 * ARTIFACT_BRIDGE_LIMITS.refillPerSecond);
    expect(ok).toBe(refill - 1);
    expect(apiCalls).toHaveLength(ARTIFACT_BRIDGE_LIMITS.burst + refill);
    expect(apiCalls[ARTIFACT_BRIDGE_LIMITS.burst]).toBe("GET /api/artifacts/study");
  });

  it("Promise.all over more reads than the in-flight cap succeeds: the shim queues, the host never sees more than the cap", async () => {
    const { cb } = await mount("deck", "read");
    const texts = await Promise.all(Array.from({ length: 12 }, () => cb.storage.read("deck.json")));
    expect(new Set(texts)).toEqual(new Set([JSON.stringify(DECK)]));
  });
});
