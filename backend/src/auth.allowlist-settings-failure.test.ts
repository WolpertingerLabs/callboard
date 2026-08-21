/**
 * The remote-access IP allowlist, driven against a **real settings file on
 * disk**.
 *
 * ## The bug, and why a mock could not have found it
 *
 * `requireAuth` read `getAgentSettings().remoteAccessIpAllowlist ?? []`, and
 * `isIpAllowed(addr, [])` means *no restriction* by design. `loadSettings`
 * catches its own `readFileSync` / `JSON.parse` failures and returns
 * `{ proxyMode: "local" }` — a valid object with the field absent — so a
 * truncated write or a `chmod 000` turned an operator's allowlist into an empty
 * one and let every public address through to the login endpoint. There was no
 * throw to catch and nothing in the code path that could have been asserted
 * about; the only way to see it is to break the file and ask.
 *
 * That is the same trap `engine-install.settings-failure.test.ts` documents, so
 * this suite is built the same way: `CALLBOARD_DATA_DIR` points at a temporary
 * directory, a genuinely broken `agent-settings.json` is written into it, and
 * the middleware is called with a fake req/res the way a request would call it.
 * Nothing below `readAgentSettings` is mocked.
 *
 * ## The half that must keep working
 *
 * Failing closed on an IP restriction locks a tunnelled operator out until the
 * file is repaired. That is the right way round, and it is survivable only
 * because loopback and LAN clients are never gated at all — so the last two
 * cases here are as load-bearing as the first: a fail-closed that also locks
 * out the person who could fix it is its own outage.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-allowlist-failure-"));
const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

// Must be set before anything imports `utils/paths.js`, which reads it at
// module scope.
process.env.CALLBOARD_DATA_DIR = DATA_DIR;
const { requireAllowedIp } = await import("./auth.js");

/** Root's `access()` ignores permission bits, so the chmod case proves nothing when run as root. */
const notRoot = process.getuid === undefined || process.getuid() !== 0;

const PUBLIC_IP = "203.0.113.7";

/**
 * Drive the middleware the way a request does.
 *
 * A *public* peer address with no forwarding header, so `getClientKey` returns
 * the socket address unchanged — the shape a client arriving from the internet
 * has, and the only shape the allowlist gates.
 */
function call(socketIp: string, path = "/system-info"): { status?: number; body?: any; passed: boolean } {
  let status: number | undefined;
  let body: any;
  let passed = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
    cookie() {
      return this;
    },
    locals: {} as Record<string, unknown>,
  } as unknown as Response;
  const req = { socket: { remoteAddress: socketIp }, headers: {}, path, cookies: {} } as unknown as Request;
  requireAllowedIp(req, res, (() => {
    passed = true;
  }) as NextFunction);
  return { status, body, passed };
}

afterAll(() => {
  try {
    chmodSync(SETTINGS_FILE, 0o644);
  } catch {
    /* already gone */
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  delete process.env.CALLBOARD_DATA_DIR;
});

beforeEach(() => {
  vi.clearAllMocks();
  try {
    chmodSync(SETTINGS_FILE, 0o644);
  } catch {
    /* not created yet */
  }
});

afterEach(() => {
  rmSync(SETTINGS_FILE, { force: true });
});

describe("a readable settings file", () => {
  it("lets a public client through when there is no allowlist — the documented default", () => {
    rmSync(SETTINGS_FILE, { force: true });
    expect(call(PUBLIC_IP).passed).toBe(true);
  });

  it("lets a public client through when the allowlist is empty", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ remoteAccessIpAllowlist: [] }));
    expect(call(PUBLIC_IP).passed).toBe(true);
  });

  it("lets an allowlisted address through", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ remoteAccessIpAllowlist: [PUBLIC_IP] }));
    expect(call(PUBLIC_IP).passed).toBe(true);
  });

  it("refuses an address that is not on the list", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ remoteAccessIpAllowlist: ["198.51.100.4"] }));
    const result = call(PUBLIC_IP);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe("the fail-open, reproduced and closed", () => {
  it("REFUSES a public client when the file is corrupt", () => {
    // Measured before the fix: this returned `passed: true`. The file below
    // *does* restrict — to one address that is not this one — and the corruption
    // is what removed the restriction.
    writeFileSync(SETTINGS_FILE, '{"remoteAccessIpAllowlist": ["198.51.100.4"');
    const result = call(PUBLIC_IP);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/could not be read/);
  });

  it.skipIf(!notRoot)("REFUSES a public client when the file cannot be opened", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ remoteAccessIpAllowlist: ["198.51.100.4"] }));
    chmodSync(SETTINGS_FILE, 0o000);
    const result = call(PUBLIC_IP);
    expect(result.passed).toBe(false);
    expect(result.body.error).toMatch(/could not be read/);
  });

  it("REFUSES even a would-be allowlisted address, because the list is unknown", () => {
    // The point of the branch: it is not "assume the list is what it was", it
    // is "Callboard cannot tell". An address that a working file would have
    // admitted is refused too, and the message says why rather than claiming it
    // is off the list.
    writeFileSync(SETTINGS_FILE, "{ this is not json");
    const result = call(PUBLIC_IP);
    expect(result.passed).toBe(false);
    expect(result.body.error).not.toMatch(/not on the allowlist/);
  });

  it("starts letting clients through again once the file is repaired", () => {
    // A fail-closed that never re-opens is its own outage.
    writeFileSync(SETTINGS_FILE, "{ this is not json");
    expect(call(PUBLIC_IP).passed).toBe(false);

    writeFileSync(SETTINGS_FILE, JSON.stringify({ remoteAccessIpAllowlist: [PUBLIC_IP] }));
    expect(call(PUBLIC_IP).passed).toBe(true);
  });
});

describe("the repair is always reachable", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["LAN", "192.168.1.50"],
    ["unique-local IPv6", "fd00::1"],
  ])("does not gate a %s client even when the file is corrupt", (_label, ip) => {
    // Without this, corrupting one file would lock the operator out of their
    // own machine with no way in but a shell.
    writeFileSync(SETTINGS_FILE, "{ this is not json");
    expect(call(ip).passed).toBe(true);
  });
});

describe("what it gates", () => {
  it("gates the login endpoint, which is the whole point of an address allowlist", () => {
    // The gate does not look at the path at all — every /api route it is
    // mounted over is covered. What used to make login exempt was *where* it
    // was mounted, which the next case pins.
    writeFileSync(SETTINGS_FILE, JSON.stringify({ remoteAccessIpAllowlist: ["198.51.100.4"] }));
    for (const path of ["/auth/login", "/auth/check", "/auth/logout", "/system-info"]) {
      expect(call(PUBLIC_IP, path).passed, path).toBe(false);
    }
  });

  /**
   * A source-order assertion, deliberately, because the defect was one.
   *
   * `requireAuth` carried this gate as its first block and is mounted *after*
   * `/api/auth/login`, `/api/auth/check` and `/api/auth/logout`, so it never ran
   * for them — while its own comment said it "applies to ALL /api routes
   * (including login), so a non-allowlisted remote client can't even reach the
   * login endpoint". Measured against a settings file allowlisting one address
   * that was not the caller's: `/api/system-info` 403, `/api/auth/login` 401 (it
   * reached the password check), `/api/auth/check` 200.
   *
   * No behavioural test could have caught that, because every unit test of the
   * middleware calls it directly and so passes whatever the mount order is.
   * Importing `index.ts` is not an option either — it boots a listener, a cron
   * scheduler and an SDK query. So this reads the registration order out of the
   * source, which is the exact property that broke and the only place it is
   * observable short of running a daemon.
   */
  it("is mounted above the auth routes in index.ts", () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf-8");
    const gate = index.indexOf('app.use("/api", requireAllowedIp)');
    expect(gate, "requireAllowedIp is no longer mounted in index.ts").toBeGreaterThan(-1);
    for (const route of ["/api/auth/login", "/api/auth/check", "/api/auth/logout"]) {
      expect(index.indexOf(`"${route}"`), route).toBeGreaterThan(gate);
    }
    // And below the gate, so a client that passes it still has to authenticate.
    expect(index.indexOf('app.use("/api", requireAuth)')).toBeGreaterThan(gate);
  });
});
