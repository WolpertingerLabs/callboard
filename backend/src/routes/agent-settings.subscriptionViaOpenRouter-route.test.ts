import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-agent-settings-subor-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const SETTINGS_FILE = join(tmpRoot, "agent-settings.json");

const switchProxyMode = vi.fn(async (_mode: string | undefined) => {});
vi.mock("../services/proxy-singleton.js", () => ({
  switchProxyMode: (mode: string | undefined) => switchProxyMode(mode),
  testRemoteConnection: async () => ({ status: "connected", message: "" }),
  getConfiguredAliases: () => [],
  resetAllClients: () => {},
  resetClient: () => {},
}));
vi.mock("../services/local-daemon.js", () => ({ getLocalDaemonStatus: () => ({}), fetchDaemonHealth: async () => null }));
const refreshSdk = vi.fn(async () => {});
const refreshCodex = vi.fn(async () => {});
vi.mock("../services/sdk-info.js", () => ({ refreshSdkInfoCache: () => refreshSdk() }));
vi.mock("../services/codex-models.js", () => ({ refreshCodexModelsCache: () => refreshCodex() }));

const { agentSettingsRouter } = await import("./agent-settings.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const putHandler = (agentSettingsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.put).route.stack.at(-1).handle as (
  req: Request,
  res: Response,
) => Promise<void>;

/** Invoke PUT / with a body and resolve with the status code and JSON body. */
function put(body: unknown): Promise<{ code: number; body: any }> {
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
    void putHandler({ body, headers: {}, socket: {} } as unknown as Request, res as unknown as Response);
  });
}

const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

beforeEach(() => {
  refreshSdk.mockClear();
  refreshCodex.mockClear();
  writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local", openRouterApiKey: "sk-or-old" }, null, 2));
});

describe("PUT /api/agent-settings — route subscription through OpenRouter", () => {
  it("persists both flags, and clears them on an explicit false", async () => {
    expect((await put({ claudeCodeSubscriptionViaOpenRouter: true, codexSubscriptionViaOpenRouter: true })).code).toBe(200);
    expect(onDisk()).toMatchObject({ claudeCodeSubscriptionViaOpenRouter: true, codexSubscriptionViaOpenRouter: true });
    await put({ claudeCodeSubscriptionViaOpenRouter: false });
    expect(onDisk()).toMatchObject({ claudeCodeSubscriptionViaOpenRouter: false, codexSubscriptionViaOpenRouter: true });
  });

  it("refreshes the SDK account and the Codex catalog when a flag moves", async () => {
    await put({ claudeCodeSubscriptionViaOpenRouter: true });
    expect(refreshSdk).toHaveBeenCalledTimes(1);
    expect(refreshCodex).not.toHaveBeenCalled();
    await put({ codexSubscriptionViaOpenRouter: true });
    expect(refreshCodex).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the account-wide key changes while a mode is on, and only then", async () => {
    await put({ openRouterApiKey: "sk-or-new" });
    expect(refreshSdk).not.toHaveBeenCalled();
    expect(refreshCodex).not.toHaveBeenCalled();

    await put({ claudeCodeSubscriptionViaOpenRouter: true, codexSubscriptionViaOpenRouter: true });
    refreshSdk.mockClear();
    refreshCodex.mockClear();

    // Unchanged key (the page's Save sends every field): nothing to refresh.
    await put({ openRouterApiKey: "sk-or-new" });
    expect(refreshSdk).not.toHaveBeenCalled();
    expect(refreshCodex).not.toHaveBeenCalled();

    await put({ openRouterApiKey: "sk-or-newer" });
    expect(refreshSdk).toHaveBeenCalledTimes(1);
    expect(refreshCodex).toHaveBeenCalledTimes(1);
  });

  it("rejects an OpenRouter key with a line break inside it, and stores nothing", async () => {
    for (const field of ["openRouterApiKey", "claudeCodeOpenRouterApiKey", "codexOpenRouterApiKey"]) {
      const res = await put({ [field]: "sk-or-a\r\nx-evil: 1", claudeCodeSubscriptionViaOpenRouter: true });
      expect(res.code).toBe(400);
      expect(res.body.error).toContain(field);
      expect(res.body.error).toContain("line break");
    }
    expect(onDisk()).toEqual({ proxyMode: "local", openRouterApiKey: "sk-or-old" });
  });

  it("accepts a key whose only line break is a trailing one, trimmed away", async () => {
    expect((await put({ openRouterApiKey: "sk-or-pasted\n" })).code).toBe(200);
    expect(onDisk().openRouterApiKey).toBe("sk-or-pasted");
  });
});
