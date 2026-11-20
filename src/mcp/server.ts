/**
 * MCP Proxy Server — the local side.
 *
 * Claude Code spawns this as a child process (stdio transport).
 * It exposes MCP tools, encrypts requests, forwards them to the remote
 * secure server over HTTP, decrypts responses, and returns them to Claude.
 *
 * The proxy holds NO secrets. It only has:
 *   - Its own Ed25519 + X25519 keypair (for authentication + encryption)
 *   - The remote server's public keys (for verifying the remote's identity)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadProxyConfig,
  resolveCallerKeyAlias,
  getCallerKeysDir,
  getServerKeysDir,
  getProxyConfigPath,
  resolveLocalTimeout,
  resolveOutboundBudget,
  MAX_OUTBOUND_TIMEOUT_MS,
} from '../shared/config.js';
import {
  loadKeyBundle,
  loadPublicKeys,
  EncryptedChannel,
  extractPublicKeys,
  fingerprint,
} from '../shared/crypto/index.js';
import { existsSync } from 'node:fs';
import {
  HandshakeInitiator,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';

// ── State ──────────────────────────────────────────────────────────────────

let channel: EncryptedChannel | null = null;
let remoteUrl: string;

// ── Handshake ──────────────────────────────────────────────────────────────

async function establishChannel(): Promise<EncryptedChannel> {
  // Pre-flight validation
  if (!existsSync(getProxyConfigPath())) {
    throw new Error(`No proxy config found at ${getProxyConfigPath()}. Run: drawlatch init`);
  }

  const config = loadProxyConfig();
  remoteUrl = config.remoteUrl;

  // Resolve key paths from config dir + alias
  const alias = resolveCallerKeyAlias();
  const callerKeysDir = path.join(getCallerKeysDir(), alias);
  const serverKeysDir = getServerKeysDir();

  console.error(`[mcp-proxy] Using caller alias: "${alias}"`);
  console.error(`[mcp-proxy] Caller keys dir: ${callerKeysDir}`);

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
      console.error(`[mcp-proxy] Handshake rejected by server. Your key fingerprint: ${localFp}`);
      console.error(
        '[mcp-proxy] Ensure this fingerprint matches an authorized peer on the remote server.',
      );
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

  console.error(`[mcp-proxy] Secure channel established (session: ${sessionKeys.sessionId})`);
  return newChannel;
}

async function getChannel(): Promise<EncryptedChannel> {
  channel ??= await establishChannel();
  return channel;
}

// ── Encrypted request/response ─────────────────────────────────────────────

async function sendEncryptedRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<unknown> {
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
      console.error('[mcp-proxy] Session expired, re-establishing...');
      channel = null;
      try {
        return await sendEncryptedRequest(toolName, toolInput);
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

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'secure-proxy',
  version: '1.0.0',
});

/**
 * Generic HTTP request tool — similar to the api-proxy but all traffic is
 * encrypted end-to-end. The remote server resolves secret placeholders.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'secure_request',
  "Make an authenticated HTTP request through the encrypted proxy. Route-level headers (e.g., Authorization) are injected automatically by the server — do not send them yourself. You may use ${VAR_NAME} placeholders for other secrets in the URL, headers, or body — they are resolved server-side using the matched route's secrets and never exposed to the client. Secrets a route injects through its own headers (and signing/webhook secrets) are withheld: list_routes reports them as withheldSecretNames, and a request that references one is rejected.",
  {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
    url: z.string().describe('Full URL, may contain ${VAR} placeholders'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Request headers, may contain ${VAR} placeholders'),
    body: z.any().optional().describe('Request body (object for JSON, string for raw)'),
    files: z
      .array(
        z.object({
          field: z.string().describe('Form field name (e.g., "files[0]", "file", "attachment")'),
          path: z.string().describe('Absolute path to the file on the local filesystem'),
          filename: z.string().describe('Filename to use in the upload'),
          contentType: z.string().describe('MIME type (e.g., "image/png", "application/pdf")'),
        }),
      )
      .optional()
      .describe(
        'File attachments for multipart/form-data uploads. When present, the request is sent as multipart with the JSON body as "payload_json". Use bodyFieldName to change the JSON part name.',
      ),
    bodyFieldName: z
      .string()
      .optional()
      .describe(
        'Form field name for the JSON body part in multipart requests (default: "payload_json"). Only used when files are present.',
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      // Without an upper bound, a large value overflows Node's 32-bit timer:
      // the local deadline collapses to 1ms and aborts instantly while the
      // remote's fetch runs on and bills. See MAX_LOCAL_TIMEOUT_MS.
      .max(MAX_OUTBOUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Outbound request timeout in milliseconds — how long the server waits for the upstream API before cancelling the call. Clamped to the connection's own ceiling and to the local proxy's requestTimeout budget; call list_routes to see the effective maxTimeoutMs per connection. Omit for the connection default (~25s, or higher for slow connections like web scraping). Values above ~55000 also require raising MCP_TOOL_TIMEOUT in your MCP client, which caps tool calls at 60s by default. Maximum ${MAX_OUTBOUND_TIMEOUT_MS}.`,
      ),
  },
  async ({ method, url, headers, body, files, bodyFieldName, timeoutMs }) => {
    try {
      const toolInput: Record<string, unknown> = {
        method,
        url,
        headers: headers ?? {},
        body,
      };

      // Rides along inside toolInput through the existing encrypted channel —
      // no protocol change needed. Also drives the local → remote deadline.
      if (timeoutMs !== undefined) {
        toolInput.timeoutMs = timeoutMs;
      }

      // Read and base64-encode files from the local filesystem before sending
      // through the encrypted channel (remote server can't access local files)
      if (files?.length) {
        const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file
        const encodedFiles = await Promise.all(
          files.map(async ({ field, path: filePath, filename, contentType }) => {
            if (!path.isAbsolute(filePath)) {
              throw new Error(`File path must be absolute: ${filePath}`);
            }
            let stat;
            try {
              stat = await fs.stat(filePath);
            } catch {
              throw new Error(`File not found: ${filePath}`);
            }
            if (stat.size > MAX_FILE_SIZE) {
              throw new Error(
                `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${filePath} — max ${MAX_FILE_SIZE / 1024 / 1024} MB`,
              );
            }
            const buffer = await fs.readFile(filePath);
            return { field, data: buffer.toString('base64'), filename, contentType };
          }),
        );
        toolInput.files = encodedFiles;
        if (bodyFieldName) {
          toolInput.bodyFieldName = bodyFieldName;
        }
      }

      const result = await sendEncryptedRequest('http_request', toolInput);

      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * List all available routes from the remote server with full metadata.
 * Returns route names, descriptions, docs links, endpoint patterns,
 * secret names (not values), and auto-injected header names.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'list_routes',
  'List all available routes on the remote server. Returns metadata (name, description, docs link), allowed endpoint patterns, available secret placeholder names (not values), and auto-injected header names for each route, plus withheldSecretNames: secrets the route uses itself that requests may not reference. Use this to discover which APIs are available and how to call them.',
  // Empty schema — no input needed
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('list_routes', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Poll for new events from ingestors on the remote server.
 * Returns events received from real-time sources (Discord Gateway, webhooks, etc.)
 * since the last poll cursor.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'poll_events',
  'Poll for new events from ingestors (Discord messages, GitHub webhooks, etc.). Returns events received since the given cursor. Pass after_id from the last event you received to get only new events. Omit connection to get events from all ingestors.',
  {
    connection: z
      .string()
      .optional()
      .describe('Connection alias to poll (e.g., "discord-bot"). Omit for all.'),
    after_id: z
      .number()
      .optional()
      .describe('Return events with id > after_id. Omit or -1 for all buffered events.'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Instance ID for multi-instance listeners (e.g., "project-board"). Omit for all instances.',
      ),
  },
  async ({ connection, after_id, instance_id }) => {
    try {
      const result = await sendEncryptedRequest('poll_events', {
        connection,
        after_id,
        instance_id,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Get the status of all active ingestors for this caller.
 * Shows connection state, buffer sizes, event counts, and any errors.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'ingestor_status',
  'Get the status of all active ingestors for this caller. Shows connection state, buffer sizes, event counts, and any errors.',
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('ingestor_status', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Test connectivity for a specific connection by running a pre-configured,
 * non-destructive read-only request against its API.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'test_connection',
  'Test connectivity to a specific connection by making a non-destructive read-only request. Verifies that API credentials are valid. Returns success/failure with status details.',
  {
    connection: z.string().describe('Connection alias to test (e.g., "github", "discord-bot")'),
  },
  async ({ connection }) => {
    try {
      const result = await sendEncryptedRequest('test_connection', { connection });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Test event listener / ingestor configuration for a specific connection.
 * Verifies credentials and listener parameters are correct.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'test_ingestor',
  'Test event listener configuration for a connection. Verifies credentials and listener parameters are correct without starting the full listener. Returns success/failure with details.',
  {
    connection: z.string().describe('Connection alias to test listener for (e.g., "discord-bot")'),
  },
  async ({ connection }) => {
    try {
      const result = await sendEncryptedRequest('test_ingestor', { connection });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * List listener configuration schemas for all connections with configurable event listeners.
 * Returns field schemas that UIs can use to render configuration forms.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'list_listener_configs',
  'List configurable event listener schemas for all connections. Returns field definitions (type, label, options, defaults) that can be used to render configuration forms.',
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('list_listener_configs', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Resolve dynamic options for a listener configuration field by fetching
 * them from the external API (e.g., list of Trello boards, Discord guilds).
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'resolve_listener_options',
  'Fetch dynamic options for a listener configuration field. Some fields (like Trello boards) require an API call to populate their options list.',
  {
    connection: z.string().describe('Connection alias (e.g., "trello")'),
    paramKey: z.string().describe('The field key to resolve options for (e.g., "boardId")'),
  },
  async ({ connection, paramKey }) => {
    try {
      const result = await sendEncryptedRequest('resolve_listener_options', {
        connection,
        paramKey,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Start, stop, or restart an event listener for a specific connection.
 * Controls the lifecycle of ingestors at runtime without restarting the server.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'control_listener',
  'Start, stop, or restart an event listener for a connection. Stopping a listener pauses event collection; starting resumes it. Use restart after configuration changes.',
  {
    connection: z.string().describe('Connection alias (e.g., "discord-bot")'),
    action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action to perform'),
    instance_id: z
      .string()
      .optional()
      .describe('Instance ID for multi-instance listeners. Omit to control all instances.'),
  },
  async ({ connection, action, instance_id }) => {
    try {
      const result = await sendEncryptedRequest('control_listener', {
        connection,
        action,
        instance_id,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Read current listener parameter overrides for a connection.
 * Returns current values and schema defaults for populating config forms.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'get_listener_params',
  'Read current listener parameter overrides for a connection. Returns current values and schema defaults. Use instance_id for multi-instance listeners.',
  {
    connection: z.string().describe('Connection alias (e.g., "trello", "discord-bot")'),
    instance_id: z
      .string()
      .optional()
      .describe('Instance ID for multi-instance listeners. Omit for single-instance.'),
  },
  async ({ connection, instance_id }) => {
    try {
      const result = await sendEncryptedRequest('get_listener_params', { connection, instance_id });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Add or edit listener parameter overrides for a connection.
 * Merges params into existing config. Supports creating new multi-instance listeners.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'set_listener_params',
  'Add or edit listener parameter overrides for a connection. Merges params into existing config. Set create_instance to true to create a new multi-instance listener.',
  {
    connection: z.string().describe('Connection alias (e.g., "trello")'),
    instance_id: z
      .string()
      .optional()
      .describe('Instance ID for multi-instance listeners. Omit for single-instance.'),
    params: z
      .record(z.string(), z.unknown())
      .describe('Key-value pairs to set. Keys must match listener config field keys.'),
    create_instance: z
      .boolean()
      .optional()
      .describe("Set to true to create a new instance if it doesn't exist."),
  },
  async ({ connection, instance_id, params, create_instance }) => {
    try {
      const result = await sendEncryptedRequest('set_listener_params', {
        connection,
        instance_id,
        params,
        create_instance,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * List all configured listener instances for a multi-instance connection.
 * Returns every instance from config, including stopped/disabled ones.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'list_listener_instances',
  'List all configured instances for a multi-instance listener connection. Returns every instance from config (including stopped/disabled ones), unlike ingestor_status which only shows running instances.',
  {
    connection: z.string().describe('Connection alias (e.g., "trello")'),
  },
  async ({ connection }) => {
    try {
      const result = await sendEncryptedRequest('list_listener_instances', { connection });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Delete a multi-instance listener instance.
 * Stops the running ingestor if active and removes the instance from config.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'delete_listener_instance',
  'Remove a multi-instance listener instance. Stops the running ingestor if active and removes the instance from config.',
  {
    connection: z.string().describe('Connection alias (e.g., "trello")'),
    instance_id: z
      .string()
      .describe('Instance ID to delete (required — only for multi-instance listeners).'),
  },
  async ({ connection, instance_id }) => {
    try {
      const result = await sendEncryptedRequest('delete_listener_instance', {
        connection,
        instance_id,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * List all available connection templates with caller-specific status.
 * Returns which connections are enabled and which secrets are configured.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'list_connection_templates',
  'List all available connection templates (built-in + custom). Returns template metadata, which connections are enabled for this caller, and which secrets are configured (boolean only, never values).',
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('list_connection_templates', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Enable or disable a connection for the authenticated caller.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'set_connection_enabled',
  'Enable or disable a connection for the authenticated caller. When disabling, any running ingestors for the connection are stopped.',
  {
    connection: z.string().describe('Connection alias (e.g., "github", "discord-bot")'),
    enabled: z.boolean().describe('Whether to enable (true) or disable (false) the connection'),
  },
  async ({ connection, enabled }) => {
    try {
      const result = await sendEncryptedRequest('set_connection_enabled', { connection, enabled });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Set or delete secrets for the authenticated caller.
 * Uses prefixed env vars for caller isolation. Never returns secret values.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'set_secrets',
  'Set or delete secrets for the authenticated caller. Pass secret name → value pairs. Use empty string to delete a secret. Returns boolean status per secret (never values).',
  {
    secrets: z
      .record(z.string(), z.string())
      .describe('Secret name → value pairs. Empty string deletes the secret.'),
  },
  async ({ secrets }) => {
    try {
      const result = await sendEncryptedRequest('set_secrets', { secrets });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Check which secrets are set for the authenticated caller (never returns values).
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'get_secret_status',
  'Check which secrets are configured for a connection. Returns boolean status for each required and optional secret (never returns values).',
  {
    connection: z.string().describe('Connection alias to check secrets for (e.g., "github")'),
  },
  async ({ connection }) => {
    try {
      const result = await sendEncryptedRequest('get_secret_status', { connection });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-proxy] MCP Secure Proxy server started (stdio transport)');

  // Non-blocking health check: advise user if the remote server is not reachable
  try {
    const config = loadProxyConfig();
    const resp = await fetch(`${config.remoteUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.error(`[mcp-proxy] Remote server reachable at ${config.remoteUrl}`);
    } else {
      console.error(
        `[mcp-proxy] WARNING: Remote server at ${config.remoteUrl} returned ${resp.status}. Check server health.`,
      );
    }
  } catch {
    const config = loadProxyConfig();
    console.error(
      `[mcp-proxy] WARNING: Remote server at ${config.remoteUrl} is not reachable. Start it with: drawlatch start`,
    );
  }
}

main().catch((err: unknown) => {
  console.error('[mcp-proxy] Fatal error:', err);
  process.exit(1);
});
