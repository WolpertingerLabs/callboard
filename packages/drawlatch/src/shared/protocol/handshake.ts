/**
 * Mutual authentication handshake protocol.
 *
 * Inspired by the Noise NK pattern — the responder's (remote server's) public
 * key is known in advance. The initiator (MCP proxy) proves its identity by
 * signing a challenge, and both sides derive a shared secret via X25519 ECDH.
 *
 * Protocol flow:
 *
 *   Initiator (MCP Proxy)                    Responder (Remote Server)
 *   ──────────────────────                    ────────────────────────
 *
 *   1. Generate ephemeral X25519 keypair
 *      Sign(ephemeral_pub || nonce_i) with Ed25519
 *      ──── HandshakeInit ────────────────►
 *                                             2. Verify initiator's signature
 *                                                Check initiator's pubkey is authorized
 *                                                Generate ephemeral X25519 keypair
 *                                                Sign(ephemeral_pub || nonce_r || nonce_i)
 *                                             ◄──── HandshakeReply ──────
 *   3. Verify responder's signature
 *      Both: ECDH(ephemeral_i, ephemeral_r) → shared secret
 *      Both: HKDF(shared_secret, transcript_hash) → session keys
 *      ──── HandshakeFinish (encrypted "ready") ──►
 *                                             4. Decrypt and verify "ready"
 *                                                Session established ✓
 *
 * The handshake transcript (all messages concatenated) is hashed and used as
 * HKDF salt, binding the session keys to the exact handshake that occurred.
 * This prevents unknown-key-share attacks.
 */

import crypto from 'node:crypto';
import {
  type KeyBundle,
  type PublicKeyBundle,
  deriveSessionKeys,
  fingerprint,
  EncryptedChannel,
  type SessionKeys,
} from '../crypto/index.js';

// ── Message types ──────────────────────────────────────────────────────────

export interface HandshakeInit {
  type: 'handshake_init';
  /** Initiator's static Ed25519 public key (PEM) */
  signingPubKey: string;
  /** Initiator's ephemeral X25519 public key (PEM) */
  ephemeralPubKey: string;
  /** Random nonce (32 bytes, hex) */
  nonceI: string;
  /** Ed25519 signature over (ephemeralPubKey || nonceI) */
  signature: string;
  /** Protocol version */
  version: 1;
}

export interface HandshakeReply {
  type: 'handshake_reply';
  /** Responder's ephemeral X25519 public key (PEM) */
  ephemeralPubKey: string;
  /** Random nonce (32 bytes, hex) */
  nonceR: string;
  /** Ed25519 signature over (ephemeralPubKey || nonceR || nonceI) */
  signature: string;
}

export interface HandshakeFinish {
  type: 'handshake_finish';
  /** Encrypted "ready" payload — proves the initiator derived the right keys */
  payload: string; // hex-encoded encrypted data
}

export type HandshakeMessage = HandshakeInit | HandshakeReply | HandshakeFinish;

// ── Helpers ────────────────────────────────────────────────────────────────

function signData(privateKey: crypto.KeyObject, ...parts: (string | Buffer)[]): Buffer {
  const combined = Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf-8') : p)),
  );
  return crypto.sign(null, combined, privateKey);
}

function verifySignature(
  publicKey: crypto.KeyObject,
  signature: Buffer,
  ...parts: (string | Buffer)[]
): boolean {
  const combined = Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf-8') : p)),
  );
  return crypto.verify(null, combined, publicKey, signature);
}

// ── Initiator (MCP Proxy side) ─────────────────────────────────────────────

export class HandshakeInitiator {
  private ephemeral: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
  private nonceI: Buffer;
  private transcript: Buffer[] = [];

  constructor(
    /** Our full key bundle */
    private readonly ownKeys: KeyBundle,
    /** The remote server's known public keys */
    private readonly peerPublicKeys: PublicKeyBundle,
  ) {
    this.ephemeral = crypto.generateKeyPairSync('x25519');
    this.nonceI = crypto.randomBytes(32);
  }

  /**
   * Step 1: Create the initial handshake message.
   */
  createInit(): HandshakeInit {
    const ephemeralPubPem = this.ephemeral.publicKey.export({
      type: 'spki',
      format: 'pem',
    });

    const signature = signData(this.ownKeys.signing.privateKey, ephemeralPubPem, this.nonceI);

    const msg: HandshakeInit = {
      type: 'handshake_init',
      signingPubKey: this.ownKeys.signing.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      ephemeralPubKey: ephemeralPubPem,
      nonceI: this.nonceI.toString('hex'),
      signature: signature.toString('hex'),
      version: 1,
    };

    // Record in transcript
    this.transcript.push(Buffer.from(JSON.stringify(msg), 'utf-8'));

    return msg;
  }

  /**
   * Step 3: Process the responder's reply and derive session keys.
   */
  processReply(reply: HandshakeReply): SessionKeys {
    // Record in transcript
    this.transcript.push(Buffer.from(JSON.stringify(reply), 'utf-8'));

    // Verify responder's signature over (ephemeralPubKey || nonceR || nonceI)
    const sigValid = verifySignature(
      this.peerPublicKeys.signing,
      Buffer.from(reply.signature, 'hex'),
      reply.ephemeralPubKey,
      Buffer.from(reply.nonceR, 'hex'),
      this.nonceI,
    );

    if (!sigValid) {
      throw new Error('Handshake failed: responder signature invalid');
    }

    // ECDH to derive shared secret
    const peerEphemeral = crypto.createPublicKey(reply.ephemeralPubKey);
    const sharedSecret = crypto.diffieHellman({
      privateKey: this.ephemeral.privateKey,
      publicKey: peerEphemeral,
    });

    // Hash the full transcript
    const transcriptHash = crypto
      .createHash('sha256')
      .update(Buffer.concat(this.transcript))
      .digest();

    return deriveSessionKeys(sharedSecret, true, transcriptHash);
  }

  /**
   * Create the finish message (encrypted with the newly derived keys).
   */
  createFinish(keys: SessionKeys): HandshakeFinish {
    const channel = new EncryptedChannel(keys);

    const readyPayload = channel.encrypt(
      Buffer.from(JSON.stringify({ status: 'ready', timestamp: Date.now() }), 'utf-8'),
    );

    return {
      type: 'handshake_finish',
      payload: readyPayload.toString('hex'),
    };
  }
}

// ── Responder (Remote Server side) ──────────────────────────────────────────

export class HandshakeResponder {
  private ephemeral: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } | null = null;
  private transcript: Buffer[] = [];

  constructor(
    /** Our full key bundle */
    private readonly ownKeys: KeyBundle,
    /** Set of authorized initiator public keys */
    private readonly authorizedKeys: PublicKeyBundle[],
  ) {}

  /**
   * Step 2: Process the init message, verify the initiator, and create a reply.
   */
  processInit(init: HandshakeInit): { reply: HandshakeReply; initiatorPubKey: PublicKeyBundle } {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation for untrusted input regardless of static type
    if (init.version !== 1) {
      throw new Error(`Unsupported handshake version: ${String(init.version)}`);
    }

    // Record in transcript
    this.transcript.push(Buffer.from(JSON.stringify(init), 'utf-8'));

    // Parse the initiator's signing public key
    const initiatorSigningKey = crypto.createPublicKey(init.signingPubKey);

    // Check if this key is authorized
    const authorized = this.authorizedKeys.find((ak) => {
      const akPem = ak.signing.export({ type: 'spki', format: 'pem' });
      return akPem === init.signingPubKey;
    });

    if (!authorized) {
      // Log fingerprints for diagnosis
      const initiatorFp = crypto
        .createHash('sha256')
        .update(initiatorSigningKey.export({ type: 'spki', format: 'der' }))
        .digest();
      const fpStr = Array.from(initiatorFp.subarray(0, 16))
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join(':');
      console.error(
        `[handshake] Rejected: no authorized peer matches signing key fingerprint ${fpStr}`,
      );
      console.error('[handshake] Authorized peer fingerprints:');
      for (const ak of this.authorizedKeys) {
        console.error(`[handshake]   ${fingerprint(ak)}`);
      }
      throw new Error('Handshake failed: initiator not authorized');
    }

    // Verify initiator's signature over (ephemeralPubKey || nonceI)
    const sigValid = verifySignature(
      initiatorSigningKey,
      Buffer.from(init.signature, 'hex'),
      init.ephemeralPubKey,
      Buffer.from(init.nonceI, 'hex'),
    );

    if (!sigValid) {
      throw new Error('Handshake failed: initiator signature invalid');
    }

    // Generate our ephemeral keypair
    this.ephemeral = crypto.generateKeyPairSync('x25519');
    const ephemeralPubPem = this.ephemeral.publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    const nonceR = crypto.randomBytes(32);

    // Sign (ephemeralPubKey || nonceR || nonceI)
    const signature = signData(
      this.ownKeys.signing.privateKey,
      ephemeralPubPem,
      nonceR,
      Buffer.from(init.nonceI, 'hex'),
    );

    const reply: HandshakeReply = {
      type: 'handshake_reply',
      ephemeralPubKey: ephemeralPubPem,
      nonceR: nonceR.toString('hex'),
      signature: signature.toString('hex'),
    };

    // Record in transcript
    this.transcript.push(Buffer.from(JSON.stringify(reply), 'utf-8'));

    return { reply, initiatorPubKey: authorized };
  }

  /**
   * Derive session keys after sending the reply.
   * Call this after processInit() and before verifying the finish message.
   */
  deriveKeys(init: HandshakeInit): SessionKeys {
    if (!this.ephemeral) {
      throw new Error('Must call processInit() first');
    }

    // ECDH with initiator's ephemeral public key
    const peerEphemeral = crypto.createPublicKey(init.ephemeralPubKey);
    const sharedSecret = crypto.diffieHellman({
      privateKey: this.ephemeral.privateKey,
      publicKey: peerEphemeral,
    });

    // Hash the full transcript
    const transcriptHash = crypto
      .createHash('sha256')
      .update(Buffer.concat(this.transcript))
      .digest();

    return deriveSessionKeys(sharedSecret, false, transcriptHash);
  }

  /**
   * Step 4: Verify the finish message to confirm the initiator derived the right keys.
   */
  verifyFinish(finish: HandshakeFinish, keys: SessionKeys): boolean {
    const channel = new EncryptedChannel(keys);

    try {
      const payload = channel.decrypt(Buffer.from(finish.payload, 'hex'));
      const parsed = JSON.parse(payload.toString('utf-8'));
      return parsed.status === 'ready';
    } catch {
      return false;
    }
  }
}
