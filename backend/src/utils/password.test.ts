import { describe, it, expect } from "vitest";
import { validateNewPassword, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, generateSalt } from "./password.js";

describe("validateNewPassword", () => {
  it("rejects passwords shorter than the minimum", () => {
    expect(validateNewPassword("1234567").valid).toBe(false);
    expect(validateNewPassword("a".repeat(MIN_PASSWORD_LENGTH - 1)).valid).toBe(false);
  });

  it("accepts passwords at or above the minimum", () => {
    expect(validateNewPassword("12345678").valid).toBe(true);
    expect(validateNewPassword("a".repeat(MIN_PASSWORD_LENGTH)).valid).toBe(true);
    expect(validateNewPassword("a-very-long-passphrase").valid).toBe(true);
  });

  it("enforces length only — no charset/complexity rules", () => {
    // All-lowercase, no digits/symbols, but long enough → still valid.
    expect(validateNewPassword("passwordpassword").valid).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(validateNewPassword(undefined).valid).toBe(false);
    expect(validateNewPassword(null).valid).toBe(false);
    expect(validateNewPassword(12345678 as unknown).valid).toBe(false);
  });

  it("returns a helpful error message mentioning the minimum", () => {
    const r = validateNewPassword("short");
    expect(r.valid).toBe(false);
    expect(r.error).toContain(String(MIN_PASSWORD_LENGTH));
  });
});

describe("hashPassword / verifyPassword (sanity)", () => {
  it("round-trips a valid password", async () => {
    const salt = generateSalt();
    const hash = await hashPassword("correct horse battery", salt);
    expect(await verifyPassword("correct horse battery", hash, salt)).toBe(true);
    expect(await verifyPassword("wrong", hash, salt)).toBe(false);
  });
});
