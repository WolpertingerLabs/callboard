/**
 * Served user/agent/external content over a real socket: every route that
 * hands those bytes back on the app origin carries a sandboxing CSP, and the
 * `/api/files/serve?url=` proxy types by extension and refuses non-public
 * destinations on every hop.
 *
 * Upstream fixtures listen on 127.0.0.2. The production address policy refuses
 * all of 127/8, so the tests that need a reachable upstream use a router whose
 * policy admits exactly that one address — every other address, 127.0.0.1
 * included, still goes through the production check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-served-content-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { filesRouter, createFilesRouter } = await import("./files.js");
const { canvasRouter, CANVAS_HTML_CSP } = await import("./canvas.js");
const { gitRouter } = await import("./git.js");
const { imagesRouter } = await import("./images.js");
const { createCanvas } = await import("../services/canvas-service.js");
const { ImageStorageService } = await import("../services/image-storage.js");
const { isPublicAddress } = await import("../utils/public-url-fetch.js");

const SANDBOX_CSP = "default-src 'none'; sandbox";
const UPSTREAM_IP = "127.0.0.2";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/agent-settings")</script></svg>';
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAAMBAQAY3Y2wAAAAAElFTkSuQmCC", "base64");

/** A tiny upstream: per-path handlers, plus a log of every request it received. */
async function listenUpstream(host: string, routes: Record<string, (res: http.ServerResponse) => void>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const handler = routes[new URL(req.url ?? "/", "http://x").pathname];
    if (handler) handler(res);
    else res.writeHead(404).end();
  });
  server.listen(0, host);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let app: RawServer; // production policy everywhere
let fixtureApp: RawServer; // the proxy may reach UPSTREAM_IP, and nothing else non-public
let lookupCalls: string[];
let upstream: Awaited<ReturnType<typeof listenUpstream>>;
let loopbackSecret: Awaited<ReturnType<typeof listenUpstream>>;
let repo: string;
const stalledClosedAt: number[] = [];

beforeAll(async () => {
  loopbackSecret = await listenUpstream("127.0.0.1", {
    "/secret.png": (res) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG),
  });
  upstream = await listenUpstream(UPSTREAM_IP, {
    "/report.pdf": (res) => res.writeHead(200, { "Content-Type": "image/svg+xml" }).end(SVG),
    "/drawing.svg": (res) => res.writeHead(200, { "Content-Type": "image/svg+xml" }).end(SVG),
    "/pic.png": (res) => res.writeHead(200, { "Content-Type": "text/html" }).end(PNG),
    "/hop.png": (res) => res.writeHead(302, { Location: "/pic.png" }).end(),
    "/to-loopback.png": (res) => res.writeHead(302, { Location: `http://127.0.0.1:${loopbackSecret.port}/secret.png` }).end(),
    "/to-localhost.png": (res) => res.writeHead(307, { Location: `http://localhost:${loopbackSecret.port}/secret.png` }).end(),
    "/to-metadata.png": (res) => res.writeHead(301, { Location: "http://169.254.169.254/latest/meta-data/x.png" }).end(),
    "/to-file.png": (res) => res.writeHead(302, { Location: "file:///etc/passwd.png" }).end(),
    "/loop.png": (res) => res.writeHead(302, { Location: "/loop.png" }).end(),
    // One chunk, then hold the response open until the proxy lets go.
    "/stalled.png": (res) => {
      res.writeHead(200, { "Content-Type": "image/png" }).write(PNG);
      res.once("close", () => stalledClosedAt.push(Date.now()));
    },
  });

  const prod = express();
  prod.use("/api/files", filesRouter);
  prod.use("/api/canvas", canvasRouter);
  prod.use("/api/git", gitRouter);
  prod.use("/api/images", imagesRouter);
  app = await listenRaw(prod);

  lookupCalls = [];
  const fixture = express();
  fixture.use(
    "/api/files",
    createFilesRouter({
      isAllowedAddress: (address) => address === UPSTREAM_IP || isPublicAddress(address),
      // media.test → the fixture upstream; everything else through real DNS.
      lookup: (hostname, options, callback) => {
        lookupCalls.push(hostname);
        if (hostname === "media.test") return callback(null, [{ address: UPSTREAM_IP, family: 4 }]);
        if (hostname === "rebind.test")
          return callback(null, [
            { address: "93.184.215.14", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ]);
        dns.lookup(hostname, options, callback as never);
      },
    }),
  );
  fixtureApp = await listenRaw(fixture);

  repo = mkdtempSync(join(tmpdir(), "callboard-served-content-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "logo.svg"), SVG);
});

afterAll(async () => {
  await Promise.all([app.close(), fixtureApp.close(), upstream.close(), loopbackSecret.close()]);
});

const serveUrl = (server: RawServer, url: string) => server.request("GET", `/api/files/serve?url=${encodeURIComponent(url)}`);

function expectSandboxed(res: { status: number; headers: http.IncomingHttpHeaders }, csp = SANDBOX_CSP) {
  expect(res.status).toBe(200);
  expect(res.headers["content-security-policy"]).toBe(csp);
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
}

describe("every served-content route carries a sandboxing CSP", () => {
  it("files/serve?path= (an .svg on disk)", async () => {
    const file = join(DATA, "drawing.svg");
    writeFileSync(file, SVG);
    const res = await app.request("GET", `/api/files/serve?path=${encodeURIComponent(file)}`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
  });

  it("files/serve?url=", async () => {
    const res = await serveUrl(fixtureApp, `${upstream.origin}/drawing.svg`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.body.toString()).toBe(SVG);
  });

  it("canvas html: the iframe's own `sandbox allow-scripts`, so a top-level open is still an opaque origin", async () => {
    const { result } = createCanvas({ name: "c", content_type: "html", content: "<p>x</p><script>1</script>" });
    const res = await app.request("GET", `/api/canvas/${result!.canvas_id}/1`);
    expectSandboxed(res, CANVAS_HTML_CSP);
    expect(CANVAS_HTML_CSP).toBe("sandbox allow-scripts");
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
  });

  it("canvas svg", async () => {
    const { result } = createCanvas({ name: "s", content_type: "svg", content: SVG });
    const res = await app.request("GET", `/api/canvas/${result!.canvas_id}/1`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
  });

  it("git/diff/file/raw (an .svg in a repo)", async () => {
    const res = await app.request("GET", `/api/git/diff/file/raw?folder=${encodeURIComponent(repo)}&filename=logo.svg`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
  });

  it("images/:id", async () => {
    const stored = await ImageStorageService.storeImage(PNG, "a.png", "image/png");
    const res = await app.request("GET", `/api/images/${stored.image!.id}`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("image/png");
  });
});

describe("URL proxy: the extension decides the type, never the upstream", () => {
  it("a .pdf whose upstream answers image/svg+xml is served as application/pdf", async () => {
    const res = await serveUrl(fixtureApp, `${upstream.origin}/report.pdf`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("application/pdf");
  });

  it("a .png whose upstream answers text/html is served as image/png", async () => {
    const res = await serveUrl(fixtureApp, `${upstream.origin}/pic.png`);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("a same-host redirect is still followed (by hand), and typed by the original URL", async () => {
    const res = await serveUrl(fixtureApp, `${upstream.origin}/hop.png`);
    expectSandboxed(res);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body.equals(PNG)).toBe(true);
  });

  it("a hostname connects to the address its one validated lookup returned", async () => {
    lookupCalls.length = 0;
    const before = upstream.hits.length;
    const res = await serveUrl(fixtureApp, `http://media.test:${upstream.port}/pic.png`);
    expect(res.status).toBe(200);
    expect(lookupCalls).toEqual(["media.test"]);
    expect(upstream.hits.length).toBe(before + 1);
  });
});

describe("URL proxy: client disconnects", () => {
  it("a client that aborts mid-stream releases the upstream socket at once, not at the 30s timeout", async () => {
    const { port } = new URL(fixtureApp.origin);
    const abortedAt = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: `/api/files/serve?url=${encodeURIComponent(`${upstream.origin}/stalled.png`)}` },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve(Date.now());
          });
        },
      );
      req.on("error", (err) => (err.message === "socket hang up" ? undefined : reject(err)));
    });
    await expect.poll(() => stalledClosedAt.length, { timeout: 2000 }).toBe(1);
    expect(stalledClosedAt[0] - abortedAt).toBeLessThan(1000);
  });
});

describe("URL proxy: non-public destinations are refused", () => {
  const refusedLiterals = [
    "http://127.0.0.1:1/x.png",
    "http://127.9.9.9/x.png",
    "http://[::1]/x.png",
    "http://[::ffff:127.0.0.1]/x.png",
    "http://[::ffff:7f00:1]/x.png",
    "http://0.0.0.0/x.png",
    "http://[::]/x.png",
    "http://[::7f00:1]/x.png", // IPv4-compatible ::/96 — ipaddr.js calls it unicast
    "http://[::127.0.0.1]/x.png",
    "http://[::a00:1]/x.png",
    "http://10.1.2.3/x.png",
    "http://172.16.0.1/x.png",
    "http://192.168.1.1/x.png",
    "http://100.64.0.1/x.png",
    "http://169.254.169.254/x.png",
    "http://[fe80::1]/x.png",
    "http://[fd00::1]/x.png",
    "http://[64:ff9b::7f00:1]/x.png",
    "http://2130706433/x.png", // 127.0.0.1 as one decimal number; URL parsing normalizes it
  ];
  it.each(refusedLiterals)("%s → 403", async (url) => {
    const res = await serveUrl(app, url);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("loopback on a live port: 403, and the loopback server never sees a request", async () => {
    const before = loopbackSecret.hits.length;
    expect((await serveUrl(app, `http://127.0.0.1:${loopbackSecret.port}/secret.png`)).status).toBe(403);
    expect(loopbackSecret.hits.length).toBe(before);
  });

  it("a hostname that resolves to loopback (checked after DNS): localhost → 403", async () => {
    const before = loopbackSecret.hits.length;
    expect((await serveUrl(app, `http://localhost:${loopbackSecret.port}/secret.png`)).status).toBe(403);
    expect(loopbackSecret.hits.length).toBe(before);
  });

  it("a hostname with any non-public address among its answers → 403", async () => {
    expect((await serveUrl(fixtureApp, "http://rebind.test/x.png")).status).toBe(403);
  });

  it.each(["/to-loopback.png", "/to-localhost.png", "/to-metadata.png"])("redirect %s → 403, and the target is never reached", async (path) => {
    const before = loopbackSecret.hits.length;
    const res = await serveUrl(fixtureApp, `${upstream.origin}${path}`);
    expect(res.status).toBe(403);
    expect(loopbackSecret.hits.length).toBe(before);
  });

  it("redirect to a non-http(s) scheme → 403", async () => {
    expect((await serveUrl(fixtureApp, `${upstream.origin}/to-file.png`)).status).toBe(403);
  });

  it("redirect loops stop after 5 hops", async () => {
    const before = upstream.hits.length;
    expect((await serveUrl(fixtureApp, `${upstream.origin}/loop.png`)).status).toBe(403);
    expect(upstream.hits.length - before).toBe(6);
  });
});

describe("isPublicAddress", () => {
  it.each([
    ["1.1.1.1", true],
    ["93.184.215.14", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.0.0.1", false],
    ["172.31.255.255", false],
    ["192.168.0.1", false],
    ["100.127.255.255", false],
    ["169.254.1.1", false],
    ["0.0.0.0", false],
    ["255.255.255.255", false],
    ["224.0.0.1", false],
    ["::", false],
    ["::1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["::7f00:1", false],
    ["::808:808", false],
    ["::ffff:0:7f00:1", false],
    ["64:ff9b:1::7f00:1", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["not an ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address as string)).toBe(expected);
  });
});
