/**
 * Unit tests for the API-key service — creation, one-time token return,
 * listing without hashes, verification, expiry, revocation, and the
 * last_used_at write throttle.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is resolved from this env var when utils/paths.js first loads, so
// it must be set before the service modules are imported (hence dynamic import).
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-api-keys-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const apiKeys = await import("./api-keys.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the store between tests by revoking everything
  for (const key of apiKeys.listApiKeys()) {
    apiKeys.deleteApiKey(key.id);
  }
  vi.useRealTimers();
});

describe("createApiKey", () => {
  it("returns the plaintext token once and stores only a hash", () => {
    const { key, token } = apiKeys.createApiKey("devboard", "Linear dashboard", null);

    expect(token).toMatch(/^cbk_[0-9a-f]{40}$/);
    expect(key.tokenPreview).toBe(token.slice(0, 10));
    expect(key.name).toBe("devboard");
    expect(key.description).toBe("Linear dashboard");
    expect(key.expires_at).toBeNull();
    expect(key.last_used_at).toBeNull();
    expect(key).not.toHaveProperty("tokenHash");

    const raw = readFileSync(join(tmpRoot, "api-keys.json"), "utf8");
    expect(raw).not.toContain(token);
  });

  it("stores an expiry when provided", () => {
    const expiry = Date.now() + 60_000;
    const { key } = apiKeys.createApiKey("temp", "", expiry);
    expect(key.expires_at).toBe(expiry);
  });
});

describe("listApiKeys", () => {
  it("lists all keys without token hashes", () => {
    apiKeys.createApiKey("one", "", null);
    apiKeys.createApiKey("two", "", null);

    const keys = apiKeys.listApiKeys();
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.name).sort()).toEqual(["one", "two"]);
    for (const key of keys) expect(key).not.toHaveProperty("tokenHash");
  });
});

describe("verifyApiToken", () => {
  it("accepts a valid token and records last_used_at", () => {
    const { key, token } = apiKeys.createApiKey("devboard", "", null);

    const verified = apiKeys.verifyApiToken(token);
    expect(verified?.id).toBe(key.id);
    expect(verified?.last_used_at).toBeTypeOf("number");
  });

  it("rejects unknown, malformed, and revoked tokens", () => {
    const { key, token } = apiKeys.createApiKey("devboard", "", null);

    expect(apiKeys.verifyApiToken("cbk_" + "0".repeat(40))).toBeNull();
    expect(apiKeys.verifyApiToken("not-a-key")).toBeNull();
    expect(apiKeys.verifyApiToken("")).toBeNull();

    apiKeys.deleteApiKey(key.id);
    expect(apiKeys.verifyApiToken(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { token } = apiKeys.createApiKey("temp", "", Date.now() + 60_000);

    expect(apiKeys.verifyApiToken(token)).not.toBeNull();

    vi.setSystemTime(1_000_000 + 60_001);
    expect(apiKeys.verifyApiToken(token)).toBeNull();
  });

  it("throttles last_used_at writes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { token } = apiKeys.createApiKey("devboard", "", null);

    const first = apiKeys.verifyApiToken(token);
    expect(first?.last_used_at).toBe(1_000_000);

    // Within the throttle window the stored timestamp doesn't move
    vi.setSystemTime(1_000_000 + 30_000);
    const second = apiKeys.verifyApiToken(token);
    expect(second?.last_used_at).toBe(1_000_000);

    // Past the window it updates
    vi.setSystemTime(1_000_000 + 61_000);
    const third = apiKeys.verifyApiToken(token);
    expect(third?.last_used_at).toBe(1_000_000 + 61_000);
  });
});

describe("deleteApiKey", () => {
  it("returns false for an unknown id", () => {
    expect(apiKeys.deleteApiKey("nope")).toBe(false);
  });
});
