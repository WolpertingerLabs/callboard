/**
 * `/api/files/serve` and Sandbox desktop deliverables, over a real socket:
 * a delivered file is served (inline and as a download) only with `chat=`
 * naming the chat it was delivered to. Another chat, no chat, and anything
 * under the deliverables root that is not a delivered file (a manifest, a
 * temp file) all get the same 404. Paths outside the root are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-files-deliverables-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { createFilesRouter } = await import("./files.js");
const { SandboxDeliveries } = await import("../services/sandbox-deliverables.js");

let app: RawServer;
const files: Record<string, string> = {};

beforeAll(async () => {
  const deliveries = new SandboxDeliveries({ dataDir: DATA });
  for (const [chatId, workspaceId, name, body] of [
    ["chat-a", "ws-1", "chart.png", "\x89PNG fake"],
    ["chat-b", "ws-1", "secret.txt", "chat b only"],
    ["chat-c", "ws-2", "other.pdf", "%PDF other workspace"],
  ]) {
    const data = Buffer.from(body);
    const report = await deliveries.drain(
      {
        sessionId: randomUUID(),
        chatId,
        workspaceId,
        mode: "managed",
        source: {
          listOutbox: async () => [{ name, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), mtimeMs: 0 }],
          downloadOutboxFile: async () => ({
            name,
            size: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
            data,
          }),
        },
      },
      AbortSignal.timeout(5_000),
    );
    files[chatId] = report.files[0].path;
  }
  const server = express();
  server.use("/api/files", createFilesRouter({ dataDir: DATA }));
  app = await listenRaw(server);
});
afterAll(async () => {
  await app.close();
});

const serve = (path: string, query = "") => app.request("GET", `/api/files/serve?path=${encodeURIComponent(path)}${query}`);

describe("deliverables are served to their own chat only", () => {
  it("serves a delivered file to its chat, inline and as a download", async () => {
    const inline = await serve(files["chat-a"], "&chat=chat-a");
    expect(inline.status).toBe(200);
    expect(inline.headers["content-type"]).toBe("image/png");
    expect(inline.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    const download = await serve(files["chat-c"], "&chat=chat-c&download=1");
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.body.toString()).toBe("%PDF other workspace");
  });

  it("refuses another chat in the same workspace, another workspace's chat, and no chat at all — with the same 404", async () => {
    for (const [path, query] of [
      [files["chat-b"], "&chat=chat-a&download=1"],
      [files["chat-c"], "&chat=chat-a&download=1"],
      [files["chat-a"], "&download=1"],
      [files["chat-a"], ""],
      [files["chat-a"], "&chat=chat-b"],
    ]) {
      const res = await serve(path, query);
      expect(res.status, `${path} ${query}`).toBe(404);
      expect(res.body.toString()).toContain("File not found");
    }
  });

  it("never serves the manifest or anything else under the root, even to the owning chat", async () => {
    const manifest = join(files["chat-a"], "..", "..", "manifest.json");
    expect((await serve(manifest, "&chat=chat-a&download=1")).status).toBe(404);
    const stray = join(DATA, "sandbox-deliverables", "stray.txt");
    writeFileSync(stray, "x");
    expect((await serve(stray, "&chat=chat-a&download=1")).status).toBe(404);
  });

  it("leaves paths outside the deliverables root as they were", async () => {
    const outside = join(DATA, "elsewhere.txt");
    writeFileSync(outside, "plain");
    expect((await serve(outside, "&download=1")).status).toBe(200);
  });
});
