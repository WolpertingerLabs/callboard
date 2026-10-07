/**
 * Session store: extendSession runs on every cookie-authenticated request, so
 * it only rewrites sessions.json when the expiry moves by more than a minute.
 * getSession is the whole validity check, so it must fail closed on anything
 * that is not a live session minted by createSession.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is resolved when utils/paths.js first loads, so set it before importing.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-sessions-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const sessions = await import("./sessions.js");

const sessionsFile = join(tmpRoot, "sessions.json");
const readStore = () => JSON.parse(readFileSync(sessionsFile, "utf8")) as { sessions: Record<string, { expires_at: unknown }> };
const storedExpiry = (token: string) => readStore().sessions[token].expires_at;
const HOUR = 3_600_000;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("extendSession", () => {
  it("does not rewrite the file when the expiry moves by less than the throttle window", () => {
    const expiry = Date.now() + HOUR;
    const token = sessions.createSession(expiry);
    sessions.extendSession(token, expiry + 30_000);
    expect(storedExpiry(token)).toBe(expiry);
    expect(sessions.getSession(token)?.expires_at).toBe(expiry);
  });

  it("persists once the expiry moves past the throttle window", () => {
    const expiry = Date.now() + HOUR;
    const token = sessions.createSession(expiry);
    sessions.extendSession(token, expiry + 61_000);
    expect(storedExpiry(token)).toBe(expiry + 61_000);
    expect(sessions.getSession(token)?.expires_at).toBe(expiry + 61_000);
  });

  it("ignores unknown tokens", () => {
    const unknown = "a".repeat(64);
    sessions.extendSession(unknown, Date.now() + HOUR);
    expect(sessions.getSession(unknown)).toBeUndefined();
  });
});

describe("token format", () => {
  it("mints 64 lowercase hex characters", () => {
    expect(sessions.createSession(Date.now() + HOUR)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "", "short"])(
    "never resolves %j, and the mutating helpers leave the store alone",
    (token) => {
      sessions.createSession(Date.now() + HOUR);
      const before = statSync(sessionsFile, { bigint: true }).mtimeNs;
      expect(sessions.getSession(token)).toBeUndefined();
      sessions.extendSession(token, Date.now() + 10 * HOUR);
      sessions.deleteSession(token);
      expect(statSync(sessionsFile, { bigint: true }).mtimeNs).toBe(before);
      expect(Object.getPrototypeOf(readStore().sessions)).toBe(Object.prototype);
    },
  );

  it("rejects a stored key that is not in the minted format, even if present in the file", () => {
    const data = readStore();
    data.sessions["hand-written"] = { expires_at: Date.now() + HOUR };
    writeFileSync(sessionsFile, JSON.stringify(data));
    expect(sessions.getSession("hand-written")).toBeUndefined();
  });
});

describe("expiry fails closed", () => {
  it("treats the exact expiry instant as expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const token = sessions.createSession(5_000_000 + 1_000);
    vi.setSystemTime(5_000_000 + 999);
    expect(sessions.getSession(token)).toBeDefined();
    vi.setSystemTime(5_000_000 + 1_000);
    expect(sessions.getSession(token)).toBeUndefined();
    expect(readStore().sessions[token]).toBeUndefined();
  });

  it.each([
    ["missing", `{"created_at": 0}`],
    ["a numeric string", `{"expires_at": "99999999999999", "created_at": 0}`],
    ["null", `{"expires_at": null, "created_at": 0}`],
    ["Infinity (1e999)", `{"expires_at": 1e999, "created_at": 0}`],
    ["an object", `{"expires_at": {}, "created_at": 0}`],
  ])("rejects and prunes an entry whose expires_at is %s", (_label, entryJson) => {
    const token = sessions.createSession(Date.now() + HOUR);
    const raw = readFileSync(sessionsFile, "utf8");
    const data = JSON.parse(raw);
    data.sessions[token] = "__ENTRY__";
    writeFileSync(sessionsFile, JSON.stringify(data).replace('"__ENTRY__"', entryJson));
    expect(sessions.getSession(token)).toBeUndefined();
    expect(readStore().sessions[token]).toBeUndefined();
  });

  it("rejects an entry that is not an object", () => {
    const token = sessions.createSession(Date.now() + HOUR);
    const data = readStore() as { sessions: Record<string, unknown> };
    data.sessions[token] = "not-a-session";
    writeFileSync(sessionsFile, JSON.stringify(data));
    expect(sessions.getSession(token)).toBeUndefined();
  });
});
