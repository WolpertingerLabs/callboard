/**
 * Proxy client for communicating with mcp-secure-proxy's remote server.
 *
 * Handles the Ed25519/X25519 handshake and AES-256-GCM encrypted channel,
 * providing a simple interface for making authenticated tool calls
 * (poll_events, ingestor_status, list_routes).
 *
 * This is a self-contained vendor of the essential protocol from
 * mcp-secure-proxy, using only Node.js native crypto (zero external deps).
 *
 * @see /home/cybil/mcp-secure-proxy/src/shared/ for the canonical implementation
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-client");

// ── Key types ───────────────────────────────────────────────────────

interface KeyBundle {
  signing: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
  exchange: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
}

interface PublicKeyBundle {
  signing: crypto.KeyObject;
  exchange: crypto.KeyObject;
}

// ── Message types ───────────────────────────────────────────────────

interface ProxyRequest {
  type: "proxy_request";
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
}

interface ProxyResponse {
  type: "proxy_response";
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  timestamp: number;
}

// ── Handshake types ─────────────────────────────────────────────────

interface HandshakeInit {
  type: "handshake_init";
  signingPubKey: string;
  ephemeralPubKey: string;
  nonceI: string;
  signature: string;
  version: 1;
}

interface HandshakeReply {
  type: "handshake_reply";
  ephemeralPubKey: string;
  nonceR: string;
  signature: string;
}

interface HandshakeFinish {
  type: "handshake_finish";
  payload: string;
}

// ── Key loading ─────────────────────────────────────────────────────

function loadKeyBundle(dir: string): KeyBundle {
  return {
    signing: {
      publicKey: crypto.createPublicKey(fs.readFileSync(path.join(dir, "signing.pub.pem"), "utf-8")),
      privateKey: crypto.createPrivateKey(fs.readFileSync(path.join(dir, "signing.key.pem"), "utf-8")),
    },
    exchange: {
      publicKey: crypto.createPublicKey(fs.readFileSync(path.join(dir, "exchange.pub.pem"), "utf-8")),
      privateKey: crypto.createPrivateKey(fs.readFileSync(path.join(dir, "exchange.key.pem"), "utf-8")),
    },
  };
}

function loadPublicKeys(dir: string): PublicKeyBundle {
  return {
    signing: crypto.createPublicKey(fs.readFileSync(path.join(dir, "signing.pub.pem"), "utf-8")),
    exchange: crypto.createPublicKey(fs.readFileSync(path.join(dir, "exchange.pub.pem"), "utf-8")),
  };
}

// ── Encrypted channel ───────────────────────────────────────────────

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const COUNTER_LENGTH = 8; // uint64 big-endian

interface DirectionalKey {
  encryptionKey: Buffer;
}

interface SessionKeys {
  sendKey: DirectionalKey;
  recvKey: DirectionalKey;
  sessionId: string;
}

function deriveSessionKeys(sharedSecret: Buffer, isInitiator: boolean, handshakeHash: Buffer): SessionKeys {
  const salt = handshakeHash;
  const i2rKey = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, "initiator-to-responder", 32));
  const r2iKey = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, "responder-to-initiator", 32));
  const sessionIdBuf = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, "session-id", 16));

  return {
    sendKey: { encryptionKey: isInitiator ? i2rKey : r2iKey },
    recvKey: { encryptionKey: isInitiator ? r2iKey : i2rKey },
    sessionId: sessionIdBuf.toString("hex"),
  };
}

class EncryptedChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;

  constructor(private readonly keys: SessionKeys) {}

  get sessionId(): string {
    return this.keys.sessionId;
  }

  /**
   * Encrypt a message for sending.
   * Wire format: IV (12) || authTag (16) || counter (8) || ciphertext
   */
  encrypt(plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const counter = this.sendCounter++;
    const counterBuf = Buffer.alloc(COUNTER_LENGTH);
    counterBuf.writeBigUInt64BE(counter);

    const cipher = crypto.createCipheriv("aes-256-gcm", this.keys.sendKey.encryptionKey, iv);
    cipher.setAAD(counterBuf);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, counterBuf, encrypted]);
  }

  /**
   * Decrypt a received message.
   */
  decrypt(packed: Buffer): Buffer {
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH) {
      throw new Error("Message too short");
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const counterBuf = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH);

    const counter = counterBuf.readBigUInt64BE();
    if (counter !== this.recvCounter) {
      throw new Error(`Counter mismatch: expected ${this.recvCounter}, got ${counter}`);
    }
    this.recvCounter++;

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.keys.recvKey.encryptionKey, iv);
    decipher.setAAD(counterBuf);
    decipher.setAuthTag(authTag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("Decryption failed: authentication tag mismatch");
    }
  }

  encryptJSON(obj: unknown): Buffer {
    return this.encrypt(Buffer.from(JSON.stringify(obj), "utf-8"));
  }

  decryptJSON<T = unknown>(packed: Buffer): T {
    const plaintext = this.decrypt(packed);
    return JSON.parse(plaintext.toString("utf-8")) as T;
  }
}

// ── Handshake initiator ─────────────────────────────────────────────

function signData(privateKey: crypto.KeyObject, ...parts: (string | Buffer)[]): Buffer {
  const combined = Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf-8") : p)),
  );
  return crypto.sign(null, combined, privateKey);
}

function verifySignature(publicKey: crypto.KeyObject, signature: Buffer, ...parts: (string | Buffer)[]): boolean {
  const combined = Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf-8") : p)),
  );
  return crypto.verify(null, combined, publicKey, signature);
}

class HandshakeInitiator {
  private ephemeral = crypto.generateKeyPairSync("x25519");
  private nonceI = crypto.randomBytes(32);
  private transcript: Buffer[] = [];

  constructor(
    private readonly ownKeys: KeyBundle,
    private readonly peerPublicKeys: PublicKeyBundle,
  ) {}

  createInit(): HandshakeInit {
    const ephemeralPubPem = this.ephemeral.publicKey.export({ type: "spki", format: "pem" }) as string;
    const signature = signData(this.ownKeys.signing.privateKey, ephemeralPubPem, this.nonceI);

    const msg: HandshakeInit = {
      type: "handshake_init",
      signingPubKey: this.ownKeys.signing.publicKey.export({ type: "spki", format: "pem" }) as string,
      ephemeralPubKey: ephemeralPubPem,
      nonceI: this.nonceI.toString("hex"),
      signature: signature.toString("hex"),
      version: 1,
    };

    this.transcript.push(Buffer.from(JSON.stringify(msg), "utf-8"));
    return msg;
  }

  processReply(reply: HandshakeReply): SessionKeys {
    this.transcript.push(Buffer.from(JSON.stringify(reply), "utf-8"));

    const sigValid = verifySignature(
      this.peerPublicKeys.signing,
      Buffer.from(reply.signature, "hex"),
      reply.ephemeralPubKey,
      Buffer.from(reply.nonceR, "hex"),
      this.nonceI,
    );

    if (!sigValid) {
      throw new Error("Handshake failed: responder signature invalid");
    }

    const peerEphemeral = crypto.createPublicKey(reply.ephemeralPubKey);
    const sharedSecret = crypto.diffieHellman({
      privateKey: this.ephemeral.privateKey,
      publicKey: peerEphemeral,
    });

    const transcriptHash = crypto
      .createHash("sha256")
      .update(Buffer.concat(this.transcript))
      .digest();

    return deriveSessionKeys(sharedSecret, true, transcriptHash);
  }

  createFinish(keys: SessionKeys): HandshakeFinish {
    // The finish uses a throwaway channel just for the "ready" proof.
    // After the handshake, both sides create fresh channels starting at counter 0.
    const channel = new EncryptedChannel(keys);
    const payload = channel.encrypt(
      Buffer.from(JSON.stringify({ status: "ready", timestamp: Date.now() }), "utf-8"),
    );

    return {
      type: "handshake_finish",
      payload: payload.toString("hex"),
    };
  }
}

// ── Public API: ProxyClient ─────────────────────────────────────────

export class ProxyClient {
  private channel: EncryptedChannel | null = null;
  private sessionId: string | null = null;
  private ownKeys: KeyBundle;
  private peerKeys: PublicKeyBundle;

  constructor(
    private readonly remoteUrl: string,
    keysDir: string,
    peerKeysDir: string,
  ) {
    this.ownKeys = loadKeyBundle(keysDir);
    this.peerKeys = loadPublicKeys(peerKeysDir);
  }

  /**
   * Perform the Ed25519/X25519 handshake with the remote server.
   */
  async handshake(): Promise<void> {
    const initiator = new HandshakeInitiator(this.ownKeys, this.peerKeys);

    // Step 1: Send init
    const init = initiator.createInit();
    const initRes = await fetch(`${this.remoteUrl}/handshake/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init),
    });

    if (!initRes.ok) {
      throw new Error(`Handshake init failed: ${initRes.status} ${await initRes.text()}`);
    }

    const reply: HandshakeReply = (await initRes.json()) as HandshakeReply;

    // Step 3: Process reply and derive session keys
    const keys = initiator.processReply(reply);

    // Step 4: Send finish (encrypted "ready" proof)
    const finish = initiator.createFinish(keys);
    const finishRes = await fetch(`${this.remoteUrl}/handshake/finish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": keys.sessionId,
      },
      body: JSON.stringify(finish),
    });

    if (!finishRes.ok) {
      throw new Error(`Handshake finish failed: ${finishRes.status}`);
    }

    // Create a fresh channel for subsequent requests.
    // The finish message used a throwaway channel. Both sides now create
    // fresh EncryptedChannel instances starting at counter 0.
    this.channel = new EncryptedChannel(keys);
    this.sessionId = keys.sessionId;

    log.info(`Handshake complete, session=${keys.sessionId}`);
  }

  /**
   * Make an authenticated tool call to the remote server.
   * Auto-handshakes on first call and re-handshakes on 401.
   */
  async callTool(toolName: string, toolInput: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.channel || !this.sessionId) {
      await this.handshake();
    }

    const request: ProxyRequest = {
      type: "proxy_request",
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      timestamp: Date.now(),
    };

    const encrypted = this.channel!.encryptJSON(request);

    const res = await fetch(`${this.remoteUrl}/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Session-Id": this.sessionId!,
      },
      body: new Uint8Array(encrypted),
    });

    if (res.status === 401) {
      // Session expired (30-min TTL) — rehandshake and retry
      log.warn("Session expired, rehandshaking...");
      this.channel = null;
      this.sessionId = null;
      await this.handshake();
      return this.callTool(toolName, toolInput);
    }

    if (!res.ok) {
      throw new Error(`Proxy request failed: ${res.status}`);
    }

    const responseBuffer = Buffer.from(await res.arrayBuffer());
    const response = this.channel!.decryptJSON<ProxyResponse>(responseBuffer);

    if (!response.success) {
      throw new Error(response.error || "Unknown proxy error");
    }

    return response.result;
  }

  /**
   * Check if the client has an active encrypted session.
   */
  get isConnected(): boolean {
    return this.channel !== null && this.sessionId !== null;
  }

  /**
   * Reset the session (force rehandshake on next call).
   */
  reset(): void {
    this.channel = null;
    this.sessionId = null;
  }
}
