import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export function generateSalt(): string {
  return randomBytes(SALT_LENGTH).toString('hex');
}

export function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

/**
 * Verify a password against a stored hash and salt.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const derivedKey = await hashPassword(password, salt);
  const hashBuffer = Buffer.from(storedHash, 'hex');
  const derivedBuffer = Buffer.from(derivedKey, 'hex');
  if (hashBuffer.length !== derivedBuffer.length) return false;
  return timingSafeEqual(hashBuffer, derivedBuffer);
}
