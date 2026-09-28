/**
 * The plan's design test (§5): cramhouse as one artifact plus one storage key
 * per deck.
 *
 * An agent's-eye run through the tools — save a tiny HTML study UI as an
 * artifact, save `deck.json` into a key, `render_artifact` with that key — then
 * the served document is fetched over a real socket and checked (CSP, shim),
 * and finally the served page's own scripts are executed against a minimal
 * host that performs bridge requests through the REST API, scoped to the one
 * bound key. The artifact reads the deck, bumps a card's seen-count, and
 * writes it back; the write lands in storage.
 *
 * The host here is a reference for the contract, not the product: the real
 * host (token minting, source check, load-event revocation) is the
 * frontend's ArtifactRenderer; tests/artifact-bridge.cross-boundary.test.ts
 * wires that one to the served shim.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import vm from "node:vm";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBridgeReply, ArtifactBridgeRequest, RenderArtifactToolResult } from "shared/types/index.js";
import { listenRaw, type RawServer } from "../routes/__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-cramhouse-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { buildStorageArtifactTools } = await import("./storage-artifact-tools.js");
const { storageRouter } = await import("../routes/storage.js");
const { artifactsRouter } = await import("../routes/artifacts.js");
const { artifactBridgeShimScript } = await import("./artifact-bridge-shim.js");

const TOKEN = "c0ffeec0ffeec0ffeec0ffeec0ffee00";
const storage = await import("./storage-service.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const t = buildStorageArtifactTools().find((d) => d.name === name)!;
  const res = await (t.handler as (a: unknown) => Promise<{ content: { text: string }[] }>)(args);
  return JSON.parse(res.content[0].text);
}

/** The artifact's own study logic: read the deck, mark card 1 seen, write it back. */
const STUDY_SCRIPT = `
window.callboard.ready
  .then(function (info) { window.boundTo = info; return window.callboard.storage.read("deck.json", { as: "json" }); })
  .then(function (deck) {
    window.firstFront = deck.cards[0].front;
    deck.cards[0].seenCount += 1;
    return window.callboard.storage.write("deck.json", deck);
  })
  .then(function () { window.done = true; }, function (e) { window.failed = String(e && e.message); });
`;
const CRAMHOUSE_HTML = `<!doctype html><html><head><title>cramhouse</title><script>${STUDY_SCRIPT}</script></head><body><div id="card"></div></body></html>`;

const DECK = {
  topic: "Birds of Western Europe",
  prompt: "common garden birds",
  subDecks: ["garden"],
  cards: [
    {
      id: "c1",
      archetype: "identify",
      front: "Robin?",
      back: "Erithacus rubecula",
      subDeck: "garden",
      sourceUrl: "https://en.wikipedia.org/wiki/European_robin",
      seenCount: 0,
      lastSeen: null,
      flagged: false,
      deleted: false,
    },
  ],
  sources: [],
  runs: [],
};

let server: RawServer;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/storage", storageRouter);
  app.use("/api/artifacts", artifactsRouter);
  server = await listenRaw(app);
});

afterAll(() => server.close());

/** Run the served page's inline scripts in a fake frame whose parent is a REST-backed host bound to one key. */
async function runInHost(html: string, render: RenderArtifactToolResult) {
  let port: MessagePort | undefined;
  const bound = encodeURIComponent(render.storage_key ?? "");
  const hostOps: string[] = [];

  async function perform(req: ArtifactBridgeRequest): Promise<unknown> {
    if (req.token !== TOKEN) throw new Error("bad token");
    if (!render.storage_key || render.storage_access === "none") throw new Error("unbound");
    if (req.op !== "list" && !storage.isValidItemName(req.name)) throw new Error("invalid name");
    const item = `${server.origin}/api/storage/${bound}/items/${encodeURIComponent(req.name ?? "")}`;
    hostOps.push(`${req.op} ${req.name ?? ""}`);
    if (req.op === "list") return (await (await fetch(`${server.origin}/api/storage/${bound}`)).json()).key.items;
    if (req.op === "read") {
      const text = await (await fetch(item)).text();
      return req.as === "json" ? JSON.parse(text) : text;
    }
    if (render.storage_access !== "readwrite") throw new Error("read-only");
    if (req.op === "write") {
      const body = req.encoding === "base64" ? { content_base64: req.data, mimeType: req.mimeType } : { content: req.data, mimeType: req.mimeType };
      const res = await fetch(item, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error);
      return true;
    }
    await fetch(item, { method: "DELETE" });
    return true;
  }

  // The hello: check the token, then speak only over the transferred port — init first.
  const parent = {
    postMessage(msg: { __callboard?: string; token?: string }, _target: string, transfer?: MessagePort[]) {
      if (msg?.__callboard !== "artifact-bridge-hello" || msg.token !== TOKEN || !transfer?.[0] || port) return;
      const p = (port = transfer[0]);
      p.on("message", (req: ArtifactBridgeRequest) => {
        if (req?.__callboard !== "artifact-bridge-request") return;
        void perform(req).then(
          (result) => p.postMessage({ __callboard: "artifact-bridge-reply", id: req.id, ok: true, result } satisfies ArtifactBridgeReply),
          (err: Error) => p.postMessage({ __callboard: "artifact-bridge-reply", id: req.id, ok: false, error: err.message } satisfies ArtifactBridgeReply),
        );
      });
      p.postMessage({ __callboard: "artifact-bridge-init", storageKey: render.storage_key ?? null, access: render.storage_access });
    },
  };
  const win: Record<string, unknown> = { parent, addEventListener: () => undefined };
  const ctx = vm.createContext({ window: win, Promise, Object, JSON, Math, String, Error, TypeError, ArrayBuffer, Uint8Array, btoa, MessageChannel, setTimeout, clearTimeout });
  // Execute every inline script in document order, as the browser would.
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    if (code.includes("ResizeObserver")) continue; // the size reporter needs a DOM; not under test here
    vm.runInContext(code, ctx);
  }
  for (let i = 0; i < 200 && !win.done && !win.failed; i++) await new Promise((r) => setTimeout(r, 5));
  port?.close();
  return { win, hostOps };
}

describe("cramhouse = one artifact + one storage key per deck", () => {
  it("saves the artifact and the deck, renders bound to the key, and the served app reads and writes through the bridge", async () => {
    const saved = await tool("save_artifact", {
      id: "cramhouse",
      name: "cramhouse",
      content_type: "html",
      storage_access: "readwrite",
      content: CRAMHOUSE_HTML,
      note: "flip UI",
    });
    expect(saved).toMatchObject({ created: true, version: { version: 1 } });
    expect(await tool("create_storage_key", { key: "cramhouse-birds-of-western-europe", description: "Birds of Western Europe" })).not.toHaveProperty("error");
    expect(await tool("save_storage_item", { key: "cramhouse-birds-of-western-europe", name: "deck.json", content: JSON.stringify(DECK) })).toMatchObject({
      item: { name: "deck.json", mimeType: "application/json" },
    });

    const render = (await tool("render_artifact", { id: "cramhouse", storage_key: "cramhouse-birds-of-western-europe" })) as RenderArtifactToolResult;
    expect(render).toEqual({
      type: "render_artifact",
      artifact_id: "cramhouse",
      version: 1,
      sha256: saved.version.sha256,
      name: "cramhouse",
      content_type: "html",
      storage_key: "cramhouse-birds-of-western-europe",
      storage_access: "readwrite",
    });

    const served = await server.request("GET", `/api/artifacts/${render.artifact_id}/versions/${render.version}/render?bridge=${TOKEN}&sha256=${render.sha256}`);
    expect(served.status).toBe(200);
    expect(served.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(served.headers["content-security-policy"]).toMatch(/^default-src 'none'; script-src 'unsafe-inline';/);
    const html = served.body.toString();
    expect(html).toContain(artifactBridgeShimScript(TOKEN));
    expect(html.indexOf(artifactBridgeShimScript(TOKEN))).toBeLessThan(html.indexOf("window.callboard.ready"));

    const { win, hostOps } = await runInHost(html, render);
    expect(win.failed).toBeUndefined();
    expect(win.done).toBe(true);
    expect(win.boundTo).toEqual({ storageKey: "cramhouse-birds-of-western-europe", access: "readwrite" });
    expect(win.firstFront).toBe("Robin?");
    expect(hostOps).toEqual(["read deck.json", "write deck.json"]);
    const stored = JSON.parse(storage.readStorageItemBytes("cramhouse-birds-of-western-europe", "deck.json").data.toString());
    expect(stored.cards[0].seenCount).toBe(1);
    expect(storage.getStorageItem("cramhouse-birds-of-western-europe", "deck.json").mimeType).toBe("application/json");
  });

  it("an unbound render of the same artifact gets access none, and its calls fail inside the frame", async () => {
    const render = (await tool("render_artifact", { id: "cramhouse" })) as RenderArtifactToolResult;
    expect(render.storage_access).toBe("none");
    expect(render.storage_key).toBeUndefined();
    const html = (await server.request("GET", `/api/artifacts/cramhouse/versions/1/render?bridge=${TOKEN}&sha256=${render.sha256}`)).body.toString();
    const { win, hostOps } = await runInHost(html, render);
    expect(win.boundTo).toEqual({ storageKey: null, access: "none" });
    expect(win.failed).toMatch(/without a storage key/);
    expect(hostOps).toEqual([]);
  });
});
