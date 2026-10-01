/**
 * A draft id is a file name under the queue directory, so it has to be checked
 * before it becomes one. Express percent-decodes route params: over the wire,
 * `/api/queue/..%2Fvictim` reaches the handler as `../victim`, and before ids
 * were validated that read, rewrote or unlinked `$DATA_DIR/victim.json`.
 *
 * This goes over a real socket on purpose. Supertest, `app.inject` and the
 * handler-off-the-stack style the other queue tests use all hand the router an
 * already-normalized path or skip param decoding, so they cannot see this.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { AddressInfo, Server } from "node:net";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-queue-traversal-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

vi.mock("../services/claude.js", () => ({ sendMessage: vi.fn() }));

const express = (await import("express")).default;
const { queueRouter } = await import("./queue.js");
const { ImageStorageService } = await import("../services/image-storage.js");
const { sendMessage } = await import("../services/claude.js");

let server: Server;
let port: number;

/** One raw HTTP/1.1 request, path bytes exactly as given. */
function raw(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n` +
          (payload ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : "") +
          `\r\n${payload}`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve({ status: Number(data.split(" ")[1]), text: data.slice(data.indexOf("\r\n\r\n") + 4) }));
    socket.on("error", reject);
  });
}

const VICTIM = join(DATA_DIR, "victim.json");
let victimImage: string;
let victimContents: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/queue", queueRouter);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;

  victimImage = (await ImageStorageService.storeImage(Buffer.from("victim-png"), "v.png", "image/png")).image!.id;
  victimContents = JSON.stringify({ id: "victim", status: "draft", chat_id: "c", user_message: "secret", images: [{ id: victimImage, originalName: "v.png" }] });
  writeFileSync(VICTIM, victimContents);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("draft ids over the wire", () => {
  it.each([
    ["GET", "/api/queue/..%2Fvictim"],
    ["GET", "/api/queue/%2E%2E%2Fvictim"],
    ["PUT", "/api/queue/..%2Fvictim"],
    ["POST", "/api/queue/..%2Fvictim/execute-now"],
    ["DELETE", "/api/queue/..%2Fvictim"],
    ["DELETE", "/api/queue/%2E%2E%2Fvictim"],
  ])("%s %s is refused and touches nothing outside the queue directory", async (method, path) => {
    const res = await raw(method, path, method === "PUT" ? { user_message: "overwritten", images: [] } : undefined);

    expect(res.status).toBe(400);
    expect(res.text).not.toContain("secret");
    expect(existsSync(VICTIM)).toBe(true);
    expect(readFileSync(VICTIM, "utf8")).toBe(victimContents);
    expect(ImageStorageService.getImage(victimImage)).not.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("still serves a real draft by its UUID", async () => {
    const created = await raw("POST", "/api/queue", { chat_id: "chat-1", user_message: "hello" });
    const { id } = JSON.parse(created.text);
    const read = await raw("GET", `/api/queue/${id}`);
    expect(read.status).toBe(200);
    expect(JSON.parse(read.text)).toMatchObject({ id, user_message: "hello" });
    expect((await raw("DELETE", `/api/queue/${id}`)).status).toBe(200);
  });
});
