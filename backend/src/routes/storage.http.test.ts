/**
 * /api/storage over a REAL socket, with request paths sent unnormalized.
 *
 * The traversal matrix is delivered raw (where HTTP allows the bytes at all)
 * and percent-encoded, as item names and as keys, on reads and on writes. The
 * pass condition is not a particular status — it is that no request ever
 * reads the planted secrets or writes a byte outside the one legitimate key.
 *
 * Also pins the serving rules: only raster images and text/plain are inline;
 * HTML, SVG and everything else is an attachment; every response is nosniff,
 * sandboxed by CSP, and no-store.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TRAVERSAL_MATRIX } from "../services/__fixtures__/storage-traversal-matrix.js";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-storage-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { storageRouter, STORAGE_ITEM_CSP } = await import("./storage.js");
const svc = await import("../services/storage-service.js");

const SECRET = "TOPSECRET-do-not-serve";
const PWNED = "PWNED-must-not-land";

let server: RawServer;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/storage", storageRouter);
  server = await listenRaw(app);
  // Secrets next to, and one level above, the store.
  writeFileSync(join(DATA, "secret"), SECRET);
  mkdirSync(join(DATA, "storage"), { recursive: true });
  writeFileSync(join(DATA, "storage", "secret"), SECRET);
  await svc.createStorageKey("k");
  await svc.saveStorageItem("k", "real.txt", Buffer.from("hello"));
});

afterAll(() => server.close());

/** Every way a hostile segment can be put on the wire. */
function wireForms(bad: string): string[] {
  const forms = new Set<string>([encodeURIComponent(bad)]);
  // Node's client refuses bytes outside 0x21-0xFF in a path; everything else goes raw.
  if (bad && /^[\x21-\x7e]+$/.test(bad)) forms.add(bad);
  return [...forms];
}

const EXTRA_RAW = ["%2e%2e", "%2E%2E", "%2e%2e%2fsecret", "..%2F..%2Fsecret", "..%5c..%5csecret", "%00", "real.txt%00.png", "..;", "%252e%252e"];

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? allFiles(p) : [relative(DATA, p)];
  });
}

describe("traversal matrix over a real socket", () => {
  const attempts: { method: string; path: string }[] = [];
  for (const bad of TRAVERSAL_MATRIX) {
    for (const seg of wireForms(bad)) {
      attempts.push({ method: "GET", path: `/api/storage/k/items/${seg}` });
      attempts.push({ method: "GET", path: `/api/storage/${seg}` });
      attempts.push({ method: "GET", path: `/api/storage/${seg}/items/real.txt` });
      attempts.push({ method: "PUT", path: `/api/storage/k/items/${seg}` });
      attempts.push({ method: "PUT", path: `/api/storage/${seg}/items/x.txt` });
      attempts.push({ method: "DELETE", path: `/api/storage/k/items/${seg}` });
    }
  }
  for (const seg of EXTRA_RAW) {
    attempts.push({ method: "GET", path: `/api/storage/k/items/${seg}` });
    attempts.push({ method: "PUT", path: `/api/storage/k/items/${seg}` });
    attempts.push({ method: "GET", path: `/api/storage/${seg}` });
  }
  // Classic dot-segment walks, sent verbatim.
  for (const walk of [
    "/api/storage/k/items/../../secret",
    "/api/storage/k/items/../../../secret",
    "/api/storage/../secret",
    "/api/storage/k/items/..%2f..%2f..%2fsecret",
  ]) {
    attempts.push({ method: "GET", path: walk }, { method: "PUT", path: walk });
  }

  it(`never serves a secret or writes outside the key (${attempts.length} requests)`, async () => {
    const before = allFiles(DATA).sort();
    const served: string[] = [];
    for (const { method, path } of attempts) {
      // An empty key segment is just the catalogue listing — legitimately 200.
      if (path === "/api/storage/") continue;
      const res = await server.request(method, path, method === "PUT" ? JSON.stringify({ content: PWNED }) : undefined, {
        "Content-Type": "application/json",
      });
      if (res.status < 400 || res.body.includes(SECRET)) served.push(`${method} ${path} → ${res.status}`);
      expect([400, 404], `${method} ${JSON.stringify(path)}`).toContain(res.status);
    }
    expect(served).toEqual([]);
    expect(allFiles(DATA).sort()).toEqual(before);
    for (const f of allFiles(DATA)) expect(readFileSync(join(DATA, f), "utf-8"), f).not.toContain(PWNED);
    // The legitimate item is still reachable.
    const ok = await server.request("GET", "/api/storage/k/items/real.txt");
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe("hello");
  });

  it("answers a validation failure with 400 and a JSON error", async () => {
    const res = await server.request("GET", "/api/storage/k/items/%2e%2e");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString()).error).toMatch(/Invalid item name/);
  });
});

describe("serving rules", () => {
  const cases: { name: string; mimeType?: string; body: Buffer; inline: boolean; type: string }[] = [
    { name: "page.html", body: Buffer.from("<script>alert(document.cookie)</script>"), inline: false, type: "application/octet-stream" },
    {
      name: "pic.svg",
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      inline: false,
      type: "application/octet-stream",
    },
    { name: "fake.png", mimeType: "text/html", body: Buffer.from("<script>alert(1)</script>"), inline: false, type: "application/octet-stream" },
    { name: "data.json", body: Buffer.from("{}"), inline: false, type: "application/octet-stream" },
    { name: "code.js", body: Buffer.from("alert(1)"), inline: false, type: "application/octet-stream" },
    { name: "doc.xhtml", mimeType: "application/xhtml+xml", body: Buffer.from("<html/>"), inline: false, type: "application/octet-stream" },
    { name: "img.png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), inline: true, type: "image/png" },
    { name: "img.jpg", body: Buffer.from([0xff, 0xd8]), inline: true, type: "image/jpeg" },
    { name: "img.gif", body: Buffer.from("GIF89a"), inline: true, type: "image/gif" },
    { name: "img.webp", body: Buffer.from("RIFF"), inline: true, type: "image/webp" },
    { name: "notes.txt", body: Buffer.from("plain"), inline: true, type: "text/plain; charset=utf-8" },
  ];

  it.each(cases)("$name → $type, inline=$inline, always nosniff + CSP sandbox + no-store", async ({ name, mimeType, body, inline, type }) => {
    await svc.createStorageKey("serve").catch(() => undefined);
    await svc.saveStorageItem("serve", name, body, { mimeType });
    const res = await server.request("GET", `/api/storage/serve/items/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(type);
    expect(res.headers["content-disposition"]).toBe(`${inline ? "inline" : "attachment"}; filename="${name}"`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(STORAGE_ITEM_CSP);
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.equals(body)).toBe(true);
  });
});

describe("REST surface", () => {
  it("creates, lists, patches and deletes keys", async () => {
    const json = { "Content-Type": "application/json" };
    expect((await server.request("POST", "/api/storage", JSON.stringify({ key: "rest", description: "d" }), json)).status).toBe(201);
    expect((await server.request("POST", "/api/storage", JSON.stringify({ key: "rest" }), json)).status).toBe(409);
    expect((await server.request("POST", "/api/storage", JSON.stringify({ key: "../x" }), json)).status).toBe(400);
    const list = JSON.parse((await server.request("GET", "/api/storage")).body.toString());
    expect(list.keys.map((k: { key: string }) => k.key)).toContain("rest");
    expect((await server.request("PATCH", "/api/storage/rest", JSON.stringify({ description: "new" }), json)).status).toBe(200);
    const detail = JSON.parse((await server.request("GET", "/api/storage/rest")).body.toString());
    expect(detail.key).toMatchObject({ key: "rest", description: "new", items: [] });
    expect((await server.request("DELETE", "/api/storage/rest")).status).toBe(200);
    expect((await server.request("GET", "/api/storage/rest")).status).toBe(404);
  });

  it("PUT accepts JSON content, JSON content_base64, and multipart file; rejects both/neither and bad base64", async () => {
    const json = { "Content-Type": "application/json" };
    await svc.createStorageKey("put");
    expect((await server.request("PUT", "/api/storage/put/items/a.txt", JSON.stringify({ content: "héllo" }), json)).status).toBe(200);
    expect((await server.request("GET", "/api/storage/put/items/a.txt")).body.toString()).toBe("héllo");
    const b64 = Buffer.from([1, 2, 3]).toString("base64");
    const r = await server.request("PUT", "/api/storage/put/items/b.bin", JSON.stringify({ content_base64: b64, mimeType: "application/x-thing" }), json);
    expect(JSON.parse(r.body.toString()).item).toMatchObject({ name: "b.bin", size: 3, mimeType: "application/x-thing" });
    expect((await server.request("PUT", "/api/storage/put/items/c.txt", JSON.stringify({ content: "a", content_base64: "YQ==" }), json)).status).toBe(400);
    expect((await server.request("PUT", "/api/storage/put/items/c.txt", JSON.stringify({}), json)).status).toBe(400);
    expect((await server.request("PUT", "/api/storage/put/items/c.txt", JSON.stringify({ content_base64: "not base64!" }), json)).status).toBe(400);

    const form = new FormData();
    form.append("file", new Blob([Buffer.from([0x89, 0x50])], { type: "image/png" }), "up.png");
    const up = await fetch(`${server.origin}/api/storage/put/items/up.png`, { method: "PUT", body: form });
    expect(up.status).toBe(200);
    expect((await up.json()).item).toMatchObject({ name: "up.png", size: 2, mimeType: "image/png" });
  });

  it("multipart over the 25MB item limit is refused with 413 and nothing lands", async () => {
    await svc.createStorageKey("big");
    const form = new FormData();
    form.append("file", new Blob([Buffer.alloc(svc.STORAGE_MAX_ITEM_BYTES + 1)]), "big.bin");
    const res = await fetch(`${server.origin}/api/storage/big/items/big.bin`, { method: "PUT", body: form });
    expect(res.status).toBe(413);
    expect(svc.listStorageItems("big")).toEqual([]);
  });
});
