/**
 * The session store can throw — sessions.json caught mid-write by something
 * outside the daemon (see utils/json-file-store.ts). That must cost one request
 * or one cleanup pass, never the process: not an aborted boot, not an
 * uncaughtException from a timer, not an async handler that never answers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-auth-store-failure-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const torn = () => {
  throw new SyntaxError("Unexpected end of JSON input");
};
const sessions = vi.hoisted(() => ({
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  extendSession: vi.fn(),
  cleanupExpiredSessions: vi.fn(),
  deleteAllSessionsExcept: vi.fn(),
}));
vi.mock("./services/sessions.js", () => sessions);
vi.mock("./services/agent-settings.js", () => ({ getAgentSettings: () => ({}), readAgentSettings: () => ({ settings: {}, state: "ok" }) }));
const password = vi.hoisted(() => ({
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => "new-hash"),
  generateSalt: vi.fn(() => "new-salt"),
  validateNewPassword: vi.fn(() => ({ valid: true })),
}));
vi.mock("./utils/password.js", () => password);
const updateEnvFile = vi.hoisted(() => vi.fn());
vi.mock("./utils/env-writer.js", () => ({ updateEnvFile }));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AUTH_PASSWORD_HASH = "old-hash";
  process.env.AUTH_PASSWORD_SALT = "old-salt";
});
afterEach(() => {
  vi.useRealTimers();
  for (const fn of Object.values(sessions)) fn.mockReset();
  updateEnvFile.mockReset();
});

function makeReq(body: unknown): Request {
  return { body, headers: {}, cookies: { callboard_session: "current" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown as { error: string; passwordChanged?: boolean },
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload as typeof this.body;
      return this;
    },
    cookie: vi.fn(),
  };
  return res as typeof res & Response;
}

describe("a session store that throws", () => {
  it("does not abort boot: importing auth survives a failed startup cleanup", async () => {
    vi.resetModules();
    sessions.cleanupExpiredSessions.mockImplementation(torn);
    await expect(import("./auth.js")).resolves.toBeDefined();
    expect(sessions.cleanupExpiredSessions).toHaveBeenCalled();
  });

  it("does not throw out of the chat-view cleanup timer", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    sessions.getSession.mockReturnValue({ expires_at: Date.now() + 60_000, created_at: 0 });
    const { chatViews } = await import("./services/chat-view.js");
    const { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS } = await import("shared/types/chat-filters.js");
    chatViews.publish("current", {
      viewId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      filters: structuredClone(DEFAULT_CHAT_FILTERS),
      options: { ...DEFAULT_CHAT_VIEW_OPTIONS },
      submittedSearch: "",
    });

    sessions.getSession.mockImplementation(torn);
    // A throw inside the interval callback surfaces here — in the daemon it is
    // an uncaughtException, and process-guards exits on those.
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(sessions.getSession).toHaveBeenCalled();
  });

  it("login answers 503 instead of leaving the request hanging", async () => {
    const { loginHandler } = await import("./auth.js");
    sessions.createSession.mockImplementation(torn);
    const res = makeRes();
    await loginHandler(makeReq({ password: "pw" }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/session store is temporarily unavailable/i);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("change-password refuses before touching the password when the store cannot be read", async () => {
    const { changePasswordHandler } = await import("./auth.js");
    sessions.getSession.mockImplementation(torn);
    const res = makeRes();
    await changePasswordHandler(makeReq({ currentPassword: "old", newPassword: "new-password" }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain("Your password was not changed.");
    expect(updateEnvFile).not.toHaveBeenCalled();
    expect(process.env.AUTH_PASSWORD_HASH).toBe("old-hash");
  });

  it("change-password says so when the password changed but other sessions could not be signed out", async () => {
    const { changePasswordHandler } = await import("./auth.js");
    sessions.deleteAllSessionsExcept.mockImplementation(torn);
    const res = makeRes();
    await changePasswordHandler(makeReq({ currentPassword: "old", newPassword: "new-password" }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ passwordChanged: true });
    expect(process.env.AUTH_PASSWORD_HASH).toBe("new-hash");
  });
});
