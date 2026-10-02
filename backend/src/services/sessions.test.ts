/**
 * Session store: extendSession runs on every cookie-authenticated request, so
 * it only rewrites sessions.json when the expiry moves by more than a minute.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is resolved when utils/paths.js first loads, so set it before importing.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-sessions-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const sessions = await import("./sessions.js");

const storedExpiry = (token: string): number => JSON.parse(readFileSync(join(tmpRoot, "sessions.json"), "utf8")).sessions[token].expires_at;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("extendSession", () => {
  it("does not rewrite the file when the expiry moves by less than the throttle window", () => {
    sessions.createSession("tok-a", 1_000_000);
    sessions.extendSession("tok-a", 1_000_000 + 30_000);
    expect(storedExpiry("tok-a")).toBe(1_000_000);
    expect(sessions.getSession("tok-a")?.expires_at).toBe(1_000_000);
  });

  it("persists once the expiry moves past the throttle window", () => {
    sessions.createSession("tok-b", 1_000_000);
    sessions.extendSession("tok-b", 1_000_000 + 61_000);
    expect(storedExpiry("tok-b")).toBe(1_000_000 + 61_000);
    expect(sessions.getSession("tok-b")?.expires_at).toBe(1_000_000 + 61_000);
  });

  it("ignores unknown tokens", () => {
    sessions.extendSession("nope", Date.now() + 3_600_000);
    expect(sessions.getSession("nope")).toBeUndefined();
  });
});
