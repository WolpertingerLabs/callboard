/**
 * Config encryption module.
 *
 * Provides at-rest encryption for Drawlatch connection secrets (.env files).
 * The encryption key is derived from the user's login password + a constant
 * per-install salt using scrypt. The key only exists in memory after a
 * successful login — it is never persisted to disk.
 *
 * File format for .env.enc:
 *   Bytes 0–11:   IV  (12 bytes, random per encryption)
 *   Bytes 12–27:  GCM Auth Tag (16 bytes)
 *   Bytes 28–end: Ciphertext
 *
 * Uses AES-256-GCM for authenticated encryption.
 */
import { scrypt, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { updateEnvFile } from "./env-writer.js";
import { createLogger } from "./logger.js";

const log = createLogger("config-encryption");

// ── Constants ────────────────────────────────────────────────────────

const AES_KEY_LENGTH = 32; // 256-bit key for AES-256
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const ALGORITHM = "aes-256-gcm";

// ── In-memory key state ──────────────────────────────────────────────

let encryptionKey: Buffer | null = null;

/** Store the derived encryption key in memory. */
export function setEncryptionKey(key: Buffer): void {
  encryptionKey = key;
}

/** Retrieve the in-memory encryption key, or null if not yet derived. */
export function getEncryptionKey(): Buffer | null {
  return encryptionKey;
}

/** Clear the encryption key from memory. */
export function clearEncryptionKey(): void {
  if (encryptionKey) {
    encryptionKey.fill(0); // Zero-fill before releasing
  }
  encryptionKey = null;
}

/** True when the encryption key is available in memory (user has logged in). */
export function isEncryptionKeyAvailable(): boolean {
  return encryptionKey !== null;
}

// ── Key derivation ───────────────────────────────────────────────────

/**
 * Derive a 32-byte AES-256 encryption key from a password and salt using scrypt.
 *
 * This produces a DIFFERENT key than the 64-byte auth hash (different output
 * length means scrypt produces a different derived key), so knowledge of one
 * does not reveal the other.
 */
export function deriveConfigEncryptionKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, AES_KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey);
    });
  });
}

// ── Salt management ──────────────────────────────────────────────────

/**
 * Get the existing CONFIG_ENCRYPTION_SALT from process.env, or generate
 * one and persist it to ~/.callboard/.env.
 *
 * The salt is generated ONCE per installation and must never be changed.
 * Changing or deleting it makes all encrypted secrets unrecoverable.
 */
export function getOrCreateConfigEncryptionSalt(): string {
  const existing = process.env.CONFIG_ENCRYPTION_SALT;
  if (existing) return existing;

  // Generate a new 32-byte random salt
  const salt = randomBytes(32).toString("hex");

  // Persist to ~/.callboard/.env
  updateEnvFile({ CONFIG_ENCRYPTION_SALT: salt });
  process.env.CONFIG_ENCRYPTION_SALT = salt;

  log.warn(
    "Generated CONFIG_ENCRYPTION_SALT and saved to .env. " +
      "WARNING: Do not modify or delete this value — it is required to decrypt connection secrets.",
  );

  return salt;
}

// ── Encrypt / Decrypt primitives ─────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a Buffer containing [IV (12) | Auth Tag (16) | Ciphertext].
 */
export function encryptString(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: IV + AuthTag + Ciphertext
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer (IV + Auth Tag + Ciphertext) back to a plaintext string.
 * Throws if the key is wrong or the data is corrupted (GCM auth tag mismatch).
 */
export function decryptToString(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted data too short — expected at least 28 bytes (IV + Auth Tag)");
  }

  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err: any) {
    if (err.message?.includes("Unsupported state") || err.code === "ERR_OSSL_BAD_DECRYPT") {
      throw new Error(
        "Decryption failed — wrong key or corrupted data. " +
          "If CONFIG_ENCRYPTION_SALT was changed, encrypted secrets are unrecoverable. " +
          "Delete the .env.enc file and reconfigure your connection secrets.",
      );
    }
    throw err;
  }
}

// ── File-level operations ────────────────────────────────────────────

/**
 * Encrypt a plaintext .env file and write the result to .env.enc.
 * Uses atomic write (write .tmp, rename, then delete plaintext).
 *
 * @param envPath   Path to the plaintext .env file to encrypt
 * @param encPath   Path for the encrypted output (.env.enc)
 * @param key       AES-256 encryption key
 */
export function encryptEnvFile(envPath: string, encPath: string, key: Buffer): void {
  const plaintext = readFileSync(envPath, "utf-8");
  const encrypted = encryptString(plaintext, key);

  // Atomic write: .enc.tmp → rename to .enc → delete plaintext
  const tmpPath = encPath + ".tmp";
  writeFileSync(tmpPath, encrypted, { mode: 0o600 });
  renameSync(tmpPath, encPath);

  // Remove plaintext .env
  try {
    unlinkSync(envPath);
    log.info(`Encrypted ${envPath} → ${encPath} (plaintext removed)`);
  } catch (err: any) {
    log.warn(`Encrypted file written but failed to remove plaintext ${envPath}: ${err.message}`);
  }
}

/**
 * Decrypt an .env.enc file and return its plaintext contents.
 * Does NOT write the plaintext to disk.
 */
export function decryptEnvFileContents(encPath: string, key: Buffer): string {
  const encrypted = readFileSync(encPath);
  return decryptToString(encrypted, key);
}

// ── Status helpers ───────────────────────────────────────────────────

/**
 * Check if config encryption is active for a given config directory.
 * Returns true when CONFIG_ENCRYPTION_SALT is set AND the directory
 * contains a .env.enc file.
 */
export function isEncryptionActive(configDir: string): boolean {
  if (!process.env.CONFIG_ENCRYPTION_SALT) return false;
  return existsSync(join(configDir, ".env.enc"));
}

/**
 * Check if a plaintext .env exists that should be migrated to encrypted.
 * Returns true when CONFIG_ENCRYPTION_SALT is set AND the directory
 * has a plaintext .env but NO .env.enc yet.
 */
export function needsEncryptionMigration(configDir: string): boolean {
  if (!process.env.CONFIG_ENCRYPTION_SALT) return false;
  const envPath = join(configDir, ".env");
  const encPath = join(configDir, ".env.enc");
  return existsSync(envPath) && !existsSync(encPath);
}

/**
 * Clean up stale temporary files and handle crash recovery.
 * Called on startup to ensure consistent state.
 *
 * - Removes orphaned .env.enc.tmp files
 * - If both .env and .env.enc exist (crash between encrypt and delete),
 *   removes the plaintext .env since .env.enc is the authoritative copy
 */
export function cleanupEncryptionArtifacts(configDir: string): void {
  const tmpPath = join(configDir, ".env.enc.tmp");
  const envPath = join(configDir, ".env");
  const encPath = join(configDir, ".env.enc");

  // Clean up orphaned .tmp files from interrupted writes
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath);
      log.warn(`Cleaned up stale ${tmpPath} (likely from interrupted encryption)`);
    } catch {
      // Best effort
    }
  }

  // If both plaintext and encrypted exist, the encrypted is authoritative
  if (process.env.CONFIG_ENCRYPTION_SALT && existsSync(envPath) && existsSync(encPath)) {
    try {
      unlinkSync(envPath);
      log.warn(`Removed leftover plaintext ${envPath} (encrypted version is authoritative)`);
    } catch {
      // Best effort
    }
  }
}
