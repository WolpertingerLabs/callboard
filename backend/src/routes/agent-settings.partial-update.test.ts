/**
 * Route-level tests for PUT /api/agent-settings as a *partial* update.
 *
 * The regression these pin down: `proxyMode`, `remoteServerUrl` and
 * `tunnelEnabled` used to be passed to updateAgentSettings unconditionally
 * (`proxyMode ?? undefined`). Because the service merges with a spread and
 * persists via JSON.stringify, an explicit `undefined` deleted the key from
 * agent-settings.json — so saving any unrelated tab (API keys, model aliases,
 * remote access) wiped the drawlatch endpoint and the next boot read the
 * default, silently reverting a remote install to local.
 *
 * The handler is pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in cards.metadata.test.ts. Everything the
 * save fans out to (daemon lifecycle, tunnels, SDK/Codex catalog refreshes) is
 * stubbed — only the persisted settings and the switchProxyMode call are
 * asserted on.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-agent-settings-route-"));
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

const putHandler = (agentSettingsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.put).route.stack[0].handle as (
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

/** A configured remote install: external daemon, pinned URL, drawlatch tunnel on. */
const REMOTE_SETTINGS = {
  proxyMode: "remote",
  remoteServerUrl: "http://192.168.1.179:9999",
  tunnelEnabled: true,
  defaultCallerRemote: "ben-default",
};

beforeEach(() => {
  switchProxyMode.mockClear();
  writeFileSync(SETTINGS_FILE, JSON.stringify(REMOTE_SETTINGS, null, 2));
});

describe("PUT /api/agent-settings — proxy fields survive unrelated saves", () => {
  it("leaves the remote drawlatch config intact when the body omits it", async () => {
    const res = await put({ openRouterApiKey: "sk-or-test" });
    expect(res.code).toBe(200);
    expect(res.body.proxyMode).toBe("remote");

    const saved = onDisk();
    expect(saved.proxyMode).toBe("remote");
    expect(saved.remoteServerUrl).toBe("http://192.168.1.179:9999");
    expect(saved.tunnelEnabled).toBe(true);
    expect(saved.openRouterApiKey).toBe("sk-or-test");
  });

  it("survives a remote-access save, which touches neither field", async () => {
    await put({ remoteAccessEnabled: false, remoteAccessMode: "quick" });
    const saved = onDisk();
    expect(saved.proxyMode).toBe("remote");
    expect(saved.remoteServerUrl).toBe("http://192.168.1.179:9999");
  });

  it("does not bounce the proxy when nothing about the endpoint changed", async () => {
    await put({ model: "claude-opus-5" });
    expect(switchProxyMode).not.toHaveBeenCalled();
  });

  it("still applies an explicit mode switch, and reconnects", async () => {
    const res = await put({ proxyMode: "local" });
    expect(res.body.proxyMode).toBe("local");
    expect(onDisk().proxyMode).toBe("local");
    // The pinned URL is kept so switching back doesn't lose it.
    expect(onDisk().remoteServerUrl).toBe("http://192.168.1.179:9999");
    expect(switchProxyMode).toHaveBeenCalledWith("local");
  });

  it("reconnects when only the remote server URL changes", async () => {
    await put({ remoteServerUrl: "http://10.0.0.5:9999" });
    expect(onDisk().remoteServerUrl).toBe("http://10.0.0.5:9999");
    expect(switchProxyMode).toHaveBeenCalledWith("remote");
  });

  it("clears the URL on an empty string and ignores a bogus mode", async () => {
    await put({ remoteServerUrl: "  ", proxyMode: "sideways" });
    const saved = onDisk();
    expect(saved.remoteServerUrl).toBeUndefined();
    expect(saved.proxyMode).toBeUndefined();
  });
});

/**
 * The Cline tab saved nothing at all, and nothing said so.
 *
 * This handler destructures an explicit allowlist off `req.body` and only
 * persists when one of the fields it recognises changed. The Cline adapter
 * shipped with its settings in the type, in the service, and in the UI form —
 * but never added here. So typing a provider, key and model into Settings → API
 * and pressing Save returned 200, showed "Saved!", and wrote nothing.
 *
 * It is invisible by construction: an unknown key is silently ignored rather
 * than rejected, so neither the type system nor the response could catch it.
 * Hence a round-trip test per field.
 */
describe("PUT /api/agent-settings — Cline fields round-trip", () => {
  it("persists every field the Cline settings tab sends", async () => {
    const res = await put({
      clineProviderId: "openrouter",
      clineModel: "openai/gpt-5.4",
      clineApiKey: "sk-or-test",
      clineBaseUrl: "https://example.invalid/v1",
      clineMaxIterations: 40,
    });
    expect(res.code).toBe(200);

    const saved = onDisk();
    expect(saved.clineProviderId).toBe("openrouter");
    expect(saved.clineModel).toBe("openai/gpt-5.4");
    expect(saved.clineApiKey).toBe("sk-or-test");
    expect(saved.clineBaseUrl).toBe("https://example.invalid/v1");
    expect(saved.clineMaxIterations).toBe(40);
  });

  it("saves the Cline tab on its own, without another field to piggyback on", () => {
    // The failure mode this pins: the dirty check gates the write, so a body
    // containing ONLY cline fields has to be enough to trigger a persist.
    return put({ clineProviderId: "anthropic" }).then(() => {
      expect(onDisk().clineProviderId).toBe("anthropic");
    });
  });

  it("clears a field when the user empties it", async () => {
    await put({ clineApiKey: "sk-or-test" });
    expect(onDisk().clineApiKey).toBe("sk-or-test");
    await put({ clineApiKey: "" });
    expect(onDisk().clineApiKey).toBeUndefined();
  });

  it("leaves Cline settings alone when an unrelated tab is saved", async () => {
    await put({ clineProviderId: "openrouter", clineModel: "openai/gpt-5.4" });
    await put({ openRouterApiKey: "sk-or-other" });
    const saved = onDisk();
    expect(saved.clineProviderId).toBe("openrouter");
    expect(saved.clineModel).toBe("openai/gpt-5.4");
  });
});

/**
 * pi had the same hole, and the Cline fix above did not close it — the
 * allowlist gained `cline*` and left `pi*` behind.
 *
 * The symptom is one step further downstream than Cline's and reads as a model
 * failure rather than a settings one: the key never lands on disk, the pi block
 * in `claude.ts` omits `apiKey` from the session options, and pi falls through
 * to its own `auth.json` / `$OPENROUTER_API_KEY` lookup. The chat then ends on
 * "No API key found for openrouter" with nothing streamed, so it presents as
 * "pi doesn't respond" — not as "Settings didn't save".
 */
describe("PUT /api/agent-settings — pi fields round-trip", () => {
  it("persists every field the pi settings tab sends", async () => {
    const res = await put({
      piProviderId: "openrouter",
      piModel: "~anthropic/claude-haiku-latest",
      piApiKey: "sk-or-test",
      piBaseUrl: "https://example.invalid/v1",
    });
    expect(res.code).toBe(200);

    const saved = onDisk();
    expect(saved.piProviderId).toBe("openrouter");
    expect(saved.piModel).toBe("~anthropic/claude-haiku-latest");
    expect(saved.piApiKey).toBe("sk-or-test");
    expect(saved.piBaseUrl).toBe("https://example.invalid/v1");
  });

  it("saves the pi tab on its own, without another field to piggyback on", async () => {
    await put({ piApiKey: "sk-or-solo" });
    expect(onDisk().piApiKey).toBe("sk-or-solo");
  });

  it("clears a field when the user empties it", async () => {
    await put({ piApiKey: "sk-or-test" });
    expect(onDisk().piApiKey).toBe("sk-or-test");
    await put({ piApiKey: "" });
    expect(onDisk().piApiKey).toBeUndefined();
  });

  it("leaves pi settings alone when an unrelated tab is saved", async () => {
    await put({ piProviderId: "openrouter", piModel: "~anthropic/claude-haiku-latest" });
    await put({ openRouterApiKey: "sk-or-other" });
    const saved = onDisk();
    expect(saved.piProviderId).toBe("openrouter");
    expect(saved.piModel).toBe("~anthropic/claude-haiku-latest");
  });
});
