/**
 * Every multipart route answers a refused upload with a JSON 4xx that names
 * the limit, over a real socket. Before this, multer errors on the images and
 * agent-import routes fell through to Express's default HTML 500 — including
 * a legitimate user attaching an 11th image.
 *
 * Hostile names here are ones that are harmless even if the field limits
 * regress (`items[x]` nests but has no huge index), so a regression fails
 * these tests instead of freezing the worker; the freeze itself is covered
 * from a child process in agent-export-import.security.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-upload-errors-"));
process.env.CALLBOARD_DATA_DIR = DATA;

vi.mock("../services/cron-scheduler.js", () => ({ scheduleJob: vi.fn() }));

const { imagesRouter } = await import("./images.js");
const { storageRouter } = await import("./storage.js");
const { agentExportImportRouter } = await import("./agent-export-import.js");
const svc = await import("../services/storage-service.js");

let server: RawServer;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/images", imagesRouter);
  app.use("/api/chats", imagesRouter);
  app.use("/api/storage", storageRouter);
  app.use("/api/agents", agentExportImportRouter);
  server = await listenRaw(app);
  await svc.createStorageKey("k");
});

afterAll(async () => {
  await server.close();
  rmSync(DATA, { recursive: true, force: true });
});

const png = (bytes = 8) => new Blob([new Uint8Array(bytes).fill(0x89)], { type: "image/png" });

async function send(method: string, path: string, form: FormData): Promise<{ status: number; type: string; body: { error?: string; code?: string } }> {
  const res = await fetch(server.origin + path, { method, body: form });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: (await res.json().catch(() => ({}))) as { error?: string; code?: string } };
}

const ROUTES: [string, string, string][] = [
  ["POST", "/api/images/upload", "images"],
  ["POST", "/api/chats/c1/images", "images"],
  ["PUT", "/api/storage/k/items/x.png", "file"],
  ["POST", "/api/agents/import", "file"],
];

describe("refused multipart uploads are a JSON 4xx naming the limit", () => {
  it.each(ROUTES)("%s %s: a bracketed field name is a 400", async (method, path, fileField) => {
    const form = new FormData();
    form.append("items[x]", "v");
    form.append(fileField, png(), "a.png");
    const res = await send(method, path, form);
    expect(res.status).toBe(400);
    expect(res.type).toMatch(/application\/json/);
    expect(res.body.code).toBe("LIMIT_FIELD_NESTING");
    expect(res.body.error).toMatch(/nesting/i);
  });

  it.each(ROUTES.slice(0, 2))("%s %s: an 11th image is a 400 that says the limit is 10", async (method, path) => {
    const form = new FormData();
    for (let i = 0; i < 11; i++) form.append("images", png(), `${i}.png`);
    const res = await send(method, path, form);
    expect(res.status).toBe(400);
    expect(res.type).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/at most 10/);
  });

  it("10 images is still accepted", async () => {
    const form = new FormData();
    for (let i = 0; i < 10; i++) form.append("images", png(), `${i}.png`);
    const res = await send("POST", "/api/images/upload", form);
    expect(res.status).toBe(200);
  });

  it("an image over 10MB is a 413 that names the limit", async () => {
    const form = new FormData();
    form.append("images", png(10 * 1024 * 1024 + 1), "big.png");
    const res = await send("POST", "/api/images/upload", form);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/10MB/);
  });

  it("a non-image is a 400, not a 500", async () => {
    const form = new FormData();
    form.append("images", new Blob(["x"], { type: "text/html" }), "x.html");
    const res = await send("POST", "/api/images/upload", form);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid file type/);
  });

  it("storage keeps its own over-limit message and 413", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(26 * 1024 * 1024)]), "big.bin");
    const res = await send("PUT", "/api/storage/k/items/big.bin", form);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/per-item limit is 25MB/);
  });
});
