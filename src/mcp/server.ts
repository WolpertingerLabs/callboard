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
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProxyConfig, MAX_OUTBOUND_TIMEOUT_MS } from '../shared/config.js';
import { createChannelClient } from './client.js';

// ── Encrypted channel ──────────────────────────────────────────────────────
//
// Handshake, session re-establishment and the encrypted request/response live
// in client.ts, shared with the `drawlatch vault` CLI.

const client = createChannelClient();

function sendEncryptedRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<unknown> {
  return client.send(toolName, toolInput);
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
  'Make an authenticated HTTP request through the encrypted proxy. Route-level headers (e.g., Authorization) are injected automatically by the server — do not send them yourself. You may use ${VAR_NAME} placeholders for other secrets in the URL, headers, or body — they are resolved server-side using the matched route\'s secrets and never exposed to the client. Secrets a route injects through its own headers (and signing/webhook secrets) are withheld: list_routes reports them as withheldSecretNames, and a request that references one is rejected. On a route whose list_routes entry has auth.type "oauth2", drawlatch mints the access token itself: do not send an Authorization header or an access_token query parameter. Your own vault items resolve as ${vault:name} or ${vault:name.field} in the URL path or query and in headers (in the body only where ${VAR} resolves there too), never in the host; a value containing #, ? or & is refused in the URL (send it in a header). The value never comes back to you: echoes are scrubbed to ${vault:<your caller alias>/name.field}. A placeholder for a missing item or field, or one used on a connection outside the item\'s connections binding, fails the request before anything is sent.',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
    url: z
      .string()
      .describe(
        'Full URL, may contain ${VAR} and (in the path or query) ${vault:name} placeholders',
      ),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Request headers, may contain ${VAR} and ${vault:name} placeholders'),
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
  'List all available routes on the remote server. Returns metadata (name, description, docs link), allowed endpoint patterns, available secret placeholder names (not values), and auto-injected header names for each route, plus withheldSecretNames: secrets the route uses itself that requests may not reference, and auth ({ type: "oauth2", grant, scopes, delegated? }) on routes whose token drawlatch mints itself (delegated: true when a service account acts as a user). Use this to discover which APIs are available and how to call them.',
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
  'Enable or disable a connection for the authenticated caller. When disabling, any running ingestors for the connection are stopped. Refused when the operator has disabled self-management for this caller (selfManageable: false in list_connection_templates). Enabling an OAuth2 connection (auth.type "oauth2" in list_connection_templates) is always refused: only the operator can enable those. Disabling one is allowed.',
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
  'Set or delete secrets for the authenticated caller. Pass secret name → value pairs. Use empty string to delete a secret. Returns boolean status per secret (never values). Refused when the operator has disabled self-management for this caller (selfManageable: false in list_connection_templates). Setting or deleting a signing credential (the client ID, client secret, refresh token, or service-account key of an OAuth2 connection, or the signing keys of an AWS SigV4 connection) is always refused.',
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

// ── Vault ──────────────────────────────────────────────────────────────────
//
// The daemon validates every vault input, so these schemas stay loose and a
// validation message never quotes a value back.

/** Forward a vault tool call and render its result or error as MCP content. */
async function forwardVaultTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const result = await sendEncryptedRequest(toolName, input);
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
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
}

const VAULT_PLAINTEXT_NOTE =
  'notes, tags and metadata are plain text that vault_list returns: never put secrets in them.';
const VAULT_CONTEXT_NOTE =
  'The values you pass here go through your own context. For a secret you should never see, ask the operator to create the item on the drawlatch dashboard instead.';

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_list',
  `List your vault items: name, kind, exposure, field names, notes, tags, metadata and connections binding. Never returns values. "shared" lists other callers' items the operator has granted you: owner, name, kind, field names, connections binding, and mode ("inject": use it as \${vault:owner/name} in secure_request; "reveal": vault_get with owner can read it too). ${VAULT_PLAINTEXT_NOTE}`,
  {
    tag: z.string().optional().describe('Only items carrying this tag'),
  },
  async ({ tag }) => forwardVaultTool('vault_list', tag === undefined ? {} : { tag }),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_create',
  `Save a new item in your vault. kind "token" and "note" take exactly { value }, "password" takes { value, username? }, "key-value" takes 1-16 named fields. exposure "inject" (the default) means no tool will ever return the value, and you use it as \${vault:name} in secure_request; "reveal" lets vault_get return it to you as well (every read is audit-logged). Fails if the name exists. ${VAULT_CONTEXT_NOTE} ${VAULT_PLAINTEXT_NOTE}`,
  {
    name: z.string().describe('Item name: 1-64 letters, digits, "_" or "-", unique in your vault'),
    kind: z.string().describe('"password", "token", "note" or "key-value"'),
    values: z.record(z.string(), z.string()).describe('Field name → secret value'),
    exposure: z.string().optional().describe('"inject" (default) or "reveal"'),
    notes: z.string().optional().describe('Plain-text description (not secret)'),
    tags: z.array(z.string()).optional().describe('Plain-text tags (not secret)'),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe('Plain-text key → value pairs, e.g. a URL (not secret)'),
    connections: z
      .array(z.string())
      .optional()
      .describe('Connection aliases this item may be used on; omit for any'),
  },
  async (input) => forwardVaultTool('vault_create', input),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_update',
  `Change one of your vault items. values replaces the whole value map. You can only tighten an item: exposure may go from "reveal" to "inject" but not back, and connections may only narrow (the operator can loosen an item on the drawlatch dashboard). ${VAULT_CONTEXT_NOTE} ${VAULT_PLAINTEXT_NOTE}`,
  {
    name: z.string().describe('Current item name'),
    values: z.record(z.string(), z.string()).optional().describe('New field name → value map'),
    rename: z.string().optional().describe('New name'),
    exposure: z.string().optional().describe('"inject" or "reveal" (tighten only)'),
    notes: z.string().optional().describe('New notes ("" clears)'),
    tags: z.array(z.string()).optional().describe('New tags'),
    metadata: z.record(z.string(), z.string()).optional().describe('New metadata'),
    connections: z.array(z.string()).optional().describe('New, narrower connections binding'),
  },
  async (input) => forwardVaultTool('vault_update', input),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_delete',
  'Delete one of your vault items.',
  {
    name: z.string().describe('Item name'),
  },
  async ({ name }) => forwardVaultTool('vault_delete', { name }),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_get',
  'Read the values of one of your vault items whose exposure is "reveal", or (with owner) of another caller\'s item the operator granted you at mode "reveal". Every read is recorded in the owner\'s audit log before the value is returned. Inject-only items are refused: use them as ${vault:name} (or ${vault:owner/name}) in secure_request.',
  {
    name: z.string().describe('Item name'),
    field: z.string().optional().describe('Return just this field'),
    owner: z
      .string()
      .optional()
      .describe("Another caller's alias, to read an item shared with you (needs a grant)"),
  },
  async (input) => forwardVaultTool('vault_get', input),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_request_access',
  'Ask the operator for access to another caller\'s vault item. Only the human operator can grant it, on the drawlatch dashboard; this tool grants nothing. The answer is { requestId, status: "pending" } whether or not that caller or item exists. Asking again while a request is pending returns the same request; if a grant already covers it, status is "granted". At most 20 pending requests. Once granted, use the item as ${vault:owner/name} in secure_request (and, at mode "reveal", read it with vault_get and owner). The operator sees your reason as text written by you.',
  {
    owner: z.string().describe("The item owner's caller alias"),
    name: z.string().describe("Item name in that caller's vault"),
    reason: z.string().describe('Why you need it (at most 1 KiB; shown to the operator)'),
    mode: z
      .string()
      .optional()
      .describe('"inject" (default: use it in requests only) or "reveal" (also read it)'),
  },
  async (input) => forwardVaultTool('vault_request_access', input),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_list_requests',
  'List your own vault access requests: id, owner, item name, mode, status (pending, granted, denied, cancelled, withdrawn), and the operator\'s note when one was given. status is the operator\'s decision on the request and stays "granted" even after the grant is revoked: what you can use now is the shared section of vault_list.',
  {},
  async () => forwardVaultTool('vault_list_requests', {}),
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'vault_cancel_request',
  'Cancel one of your own pending vault access requests.',
  {
    requestId: z.string().describe('The id vault_request_access returned'),
  },
  async ({ requestId }) => forwardVaultTool('vault_cancel_request', { requestId }),
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
