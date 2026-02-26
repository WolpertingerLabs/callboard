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
