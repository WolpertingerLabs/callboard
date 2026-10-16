/**
 * Route-level tests for the two places the settings router reads a client's
 * address for the remote-access IP allowlist:
 *
 *   GET /api/agent-settings/caller-ip — what "Add my IP" offers
 *   PUT /api/agent-settings           — the save-time self-lockout guard
 *
 * Both must agree with `requireAllowedIp`, which judges `allowlistSubject`: a
 * direct loopback/LAN client is exempt, anyone else is judged by the LAST
 * `X-Forwarded-For` entry (the one a loopback proxy such as `tailscale serve`
 * appended) or, on a direct connection, the socket address. An "Add my IP" that
 * offered a different address, or a guard that judged one, would let the
 * operator save a list that locks them out on their next request.
 *
 * Driven with a fake req/res off the router stack, as in
 * agent-settings.partial-update.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-allowlist-route-"));
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
vi.mock("../services/sdk-info.js", () => ({ refreshSdkInfoCache: async () => {} }));
vi.mock("../services/codex-models.js", () => ({ refreshCodexModelsCache: async () => {} }));

const { agentSettingsRouter } = await import("./agent-settings.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

type Handler = (req: Request, res: Response) => unknown;
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
}
const routeHandler = (path: string, method: "get" | "put"): Handler =>
  (agentSettingsRouter as unknown as { stack: Layer[] }).stack.find((layer) => layer.route?.path === path && layer.route.methods[method])!.route!.stack.at(-1)!.handle;

const callerIpHandler = routeHandler("/caller-ip", "get");
const putHandler = routeHandler("/", "put");

interface Client {
  socket: { remoteAddress: string };
  headers: Record<string, string>;
}

/** A browser on the same machine. */
const LOCAL: Client = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
/** A browser on the LAN, connecting directly. */
const LAN: Client = { socket: { remoteAddress: "192.168.1.42" }, headers: {} };
/** A tailnet device connecting straight to the daemon port. */
const TAILNET: Client = { socket: { remoteAddress: "100.101.102.103" }, headers: {} };
/** A tailnet device behind `tailscale serve`, with a client-written head on its XFF. */
const PROXIED: Client = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "9.9.9.9, 100.101.102.103" } };

function call(handler: Handler, client: Client, body?: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    void handler({ ...client, body } as unknown as Request, res as unknown as Response);
  });
}

const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

beforeEach(() => {
  writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local" }, null, 2));
});

describe("GET /api/agent-settings/caller-ip", () => {
  it("is the socket address on a direct connection", async () => {
    expect((await call(callerIpHandler, LAN)).body).toEqual({ callerIp: "192.168.1.42" });
    expect((await call(callerIpHandler, TAILNET)).body).toEqual({ callerIp: "100.101.102.103" });
  });

  it("is the last X-Forwarded-For entry behind a loopback proxy, not the head", async () => {
    expect((await call(callerIpHandler, PROXIED)).body).toEqual({ callerIp: "100.101.102.103" });
  });

  it("ignores a CF-Connecting-IP header", async () => {
    const res = await call(callerIpHandler, { socket: { remoteAddress: "127.0.0.1" }, headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "100.101.102.103" } });
    expect(res.body).toEqual({ callerIp: "100.101.102.103" });
  });

  it("ignores forwarding headers on a direct non-loopback connection", async () => {
    const res = await call(callerIpHandler, { socket: { remoteAddress: "203.0.113.7" }, headers: { "x-forwarded-for": "100.101.102.103" } });
    expect(res.body).toEqual({ callerIp: "203.0.113.7" });
  });
});

describe("PUT /api/agent-settings — allowlist self-lockout guard", () => {
  it("refuses a proxied saver whose last X-Forwarded-For entry is not on the new list", async () => {
    // The head (9.9.9.9) is on the list; the gate judges the tail, so this
    // saver would be locked out by their own save.
    const res = await call(putHandler, PROXIED, { remoteAccessIpAllowlist: ["9.9.9.9"] });
    expect(res.code).toBe(400);
    expect(String(res.body.error)).toContain("100.101.102.103");
    expect(onDisk().remoteAccessIpAllowlist).toBeUndefined();
  });

  it("accepts a proxied saver whose last X-Forwarded-For entry is on the new list", async () => {
    const res = await call(putHandler, PROXIED, { remoteAccessIpAllowlist: ["100.64.0.0/10"] });
    expect(res.code).toBe(200);
    expect(onDisk().remoteAccessIpAllowlist).toEqual(["100.64.0.0/10"]);
  });

  it("refuses a direct tailnet saver (IPv4 or IPv6) who is not on the new list", async () => {
    expect((await call(putHandler, TAILNET, { remoteAccessIpAllowlist: ["203.0.113.7"] })).code).toBe(400);
    const v6: Client = { socket: { remoteAddress: "fd7a:115c:a1e0::1" }, headers: {} };
    expect((await call(putHandler, v6, { remoteAccessIpAllowlist: ["203.0.113.7"] })).code).toBe(400);
    expect((await call(putHandler, v6, { remoteAccessIpAllowlist: ["fd7a:115c:a1e0::/48"] })).code).toBe(200);
  });

  it("exempts a direct LAN or loopback saver, who the gate never judges", async () => {
    for (const client of [LAN, LOCAL]) {
      const res = await call(putHandler, client, { remoteAccessIpAllowlist: ["203.0.113.7"] });
      expect(res.code).toBe(200);
      expect(onDisk().remoteAccessIpAllowlist).toEqual(["203.0.113.7"]);
    }
  });

  it("does not exempt a loopback socket that carries a forwarding header", async () => {
    // A proxy announced itself, so this is not the operator's own browser.
    const res = await call(putHandler, { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "127.0.0.1, 198.51.100.4" } }, { remoteAccessIpAllowlist: ["203.0.113.7"] });
    expect(res.code).toBe(400);
  });

  it("lets anyone clear the list", async () => {
    expect((await call(putHandler, PROXIED, { remoteAccessIpAllowlist: [] })).code).toBe(200);
  });
});
