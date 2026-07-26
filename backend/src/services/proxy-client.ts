/**
 * Proxy client for communicating with drawlatch's remote server.
 *
 * Handles the Ed25519/X25519 handshake and AES-256-GCM encrypted channel,
 * providing a simple interface for making authenticated tool calls
 * (poll_events, ingestor_status, list_routes, http_request).
 *
 * Imports crypto primitives and protocol types from the drawlatch
 * package — no vendored crypto code.
 */
import crypto from "node:crypto";
import { loadKeyBundle, loadPublicKeys, EncryptedChannel, type KeyBundle, type PublicKeyBundle } from "@wolpertingerlabs/drawlatch/shared/crypto";
import { HandshakeInitiator, type HandshakeReply, type ProxyRequest, type ProxyResponse } from "@wolpertingerlabs/drawlatch/shared/protocol";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-client");

/** Total attempts for a single callTool before giving up. */
const MAX_ATTEMPTS = 4;
/** Ceiling on a single backoff sleep. */
const MAX_BACKOFF_MS = 8000;
/** Ceiling on a server-supplied Retry-After sleep. */
const MAX_RETRY_AFTER_MS = 15000;

/**
 * Stale-channel errors: the encrypted session on one side no longer matches
 * the other (server restart, key rotation, counter desync). Dropping the
 * channel and rehandshaking clears these.
 */
function isStaleChannelError(message: string): boolean {
  return /authentication tag mismatch|duplicate counter|possible replay|decryption failed/i.test(message);
}

/**
 * Handshake errors that are transient rather than a genuine authorization
 * failure — worth one more try with a fresh initiator. Explicitly excludes
 * "not authorized", which is a real permission problem and must not be retried.
 */
function isTransientHandshakeError(message: string): boolean {
  if (/not authorized/i.test(message)) return false;
  return /responder signature invalid|handshake (init |finish )?failed/i.test(message);
}

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

    // Step 2: Process reply and derive session keys
    const keys = initiator.processReply(reply);

    // Step 3: Send finish (encrypted "ready" proof)
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
   * Sleep before a retry. Uses the server's Retry-After when present, else
   * exponential backoff. Always adds jitter: concurrent session starts (e.g.
   * several scheduled jobs firing at the top of the hour) otherwise retry in
   * lockstep and trip the same rate limit again.
   */
  private async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    let delayMs = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);

    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        delayMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      }
    }

    delayMs += Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Handshake, retrying once on a transient failure (e.g. a responder
   * signature that fails to verify against a mid-rotation key).
   */
  private async handshakeWithRetry(): Promise<void> {
    try {
      await this.handshake();
    } catch (err: any) {
      if (!isTransientHandshakeError(err?.message || "")) throw err;
      log.warn(`Handshake failed transiently (${err.message}) — retrying once`);
      await this.backoff(1);
      await this.handshake();
    }
  }

  /**
   * Make an authenticated tool call to the remote server.
   *
   * Auto-handshakes on first call and recovers from the transient failures
   * seen against drawlatch: 401 (30-min session TTL), 429 (rate limit, which
   * bursts when many sessions start at once), 5xx, network blips, and
   * stale-channel crypto errors. Genuine failures (403, unknown tool, a tool
   * returning an error) still throw on the first attempt.
   */
  async callTool(toolName: string, toolInput: Record<string, unknown> = {}): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!this.channel || !this.sessionId) {
        await this.handshakeWithRetry();
      }

      const request: ProxyRequest = {
        type: "proxy_request",
        id: crypto.randomUUID(),
        toolName,
        toolInput,
        timestamp: Date.now(),
      };

      try {
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
          // Session expired (30-min TTL) — drop the channel and rehandshake.
          log.warn(`Session expired on "${toolName}", rehandshaking (attempt ${attempt}/${MAX_ATTEMPTS})`);
          this.channel = null;
          this.sessionId = null;
          lastError = new Error("Proxy request failed: 401");
          continue;
        }

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`Proxy request failed: ${res.status}`);
          if (attempt === MAX_ATTEMPTS) break;
          log.warn(`Proxy ${res.status} on "${toolName}" — backing off (attempt ${attempt}/${MAX_ATTEMPTS})`);
          await this.backoff(attempt, res.headers.get("retry-after"));
          continue;
        }

        if (!res.ok) {
          // 403 and friends are real failures — do not burn retries on them.
          throw new Error(`Proxy request failed: ${res.status}`);
        }

        const responseBuffer = Buffer.from(await res.arrayBuffer());
        const response = this.channel!.decryptJSON<ProxyResponse>(responseBuffer);

        if (!response.success) {
          throw new Error(response.error || "Unknown proxy error");
        }

        return response.result;
      } catch (err: any) {
        const message = err?.message || String(err);

        // Stale channel — the session is unrecoverable but a fresh one works.
        if (isStaleChannelError(message)) {
          log.warn(`Stale channel on "${toolName}" (${message}) — rehandshaking (attempt ${attempt}/${MAX_ATTEMPTS})`);
          this.channel = null;
          this.sessionId = null;
          lastError = err;
          if (attempt === MAX_ATTEMPTS) break;
          continue;
        }

        // Network-level failure (daemon restarting, transient DNS/socket).
        if (err?.name === "TypeError" || /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
          lastError = err;
          if (attempt === MAX_ATTEMPTS) break;
          log.warn(`Proxy network error on "${toolName}" (${message}) — backing off (attempt ${attempt}/${MAX_ATTEMPTS})`);
          await this.backoff(attempt);
          continue;
        }

        throw err;
      }
    }

    throw lastError ?? new Error(`Proxy request failed for "${toolName}"`);
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
