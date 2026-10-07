/**
 * Session cookies over the wire, against a real listening server.
 *
 * sessions.json is parsed JSON, so looking a cookie up as `sessions[token]`
 * used to answer `constructor`, `__proto__`, `toString`, ... with an inherited
 * Object.prototype member: a truthy entry whose `expires_at` is undefined, and
 * `Date.now() > undefined` is false. That logged an unauthenticated client in
 * as a full password session, able to mint API keys. These tests drive the
 * daemon's auth wiring (cookie-parser → checkAuthHandler / requireAuth →
 * session-only router) through real HTTP so the cookie takes the same path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-auth-session-token-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("./services/agent-settings.js", () => ({
  getAgentSettings: () => ({}),
  readAgentSettings: () => ({ settings: {}, state: "ok" }),
}));

const { loginHandler, checkAuthHandler, requireAuth } = await import("./auth.js");
const { apiKeysRouter } = await import("./routes/api-keys.js");
const { generateSalt, hashPassword } = await import("./utils/password.js");
const { createSession } = await import("./services/sessions.js");

const PASSWORD = "correct horse battery staple";
const sessionsFile = join(tmpRoot, "sessions.json");
let server: Server;
let base: string;

beforeAll(async () => {
  const salt = generateSalt();
  process.env.AUTH_PASSWORD_SALT = salt;
  process.env.AUTH_PASSWORD_HASH = await hashPassword(PASSWORD, salt);

  // The same order index.ts mounts them in.
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.post("/api/auth/login", loginHandler);
  app.get("/api/auth/check", checkAuthHandler);
  app.use("/api", requireAuth);
  app.use("/api/api-keys", apiKeysRouter);

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

const withCookie = (token: string) => ({ headers: { cookie: `callboard_session=${token}` } });

async function authCheck(token: string): Promise<{ status: number; body: { authenticated: boolean }; setCookie: string | null }> {
  const res = await fetch(`${base}/api/auth/check`, withCookie(token));
  return { status: res.status, body: await res.json(), setCookie: res.headers.get("set-cookie") };
}

async function login(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const token = /callboard_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  expect(token).toBeDefined();
  return token!;
}

describe("prototype-property session cookies", () => {
  // Make sure the store exists and holds a real session, as it would in production.
  beforeAll(async () => {
    await login();
  });

  // cookie-parser JSON-decodes a `j:`-prefixed value, so `j:["constructor"]`
  // arrives as an array that coerces to "constructor" when used as a key.
  it.each([
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    encodeURIComponent('j:["constructor"]'),
    encodeURIComponent('j:["__proto__"]'),
    encodeURIComponent('j:{"a":1}'),
  ])(
    "callboard_session=%s is not authenticated",
    async (token) => {
      const check = await authCheck(token);
      expect(check.body).toEqual({ authenticated: false });
      expect(check.setCookie).toBeNull();

      const list = await fetch(`${base}/api/api-keys`, withCookie(token));
      expect(list.status).toBe(401);

      const mint = await fetch(`${base}/api/api-keys`, {
        method: "POST",
        headers: { ...withCookie(token).headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "pwned" }),
      });
      expect(mint.status).toBe(401);
    },
  );
});

describe("a real session", () => {
  it("still authenticates, rolls, and reaches session-only routes", async () => {
    const token = await login();
    const check = await authCheck(token);
    expect(check.body).toEqual({ authenticated: true });
    expect(check.setCookie).toContain(`callboard_session=${token}`);

    const list = await fetch(`${base}/api/api-keys`, withCookie(token));
    expect(list.status).toBe(200);
  });
});

// Login allows 3 attempts a minute per IP, so these mint their sessions directly.
describe("stored entries with a broken expires_at", () => {
  it.each([
    ["missing", `{"created_at": 0}`],
    ["a numeric string", `{"expires_at": "99999999999999", "created_at": 0}`],
    ["null", `{"expires_at": null, "created_at": 0}`],
    ["Infinity (1e999)", `{"expires_at": 1e999, "created_at": 0}`],
  ])("an entry whose expires_at is %s is rejected", async (_label, entryJson) => {
    const token = createSession(Date.now() + 3_600_000);
    expect((await authCheck(token)).body).toEqual({ authenticated: true });
    const data = JSON.parse(readFileSync(sessionsFile, "utf8"));
    data.sessions[token] = "__ENTRY__";
    writeFileSync(sessionsFile, JSON.stringify(data).replace('"__ENTRY__"', entryJson));

    expect((await authCheck(token)).body).toEqual({ authenticated: false });
    expect((await fetch(`${base}/api/api-keys`, withCookie(token))).status).toBe(401);
  });

  it("an expired entry is rejected", async () => {
    const token = createSession(Date.now() + 3_600_000);
    const data = JSON.parse(readFileSync(sessionsFile, "utf8"));
    data.sessions[token].expires_at = Date.now() - 1;
    writeFileSync(sessionsFile, JSON.stringify(data));

    expect((await authCheck(token)).body).toEqual({ authenticated: false });
  });
});
