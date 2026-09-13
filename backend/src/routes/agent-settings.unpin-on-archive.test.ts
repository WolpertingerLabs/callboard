/**
 * PUT /api/agent-settings round-trip for `unpinChatsOnArchive`.
 *
 * The field's default is ON when absent, which is the whole reason this file
 * exists: "absent ⇒ true" and "stored false" are a pair that is easy to write
 * and easy to break, because the only difference between them is a key that is
 * not there. An explicit `false` has to survive the write, survive a later save
 * from an unrelated tab, and not be quietly deleted by a malformed value — any
 * of which would revert the behaviour to on without telling anyone.
 *
 * Same no-supertest style and the same fan-out stubs as
 * agent-settings.partial-update.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-unpin-setting-route-"));
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
const { unpinOnArchiveEnabled } = await import("../services/card-archive-unpin.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const route = (method: "get" | "put") =>
  (agentSettingsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods[method]).route.stack[0].handle;

function call(handler: any, body: unknown): Promise<{ code: number; body: any }> {
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
    void handler({ body, query: {}, headers: {}, socket: {} } as unknown as Request, res as unknown as Response);
  });
}

const put = (body: unknown) => call(route("put"), body);
const get = () => call(route("get"), {});
const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

beforeEach(() => {
  writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local" }, null, 2));
});

describe("PUT /api/agent-settings — unpinChatsOnArchive", () => {
  it("reads as on before anyone has ever set it", async () => {
    expect(onDisk().unpinChatsOnArchive).toBeUndefined();
    expect((await get()).body.unpinChatsOnArchive).toBeUndefined();
    expect(unpinOnArchiveEnabled()).toBe(true);
  });

  it("persists an explicit false and reads it back as off", async () => {
    const res = await put({ unpinChatsOnArchive: false });

    expect(res.code).toBe(200);
    expect(res.body.unpinChatsOnArchive).toBe(false);
    // On disk as `false`, not merely absent — absent would mean "on".
    expect(onDisk().unpinChatsOnArchive).toBe(false);
    expect((await get()).body.unpinChatsOnArchive).toBe(false);
    expect(unpinOnArchiveEnabled()).toBe(false);
  });

  it("turns back on, and stores the true rather than dropping the key", async () => {
    await put({ unpinChatsOnArchive: false });
    const res = await put({ unpinChatsOnArchive: true });

    expect(res.body.unpinChatsOnArchive).toBe(true);
    expect(onDisk().unpinChatsOnArchive).toBe(true);
    expect(unpinOnArchiveEnabled()).toBe(true);
  });

  it("survives a save from an unrelated settings tab", async () => {
    await put({ unpinChatsOnArchive: false });
    await put({ openRouterApiKey: "sk-or-test" });

    expect(onDisk().unpinChatsOnArchive).toBe(false);
    expect(unpinOnArchiveEnabled()).toBe(false);
  });

  it("leaves a stored false alone when the value is not a boolean", async () => {
    await put({ unpinChatsOnArchive: false });
    // A form serialiser, a shell script, or a typo. Clearing the field here
    // would silently revert the behaviour to its default-on state.
    for (const bogus of ["false", "true", 0, 1, null, {}, []]) {
      const res = await put({ unpinChatsOnArchive: bogus });
      expect(res.code, `value=${JSON.stringify(bogus)}`).toBe(200);
      expect(onDisk().unpinChatsOnArchive, `value=${JSON.stringify(bogus)}`).toBe(false);
    }
    expect(unpinOnArchiveEnabled()).toBe(false);
  });

  it("does not invent the field when a bogus value arrives with nothing stored", async () => {
    await put({ unpinChatsOnArchive: "yes please" });
    expect(onDisk().unpinChatsOnArchive).toBeUndefined();
    expect(unpinOnArchiveEnabled()).toBe(true);
  });
});
