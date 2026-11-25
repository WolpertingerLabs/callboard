/**
 * Caller credential bundle — passphrase wrapping (scrypt KDF + AES-256-GCM AEAD).
 *
 * Split from the types module so the format types stay free of node:crypto and
 * can be re-exported into the dashboard. Shared with callboard, which performs
 * the inverse (decrypt) at import time when a bundle is passphrase-protected.
 */

import crypto from 'node:crypto';
import type { BundleEncryption } from './caller-bundle.js';

/**
 * Default scrypt parameters. N=16384 keeps the working set (128 * N * r bytes ≈
 * 16 MiB) under Node's default scrypt `maxmem` (32 MiB) while remaining a sound
 * interactive-use cost. The exact params are recorded in the bundle so callboard
 * derives the same key regardless of future tuning.
 */
export const DEFAULT_SCRYPT_PARAMS = { n: 16384, r: 8, p: 1 } as const;

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce
const TAG_LEN = 16; // GCM auth tag
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // generous headroom over the working set

/** Generate a fresh base64-encoded scrypt salt (16 bytes). */
export function generateBundleSalt(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Derive the AES-256 key for bundle wrapping from a passphrase + the salt and
 * cost parameters recorded in the bundle's `encryption` block.
 */
export function deriveBundleKey(passphrase: string, enc: BundleEncryption): Buffer {
  return crypto.scryptSync(passphrase, Buffer.from(enc.salt, 'base64'), KEY_LEN, {
    N: enc.n,
    r: enc.r,
    p: enc.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt one private PEM with AES-256-GCM.
 * Wire format: base64(IV[12] || authTag[16] || ciphertext).
 */
export function encryptBundleField(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt one wrapped private PEM produced by {@link encryptBundleField}.
 * Throws on a wrong passphrase or tampered ciphertext (GCM auth failure).
 */
export function decryptBundleField(wrapped: string, key: Buffer): string {
  const data = Buffer.from(wrapped, 'base64');
  if (data.length < IV_LEN + TAG_LEN) throw new Error('Wrapped field too short');
  const iv = data.subarray(0, IV_LEN);
  const authTag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}
