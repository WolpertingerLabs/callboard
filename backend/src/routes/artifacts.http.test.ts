/**
 * /api/artifacts over a real socket: the render route's headers and injected
 * scripts, the raw source route, and the REST surface.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawResponse, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-artifacts-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { artifactsRouter, ARTIFACT_ERROR_CSP, renderErrorDocument } = await import("./artifacts.js");
const { artifactBridgeShimScript } = await import("../services/artifact-bridge-shim.js");

const TOKEN = "00112233445566778899aabbccddeeff";
const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const BARE_PIN = sha("<p>bare</p>");
const { SIZE_REPORTER_SCRIPT } = await import("../services/html-injection.js");

/** The CSP the plan specifies, verbatim, plus the response-level sandbox. */
const PLAN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";

let server: RawServer;
const json = { "Content-Type": "application/json" };
const post = (path: string, body: unknown) => server.request("POST", path, JSON.stringify(body), json);

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/artifacts", artifactsRouter);
  server = await listenRaw(app);
});

afterAll(() => server.close());

describe("render route", () => {
  it("html: the artifact CSP (no fetch, no remote loads), nosniff, no-store; shim before the artifact's own scripts, size reporter before </body>", async () => {
    const source = "<!doctype html><html><head><script>window.early = typeof window.callboard;</script></head><body><p>hi</p></body></html>";
    expect((await post("/api/artifacts", { id: "app", name: "App", contentType: "html", content: source, storageAccess: "read" })).status).toBe(201);
    const res = await server.request("GET", "/api/artifacts/app/versions/1/render");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(`${PLAN_CSP}; sandbox allow-scripts`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    const html = res.body.toString();
    const shimAt = html.indexOf(artifactBridgeShimScript(null));
    const reporterAt = html.indexOf(SIZE_REPORTER_SCRIPT);
    expect(shimAt).toBeGreaterThan(html.indexOf("<head>"));
    expect(shimAt).toBeLessThan(html.indexOf("window.early"));
    expect(reporterAt).toBeGreaterThan(html.indexOf("<p>hi</p>"));
    expect(html.slice(reporterAt + SIZE_REPORTER_SCRIPT.length)).toBe("</body></html>");
    expect(html).toContain("artifact-bridge-request");
    expect(html).toContain("canvas-resize");
  });

  it("html without <head>/<body>: shim prepended, reporter appended", async () => {
    await post("/api/artifacts", { id: "bare", name: "Bare", contentType: "html", content: "<p>bare</p>" });
    const html = (await server.request("GET", "/api/artifacts/bare/versions/1/render")).body.toString();
    expect(html).toBe(artifactBridgeShimScript(null) + "<p>bare</p>" + SIZE_REPORTER_SCRIPT);
  });

  it("?bridge=<token> binds that token into the shim of that one no-store response", async () => {
    const res = await server.request("GET", `/api/artifacts/bare/versions/1/render?bridge=${TOKEN}&sha256=${BARE_PIN}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const html = res.body.toString();
    expect(html).toBe(artifactBridgeShimScript(TOKEN) + "<p>bare</p>" + SIZE_REPORTER_SCRIPT);
    expect(html).toContain(`("${TOKEN}");</script>`);
    // Without the param the shim is unbound: no token anywhere in the page.
    const plain = (await server.request("GET", "/api/artifacts/bare/versions/1/render")).body.toString();
    expect(plain).toContain("(null);</script>");
    expect(plain).not.toContain(TOKEN);
  });

  it("rejects any bridge token that is not exactly 32 lowercase hex characters", async () => {
    for (const bad of [
      "",
      "abc",
      TOKEN.toUpperCase(),
      TOKEN + "0",
      TOKEN.slice(1),
      "%22%29%3Balert(1)%2F%2F" + "0".repeat(20),
      `${TOKEN}&bridge=${TOKEN}`,
      "%3C%2Fscript%3E" + "0".repeat(23),
    ]) {
      const res = await server.request("GET", `/api/artifacts/bare/versions/1/render?bridge=${bad}&sha256=${BARE_PIN}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.toString()).not.toContain("<script>");
    }
  });

  describe("sha256 pin (S3-TOCTOU)", () => {
    const expectErrorPage = (res: RawResponse, status: number, text: RegExp) => {
      expect(res.status).toBe(status);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.headers["content-security-policy"]).toBe(ARTIFACT_ERROR_CSP);
      expect(res.headers["cache-control"]).toBe("no-store");
      const html = res.body.toString();
      expect(html).toMatch(text);
      // Nothing that could run, and nothing that could bind the bridge.
      expect(html).not.toContain("<script");
      expect(html).not.toContain(TOKEN);
      expect(html).not.toContain("artifact-bridge");
    };

    it("rejects any pin that is not exactly 64 lowercase hex characters", async () => {
      for (const bad of ["", "abc", BARE_PIN.toUpperCase(), BARE_PIN + "0", BARE_PIN.slice(1), `${BARE_PIN}&sha256=${BARE_PIN}`, "%3Cscript%3E" + "0".repeat(52)]) {
        const res = await server.request("GET", `/api/artifacts/bare/versions/1/render?bridge=${TOKEN}&sha256=${bad}`);
        expect(res.status, bad).toBe(400);
        expect(res.body.toString()).not.toContain("<script");
      }
    });

    it("a bridge token without a pin is refused with a readable page — every bound render is pinned", async () => {
      expectErrorPage(await server.request("GET", `/api/artifacts/bare/versions/1/render?bridge=${TOKEN}`), 409, /not pinned/);
    });

    it("serves only bytes that hash to the pin: delete + recreate between the host's check and the GET is a 409 page, not the new code", async () => {
      await post("/api/artifacts", { id: "swap", name: "Swap", contentType: "html", storageAccess: "readwrite", content: "<p>original</p>" });
      const pinned = sha("<p>original</p>");
      expect((await server.request("GET", `/api/artifacts/swap/versions/1/render?bridge=${TOKEN}&sha256=${pinned}`)).status).toBe(200);
      // The window: the host has judged v1 = "original"; an agent swaps the code.
      expect((await server.request("DELETE", "/api/artifacts/swap")).status).toBe(200);
      await post("/api/artifacts", { id: "swap", name: "Swap", contentType: "html", storageAccess: "readwrite", content: "<p>impostor</p>" });
      const res = await server.request("GET", `/api/artifacts/swap/versions/1/render?bridge=${TOKEN}&sha256=${pinned}`);
      expectErrorPage(res, 409, /has changed since it was checked/);
      expect(res.body.toString()).not.toContain("impostor");
    });

    it("a delete landing in the window is a readable 404 page, not raw JSON in the frame", async () => {
      await post("/api/artifacts", { id: "gone", name: "Gone", contentType: "html", content: "<p>x</p>" });
      expect((await server.request("DELETE", "/api/artifacts/gone")).status).toBe(200);
      expectErrorPage(await server.request("GET", `/api/artifacts/gone/versions/1/render?bridge=${TOKEN}&sha256=${sha("<p>x</p>")}`), 404, /not found/i);
    });

    it("error pages escape the message", async () => {
      expect(renderErrorDocument(`<img src=x onerror=alert(1)> & "q"`)).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;");
    });
  });

  it("svg is served as image/svg+xml, script-less and sandboxed", async () => {
    await post("/api/artifacts", { id: "pic", name: "Pic", contentType: "svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    const res = await server.request("GET", "/api/artifacts/pic/versions/1/render");
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.headers["content-security-policy"]).toMatch(/^default-src 'none';.*sandbox$/);
    expect(res.headers["content-security-policy"]).not.toContain("script-src");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body.toString()).not.toContain("<script>");
  });

  it("markdown is served as text/plain, untouched", async () => {
    await post("/api/artifacts", { id: "doc", name: "Doc", contentType: "markdown", content: "# Title\n<script>x</script>" });
    const res = await server.request("GET", "/api/artifacts/doc/versions/1/render");
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.body.toString()).toBe("# Title\n<script>x</script>");
  });

  it("raw source is text/plain + nosniff for every type, never the injected document", async () => {
    const res = await server.request("GET", "/api/artifacts/app/versions/1");
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.toString()).not.toContain("artifact-bridge-request");
  });

  it("svg (render) and markdown (raw source) honour the sha256 pin too: swapped code is a 409, never the new bytes", async () => {
    for (const [id, contentType, route] of [
      ["pinsvg", "svg", "/render"],
      ["pinmd", "markdown", ""],
    ] as const) {
      const original = contentType === "svg" ? "<svg xmlns='http://www.w3.org/2000/svg'><title>original</title></svg>" : "# original";
      await post("/api/artifacts", { id, name: id, contentType, content: original });
      const pinned = sha(original);
      expect((await server.request("GET", `/api/artifacts/${id}/versions/1${route}?sha256=${pinned}`)).status).toBe(200);
      expect((await server.request("DELETE", `/api/artifacts/${id}`)).status).toBe(200);
      await post("/api/artifacts", { id, name: id, contentType, content: original.replace("original", "impostor") });
      const res = await server.request("GET", `/api/artifacts/${id}/versions/1${route}?sha256=${pinned}`);
      expect(res.status).toBe(409);
      expect(res.body.toString()).not.toContain("impostor");
      // A malformed pin is a 400 on the source route, as on render.
      expect((await server.request("GET", `/api/artifacts/${id}/versions/1${route}?sha256=abc`)).status).toBe(400);
    }
  });

  it("rejects bad versions and hostile ids without touching the filesystem", async () => {
    for (const v of ["0", "-1", "1.5", "abc", "01", "99999999999"]) {
      expect((await server.request("GET", `/api/artifacts/app/versions/${v}/render`)).status, v).toBe(400);
    }
    expect((await server.request("GET", "/api/artifacts/app/versions/7/render")).status).toBe(404);
    for (const id of ["..", "%2e%2e", "..%2fapp", "APP", "a%00", "a%5cb", "%EF%BC%8E%EF%BC%8E"]) {
      expect([400, 404], id).toContain((await server.request("GET", `/api/artifacts/${id}/versions/1/render`)).status);
    }
    expect((await server.request("GET", "/api/artifacts/app/../app/versions/1/render")).status).not.toBe(200);
  });
});

describe("REST surface", () => {
  it("lists, gets, patches, appends versions and deletes", async () => {
    expect((await post("/api/artifacts", { id: "rest", name: "Rest", contentType: "html", content: "a" })).status).toBe(201);
    expect((await post("/api/artifacts", { id: "rest", name: "Rest", contentType: "html", content: "a" })).status).toBe(409);
    expect((await post("/api/artifacts", { id: "Bad Id", name: "x", contentType: "html", content: "a" })).status).toBe(400);
    const list = JSON.parse((await server.request("GET", "/api/artifacts")).body.toString());
    expect(list.artifacts.map((a: { id: string }) => a.id)).toContain("rest");
    const v2 = await post("/api/artifacts/rest/versions", { content: "b", note: "second" });
    expect(v2.status).toBe(201);
    expect(JSON.parse(v2.body.toString()).version).toMatchObject({ version: 2, note: "second" });
    expect((await post("/api/artifacts/nope/versions", { content: "b" })).status).toBe(404);
    const patched = await server.request("PATCH", "/api/artifacts/rest", JSON.stringify({ name: "Rest 2", storageAccess: "readwrite" }), json);
    expect(JSON.parse(patched.body.toString()).artifact).toMatchObject({ name: "Rest 2", storageAccess: "readwrite", currentVersion: 2 });
    const got = JSON.parse((await server.request("GET", "/api/artifacts/rest")).body.toString());
    expect(got.artifact.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect((await server.request("DELETE", "/api/artifacts/rest")).status).toBe(200);
    expect((await server.request("GET", "/api/artifacts/rest")).status).toBe(404);
  });

  it("binding: the artifact plus the key's list in one response; 404 when either is gone, 400 on hostile segments", async () => {
    const storage = await import("../services/storage-service.js");
    await post("/api/artifacts", { id: "bound", name: "Bound", contentType: "html", content: "x", storageAccess: "read" });
    await storage.createStorageKey("bk", undefined, ["bound"]);
    await storage.createStorageKey("unlisted");
    const ok = await server.request("GET", "/api/artifacts/bound/binding/bk");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.toString())).toMatchObject({ artifact: { id: "bound", currentVersion: 1 }, storageKey: { key: "bk", artifacts: ["bound"] } });
    // The route reports; it does not judge — an unlisted key is a 200 with a list that lacks the id.
    expect(JSON.parse((await server.request("GET", "/api/artifacts/bound/binding/unlisted")).body.toString()).storageKey).toEqual({ key: "unlisted", artifacts: [] });
    expect((await server.request("GET", "/api/artifacts/bound/binding/nope")).status).toBe(404);
    expect((await server.request("GET", "/api/artifacts/nope/binding/bk")).status).toBe(404);
    for (const seg of ["..", "%2e%2e", "BK", "a%00"]) {
      expect([400, 404], seg).toContain((await server.request("GET", `/api/artifacts/bound/binding/${seg}`)).status);
    }
  });
});
