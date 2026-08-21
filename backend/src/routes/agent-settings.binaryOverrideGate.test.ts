/**
 * `PUT /api/agent-settings` — binary overrides are a local-client capability.
 *
 * ## What this closes
 *
 * `pathToClaudeCodeExecutable` had existed for the life of the project and had
 * never been reachable over HTTP: `git show main:backend/src/routes/agent-settings.ts`
 * does not mention it. Phase 4 put it and `codexPathOverride` in this request
 * body, which made "which executable does this daemon spawn" remotely writable
 * for the first time — and it shipped ungated, while Phase 3 was refusing *the
 * same client* the far narrower capability of running one command from a closed
 * allowlist. Measured, before the gate:
 *
 *     XFF: 8.8.8.8   POST /api/engines/opencode/install → 403
 *     XFF: 8.8.8.8   PUT  /api/agent-settings           → 200  {"codexPathOverride": …}
 *
 * The daemon then `execFile`d that path for its `--version`, and a chat spawned
 * it outright. Not privilege escalation — an authenticated client can already
 * run commands through a chat — but two phases disagreeing about the same
 * question, with Phase 3's own justification (Remote Access can put this server
 * on the public internet behind one password) settling which way.
 *
 * ## What is asserted, and why each half matters
 *
 * The gate has to be **narrow in two directions at once**: refuse the write
 * from a tunnelled client, and refuse *only* that — an unrelated save must not
 * start 403ing because the settings page posts every field on every save, and
 * reads must keep working so a remote user can still see which binary is in
 * effect. Both halves are here; the second is the one that would break the app.
 *
 * @see plans/engine-availability-and-install.md — Decision 9
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-override-gate-"));
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
const resetEngineProbeCaches = vi.fn();
vi.mock("../services/engine-status.js", () => ({ resetEngineProbeCaches: () => resetEngineProbeCaches() }));

const { agentSettingsRouter } = await import("./agent-settings.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const putHandler = (agentSettingsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.put).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

/** A browser on the same machine: loopback socket, no forwarding header. */
const LOCAL = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
/** A browser on the LAN — also local for this purpose. */
const LAN = { socket: { remoteAddress: "192.168.1.42" }, headers: {} };
/** The same daemon reached through cloudflared: loopback socket, real client in the header. */
const TUNNELLED = { socket: { remoteAddress: "127.0.0.1" }, headers: { "cf-connecting-ip": "8.8.8.8" } };
/** A plain reverse proxy that announces the hop. */
const FORWARDED = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "8.8.8.8" } };

function put(body: unknown, client: Record<string, unknown> = LOCAL): Promise<{ code: number; body: any }> {
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
    void putHandler({ body, ...client } as unknown as Request, res as unknown as Response);
  });
}

const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

beforeEach(() => {
  resetEngineProbeCaches.mockClear();
  writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local" }, null, 2));
});

describe("a local client may set a binary override", () => {
  it("accepts the write from a loopback socket with no forwarding header", async () => {
    const res = await put({ codexPathOverride: "/opt/codex/bin/codex" }, LOCAL);
    expect(res.code).toBe(200);
    expect(onDisk().codexPathOverride).toBe("/opt/codex/bin/codex");
    // And drops the probe caches, so the next chat and the card both see it.
    expect(resetEngineProbeCaches).toHaveBeenCalledTimes(1);
  });

  it("accepts it from the LAN too", async () => {
    const res = await put({ pathToClaudeCodeExecutable: "/opt/claude" }, LAN);
    expect(res.code).toBe(200);
    expect(onDisk().pathToClaudeCodeExecutable).toBe("/opt/claude");
  });
});

describe("a tunnelled client may not", () => {
  it("refuses a codexPathOverride write with 403 and writes nothing", async () => {
    const res = await put({ codexPathOverride: "/tmp/attacker/codex" }, TUNNELLED);
    expect(res.code).toBe(403);
    expect(res.body.error).toMatch(/local network/i);
    expect(onDisk().codexPathOverride).toBeUndefined();
    expect(resetEngineProbeCaches).not.toHaveBeenCalled();
  });

  it("refuses a pathToClaudeCodeExecutable write", async () => {
    const res = await put({ pathToClaudeCodeExecutable: "/tmp/attacker/claude" }, TUNNELLED);
    expect(res.code).toBe(403);
    expect(onDisk().pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("refuses behind a plain forwarding header, not just cloudflared's", async () => {
    expect((await put({ codexPathOverride: "/tmp/x" }, FORWARDED)).code).toBe(403);
  });

  it("refuses a *clearing* write too — removing an override is still deciding which binary runs", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local", codexPathOverride: "/opt/codex" }, null, 2));
    const res = await put({ codexPathOverride: "" }, TUNNELLED);
    expect(res.code).toBe(403);
    expect(onDisk().codexPathOverride).toBe("/opt/codex");
  });

  it("does not let a whole-form save smuggle the field past the gate", async () => {
    // The realistic shape: the settings page posts every field it knows about.
    // A refusal that only looked at a lone-field request would be trivially
    // bypassed by the app's own save button.
    const res = await put({ openRouterApiKey: "sk-or-x", codexModel: "gpt-5.5", codexPathOverride: "/tmp/attacker/codex" }, TUNNELLED);
    expect(res.code).toBe(403);
    // Nothing in the body is applied — the refusal precedes the write.
    expect(onDisk().openRouterApiKey).toBeUndefined();
  });
});

describe("the gate is narrow, which is the half that would break the app", () => {
  it("lets a tunnelled client save every other setting", async () => {
    const res = await put({ openRouterApiKey: "sk-or-test", codexModel: "gpt-5.5", clineApiKey: "k" }, TUNNELLED);
    expect(res.code).toBe(200);
    expect(onDisk().openRouterApiKey).toBe("sk-or-test");
  });

  it("lets a tunnelled client echo the fields back unchanged", async () => {
    // The settings page sends every field on every save, so a remote user
    // saving an unrelated tab posts the override fields at their current values.
    // Refusing that would make the whole page unusable through the tunnel while
    // looking, from the client, like an unexplained 403 on "Save".
    writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local", codexPathOverride: "/opt/codex" }, null, 2));
    const res = await put({ codexPathOverride: "/opt/codex", openRouterApiKey: "sk-or-y" }, TUNNELLED);
    expect(res.code).toBe(200);
    expect(onDisk().openRouterApiKey).toBe("sk-or-y");
    expect(onDisk().codexPathOverride).toBe("/opt/codex");
  });

  it("treats whitespace-only differences as unchanged rather than as an attempt", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local", codexPathOverride: "/opt/codex" }, null, 2));
    expect((await put({ codexPathOverride: "  /opt/codex  " }, TUNNELLED)).code).toBe(200);
  });
});
