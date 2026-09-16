/**
 * Route-level tests for the narrow favorites pair:
 *
 *   GET  /api/agent-settings/favorites
 *   PUT  /api/agent-settings/favorites
 *
 * Two things justify the route's existence and are what these pin down.
 *
 *  1. **It leaks nothing.** The full settings object is unredacted — `apiKey`,
 *     `authToken`, `openRouterApiKey`, `codexApiKey`, `cloudflaredToken`. That
 *     was survivable while every caller was the Settings page, which exists to
 *     edit those fields. The New Chat launchpad is not, and it asks on every
 *     new-chat open from whatever device is on the remote-access tunnel. The
 *     response here is two arrays and nothing else, and the test asserts the
 *     absence by name rather than by shape, because a new credential field
 *     added to `AgentSettings` later must not quietly start shipping.
 *
 *  2. **It writes by the same rules as the main PUT.** `[]` clears, a non-array
 *     leaves the stored list alone, order survives. The star in Settings and
 *     the star on the launchpad must mean the same thing — see
 *     agent-settings.favorites.test.ts, which pins the same rules on the other
 *     handler, and `normalizeIdList`, which is now one function for both.
 *
 * Also pinned: the PUT's response is the authoritative post-write pair. The
 * client adopts it instead of keeping its optimistic copy, so a response that
 * echoed the request rather than the stored state would defeat the point.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-favorites-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const SETTINGS_FILE = join(tmpRoot, "agent-settings.json");

vi.mock("../services/proxy-singleton.js", () => ({
  switchProxyMode: async () => {},
  testRemoteConnection: async () => ({ status: "connected", message: "" }),
  getConfiguredAliases: () => [],
  resetAllClients: () => {},
  resetClient: () => {},
}));
vi.mock("../services/local-daemon.js", () => ({ getLocalDaemonStatus: () => ({}), fetchDaemonHealth: async () => null }));
vi.mock("../services/web-tunnel.js", () => ({
  startWebTunnel: async () => {},
  stopWebTunnel: async () => {},
  getWebTunnelStatus: () => ({ running: false }),
  isCloudflaredAvailable: () => false,
  resolveCallboardPort: () => 8000,
}));
vi.mock("../services/sdk-info.js", () => ({ refreshSdkInfoCache: async () => {} }));
vi.mock("../services/codex-models.js", () => ({ refreshCodexModelsCache: async () => {} }));

const { agentSettingsRouter } = await import("./agent-settings.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const handlerFor = (method: "get" | "put") =>
  (agentSettingsRouter as any).stack.find((layer: any) => layer.route?.path === "/favorites" && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;

function call(method: "get" | "put", body?: unknown): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    void handlerFor(method)({ body, headers: {}, socket: {}, query: {} } as unknown as Request, res as unknown as Response);
  });
}

const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

/** A user with credentials configured and a few things starred. */
const STORED = {
  proxyMode: "local",
  apiKey: "sk-ant-secret",
  authToken: "tok-secret",
  openRouterApiKey: "sk-or-secret",
  codexApiKey: "sk-codex-secret",
  cloudflaredToken: "cf-secret",
  favoriteSkills: ["release-notes", "bug-triage"],
  favoriteJobs: ["bake-devin-pr"],
};

beforeEach(() => {
  writeFileSync(SETTINGS_FILE, JSON.stringify(STORED, null, 2));
});

describe("GET /api/agent-settings/favorites", () => {
  it("returns the two lists in the user's order", async () => {
    const res = await call("get");
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ favoriteSkills: ["release-notes", "bug-triage"], favoriteJobs: ["bake-devin-pr"] });
  });

  it("returns ONLY the two lists — no credential rides along", async () => {
    const res = await call("get");
    expect(Object.keys(res.body).sort()).toEqual(["favoriteJobs", "favoriteSkills"]);
    for (const secret of ["apiKey", "authToken", "openRouterApiKey", "codexApiKey", "cloudflaredToken"]) {
      expect(secret in res.body).toBe(false);
    }
    // Belt and braces: no stored secret VALUE appears anywhere in the payload,
    // which catches a leak through a nested object a key check would miss.
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("reads an unset list back as an empty array", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local" }));
    const res = await call("get");
    expect(res.body).toEqual({ favoriteSkills: [], favoriteJobs: [] });
  });
});

describe("PUT /api/agent-settings/favorites", () => {
  it("stores the list verbatim and answers with what is now on disk", async () => {
    const res = await call("put", { favoriteSkills: ["bug-triage", "release-notes", "changelog"] });
    expect(res.code).toBe(200);
    expect(onDisk().favoriteSkills).toEqual(["bug-triage", "release-notes", "changelog"]);
    // The response is the post-write pair, including the list this request did
    // not touch — it is what the client adopts as authoritative.
    expect(res.body).toEqual({ favoriteSkills: ["bug-triage", "release-notes", "changelog"], favoriteJobs: ["bake-devin-pr"] });
  });

  it("normalizes the way the main PUT does, and reports the normalized list", async () => {
    const res = await call("put", { favoriteJobs: ["  nightly  ", "", "nightly", "weekly", 7, null] });
    expect(onDisk().favoriteJobs).toEqual(["nightly", "weekly"]);
    // The client sent something else. This is why it adopts the response.
    expect(res.body.favoriteJobs).toEqual(["nightly", "weekly"]);
  });

  it("clears the setting when the last star is removed", async () => {
    const res = await call("put", { favoriteSkills: [] });
    expect("favoriteSkills" in onDisk()).toBe(false);
    expect(res.body.favoriteSkills).toEqual([]);
    expect(onDisk().favoriteJobs).toEqual(["bake-devin-pr"]);
  });

  it("leaves a stored list alone when the body sends a non-array", async () => {
    // A truncated request or an older client must not be able to say "clear".
    const res = await call("put", { favoriteSkills: null, favoriteJobs: "bake-devin-pr" });
    expect(onDisk().favoriteSkills).toEqual(["release-notes", "bug-triage"]);
    expect(onDisk().favoriteJobs).toEqual(["bake-devin-pr"]);
    expect(res.body).toEqual({ favoriteSkills: ["release-notes", "bug-triage"], favoriteJobs: ["bake-devin-pr"] });
  });

  it("ignores every other settings field in the body", async () => {
    // The narrow route is narrow in both directions: it is not a second way to
    // write an API key.
    await call("put", { favoriteSkills: ["changelog"], apiKey: "sk-ant-injected", proxyMode: "remote" });
    expect(onDisk().apiKey).toBe("sk-ant-secret");
    expect(onDisk().proxyMode).toBe("local");
    expect(onDisk().favoriteSkills).toEqual(["changelog"]);
  });

  it("does not leak credentials in its response either", async () => {
    const res = await call("put", { favoriteSkills: ["changelog"] });
    expect(Object.keys(res.body).sort()).toEqual(["favoriteJobs", "favoriteSkills"]);
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("tolerates an empty body", async () => {
    const res = await call("put", {});
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ favoriteSkills: ["release-notes", "bug-triage"], favoriteJobs: ["bake-devin-pr"] });
  });
});
