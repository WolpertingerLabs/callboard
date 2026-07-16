/**
 * Tests for bearer API-key handling in requireAuth / requireSessionAuth —
 * valid key passes, invalid or expired key gets 401 (no fallthrough to the
 * cookie), and credential-management routes reject bearer auth.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-auth-bearer-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
process.env.AUTH_PASSWORD_HASH = "test-hash";

// requireAuth consults agent settings for the remote-access IP allowlist;
// stub it so the tests don't load the full settings stack.
vi.mock("./services/agent-settings.js", () => ({
  getAgentSettings: () => ({}),
}));

const { requireAuth, requireSessionAuth } = await import("./auth.js");
const { createApiKey } = await import("./services/api-keys.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: "/api/chats",
    headers: {},
    cookies: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    cookie() {
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown; locals: Record<string, unknown> };
}

describe("requireAuth with bearer tokens", () => {
  it("accepts a valid API key and marks the auth method", () => {
    const { token } = createApiKey("test", "", null);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.authMethod).toBe("bearer");
    expect(res.locals.apiKeyId).toBeTypeOf("string");
  });

  it("rejects an invalid key with 401 without falling back to cookies", () => {
    const req = makeReq({ headers: { authorization: "Bearer cbk_" + "0".repeat(40) } });
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired key with 401", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { token } = createApiKey("temp", "", Date.now() + 1_000);
    vi.setSystemTime(1_000_000 + 2_000);

    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    vi.useRealTimers();
  });

  it("ignores non-Bearer authorization schemes and falls through to cookie auth", () => {
    const req = makeReq({ headers: { authorization: "Basic dXNlcjpwYXNz" } });
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    // No cookie either → 401 from the cookie path
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe("requireSessionAuth", () => {
  it("rejects bearer-authenticated requests", () => {
    const res = makeRes();
    res.locals.authMethod = "bearer";
    const next = vi.fn();

    requireSessionAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("allows session-authenticated requests", () => {
    const res = makeRes();
    res.locals.authMethod = "session";
    const next = vi.fn();

    requireSessionAuth(makeReq(), res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
