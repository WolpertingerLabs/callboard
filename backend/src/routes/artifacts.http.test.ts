/**
 * /api/artifacts over a real socket: the render route's headers and injected
 * scripts, the raw source route, and the REST surface.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-artifacts-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { artifactsRouter } = await import("./artifacts.js");
const { ARTIFACT_BRIDGE_SHIM_SCRIPT } = await import("../services/artifact-bridge-shim.js");
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
  it("html: no-network CSP, nosniff, no-store; shim before the artifact's own scripts, size reporter before </body>", async () => {
    const source = "<!doctype html><html><head><script>window.early = typeof window.callboard;</script></head><body><p>hi</p></body></html>";
    expect((await post("/api/artifacts", { id: "app", name: "App", contentType: "html", content: source, storageAccess: "read" })).status).toBe(201);
    const res = await server.request("GET", "/api/artifacts/app/versions/1/render");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(`${PLAN_CSP}; sandbox allow-scripts`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    const html = res.body.toString();
    const shimAt = html.indexOf(ARTIFACT_BRIDGE_SHIM_SCRIPT);
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
    expect(html).toBe(ARTIFACT_BRIDGE_SHIM_SCRIPT + "<p>bare</p>" + SIZE_REPORTER_SCRIPT);
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
});
