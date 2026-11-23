/**
 * HTTP Range on `/api/files/serve`, over a real socket.
 *
 * Local files go through `res.sendFile`; the URL proxy forwards one
 * re-serialised range and relays the upstream 206. Whatever the status
 * (200, 206, 304, 416, HEAD), the served type comes from the extension and
 * the sandbox headers are present — those are asserted on every response.
 *
 * The proxy's upstream fixture listens on 127.0.0.2 (::1 where that can't be
 * bound), admitted through the router's `isAllowedAddress` seam exactly as in
 * served-content.http.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawResponse, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-files-range-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { filesRouter, createFilesRouter } = await import("./files.js");
const { isPublicAddress } = await import("../utils/public-url-fetch.js");

const SANDBOX_CSP = "default-src 'none'; sandbox";
const SIZE = 1000;
const BYTES = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));
const UPSTREAM_SIZE = 2000;
const UPSTREAM_BYTES = Buffer.from(Array.from({ length: UPSTREAM_SIZE }, (_, i) => (i * 7) % 253));
const PROXY_CAP = 4096;

async function pickUpstreamIp(): Promise<string> {
  const server = http.createServer();
  const bindable = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.2", () => resolve(true));
  });
  if (bindable) await new Promise<void>((resolve) => server.close(() => resolve()));
  return bindable ? "127.0.0.2" : "::1";
}
const UPSTREAM_IP = await pickUpstreamIp();

function expectServed(res: RawResponse, mime: string) {
  expect(res.headers["content-type"]).toBe(mime);
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-security-policy"]).toBe(SANDBOX_CSP);
}

/** A minimal single-range server over UPSTREAM_BYTES. */
function rangedResponse(req: http.IncomingMessage, res: http.ServerResponse, contentType = "video/mp4") {
  const range = req.headers.range;
  if (!range) return res.writeHead(200, { "Content-Type": contentType, "Content-Length": UPSTREAM_SIZE }).end(UPSTREAM_BYTES);
  const m = /^bytes=(\d*)-(\d*)$/.exec(range)!;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = UPSTREAM_SIZE - Number(m[2]);
    end = UPSTREAM_SIZE - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? UPSTREAM_SIZE - 1 : Math.min(Number(m[2]), UPSTREAM_SIZE - 1);
  }
  if (start >= UPSTREAM_SIZE) return res.writeHead(416, { "Content-Range": `bytes */${UPSTREAM_SIZE}` }).end("unsatisfiable");
  res
    .writeHead(206, {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${UPSTREAM_SIZE}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    })
    .end(UPSTREAM_BYTES.subarray(start, end + 1));
}

const upstreamRoutes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {
  "/ranged.mp4": (req, res) => rangedResponse(req, res),
  "/pic.png": (req, res) => rangedResponse(req, res, "text/html"),
  "/norange.mp4": (_req, res) => res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": UPSTREAM_SIZE }).end(UPSTREAM_BYTES),
  "/badrange.mp4": (_req, res) => res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-9" }).end(UPSTREAM_BYTES.subarray(0, 10)),
  "/weird416.mp4": (_req, res) => res.writeHead(416, { "Content-Range": "bytes */<script>" }).end(),
  "/hop.mp4": (_req, res) => res.writeHead(302, { Location: "/ranged.mp4" }).end(),
  // Ignores the (clamped) range it was sent and keeps writing past the cap, with no Content-Length.
  "/overflow.mp4": (_req, res) => {
    res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${PROXY_CAP * 4 - 1}/${PROXY_CAP * 4}` });
    res.end(Buffer.alloc(PROXY_CAP * 4));
  },
};

let app: RawServer;
let proxyApp: RawServer;
let upstream: http.Server;
let upstreamOrigin: string;
const upstreamHits: Array<{ path: string; range: string | undefined }> = [];
let mp4: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    upstreamHits.push({ path: pathname, range: req.headers.range });
    const handler = upstreamRoutes[pathname];
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  upstream.listen(0, UPSTREAM_IP);
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const { port } = upstream.address() as AddressInfo;
  upstreamOrigin = `http://${UPSTREAM_IP.includes(":") ? `[${UPSTREAM_IP}]` : UPSTREAM_IP}:${port}`;

  const prod = express();
  prod.use("/api/files", filesRouter);
  app = await listenRaw(prod);

  const fixture = express();
  fixture.use(
    "/api/files",
    createFilesRouter({
      isAllowedAddress: (address) => address === UPSTREAM_IP || isPublicAddress(address),
      maxProxyBytes: PROXY_CAP,
    }),
  );
  proxyApp = await listenRaw(fixture);

  mp4 = join(DATA, "clip.mp4");
  writeFileSync(mp4, BYTES);
});

afterAll(async () => {
  await Promise.all([app.close(), proxyApp.close(), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
});

const local = (file: string, headers: Record<string, string> = {}, method = "GET") =>
  app.request(method, `/api/files/serve?path=${encodeURIComponent(file)}`, undefined, headers);

const proxied = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  proxyApp.request(method, `/api/files/serve?url=${encodeURIComponent(`${upstreamOrigin}${path}`)}`, undefined, headers);

/** The last request the upstream received. */
const lastHit = () => upstreamHits[upstreamHits.length - 1];

describe("local files: Range contract", () => {
  it("no Range → 200, full body, Accept-Ranges, Content-Length", async () => {
    const res = await local(mp4);
    expect(res.status).toBe(200);
    expectServed(res, "video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(SIZE));
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.body.equals(BYTES)).toBe(true);
  });

  it.each([
    ["bytes=0-99", 0, 99],
    ["bytes=-100", 900, 999],
    ["bytes=100-", 100, 999],
    ["bytes=990-5000", 990, 999],
  ])("%s → 206 bytes %i-%i", async (range, start, end) => {
    const res = await local(mp4, { Range: range });
    expect(res.status).toBe(206);
    expectServed(res, "video/mp4");
    expect(res.headers["content-range"]).toBe(`bytes ${start}-${end}/${SIZE}`);
    expect(res.headers["content-length"]).toBe(String(end - start + 1));
    expect(res.body.equals(BYTES.subarray(start, end + 1))).toBe(true);
  });

  it("start ≥ size → 416 with bytes */size, and a body that does not reflect the path", async () => {
    const res = await local(mp4, { Range: `bytes=${SIZE}-` });
    expect(res.status).toBe(416);
    expectServed(res, "video/mp4");
    expect(res.headers["content-range"]).toBe(`bytes */${SIZE}`);
    expect(res.body.toString()).not.toContain("clip");
    expect(res.body.length).toBe(0);
  });

  it.each(["items=0-1", "bytes=x", "bytes=5-2", "bytes=", "bytes=0-1,x"])("malformed %s → 200 full body (RFC 9110: ignored)", async (range) => {
    const res = await local(mp4, { Range: range });
    expect(res.status).toBe(200);
    expectServed(res, "video/mp4");
    expect(res.body.equals(BYTES)).toBe(true);
  });

  it("multi-range → 200 full body (send does not build multipart responses)", async () => {
    const res = await local(mp4, { Range: "bytes=0-1,5-6" });
    expect(res.status).toBe(200);
    expectServed(res, "video/mp4");
    expect(res.body.equals(BYTES)).toBe(true);
  });

  it("HEAD → same status and headers, no body", async () => {
    const full = await local(mp4, {}, "HEAD");
    expect(full.status).toBe(200);
    expectServed(full, "video/mp4");
    expect(full.headers["content-length"]).toBe(String(SIZE));
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.body.length).toBe(0);

    const partial = await local(mp4, { Range: "bytes=0-99" }, "HEAD");
    expect(partial.status).toBe(206);
    expectServed(partial, "video/mp4");
    expect(partial.headers["content-range"]).toBe(`bytes 0-99/${SIZE}`);
    expect(partial.body.length).toBe(0);

    const unsatisfiable = await local(mp4, { Range: `bytes=${SIZE}-` }, "HEAD");
    expect(unsatisfiable.status).toBe(416);
    expectServed(unsatisfiable, "video/mp4");
  });

  it("If-None-Match with the ETag → 304, still sandboxed", async () => {
    const first = await local(mp4);
    const etag = first.headers.etag!;
    expect(etag).toBeTruthy();
    const res = await local(mp4, { "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(SANDBOX_CSP);
  });

  it("a stale If-Range → 200 full body", async () => {
    const res = await local(mp4, { Range: "bytes=0-9", "If-Range": '"not-the-etag"' });
    expect(res.status).toBe(200);
    expect(res.body.equals(BYTES)).toBe(true);
  });
});

describe("local files: types and paths", () => {
  it.each([
    ["voice.m4a", "audio/mp4"],
    ["photo.avif", "image/avif"],
    ["subs.vtt", "text/vtt"],
    ["CLIP.M4V", "video/mp4"],
  ])("%s is served as %s (type forced by extension)", async (name, mime) => {
    const file = join(DATA, name);
    writeFileSync(file, "<html><script>alert(1)</script></html>");
    const res = await local(file, { Range: "bytes=0-3" });
    expect(res.status).toBe(206);
    expectServed(res, mime);
  });

  it("an .html file → 415", async () => {
    const file = join(DATA, "page.html");
    writeFileSync(file, "<script>1</script>");
    const res = await local(file);
    expect(res.status).toBe(415);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("a file inside a dot-directory is served (dotfiles: allow)", async () => {
    const dir = join(DATA, ".cache", ".hidden");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rec.mp4");
    writeFileSync(file, BYTES);
    const res = await local(file, { Range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.body.equals(BYTES.subarray(0, 10))).toBe(true);
  });

  it("a file name with spaces, # and % is served", async () => {
    const file = join(DATA, "my #1 100% clip.mp4");
    writeFileSync(file, BYTES);
    const res = await local(file);
    expect(res.status).toBe(200);
    expect(res.body.equals(BYTES)).toBe(true);
  });

  it("a missing file → 404", async () => {
    expect((await local(join(DATA, "nope.mp4"))).status).toBe(404);
  });

  it("a sparse >100MB file: HEAD → 200, and a range past 100MB → 206 (no size cap)", async () => {
    const file = join(DATA, "huge.mp4");
    const size = 150 * 1024 * 1024;
    const fd = openSync(file, "w");
    ftruncateSync(fd, size);
    closeSync(fd);

    const head = await local(file, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(size));

    const res = await local(file, { Range: "bytes=104857600-104857699" });
    expect(res.status).toBe(206);
    expectServed(res, "video/mp4");
    expect(res.headers["content-range"]).toBe(`bytes 104857600-104857699/${size}`);
    expect(res.body.length).toBe(100);
  });
});

describe("URL proxy: Range forwarding", () => {
  it("forwards a re-serialised range and relays the upstream 206", async () => {
    const res = await proxied("/ranged.mp4", { Range: "bytes=  10-19" });
    expect(lastHit()).toEqual({ path: "/ranged.mp4", range: "bytes=10-19" });
    expect(res.status).toBe(206);
    expectServed(res, "video/mp4");
    expect(res.headers["content-range"]).toBe(`bytes 10-19/${UPSTREAM_SIZE}`);
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.body.equals(UPSTREAM_BYTES.subarray(10, 20))).toBe(true);
  });

  it("an open-ended range is clamped to one cap-sized window upstream", async () => {
    const res = await proxied("/ranged.mp4", { Range: "bytes=100-" });
    expect(lastHit().range).toBe(`bytes=100-${100 + PROXY_CAP - 1}`);
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-${UPSTREAM_SIZE - 1}/${UPSTREAM_SIZE}`);
  });

  it("a suffix range is forwarded as a suffix", async () => {
    const res = await proxied("/ranged.mp4", { Range: "bytes=-50" });
    expect(lastHit().range).toBe("bytes=-50");
    expect(res.status).toBe(206);
    expect(res.body.equals(UPSTREAM_BYTES.subarray(UPSTREAM_SIZE - 50))).toBe(true);
  });

  it("the extension decides Content-Type on a 206, not the upstream's text/html", async () => {
    const res = await proxied("/pic.png", { Range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expectServed(res, "image/png");
  });

  it.each(["bytes=0-1,5-6", "bytes=x", "items=0-1", "bytes=0-1,garbage"])("%j from the client → no Range upstream, plain 200", async (range) => {
    const res = await proxied("/ranged.mp4", { Range: range });
    expect(lastHit()).toEqual({ path: "/ranged.mp4", range: undefined });
    expect(res.status).toBe(200);
    expectServed(res, "video/mp4");
    expect(res.headers["accept-ranges"]).toBeUndefined();
  });

  it("no Range from the client → none upstream, and no Accept-Ranges back", async () => {
    const res = await proxied("/ranged.mp4");
    expect(lastHit().range).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBeUndefined();
    expect(res.body.equals(UPSTREAM_BYTES)).toBe(true);
  });

  it("an upstream that ignores the range → 200 with no Accept-Ranges", async () => {
    const res = await proxied("/norange.mp4", { Range: "bytes=0-9" });
    expect(lastHit().range).toBe("bytes=0-9");
    expect(res.status).toBe(200);
    expectServed(res, "video/mp4");
    expect(res.headers["accept-ranges"]).toBeUndefined();
    expect(res.headers["content-range"]).toBeUndefined();
    expect(res.body.equals(UPSTREAM_BYTES)).toBe(true);
  });

  it("a malformed upstream Content-Range → 502", async () => {
    const res = await proxied("/badrange.mp4", { Range: "bytes=0-9" });
    expect(res.status).toBe(502);
  });

  it("an upstream 206 we did not ask for → 502", async () => {
    const res = await proxied("/badrange.mp4");
    expect(res.status).toBe(502);
  });

  it("an upstream 416 is relayed with its Content-Range and an empty body", async () => {
    const res = await proxied("/ranged.mp4", { Range: `bytes=${UPSTREAM_SIZE}-` });
    expect(res.status).toBe(416);
    expectServed(res, "video/mp4");
    expect(res.headers["content-range"]).toBe(`bytes */${UPSTREAM_SIZE}`);
    expect(res.body.length).toBe(0);
  });

  it("an upstream 416 with a malformed Content-Range is relayed without it", async () => {
    const res = await proxied("/weird416.mp4", { Range: "bytes=0-9" });
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBeUndefined();
  });

  it("Range survives a same-host redirect", async () => {
    const before = upstreamHits.length;
    const res = await proxied("/hop.mp4", { Range: "bytes=5-9" });
    expect(upstreamHits.slice(before)).toEqual([
      { path: "/hop.mp4", range: "bytes=5-9" },
      { path: "/ranged.mp4", range: "bytes=5-9" },
    ]);
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 5-9/${UPSTREAM_SIZE}`);
  });

  it("HEAD relays the headers and sends no body", async () => {
    const res = await proxied("/ranged.mp4", { Range: "bytes=0-9" }, "HEAD");
    expect(res.status).toBe(206);
    expectServed(res, "video/mp4");
    expect(res.headers["content-range"]).toBe(`bytes 0-9/${UPSTREAM_SIZE}`);
    expect(res.body.length).toBe(0);
  });

  it("a relayed 206 that runs past the per-response cap mid-stream destroys the connection", async () => {
    const { port } = new URL(proxyApp.origin);
    const outcome = await new Promise<{ aborted: boolean; received: number }>((resolve) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: `/api/files/serve?url=${encodeURIComponent(`${upstreamOrigin}/overflow.mp4`)}`,
          headers: { Range: "bytes=0-" },
        },
        (res) => {
          expect(res.statusCode).toBe(206);
          let received = 0;
          res.on("data", (c: Buffer) => (received += c.length));
          res.on("error", () => resolve({ aborted: true, received }));
          res.on("end", () => resolve({ aborted: !res.complete, received }));
        },
      );
      req.on("error", () => resolve({ aborted: true, received: 0 }));
    });
    expect(lastHit().range).toBe(`bytes=0-${PROXY_CAP - 1}`);
    expect(outcome.aborted).toBe(true);
    expect(outcome.received).toBeLessThanOrEqual(PROXY_CAP);
  });
});
