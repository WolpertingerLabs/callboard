/**
 * What a `cbk_` API key may do to the install's security posture, over the wire
 * against a real listening server with real sessions, real API keys and a real
 * settings file.
 *
 * - Settings writes, restart and change-password require a logged-in session.
 *   A key could turn on remote access, clear the IP allowlist, repoint
 *   `apiBaseUrl`, restart the daemon, and use change-password as a password
 *   oracle.
 * - `GET /api/agent-settings` masks every credential for every caller, and
 *   saving the masked body back leaves the stored secrets intact.
 * - change-password's `currentPassword` check draws on login's per-client
 *   budget instead of the general 300/min API limit.
 *
 * Restart is an inline handler in `index.ts`, which cannot be imported without
 * starting the daemon, so it is mounted here with the same `requireSessionAuth`
 * gate in front of a stub. Every other route is the real one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-bearer-scope-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const SETTINGS_FILE = join(tmpRoot, "agent-settings.json");

// Everything a settings save fans out to — daemons, tunnels, catalog refreshes.
vi.mock("./services/proxy-singleton.js", () => ({
  switchProxyMode: async () => {},
  testRemoteConnection: async () => ({ status: "connected", message: "" }),
  getConfiguredAliases: () => [],
  resetAllClients: () => {},
  resetClient: () => {},
}));
vi.mock("./services/local-daemon.js", () => ({ getLocalDaemonStatus: () => ({}), fetchDaemonHealth: async () => null }));
vi.mock("./services/web-tunnel.js", () => ({
  startWebTunnel: async () => {},
  stopWebTunnel: async () => {},
  getWebTunnelStatus: () => ({ running: false }),
  isCloudflaredAvailable: () => false,
  resolveCallboardPort: () => 8000,
}));
vi.mock("./services/sdk-info.js", () => ({ refreshSdkInfoCache: async () => {} }));
vi.mock("./services/codex-models.js", () => ({ refreshCodexModelsCache: async () => {} }));
// change-password persists the new hash to .env; keep it off the disk.
vi.mock("./utils/env-writer.js", () => ({ updateEnvFile: () => {} }));

const { loginHandler, requireAuth, requireSessionAuth, changePasswordHandler } = await import("./auth.js");
const { agentSettingsRouter } = await import("./routes/agent-settings.js");
const { createApiKey } = await import("./services/api-keys.js");
const { generateSalt, hashPassword } = await import("./utils/password.js");
const { SECRET_SETTING_FIELDS, maskSecret } = await import("shared/types/index.js");

const PASSWORD = "correct horse battery staple";

/** One distinct, long value per credential field, so a leak of any one is findable in a response body. */
const SECRETS = Object.fromEntries(SECRET_SETTING_FIELDS.map((field) => [field, `raw-${field}-0123456789abcdef-${field.length}XYZ9`])) as Record<
  (typeof SECRET_SETTING_FIELDS)[number],
  string
>;

const SEED = {
  proxyMode: "local",
  remoteAccessEnabled: false,
  remoteAccessMode: "named",
  remoteAccessHostname: "callboard.example.com",
  remoteAccessIpAllowlist: ["203.0.113.7"],
  apiBaseUrl: "https://api.anthropic.example",
  codexSandboxMode: "workspace-write",
  model: "claude-opus-5-5",
  ...SECRETS,
};

const readSettings = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

let port: number;
let server: http.Server;
let session: string;
let bearer: string;

function request(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const headers = {
      ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
      ...opts.headers,
    };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const asSession = (extra: Record<string, string> = {}) => ({ cookie: `callboard_session=${session}`, ...extra });
const asBearer = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${bearer}`, ...extra });
/** A remote client behind the tunnel: loopback socket, CF-Connecting-IP names the bucket. */
const fromClient = (ip: string) => ({ "cf-connecting-ip": ip });

async function login(password: string, headers: Record<string, string> = {}): Promise<Res> {
  return request("POST", "/api/auth/login", { headers, body: { password } });
}

beforeAll(async () => {
  const salt = generateSalt();
  process.env.AUTH_PASSWORD_SALT = salt;
  process.env.AUTH_PASSWORD_HASH = await hashPassword(PASSWORD, salt);
  writeFileSync(SETTINGS_FILE, JSON.stringify(SEED, null, 2));

  // Assembled in index.ts order: cookies, JSON, login ahead of auth, then
  // requireAuth in front of every other /api route.
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.post("/api/auth/login", loginHandler);
  app.use("/api", requireAuth);
  app.use("/api/agent-settings", agentSettingsRouter);
  app.post("/api/auth/change-password", changePasswordHandler);
  app.post("/api/restart", requireSessionAuth, (_req, res) => {
    res.json({ success: true, message: "Restarting..." });
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;

  const res = await login(PASSWORD, fromClient("198.51.100.1"));
  expect(res.status).toBe(200);
  session = /callboard_session=([^;]+)/.exec((res.headers["set-cookie"] ?? []).join(";"))?.[1] ?? "";
  expect(session).not.toBe("");
  bearer = createApiKey("wire-test", "", null).token;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a bearer API key is refused every security-relevant write", () => {
  const gated: Array<[string, string, unknown]> = [
    ["PUT", "/api/agent-settings", { remoteAccessEnabled: true }],
    ["PUT", "/api/agent-settings", { remoteAccessIpAllowlist: [] }],
    ["PUT", "/api/agent-settings", { apiBaseUrl: "https://attacker.example" }],
    ["PUT", "/api/agent-settings", { codexSandboxMode: "danger-full-access" }],
    ["PUT", "/api/agent-settings", { cloudflaredToken: "attacker-token" }],
    ["PUT", "/api/agent-settings", { model: "claude-haiku-4-5" }],
    ["POST", "/api/agent-settings/test-connection", { url: "https://attacker.example" }],
    ["PUT", "/api/agent-settings/default-caller", { alias: null }],
    ["DELETE", "/api/agent-settings/callers/someone", undefined],
    ["POST", "/api/agent-settings/import-bundle", { bundle: {} }],
    ["POST", "/api/restart", undefined],
    ["POST", "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "a brand new password" }],
  ];

  it.each(gated)("%s %s %j → 403", async (method, path, body) => {
    const before = readFileSync(SETTINGS_FILE, "utf-8");
    const res = await request(method, path, { headers: asBearer(), body });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/logged-in session/);
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
    // The change-password row sends the right password. Had it gone through it
    // would have rotated the password and signed out every other session —
    // say so here rather than as a cascade of unrelated session failures below.
    expect((await request("GET", "/api/agent-settings", { headers: asSession() })).status, "session still valid").toBe(200);
  });

  it("can still read settings (masked) and use the favorites route", async () => {
    expect((await request("GET", "/api/agent-settings", { headers: asBearer() })).status).toBe(200);
    const fav = await request("PATCH", "/api/agent-settings/favorites", { headers: asBearer(), body: { skills: { add: ["dep-audit"] } } });
    expect(fav.status).toBe(200);
    expect(fav.json.favoriteSkills).toEqual(["dep-audit"]);
  });
});

describe("a logged-in session still succeeds", () => {
  it("PUT /api/agent-settings", async () => {
    const res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: { codexSandboxMode: "read-only" } });
    expect(res.status).toBe(200);
    expect(readSettings().codexSandboxMode).toBe("read-only");
  });

  it("POST /api/restart", async () => {
    const res = await request("POST", "/api/restart", { headers: asSession() });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
  });

  it("the credential sub-routes are reached (not 403)", async () => {
    for (const [method, path, body] of [
      ["PUT", "/api/agent-settings/default-caller", { alias: 7 }],
      ["POST", "/api/agent-settings/import-bundle", {}],
      ["POST", "/api/agent-settings/test-connection", {}],
    ] as const) {
      const res = await request(method, path, { headers: asSession(), body });
      expect(res.status, `${method} ${path}`).toBe(400);
    }
  });
});

describe("GET /api/agent-settings never returns a raw secret", () => {
  for (const [who, headers] of [
    ["session", () => asSession()],
    ["bearer", () => asBearer()],
  ] as const) {
    it(`to a ${who}`, async () => {
      const res = await request("GET", "/api/agent-settings", { headers: headers() });
      expect(res.status).toBe(200);
      for (const field of SECRET_SETTING_FIELDS) {
        expect(res.text).not.toContain(SECRETS[field]);
        expect(res.json[field], field).toBe(maskSecret(SECRETS[field]));
        expect(res.json[field]).toMatch(/^••••.{4}$/u);
      }
      // Non-secret fields come back as stored.
      expect(res.json.remoteAccessHostname).toBe("callboard.example.com");
      expect(res.json.apiBaseUrl).toBe("https://api.anthropic.example");
    });
  }

  it("nor does the PUT response", async () => {
    const res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: { model: "claude-sonnet-5-5" } });
    expect(res.status).toBe(200);
    for (const field of SECRET_SETTING_FIELDS) expect(res.text).not.toContain(SECRETS[field]);
  });
});

describe("saving the masked body back", () => {
  it("leaves every stored secret intact", async () => {
    const got = await request("GET", "/api/agent-settings", { headers: asSession() });
    const res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: got.json });
    expect(res.status).toBe(200);
    const stored = readSettings();
    for (const field of SECRET_SETTING_FIELDS) expect(stored[field], field).toBe(SECRETS[field]);
  });

  it("keeps a secret sent back as its mask with surrounding whitespace", async () => {
    const res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: { codexApiKey: ` ${maskSecret(SECRETS.codexApiKey)} ` } });
    expect(res.status).toBe(200);
    expect(readSettings().codexApiKey).toBe(SECRETS.codexApiKey);
  });

  // Every way a bullet can survive into the submitted value: none may be stored.
  const leftovers: Array<[string, string]> = [
    ["text typed onto the end of the mask", `${maskSecret(SECRETS.apiKey)}sk-ant-new`],
    ["the mask backspaced down to two bullets (End, Backspace×6)", "••"],
    ["a leading space in front of a mask", " ••••AAAA"],
    ["the mask of a key since replaced from another tab", "••••zzzz"],
  ];
  it.each(leftovers)("refuses %s with a 400 and leaves the key alone", async (_what, value) => {
    const res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: { apiKey: value } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/apiKey.*Clear the field/);
    expect(readSettings().apiKey).toBe(SECRETS.apiKey);
  });

  it("replaces a secret with a new value, and clears it with an empty string", async () => {
    let res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: { piApiKey: "sk-or-v1-brand-new-key-0000" } });
    expect(res.status).toBe(200);
    expect(readSettings().piApiKey).toBe("sk-or-v1-brand-new-key-0000");
    expect(res.json.piApiKey).toBe("••••0000");

    res = await request("PUT", "/api/agent-settings", { headers: asSession(), body: { piApiKey: "" } });
    expect(res.status).toBe(200);
    expect(readSettings().piApiKey).toBeUndefined();
    expect(res.json.piApiKey).toBeUndefined();
  });
});

// Last: a successful change rotates the password every later test would log in with.
describe("change-password shares login's per-client attempt budget", () => {
  const wrong = { currentPassword: "not the password", newPassword: "a brand new password" };

  it("a fourth wrong currentPassword in a minute is 429, and so is the next login", async () => {
    const client = fromClient("198.51.100.20");
    for (let i = 0; i < 3; i++) {
      const res = await request("POST", "/api/auth/change-password", { headers: asSession(client), body: wrong });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    expect((await request("POST", "/api/auth/change-password", { headers: asSession(client), body: wrong })).status).toBe(429);
    // The budget is login's own: the right password from this client is refused too.
    expect((await login(PASSWORD, client)).status).toBe(429);
  });

  it("failed logins spend the budget change-password then finds empty", async () => {
    const client = fromClient("198.51.100.21");
    for (let i = 0; i < 3; i++) expect((await login("wrong", client)).status).toBe(401);
    expect((await request("POST", "/api/auth/change-password", { headers: asSession(client), body: wrong })).status).toBe(429);
  });

  it("a session with the right password on a fresh budget changes it", async () => {
    const res = await request("POST", "/api/auth/change-password", {
      headers: asSession(fromClient("198.51.100.22")),
      body: { currentPassword: PASSWORD, newPassword: "a brand new password" },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});
