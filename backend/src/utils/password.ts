import { scrypt, randomBytes, timingSafeEqual } from "crypto";

const KEY_LENGTH = 64; // 512-bit derived key
const SALT_LENGTH = 16; // 128-bit random salt

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
