/**
 * Proxy Tools — tool-server spec exposing proxy tools to agent sessions.
 *
 * Injected into EVERY chat session — both regular chats and agent chats.
 * In local mode: calls go through LocalProxy (in-process).
 * In remote mode: calls go through ProxyClient (encrypted HTTP).
 *
 * Returns a provider-neutral {@link ToolServerSpec}; callers translate to their
 * engine's registration shape via `provider.buildToolServer(spec)`.
 */
import { z } from "zod";
import { getProxy } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";
import { defineTool } from "../agents/ports/tools.js";
import type { ToolCallResult, ToolServerSpec } from "../agents/ports/tools.js";

const log = createLogger("proxy-tools");

const NOT_CONFIGURED = "Proxy not configured. Set up proxy in Agent Settings.";

// ── Vault ────────────────────────────────────────────────────────────
//
// Mirrors drawlatch's own MCP server (src/mcp/server.ts, the vault section):
// same names, same loose schemas and the same model-facing copy. The daemon
// validates every vault input, so these schemas stay loose and a validation
// message never quotes a value back.

const VAULT_PLAINTEXT_NOTE = "notes, tags and metadata are plain text that vault_list returns: never put secrets in them.";
const VAULT_CONTEXT_NOTE =
  "The values you pass here go through your own context. For a secret you should never see, ask the operator to create the item on the drawlatch dashboard instead.";

/**
 * Forward a vault tool call and render its result or error the way drawlatch's
 * `forwardVaultTool` does: a string result verbatim, anything else as JSON, and
 * a thrown error as `Error: <message>` with `isError` set.
 */
async function forwardVaultTool(keyAlias: string, toolName: string, input: Record<string, unknown>): Promise<ToolCallResult> {
  const proxy = getProxy(keyAlias);
  if (!proxy) {
    return { content: [{ type: "text" as const, text: NOT_CONFIGURED }], isError: true };
  }
  try {
    const result = await proxy.callTool(toolName, input);
    return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${toolName} failed: ${message}`);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

function buildVaultTools(keyAlias: string) {
  return [
    defineTool(
      "vault_list",
      'List your vault items: name, kind, exposure, field names, notes, tags, metadata and connections binding. Never returns values. "shared" lists other callers\' items the operator has granted you: owner, name, kind, field names, connections binding, and mode ("inject": use it as ${vault:owner/name} in secure_request; "reveal": vault_get with owner can read it too). ' +
        VAULT_PLAINTEXT_NOTE,
      {
        tag: z.string().optional().describe("Only items carrying this tag"),
      },
      async ({ tag }) => forwardVaultTool(keyAlias, "vault_list", tag === undefined ? {} : { tag }),
    ),

    defineTool(
      "vault_create",
      'Save a new item in your vault. kind "token" and "note" take exactly { value }, "password" takes { value, username? }, "key-value" takes 1-16 named fields. exposure "inject" (the default) means no tool will ever return the value, and you use it as ${vault:name} in secure_request; "reveal" lets vault_get return it to you as well (every read is audit-logged). Fails if the name exists. ' +
        `${VAULT_CONTEXT_NOTE} ${VAULT_PLAINTEXT_NOTE}`,
      {
        name: z.string().describe('Item name: 1-64 letters, digits, "_" or "-", unique in your vault'),
        kind: z.string().describe('"password", "token", "note" or "key-value"'),
        values: z.record(z.string(), z.string()).describe("Field name → secret value"),
        exposure: z.string().optional().describe('"inject" (default) or "reveal"'),
        notes: z.string().optional().describe("Plain-text description (not secret)"),
        tags: z.array(z.string()).optional().describe("Plain-text tags (not secret)"),
        metadata: z.record(z.string(), z.string()).optional().describe("Plain-text key → value pairs, e.g. a URL (not secret)"),
        connections: z.array(z.string()).optional().describe("Connection aliases this item may be used on; omit for any"),
      },
      async (input) => forwardVaultTool(keyAlias, "vault_create", input),
    ),

    defineTool(
      "vault_update",
      'Change one of your vault items. values replaces the whole value map. You can only tighten an item: exposure may go from "reveal" to "inject" but not back, and connections may only narrow (the operator can loosen an item on the drawlatch dashboard). ' +
        `${VAULT_CONTEXT_NOTE} ${VAULT_PLAINTEXT_NOTE}`,
      {
        name: z.string().describe("Current item name"),
        values: z.record(z.string(), z.string()).optional().describe("New field name → value map"),
        rename: z.string().optional().describe("New name"),
        exposure: z.string().optional().describe('"inject" or "reveal" (tighten only)'),
        notes: z.string().optional().describe('New notes ("" clears)'),
        tags: z.array(z.string()).optional().describe("New tags"),
        metadata: z.record(z.string(), z.string()).optional().describe("New metadata"),
        connections: z.array(z.string()).optional().describe("New, narrower connections binding"),
      },
      async (input) => forwardVaultTool(keyAlias, "vault_update", input),
    ),

    defineTool(
      "vault_delete",
      "Delete one of your vault items.",
      {
        name: z.string().describe("Item name"),
      },
      async ({ name }) => forwardVaultTool(keyAlias, "vault_delete", { name }),
    ),

    defineTool(
      "vault_get",
      'Read the values of one of your vault items whose exposure is "reveal", or (with owner) of another caller\'s item the operator granted you at mode "reveal". Every read is recorded in the owner\'s audit log before the value is returned. Inject-only items are refused: use them as ${vault:name} (or ${vault:owner/name}) in secure_request.',
      {
        name: z.string().describe("Item name"),
        field: z.string().optional().describe("Return just this field"),
        owner: z.string().optional().describe("Another caller's alias, to read an item shared with you (needs a grant)"),
        purpose: z
          .string()
          .optional()
          .describe('Optional label for what the value is for, recorded in the audit log as "via" and marked as your claim (1-32 lowercase letters, digits or "-")'),
      },
      async (input) => forwardVaultTool(keyAlias, "vault_get", input),
    ),

    defineTool(
      "vault_request_access",
      'Ask the operator for access to another caller\'s vault item. Only the human operator can grant it, on the drawlatch dashboard; this tool grants nothing. The answer is { requestId, status: "pending" } whether or not that caller or item exists. Asking again while a request is pending returns the same request; if a grant already covers it, status is "granted". At most 20 pending requests. Once granted, use the item as ${vault:owner/name} in secure_request (and, at mode "reveal", read it with vault_get and owner). The operator sees your reason as text written by you.',
      {
        owner: z.string().describe("The item owner's caller alias"),
        name: z.string().describe("Item name in that caller's vault"),
        reason: z.string().describe("Why you need it (at most 1 KiB; shown to the operator)"),
        mode: z.string().optional().describe('"inject" (default: use it in requests only) or "reveal" (also read it)'),
      },
      async (input) => forwardVaultTool(keyAlias, "vault_request_access", input),
    ),

    defineTool(
      "vault_list_requests",
      'List your own vault access requests: id, owner, item name, mode, status (pending, granted, denied, cancelled, withdrawn), and the operator\'s note when one was given. status is the operator\'s decision on the request and stays "granted" even after the grant is revoked: what you can use now is the shared section of vault_list.',
      {},
      async () => forwardVaultTool(keyAlias, "vault_list_requests", {}),
    ),

    defineTool(
      "vault_cancel_request",
      "Cancel one of your own pending vault access requests.",
      {
        requestId: z.string().describe("The id vault_request_access returned"),
      },
      async ({ requestId }) => forwardVaultTool(keyAlias, "vault_cancel_request", { requestId }),
    ),
  ];
}

/**
 * Build a tool-server spec exposing proxy tools.
 *
 * @param keyAlias - The MCP key alias to use for proxy requests
 */
export function buildProxyToolsSpec(keyAlias: string): ToolServerSpec {
  log.debug(`Building proxy tools spec for alias="${keyAlias}"`);

  return {
    name: "mcp-proxy",
    version: "1.0.0",
    tools: [
      defineTool(
        "secure_request",
        "Make an authenticated HTTP request through a configured connection. " +
          "Route-level headers (e.g., Authorization) are injected automatically by the server — " +
          "do not send them yourself. You may use ${VAR_NAME} placeholders for other secrets in " +
          "the URL, headers, or body — they are resolved server-side using the matched route's secrets " +
          "and never exposed to you. Secrets a route injects through its own headers (and signing/webhook " +
          "secrets) are withheld: list_routes reports them as withheldSecretNames, and a request that " +
          'references one is rejected. On a route whose list_routes entry has auth.type "oauth2", drawlatch ' +
          "mints the access token itself: do not send an Authorization header or an access_token query parameter. " +
          "Your own vault items resolve as ${vault:name} or ${vault:name.field}, and items shared with you as " +
          "${vault:owner/name}, in the URL path or query and in headers (in the body only where ${VAR} resolves " +
          "there too), never in the host; a value containing #, ? or & is refused in the URL (send it in a header). " +
          "The value never comes back to you: echoes are scrubbed to ${vault:<your caller alias>/name.field}. " +
          "A placeholder for a missing item or field, or one used on a connection outside the item's connections " +
          "binding, fails the request before anything is sent. Use list_routes first to discover available APIs. " +
          "Supports file attachments via the files parameter for multipart uploads.",
        {
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
          url: z.string().describe("Full URL, may contain ${VAR} and (in the path or query) ${vault:name} placeholders"),
          headers: z.record(z.string(), z.string()).optional().describe("Request headers, may contain ${VAR} and ${vault:name} placeholders"),
          body: z.any().optional().describe("Request body (object for JSON, string for raw)"),
          files: z
            .array(
              z.object({
                field: z.string().describe("Form field name (e.g., 'files[0]')"),
                path: z.string().describe("Absolute path to the file on disk"),
                filename: z.string().describe("Filename for the upload"),
                contentType: z.string().describe("MIME type (e.g., 'image/png')"),
              }),
            )
            .optional()
            .describe("File attachments for multipart upload"),
          bodyFieldName: z.string().optional().describe("Form field name for the JSON body (defaults to 'payload_json')"),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("http_request", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`secure_request failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "list_routes",
        "List all available API routes/connections and their endpoints, " +
          "auto-injected headers, and available secret placeholder names. " +
          "Use this to discover which APIs are available before making requests.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("list_routes");
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`list_routes failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "poll_events",
        "Poll for new events from ingestors (Discord messages, GitHub webhooks, etc.). " +
          "Returns events received since the given cursor. Pass after_id from the last event " +
          "you received to get only new events. Omit connection to get events from all ingestors.",
        {
          connection: z.string().optional().describe('Connection alias to poll (e.g., "discord-bot"). Omit for all.'),
          after_id: z.number().optional().describe("Return events with id > after_id. Omit or -1 for all buffered events."),
          instance_id: z.string().optional().describe("Instance ID to filter events from. Only returns events from this specific listener instance."),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("poll_events", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`poll_events failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "test_connection",
        "Verify API credentials with a non-destructive read-only test request. " +
          "Use this to check if a connection's secrets are correctly configured before making real requests.",
        {
          connection: z.string().describe('Connection alias to test (e.g., "github", "slack")'),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("test_connection", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`test_connection failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "test_ingestor",
        "Verify event listener configuration without starting it. " +
          "Checks credentials, webhook secrets, and listener parameters for a connection's ingestor.",
        {
          connection: z.string().describe('Connection alias to test (e.g., "discord-bot", "github")'),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("test_ingestor", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`test_ingestor failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "control_listener",
        "Start, stop, or restart an event listener for a connection. " +
          "Stopping a listener pauses event collection; starting resumes it. " +
          "Use restart after configuration changes.",
        {
          connection: z.string().describe('Connection alias (e.g., "discord-bot")'),
          action: z.enum(["start", "stop", "restart"]).describe("Lifecycle action to perform"),
          instance_id: z.string().optional().describe("Instance ID for multi-instance listeners. Omit to control all instances."),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("control_listener", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`control_listener failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "list_listener_configs",
        "List configurable event listener schemas for all connections. " +
          "Returns field definitions (type, label, options, defaults) that can be used to render configuration forms.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("list_listener_configs");
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`list_listener_configs failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "resolve_listener_options",
        "Fetch dynamic options for a listener configuration field. " + "Some fields (like Trello boards) require an API call to populate their options list.",
        {
          connection: z.string().describe('Connection alias (e.g., "trello")'),
          paramKey: z.string().describe('The field key to resolve options for (e.g., "boardId")'),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("resolve_listener_options", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`resolve_listener_options failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "get_listener_params",
        "Read current listener parameter overrides for a connection. " +
          "Returns both the active parameter values and their schema defaults. " +
          "Use this to populate configuration forms with actual values.",
        {
          connection: z.string().describe('Connection alias (e.g., "trello", "discord-bot")'),
          instance_id: z.string().optional().describe("Instance ID for multi-instance listeners. Omit for single-instance."),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("get_listener_params", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`get_listener_params failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "set_listener_params",
        "Set listener parameter overrides for a connection. " +
          "Validates params against the schema, merges with existing config, and persists. " +
          "Supports create_instance flag for multi-instance listeners.",
        {
          connection: z.string().describe('Connection alias (e.g., "trello", "discord-bot")'),
          instance_id: z.string().optional().describe("Instance ID for multi-instance listeners. Omit for single-instance."),
          params: z.record(z.string(), z.unknown()).describe("Key-value pairs to set. Keys must match listener config field keys."),
          create_instance: z.boolean().optional().describe("If true, create the instance if it doesn't exist (multi-instance only)."),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("set_listener_params", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`set_listener_params failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "list_listener_instances",
        "List all configured instances for a multi-instance listener connection. " +
          "Returns every instance from config (including stopped/disabled ones), " +
          "unlike ingestor_status which only shows running instances.",
        {
          connection: z.string().describe('Connection alias (e.g., "trello")'),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("list_listener_instances", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`list_listener_instances failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "delete_listener_instance",
        "Remove a multi-instance listener instance. " + "Stops the running ingestor if active, removes from config, and cleans up.",
        {
          connection: z.string().describe('Connection alias (e.g., "trello")'),
          instance_id: z.string().describe("Instance ID to delete"),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("delete_listener_instance", input);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`delete_listener_instance failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      defineTool(
        "ingestor_status",
        "Get the status of all active ingestors for this caller. " + "Shows connection state, buffer sizes, event counts, and any errors.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [{ type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." }],
            };
          }
          try {
            const result = await proxy.callTool("ingestor_status");
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (err: any) {
            log.error(`ingestor_status failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            };
          }
        },
      ),

      ...buildVaultTools(keyAlias),
    ],
  };
}
