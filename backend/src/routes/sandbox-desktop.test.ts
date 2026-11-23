/**
 * Settings → Sandbox desktop over HTTP: any authenticated caller reads, only a
 * signed-in session changes settings or builds (an API key gets 403), values
 * are validated against the shared bounds, and the automatic mode resolves
 * as documented. Docker is pointed at a binary that does not exist, so
 * diagnostics report it unreachable without touching a real daemon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-sandbox-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.CALLBOARD_DOCKER_BIN = join(tmpRoot, "no-such-docker");
delete process.env.CALLBOARD_SANDBOX_DESKTOP_URL;
delete process.env.CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE;
delete process.env.CALLBOARD_SANDBOX_DESKTOP_TOKEN;

const { sandboxDesktopRouter } = await import("./sandbox-desktop.js");
const { currentSandboxMode } = await import("../services/sandbox-desktop.js");

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for requireAuth: the test says how the caller authenticated.
  app.use((req, res, next) => {
    res.locals.authMethod = req.get("x-test-auth") === "bearer" ? "bearer" : "session";
    next();
  });
  app.use("/api/sandbox-desktop", sandboxDesktopRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandbox-desktop`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmpRoot, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { auth?: "bearer" | "session" } = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-auth": init.auth ?? "session", ...(init.headers as Record<string, string>) },
  });
const settingsFile = () => join(tmpRoot, "sandbox-desktop.json");

describe("GET", () => {
  it("is readable with an API key, which is told it cannot edit", async () => {
    const res = await call("/", { auth: "bearer" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      canEdit: false,
      automatic: true,
      buildCommand: "callboard sandbox build",
      // Automatic, no endpoint variables, and no Docker: managed reads as off, with the step to take.
      effectiveMode: "off",
      problem: "docker-unreachable",
      diagnostics: { docker: { reachable: false }, running: { sessions: 0, limit: 2 }, endpoint: { configured: false } },
    });
    expect(body.owner).toMatch(/^[0-9a-f]{16}$/);
    expect((await (await call("/")).json()).canEdit).toBe(true);
  });
});

describe("PUT", () => {
  it("refuses an API key, and changes nothing", async () => {
    const res = await call("/", { method: "PUT", auth: "bearer", body: JSON.stringify({ mode: "off" }) });
    expect(res.status).toBe(403);
    expect(currentSandboxMode().mode).toBe("managed");
  });

  it("saves a signed-in session's partial update, 0600, and null clears back to the default", async () => {
    let res = await call("/", { method: "PUT", body: JSON.stringify({ mode: "managed", network: "none", cpus: 2, memoryMb: 2048, maxConcurrent: 3 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      settings: { mode: "managed", network: "none", cpus: 2, memoryMb: 2048, maxConcurrent: 3 },
      automatic: false,
      effectiveMode: "managed",
    });
    expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
    res = await call("/", { method: "PUT", body: JSON.stringify({ cpus: 1.5 }) });
    expect((await res.json()).settings).toMatchObject({ network: "none", cpus: 1.5, maxConcurrent: 3 });
    res = await call("/", { method: "PUT", body: JSON.stringify({ mode: null, network: null }) });
    const body = await res.json();
    expect(body.settings).toEqual({ cpus: 1.5, memoryMb: 2048, maxConcurrent: 3 });
    expect(body.automatic).toBe(true);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ cpus: 1.5, memoryMb: 2048, maxConcurrent: 3 });
  });

  it.each([
    [{ mode: "docker" }, /mode must be/],
    [{ network: "host" }, /network must be/],
    [{ cpus: 0.1 }, /cpus must be/],
    [{ cpus: 64 }, /cpus must be/],
    [{ cpus: 1.001 }, /cpus must be/],
    [{ memoryMb: 128 }, /memoryMb must be/],
    [{ memoryMb: 1024.5 }, /memoryMb must be/],
    [{ maxConcurrent: 0 }, /maxConcurrent must be/],
    [{ maxConcurrent: 99 }, /maxConcurrent must be/],
    [{ image: "evil:latest" }, /Unknown sandbox desktop setting/],
  ])("rejects %j", async (patch, message) => {
    const before = readFileSync(settingsFile(), "utf8");
    const res = await call("/", { method: "PUT", body: JSON.stringify(patch) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
  });
});

describe("POST /build", () => {
  it("refuses an API key", async () => {
    expect((await call("/build", { method: "POST", auth: "bearer", body: "{}" })).status).toBe(403);
  });
});

describe("automatic mode", () => {
  it("is endpoint when the endpoint variables are set, so an existing setup keeps working", () => {
    expect(currentSandboxMode({ CALLBOARD_SANDBOX_DESKTOP_URL: "http://127.0.0.1:7801" })).toEqual({ mode: "endpoint", automatic: true });
    expect(currentSandboxMode({ CALLBOARD_SANDBOX_DESKTOP_URL: " " })).toEqual({ mode: "managed", automatic: true });
    expect(currentSandboxMode({})).toEqual({ mode: "managed", automatic: true });
  });
});
