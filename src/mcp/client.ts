/**
 * The caller side of the encrypted channel: handshake with the daemon and
 * send tool calls over `/request`.
 *
 * Shared by the local MCP server (`server.ts`) and the `drawlatch vault` CLI
 * (`src/cli/vault.ts`). It authenticates only as a caller, with what the MCP
 * server has always used: `proxy.config.json`'s `remoteUrl`, the caller's
 * private keys in `keys/callers/<alias>/`, and the pinned server public keys
 * in `keys/server/`, all under the config dir. It reads no other file.
 */

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  loadProxyConfig,
  resolveCallerKeyAlias,
  getCallerKeysDir,
  getServerKeysDir,
  getProxyConfigPath,
  resolveLocalTimeout,
  resolveOutboundBudget,
} from '../shared/config.js';
import {
  loadKeyBundle,
  loadPublicKeys,
  EncryptedChannel,
  extractPublicKeys,
  fingerprint,
} from '../shared/crypto/index.js';
import {
  HandshakeInitiator,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';

export interface ChannelClientOptions {
  /**
   * Caller key alias. When omitted, `MCP_KEY_ALIAS` (or `"default"`) is read
   * each time a channel is established, as the MCP server always has.
   */
  callerAlias?: string;
  /**
   * Where progress and diagnostic lines go. They name the alias, key
   * directory, session id and fingerprint, never a request or response.
   * Defaults to stderr with the `[mcp-proxy]` prefix.
   */
  log?: (message: string) => void;
}

export interface ChannelClient {
  /**
   * Send one tool call to the daemon and return its result. Rejects with the
   * daemon's error message when the call fails.
   */
  send(toolName: string, toolInput: Record<string, unknown>): Promise<unknown>;
}

const defaultLog = (message: string): void => {
  console.error(`[mcp-proxy] ${message}`);
};

/** A client that opens the channel lazily and re-opens it when the session expires. */
export function createChannelClient(opts: ChannelClientOptions = {}): ChannelClient {
  const log = opts.log ?? defaultLog;
  let channel: EncryptedChannel | null = null;
  let remoteUrl: string;

  // ── Handshake ────────────────────────────────────────────────────────────

  async function establishChannel(): Promise<EncryptedChannel> {
    // Pre-flight validation
    if (!existsSync(getProxyConfigPath())) {
      throw new Error(`No proxy config found at ${getProxyConfigPath()}. Run: drawlatch init`);
    }

    const config = loadProxyConfig();
    remoteUrl = config.remoteUrl;

    // Resolve key paths from config dir + alias
    const alias = opts.callerAlias ?? resolveCallerKeyAlias();
    const callerKeysDir = path.join(getCallerKeysDir(), alias);
    const serverKeysDir = getServerKeysDir();

    log(`Using caller alias: "${alias}"`);
    log(`Caller keys dir: ${callerKeysDir}`);

    // Validate key paths before attempting to load
    if (!existsSync(callerKeysDir)) {
      throw new Error(
        `Caller keys not found at ${callerKeysDir}. Run: drawlatch generate-keys caller ${alias}`,
      );
    }
    if (!existsSync(serverKeysDir)) {
      throw new Error(
        `Server public keys not found at ${serverKeysDir}. Run: drawlatch init (same host), or copy the remote server's *.pub.pem files there`,
      );
    }

    let ownKeys, remotePub;
    try {
      ownKeys = loadKeyBundle(callerKeysDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load caller keys from ${callerKeysDir}: ${msg}. Run: drawlatch generate-keys caller ${alias}`,
      );
    }
    try {
      remotePub = loadPublicKeys(serverKeysDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load server public keys from ${serverKeysDir}: ${msg}. Run: drawlatch init (same host), or copy the remote server's *.pub.pem files there`,
      );
    }

    const initiator = new HandshakeInitiator(ownKeys, remotePub);

    // Step 1: Send HandshakeInit
    const initMsg = initiator.createInit();
    let initResp: Response;
    try {
      initResp = await fetch(`${remoteUrl}/handshake/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initMsg),
        signal: AbortSignal.timeout(config.connectTimeout),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED')) {
        throw new Error(
          `Remote server is not running at ${remoteUrl}. Start it with: drawlatch start`,
        );
      }
      if ((err instanceof DOMException && err.name === 'AbortError') || msg.includes('timed out')) {
        throw new Error(
          `Remote server at ${remoteUrl} is not responding (timed out after ${config.connectTimeout}ms)`,
        );
      }
      throw new Error(`Failed to connect to remote server at ${remoteUrl}: ${msg}`);
    }

    if (!initResp.ok) {
      const errText = await initResp.text();
      const localFp = fingerprint(extractPublicKeys(ownKeys));
      if (initResp.status === 401 || initResp.status === 403) {
        log(`Handshake rejected by server. Your key fingerprint: ${localFp}`);
        log('Ensure this fingerprint matches an authorized peer on the remote server.');
        throw new Error(
          `Handshake rejected (${initResp.status}). Your fingerprint: ${localFp}. Check that public keys are correctly exchanged. See: drawlatch init`,
        );
      }
      throw new Error(`Handshake init failed: ${initResp.status} ${errText}`);
    }

    const reply = await initResp.json();

    // Step 3: Process reply and derive keys
    const sessionKeys = initiator.processReply(reply);
    const newChannel = new EncryptedChannel(sessionKeys);

    // Step 3b: Send encrypted "finish" to prove we derived the right keys
    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${remoteUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
      signal: AbortSignal.timeout(config.connectTimeout),
    });

    if (!finishResp.ok) {
      throw new Error(`Handshake finish failed: ${finishResp.status}`);
    }

    log(`Secure channel established (session: ${sessionKeys.sessionId})`);
    return newChannel;
  }

  async function getChannel(): Promise<EncryptedChannel> {
    channel ??= await establishChannel();
    return channel;
  }

  // ── Encrypted request/response ───────────────────────────────────────────

  async function send(toolName: string, toolInput: Record<string, unknown>): Promise<unknown> {
    const ch = await getChannel();
    const config = loadProxyConfig();
    // Derived from toolInput (not a parameter) so the 401 re-establishment retry
    // below recomputes the same deadline without threading it through.
    const localTimeout = resolveLocalTimeout(toolInput, config);

    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName,
      toolInput,
      // On the envelope, not in toolInput — it has to reach handlers that never
      // forward their input (test_connection, test_ingestor,
      // resolve_listener_options), which is exactly where the ordering gap was.
      outboundBudgetMs: resolveOutboundBudget(localTimeout),
      timestamp: Date.now(),
    };

    // Encrypt the entire request
    const encrypted = ch.encryptJSON(request);

    let resp: Response;
    try {
      resp = await fetch(`${remoteUrl}/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Session-Id': ch.sessionId,
        },
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(localTimeout),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED')) {
        channel = null;
        throw new Error(
          `Remote server is not running at ${remoteUrl}. Start it with: drawlatch start`,
        );
      }
      if ((err instanceof DOMException && err.name === 'AbortError') || msg.includes('timed out')) {
        throw new Error(
          `Remote server at ${remoteUrl} is not responding (timed out after ${localTimeout}ms)`,
        );
      }
      channel = null;
      throw new Error(`Failed to reach remote server at ${remoteUrl}: ${msg}`);
    }

    if (!resp.ok) {
      // If session expired, re-establish
      if (resp.status === 401) {
        log('Session expired, re-establishing...');
        channel = null;
        try {
          return await send(toolName, toolInput);
        } catch (reEstErr) {
          const msg = reEstErr instanceof Error ? reEstErr.message : String(reEstErr);
          throw new Error(`Session re-establishment failed: ${msg}`);
        }
      }
      throw new Error(`Request failed: ${resp.status} ${await resp.text()}`);
    }

    // Decrypt the response
    const encryptedResponse = Buffer.from(await resp.arrayBuffer());
    const response = ch.decryptJSON<ProxyResponse>(encryptedResponse);

    if (!response.success) {
      throw new Error(response.error ?? 'Remote server returned failure');
    }

    return response.result;
  }

  return { send };
}
