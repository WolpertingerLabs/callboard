import { scrypt, randomBytes, timingSafeEqual } from "crypto";

const KEY_LENGTH = 64; // 512-bit derived key
const SALT_LENGTH = 16; // 128-bit random salt

/** Minimum length for a new login password. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate a *new* password before it is hashed and stored.
 *
 * Intentionally enforces length only (≥ 8 chars) — no charset/complexity rules.
 * The user is liable for choosing a strong password; the strength meter in the
 * UI is advisory. Do NOT call this on login (it only verifies an existing
 * credential, and a length check there could lock out an already-set password).
 */
export function validateNewPassword(password: unknown): { valid: boolean; error?: string } {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { valid: true };
}

/**
 * Generate a cryptographically random salt as a hex string.
 */
export function generateSalt(): string {
  return randomBytes(SALT_LENGTH).toString("hex");
}

/**
 * Hash a password with the given salt using scrypt.
 * Returns a hex-encoded derived key.
 */
export function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString("hex"));
    });
  });
}

/**
 * Verify a password against a stored hash and salt.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
  const derivedKey = await hashPassword(password, salt);
  const hashBuffer = Buffer.from(storedHash, "hex");
  const derivedBuffer = Buffer.from(derivedKey, "hex");
  if (hashBuffer.length !== derivedBuffer.length) return false;
  return timingSafeEqual(hashBuffer, derivedBuffer);
}
