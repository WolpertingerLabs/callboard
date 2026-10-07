/**
 * The daemon's HTTP hardening over the wire, against a real listening server
 * mounted in `index.ts` order: `applyHttpHardening` first, then cookies, auth,
 * and real routers.
 *
 * - No CORS: the SameSite=Strict cookie is sent by a page on any other port of
 *   this host (a "site" ignores the port), so a reflected
 *   `Access-Control-Allow-Origin` let that page read every authenticated
 *   response. Nothing may reflect an Origin back.
 * - Baseline headers on app responses, without clobbering the stricter
 *   per-route policy the artifact render route sets.
 * - Over https (on this daemon: a loopback terminator saying so) the session is
 *   the Secure `__Secure-callboard_session` cookie; over http the plain
 *   `callboard_session`, so an https session can never lock out http login on
 *   the same hostname.
 * - Sessions have an absolute 30-day lifetime from `created_at`.
 * - Image bytes are not marked cacheable by shared caches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-http-hardening-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("./services/agent-settings.js", () => ({
  getAgentSettings: () => ({}),
  readAgentSettings: () => ({ settings: {}, state: "ok" }),
}));

const { applyHttpHardening, DEFAULT_CSP } = await import("./utils/security-headers.js");
const { loginHandler, logoutHandler, checkAuthHandler, requireAuth } = await import("./auth.js");
const { artifactsRouter } = await import("./routes/artifacts.js");
const { imagesRouter } = await import("./routes/images.js");
const { ImageStorageService } = await import("./services/image-storage.js");
const { generateSalt, hashPassword } = await import("./utils/password.js");
const { createSession } = await import("./services/sessions.js");

const PASSWORD = "correct horse battery staple";
const DAY = 24 * 60 * 60 * 1000;
const sessionsFile = join(tmpRoot, "sessions.json");

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Listening {
  host: string;
  port: number;
  close(): Promise<void>;
}

/** The app as index.ts assembles it, minus the routers this suite doesn't need. */
function buildApp(): Express {
  const app = express();
  applyHttpHardening(app);
  app.use(cookieParser());
  app.use(express.json());
  app.post("/api/auth/login", loginHandler);
  app.post("/api/auth/logout", logoutHandler);
  app.get("/api/auth/check", checkAuthHandler);
  app.use("/api", requireAuth);
  app.use("/api/images", imagesRouter);
  app.use("/api/artifacts", artifactsRouter);
  // The SPA fallback, as index.ts serves frontend/dist/index.html.
  const spa = join(tmpRoot, "spa");
  mkdirSync(spa, { recursive: true });
  writeFileSync(join(spa, "index.html"), "<!doctype html><title>callboard</title>");
  app.use(express.static(spa));
  app.get("*", (_req, res) => res.sendFile(join(spa, "index.html")));
  return app;
}

async function listen(app: Express, host: string): Promise<Listening> {
  const server = app.listen(0, host);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    host,
    port: (server.address() as AddressInfo).port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Raw http.request: `fetch` would refuse or rewrite the `Origin` header in some runtimes. */
function request(to: Listening, method: string, path: string, opts: { headers?: Record<string, string>; body?: string; localAddress?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(opts.body)) } : {}), ...opts.headers };
    const req = http.request({ host: to.host, port: to.port, method, path, headers, localAddress: opts.localAddress }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const cookieOf = (res: Res) => (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("callboard_session=")) ?? "";
const tokenOf = (res: Res) => /callboard_session=([^;]+)/.exec(cookieOf(res))?.[1] ?? "";
const withSession = (token: string, extra: Record<string, string> = {}) => ({ headers: { cookie: `callboard_session=${token}`, ...extra } });

let server: Listening;
let token: string;

// Login allows 3 attempts a minute per client. From loopback the client is
// CF-Connecting-IP (see utils/client-ip.ts), so each login gets its own bucket.
let loginSeq = 0;

async function login(to: Listening, headers: Record<string, string> = {}, localAddress?: string): Promise<Res> {
  const client = { "cf-connecting-ip": `198.51.100.${++loginSeq}` };
  const res = await request(to, "POST", "/api/auth/login", { headers: { ...client, ...headers }, body: JSON.stringify({ password: PASSWORD }), localAddress });
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  const salt = generateSalt();
  process.env.AUTH_PASSWORD_SALT = salt;
  process.env.AUTH_PASSWORD_HASH = await hashPassword(PASSWORD, salt);
  server = await listen(buildApp(), "127.0.0.1");
  token = tokenOf(await login(server));
  expect(token).toMatch(/^[0-9a-f]{64}$/);
});

afterAll(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("no CORS", () => {
  // Another port on the same host is same-site, so the browser sends the cookie.
  const crossPort = () => `http://127.0.0.1:${server.port + 1}`;

  it.each([
    ["a cross-port page", crossPort],
    ["a cross-site page", () => "https://evil.example"],
    ["an opaque (sandboxed) origin", () => "null"],
  ])("a credentialed preflight from %s is not granted", async (_label, origin) => {
    const res = await request(server, "OPTIONS", "/api/agent-settings", {
      headers: { origin: origin(), "access-control-request-method": "POST", "access-control-request-headers": "content-type", cookie: `callboard_session=${token}` },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("a credentialed GET from a cross-port page gets no Access-Control-Allow-Origin, so the browser withholds the body", async () => {
    const res = await request(server, "GET", "/api/auth/check", withSession(token, { origin: crossPort() }));
    // The request itself is authenticated (that's the same-site cookie)...
    expect(JSON.parse(res.body)).toEqual({ authenticated: true });
    // ...which is exactly why nothing may grant the page read access to it.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("hardening headers", () => {
  it.each([
    ["the SPA document", "GET", "/", {}],
    ["an authenticated API response", "GET", "/api/auth/check", "session"],
    ["an unauthenticated API refusal", "GET", "/api/artifacts", {}],
    ["a preflight", "OPTIONS", "/api/artifacts", { origin: "https://evil.example", "access-control-request-method": "POST" }],
  ] as const)("%s carries them and no X-Powered-By", async (_label, method, path, headers) => {
    const res = await request(server, method, path, headers === "session" ? withSession(token) : { headers });
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["content-security-policy"]).toBe(DEFAULT_CSP);
    expect(DEFAULT_CSP).toContain("frame-ancestors 'self'");
    expect(res.headers["referrer-policy"]).toBe("same-origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("the artifact render route keeps its own, stricter CSP and Referrer-Policy", async () => {
    const created = await request(server, "POST", "/api/artifacts", {
      ...withSession(token),
      body: JSON.stringify({ id: "hardening-probe", name: "Probe", contentType: "html", content: "<p>hi</p>" }),
    });
    expect(created.status).toBe(201);
    const res = await request(server, "GET", "/api/artifacts/hardening-probe/versions/1/render", withSession(token));
    expect(res.status).toBe(200);
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toMatch(/sandbox allow-scripts$/);
    expect(csp).not.toBe(DEFAULT_CSP);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    // The baseline still applies where the route says nothing.
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

const SECURE_NAME = "__Secure-callboard_session";
/** The Set-Cookie for one cookie name, or "" when the response sets none. */
const setCookieFor = (res: Res, name: string) => (res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${name}=`)) ?? "";
const isSecure = (setCookie: string) => /;\s*Secure(;|$)/i.test(setCookie);

/**
 * A browser's cookie store for ONE hostname that is not localhost (say the LAN
 * address), reachable over both https (the tunnel or another TLS terminator)
 * and plain http. It applies the RFC 6265bis rules that decide this bug:
 *
 * - a Secure cookie is only sent over https;
 * - plain http cannot set a Secure cookie (§5.7, "secure-only-flag");
 * - plain http cannot overwrite or delete an existing Secure cookie of the same
 *   name ("Strict Secure Cookies", §5.7);
 * - a `__Secure-` cookie is refused unless it is Secure and set over https.
 *
 * "https" on the wire is what the daemon sees from a local terminator: a
 * loopback socket with `X-Forwarded-Proto: https`.
 */
class BrowserJar {
  private cookies = new Map<string, { value: string; secure: boolean }>();

  headers(https: boolean): Record<string, string> {
    const sent = [...this.cookies].filter(([, c]) => https || !c.secure).map(([name, c]) => `${name}=${c.value}`);
    return { ...(sent.length ? { cookie: sent.join("; ") } : {}), ...(https ? { "x-forwarded-proto": "https" } : {}) };
  }

  receive(res: Res, https: boolean): void {
    for (const line of res.headers["set-cookie"] ?? []) {
      const [pair, ...attrs] = line.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const secure = attrs.some((a) => a.toLowerCase() === "secure");
      if (name.startsWith("__Secure-") && !(secure && https)) continue;
      if (secure && !https) continue;
      if (!https && this.cookies.get(name)?.secure) continue;
      const expires = attrs.find((a) => /^expires=/i.test(a));
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      const gone = (maxAge && Number(maxAge.split("=")[1]) <= 0) || (expires && Date.parse(expires.slice(8)) <= Date.now());
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, { value, secure });
    }
  }

  has(name: string) {
    return this.cookies.has(name);
  }

  async send(method: string, path: string, https: boolean, body?: unknown): Promise<Res> {
    const headers = { ...this.headers(https), "cf-connecting-ip": `198.51.100.${++loginSeq}` };
    const res = await request(server, method, path, { headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    this.receive(res, https);
    return res;
  }

  async authenticated(https: boolean): Promise<boolean> {
    return (JSON.parse((await this.send("GET", "/api/auth/check", https)).body) as { authenticated: boolean }).authenticated;
  }
}

describe("session cookie per scheme", () => {
  it("plain http (localhost, LAN, the Vite dev proxy): the plain cookie, not Secure, or the browser would drop it", async () => {
    const res = await login(server);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(isSecure(cookie)).toBe(false);
    expect(setCookieFor(res, SECURE_NAME)).toBe("");
  });

  it.each(["https", "HTTPS", "http, https"])("https via a loopback terminator (X-Forwarded-Proto: %s): the __Secure- cookie, Secure on login and on every roll", async (proto) => {
    const loggedIn = await login(server, { "x-forwarded-proto": proto });
    const issued = setCookieFor(loggedIn, SECURE_NAME);
    expect(isSecure(issued)).toBe(true);
    expect(issued).toMatch(/HttpOnly/i);
    expect(cookieOf(loggedIn)).toBe("");
    const t = /=([^;]+)/.exec(issued)![1];
    const rolled = await request(server, "GET", "/api/auth/check", { headers: { cookie: `${SECURE_NAME}=${t}`, "x-forwarded-proto": proto } });
    expect(JSON.parse(rolled.body)).toEqual({ authenticated: true });
    expect(isSecure(setCookieFor(rolled, SECURE_NAME))).toBe(true);
  });

  it.each(["http", "https, http"])("X-Forwarded-Proto whose nearest hop says %j: the plain cookie", async (proto) => {
    const res = await login(server, { "x-forwarded-proto": proto });
    expect(isSecure(cookieOf(res))).toBe(false);
    expect(setCookieFor(res, SECURE_NAME)).toBe("");
  });

  it("rolling a plain cookie over https never makes it Secure", async () => {
    const res = await request(server, "GET", "/api/auth/check", withSession(token, { "x-forwarded-proto": "https" }));
    expect(JSON.parse(res.body)).toEqual({ authenticated: true });
    expect(cookieOf(res)).not.toBe("");
    expect(isSecure(cookieOf(res))).toBe(false);
    expect(setCookieFor(res, SECURE_NAME)).toBe("");
  });

  it("with both cookies live, the __Secure- one authenticates (and is the one rolled)", async () => {
    const secureToken = createSession(Date.now() + DAY);
    const res = await request(server, "GET", "/api/auth/check", {
      headers: { cookie: `callboard_session=${token}; ${SECURE_NAME}=${secureToken}`, "x-forwarded-proto": "https" },
    });
    expect(JSON.parse(res.body)).toEqual({ authenticated: true });
    expect(setCookieFor(res, SECURE_NAME)).toContain(secureToken);
    expect(cookieOf(res)).toBe("");
  });

  it("a dead __Secure- cookie does not shadow a live plain one (http://localhost sends both)", async () => {
    const res = await request(server, "GET", "/api/artifacts", { headers: { cookie: `callboard_session=${token}; ${SECURE_NAME}=${"d".repeat(64)}` } });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toContain(token);
  });

  it("logout clears both names", async () => {
    const t = createSession(Date.now() + DAY);
    const res = await request(server, "POST", "/api/auth/logout", { headers: { cookie: `${SECURE_NAME}=${t}`, "x-forwarded-proto": "https" } });
    expect(isSecure(setCookieFor(res, SECURE_NAME))).toBe(true);
    expect(setCookieFor(res, SECURE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(setCookieFor(res, "callboard_session")).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(JSON.parse((await request(server, "GET", "/api/auth/check", { headers: { cookie: `${SECURE_NAME}=${t}`, "x-forwarded-proto": "https" } })).body)).toEqual({
      authenticated: false,
    });
  });

  it("mixed schemes on one hostname: an https session never locks plain http out", async () => {
    const jar = new BrowserJar();
    // 1. Log in over https (the tunnel), and use it — every request rolls the cookie.
    expect((await jar.send("POST", "/api/auth/login", true, { password: PASSWORD })).status).toBe(200);
    expect(await jar.authenticated(true)).toBe(true);
    // 2. Now plain http on the same hostname: logging in must actually log in.
    expect(JSON.parse((await jar.send("POST", "/api/auth/login", false, { password: PASSWORD })).body)).toEqual({ ok: true });
    expect(await jar.authenticated(false)).toBe(true);
    // 3. Back on https, both cookies are sent; both schemes keep working.
    expect(await jar.authenticated(true)).toBe(true);
    expect(await jar.authenticated(false)).toBe(true);
    // 4. Logout over http ends the http session...
    await jar.send("POST", "/api/auth/logout", false);
    expect(jar.has("callboard_session")).toBe(false);
    expect(await jar.authenticated(false)).toBe(false);
    // 5. ...and logout over https ends everything.
    expect(await jar.authenticated(true)).toBe(true);
    await jar.send("POST", "/api/auth/logout", true);
    expect(jar.has(SECURE_NAME)).toBe(false);
    expect(await jar.authenticated(true)).toBe(false);
  });

  // A LAN client's X-Forwarded-Proto is its own header. Needs a non-loopback
  // interface to connect from; the server binds that one address only.
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((iface) => iface && iface.family === "IPv4" && !iface.internal)?.address;

  it.skipIf(!lanAddress)("X-Forwarded-Proto from a non-loopback socket is ignored", async () => {
    const lan = await listen(buildApp(), lanAddress!);
    try {
      const res = await login(lan, { "x-forwarded-proto": "https" }, lanAddress);
      expect(cookieOf(res)).toContain("callboard_session=");
      expect(isSecure(cookieOf(res))).toBe(false);
      expect(setCookieFor(res, SECURE_NAME)).toBe("");
    } finally {
      await lan.close();
    }
  });
});

describe("absolute session lifetime", () => {
  type Stored = { sessions: Record<string, { expires_at?: number; created_at?: number }> };
  const readStore = () => JSON.parse(readFileSync(sessionsFile, "utf8")) as Stored;

  /** Rewrite one stored session the way an old daemon (or plain age) would have left it. */
  async function forge(fields: { expires_at?: number; created_at?: number }): Promise<string> {
    const t = createSession(Date.now() + DAY);
    const store = readStore();
    store.sessions[t] = fields;
    writeFileSync(sessionsFile, JSON.stringify(store));
    return t;
  }

  it("a session older than 30 days is refused even though it was kept rolling", async () => {
    const now = Date.now();
    const t = await forge({ created_at: now - 31 * DAY, expires_at: now + 6 * DAY });
    expect(JSON.parse((await request(server, "GET", "/api/auth/check", withSession(t))).body)).toEqual({ authenticated: false });
    expect((await request(server, "GET", "/api/artifacts", withSession(t))).status).toBe(401);
    // Refused and pruned.
    expect(readStore().sessions[t]).toBeUndefined();
  });

  it("a session with no created_at is refused (fail closed, not grandfathered)", async () => {
    const t = await forge({ expires_at: Date.now() + 6 * DAY });
    expect((await request(server, "GET", "/api/artifacts", withSession(t))).status).toBe(401);
    expect(readStore().sessions[t]).toBeUndefined();
  });

  it("near the cap, rolling stops at created_at + 30 days, in the store and in the cookie", async () => {
    const now = Date.now();
    const createdAt = now - 29 * DAY;
    const t = await forge({ created_at: createdAt, expires_at: now + DAY / 2 });
    const res = await request(server, "GET", "/api/artifacts", withSession(t));
    expect(res.status).toBe(200);
    const cap = createdAt + 30 * DAY;
    expect(readStore().sessions[t].expires_at).toBe(cap);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookieOf(res))?.[1]);
    // One day left, give or take the request's own duration — not the 7-day TTL.
    expect(maxAge).toBeLessThanOrEqual(DAY / 1000);
    expect(maxAge).toBeGreaterThan(DAY / 1000 - 60);
  });

  it("a fresh session still rolls the full 7 days", async () => {
    const res = await request(server, "GET", "/api/auth/check", withSession(token));
    expect(Number(/Max-Age=(\d+)/i.exec(cookieOf(res))?.[1])).toBe(7 * DAY / 1000);
  });
});

describe("/api/images/:id", () => {
  it("is cacheable by the browser only", async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const stored = await ImageStorageService.storeImage(png, "pixel.png", "image/png");
    expect(stored.success).toBe(true);
    const res = await request(server, "GET", `/api/images/${stored.image!.id}`, withSession(token));
    expect(res.status).toBe(200);
    const cacheControl = res.headers["cache-control"] ?? "";
    expect(cacheControl).toMatch(/\bprivate\b/);
    expect(cacheControl).not.toMatch(/\bpublic\b/);
    expect(cacheControl).toMatch(/max-age=\d+/);
  });
});
