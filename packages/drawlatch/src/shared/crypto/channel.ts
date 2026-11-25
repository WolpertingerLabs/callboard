/**
 * Encrypted communication channel using AES-256-GCM.
 *
 * After the handshake, both sides derive directional keys:
 *   - initiator→responder key (for messages from the MCP proxy to the remote server)
 *   - responder→initiator key (for messages from the remote server back)
 *
 * Each message is encrypted with a fresh random IV and includes:
 *   - 12-byte IV
 *   - 16-byte GCM auth tag
 *   - monotonic counter as AAD (prevents replay)
 *   - ciphertext
 *
 * Replay protection uses a sliding-window approach (similar to IPsec/DTLS):
 * messages may arrive out of order, but each counter can only be accepted once,
 * and counters that fall too far behind the highest seen are rejected.
 *
 * The shared secret from X25519 ECDH is never used directly — HKDF derives
 * separate encryption keys for each direction plus a MAC key.
 */

import crypto from 'node:crypto';

/** Wire format: IV (12) + authTag (16) + counter (8) + ciphertext (variable) */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const COUNTER_LENGTH = 8; // uint64 big-endian

/**
 * Size of the sliding anti-replay window. Counters within this distance behind
 * the highest authenticated counter are accepted (if not already seen).
 * Counters further behind are rejected as too old.
 */
const ANTI_REPLAY_WINDOW_SIZE = 256n;

/** Derived session keys for one direction */
export interface DirectionalKey {
  /** AES-256-GCM encryption key (32 bytes) */
  encryptionKey: Buffer;
}

/** Full session keys for bidirectional communication */
export interface SessionKeys {
  /** Key for initiator → responder messages */
  sendKey: DirectionalKey;
  /** Key for responder → initiator messages */
  recvKey: DirectionalKey;
  /** Shared session ID for logging/correlation */
  sessionId: string;
}

/**
 * Derive bidirectional session keys from the X25519 shared secret.
 *
 * Uses HKDF-SHA256 with a role-aware info string so each direction
 * gets a unique key even from the same shared secret.
 *
 * @param sharedSecret - Raw X25519 ECDH output (32 bytes)
 * @param isInitiator - Whether this side initiated the handshake
 * @param handshakeHash - Hash of the handshake transcript (binds keys to this session)
 */
export function deriveSessionKeys(
  sharedSecret: Buffer,
  isInitiator: boolean,
  handshakeHash: Buffer,
): SessionKeys {
  // Use handshake transcript hash as salt — binds keys to this specific session
  const salt = handshakeHash;

  // Derive initiator→responder key
  const i2rKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, 'initiator-to-responder', 32),
  );

  // Derive responder→initiator key
  const r2iKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, 'responder-to-initiator', 32),
  );

  // Derive session ID for logging
  const sessionIdBuf = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, 'session-id', 16));
  const sessionId = sessionIdBuf.toString('hex');

  return {
    sendKey: { encryptionKey: isInitiator ? i2rKey : r2iKey },
    recvKey: { encryptionKey: isInitiator ? r2iKey : i2rKey },
    sessionId,
  };
}

/**
 * Encrypted channel for bidirectional communication.
 *
 * Uses a sliding-window anti-replay mechanism: each message carries a
 * monotonic counter as AAD, and the receiver tracks which counters have
 * been seen. Out-of-order delivery is tolerated within the window, but
 * duplicate counters and counters that are too old are rejected.
 */
export class EncryptedChannel {
  private sendCounter = 0n;

  /** Highest authenticated counter received so far (-1 = none seen yet). */
  private maxRecvCounter = -1n;
  /** Set of counters seen within the sliding window. */
  private readonly replayWindow = new Set<bigint>();

  constructor(private readonly keys: SessionKeys) {}

  get sessionId(): string {
    return this.keys.sessionId;
  }

  /**
   * Return the underlying session keys (for handshake verification).
   */
  getKeys(): SessionKeys {
    return this.keys;
  }

  /**
   * Encrypt a message for sending.
   *
   * @returns Buffer containing: IV (12) || authTag (16) || counter (8) || ciphertext
   */
  encrypt(plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const counter = this.sendCounter++;

    // Encode counter as big-endian uint64 for AAD
    const counterBuf = Buffer.alloc(COUNTER_LENGTH);
    counterBuf.writeBigUInt64BE(counter);

    const cipher = crypto.createCipheriv('aes-256-gcm', this.keys.sendKey.encryptionKey, iv);
    cipher.setAAD(counterBuf);

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Pack: IV || authTag || counter || ciphertext
    return Buffer.concat([iv, authTag, counterBuf, encrypted]);
  }

  /**
   * Decrypt a received message.
   *
   * Uses a sliding-window check: counters that have already been seen or that
   * have fallen too far behind the highest authenticated counter are rejected.
   * Out-of-order delivery within the window is accepted.
   *
   * Window state is only updated **after** GCM authentication succeeds, so a
   * forged message cannot advance the window or poison the seen-set.
   *
   * @throws Error if the counter is a replay, too old, or decryption fails
   */
  decrypt(packed: Buffer): Buffer {
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH) {
      throw new Error('Message too short');
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const counterBuf = packed.subarray(
      IV_LENGTH + AUTH_TAG_LENGTH,
      IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH,
    );
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH);

    const counter = counterBuf.readBigUInt64BE();

    // --- Anti-replay pre-checks (before expensive decryption) ---

    if (this.maxRecvCounter >= 0n) {
      // Reject counters that have fallen outside the window (too old)
      if (counter + ANTI_REPLAY_WINDOW_SIZE <= this.maxRecvCounter) {
        throw new Error(
          `Counter ${counter} is too old (highest seen: ${this.maxRecvCounter}, ` +
            `window: ${ANTI_REPLAY_WINDOW_SIZE}). Possible replay attack.`,
        );
      }

      // Reject duplicate counters (replay)
      if (this.replayWindow.has(counter)) {
        throw new Error(`Duplicate counter ${counter}. Possible replay attack.`);
      }
    }

    // --- Decrypt and authenticate ---

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.keys.recvKey.encryptionKey, iv);
    decipher.setAAD(counterBuf);
    decipher.setAuthTag(authTag);

    let result: Buffer;
    try {
      result = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Decryption failed: authentication tag mismatch (tampered or wrong key)');
    }

    // --- Post-authentication: update anti-replay state ---

    if (counter > this.maxRecvCounter) {
      // Advance the window and prune entries that fell outside
      const newFloor = counter - ANTI_REPLAY_WINDOW_SIZE;
      for (const seen of this.replayWindow) {
        if (seen <= newFloor) this.replayWindow.delete(seen);
      }
      this.maxRecvCounter = counter;
    }
    this.replayWindow.add(counter);

    return result;
  }

  /**
   * Convenience: encrypt a JSON-serializable object.
   */
  encryptJSON(obj: unknown): Buffer {
    return this.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
  }

  /**
   * Convenience: decrypt and parse a JSON object.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is used by callers for type narrowing of the return value
  decryptJSON<T = unknown>(packed: Buffer): T {
    const plaintext = this.decrypt(packed);
    return JSON.parse(plaintext.toString('utf-8')) as T;
  }
}
