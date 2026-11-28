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
 * save fans out to (daemon lifecycle, SDK/Codex catalog refreshes) is
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
vi.mock("../services/sdk-info.js", () => ({ refreshSdkInfoCache: async () => {} }));
vi.mock("../services/codex-models.js", () => ({ refreshCodexModelsCache: async () => {} }));

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
    await put({ remoteAccessIpAllowlist: ["203.0.113.7"] });
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
 * The cloudflared remote-access tunnel is gone. A settings file written while it
 * existed still carries its fields — one of them a credential that is no longer
 * on the masked-secret list — so they must be dropped on read, purged by the
 * next save, and ignored when an old tab sends them back.
 */
describe("PUT /api/agent-settings — retired remote-access tunnel fields", () => {
  const RETIRED = {
    remoteAccessEnabled: true,
    remoteAccessMode: "named",
    cloudflaredToken: "retired-cf-token",
    remoteAccessHostname: "callboard.example.com",
  };

  it("neither echoes nor keeps them once anything is saved", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...REMOTE_SETTINGS, ...RETIRED }, null, 2));
    const res = await put({ model: "claude-opus-5" });
    expect(res.code).toBe(200);
    for (const key of Object.keys(RETIRED)) {
      expect(key in res.body, key).toBe(false);
      expect(key in onDisk(), key).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain("retired-cf-token");
    expect(onDisk().proxyMode).toBe("remote");
  });

  it("does not store them when a stale client sends them", async () => {
    const res = await put({ ...RETIRED, model: "claude-opus-5" });
    expect(res.code).toBe(200);
    for (const key of Object.keys(RETIRED)) expect(key in onDisk(), key).toBe(false);
  });
});

/**
 * The Cline harness is gone too. Its settings — `clineApiKey` among them, a
 * stored secret — are dropped on read and purged by the next save, exactly like
 * the tunnel fields above, and a stale Settings tab sending them back stores
 * nothing.
 */
describe("PUT /api/agent-settings — retired Cline fields", () => {
  const RETIRED = {
    clineProviderId: "openrouter",
    clineModel: "openai/gpt-5.4",
    clineApiKey: "sk-or-retired-cline-key",
    clineBaseUrl: "https://example.invalid/v1",
    clineMaxIterations: 40,
  };

  it("neither echoes nor keeps them once anything is saved", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...REMOTE_SETTINGS, ...RETIRED }, null, 2));
    const res = await put({ model: "claude-opus-5" });
    expect(res.code).toBe(200);
    for (const key of Object.keys(RETIRED)) {
      expect(key in res.body, key).toBe(false);
      expect(key in onDisk(), key).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain("retired-cline-key");
    expect(onDisk().proxyMode).toBe("remote");
  });

  it("does not store them when a stale client sends them", async () => {
    const res = await put({ ...RETIRED, model: "claude-opus-5" });
    expect(res.code).toBe(200);
    for (const key of Object.keys(RETIRED)) expect(key in onDisk(), key).toBe(false);
  });
});

/**
 * The ACP harness (OpenCode) is gone as well. `acpOpenRouterApiKey` is a stored
 * secret; it and the two other `acp*` fields go the same way as Cline's.
 */
describe("PUT /api/agent-settings — retired ACP fields", () => {
  const RETIRED = {
    acpUseOpenRouter: true,
    acpOpenRouterApiKey: "sk-or-retired-acp-key",
    acpProviderModels: { opencode: "opencode/gpt-5.5" },
  };

  it("neither echoes nor keeps them once anything is saved", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...REMOTE_SETTINGS, ...RETIRED }, null, 2));
    const res = await put({ model: "claude-opus-5" });
    expect(res.code).toBe(200);
    for (const key of Object.keys(RETIRED)) {
      expect(key in res.body, key).toBe(false);
      expect(key in onDisk(), key).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain("retired-acp-key");
    expect(onDisk().proxyMode).toBe("remote");
  });

  it("does not store them when a stale client sends them", async () => {
    const res = await put({ ...RETIRED, model: "claude-opus-5" });
    expect(res.code).toBe(200);
    for (const key of Object.keys(RETIRED)) expect(key in onDisk(), key).toBe(false);
  });
});

/**
 * pi had a hole the (since retired) Cline tab had first: this handler
 * destructures an explicit allowlist off `req.body` and silently ignores any
 * key it does not recognise, so a field missing from it saves nothing. The
 * Cline fix gained `cline*` and left `pi*` behind.
 *
 * The symptom reads as a model
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

describe("PUT /api/agent-settings — openRouterVoiceModel round-trips", () => {
  it("persists the voice model, trimmed", async () => {
    const res = await put({ openRouterVoiceModel: "  openai/gpt-4o-mini-transcribe " });
    expect(res.code).toBe(200);
    expect(onDisk().openRouterVoiceModel).toBe("openai/gpt-4o-mini-transcribe");
  });

  it("clears it on a blank value, so the default applies", async () => {
    await put({ openRouterVoiceModel: "openai/whisper-1" });
    await put({ openRouterVoiceModel: "   " });
    expect(onDisk().openRouterVoiceModel).toBeUndefined();
  });

  it("is left alone when an unrelated field is saved", async () => {
    await put({ openRouterVoiceModel: "openai/whisper-1" });
    await put({ openRouterApiKey: "sk-or-other" });
    expect(onDisk().openRouterVoiceModel).toBe("openai/whisper-1");
  });
});

describe("PUT /api/agent-settings — read-aloud model and voice round-trip", () => {
  it("persists both, trimmed", async () => {
    const res = await put({ openRouterTtsModel: "  deepgram/aura-2 ", openRouterTtsVoice: " luna " });
    expect(res.code).toBe(200);
    expect(onDisk().openRouterTtsModel).toBe("deepgram/aura-2");
    expect(onDisk().openRouterTtsVoice).toBe("luna");
  });

  it("clears each on a blank value, so the defaults apply", async () => {
    await put({ openRouterTtsModel: "deepgram/aura-2", openRouterTtsVoice: "luna" });
    await put({ openRouterTtsModel: "", openRouterTtsVoice: "   " });
    expect(onDisk().openRouterTtsModel).toBeUndefined();
    expect(onDisk().openRouterTtsVoice).toBeUndefined();
  });

  it("strips control characters, keeping non-ASCII voice ids intact", async () => {
    const res = await put({ openRouterTtsModel: "deepgram/\u0000aura-2\r\n", openRouterTtsVoice: "日本\r\n語\t\u007f" });
    expect(res.code).toBe(200);
    expect(onDisk().openRouterTtsModel).toBe("deepgram/aura-2");
    expect(onDisk().openRouterTtsVoice).toBe("日本語");
  });

  it("clears a value that is only control characters", async () => {
    await put({ openRouterTtsVoice: "luna" });
    await put({ openRouterTtsVoice: "\r\n\u0000" });
    expect(onDisk().openRouterTtsVoice).toBeUndefined();
  });

  it("is left alone when an unrelated field is saved", async () => {
    await put({ openRouterTtsModel: "deepgram/aura-2", openRouterTtsVoice: "luna" });
    await put({ openRouterApiKey: "sk-or-other" });
    expect(onDisk().openRouterTtsModel).toBe("deepgram/aura-2");
    expect(onDisk().openRouterTtsVoice).toBe("luna");
  });
});

describe("PUT /api/agent-settings — claudeProjectHooks (H-02)", () => {
  it("stores always/never, clears to the default on trusted or anything unknown, and is left alone when omitted", async () => {
    await put({ claudeProjectHooks: "always" });
    expect(onDisk().claudeProjectHooks).toBe("always");
    await put({ model: "claude-opus-5" });
    expect(onDisk().claudeProjectHooks).toBe("always");
    await put({ claudeProjectHooks: "never" });
    expect(onDisk().claudeProjectHooks).toBe("never");
    await put({ claudeProjectHooks: "trusted" });
    expect(onDisk().claudeProjectHooks).toBeUndefined();
    await put({ claudeProjectHooks: "always" });
    await put({ claudeProjectHooks: "sometimes" });
    expect(onDisk().claudeProjectHooks).toBeUndefined();
  });
});
