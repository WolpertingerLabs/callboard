/**
 * Proxy Tools — In-process MCP server exposing proxy tools to Claude sessions.
 *
 * Injected into EVERY chat session — both regular chats and agent chats.
 * In local mode: calls go through LocalProxy (in-process).
 * In remote mode: calls go through ProxyClient (encrypted HTTP).
 *
 * Built with createSdkMcpServer() from @anthropic-ai/claude-agent-sdk.
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/custom-tools
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getProxy } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy-tools");

/**
 * Build an in-process MCP server exposing proxy tools.
 *
 * @param keyAlias - The MCP key alias to use for proxy requests
 */
export function buildProxyToolsServer(keyAlias: string) {
  log.debug(`Building proxy tools server for alias="${keyAlias}"`);

  return createSdkMcpServer({
    name: "mcp-proxy",
    version: "1.0.0",
    tools: [
      tool(
        "secure_request",
        "Make an authenticated HTTP request through a configured connection. " +
          "Route-level headers (e.g., Authorization) are injected automatically by the server — " +
          "do not send them yourself. You may use ${VAR_NAME} placeholders for other secrets in " +
          "the URL, headers, or body. Use list_routes first to discover available APIs.",
        {
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
            .describe("HTTP method"),
          url: z
            .string()
            .describe("Full URL, may contain ${VAR} placeholders"),
          headers: z
            .record(z.string(), z.string())
            .optional()
            .describe("Request headers, may contain ${VAR} placeholders"),
          body: z.any().optional().describe("Request body (object for JSON, string for raw)"),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [
                { type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." },
              ],
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
              content: [
                { type: "text" as const, text: `Error: ${err.message}` },
              ],
            };
          }
        },
      ),

      tool(
        "list_routes",
        "List all available API routes/connections and their endpoints, " +
          "auto-injected headers, and available secret placeholder names. " +
          "Use this to discover which APIs are available before making requests.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [
                { type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." },
              ],
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
              content: [
                { type: "text" as const, text: `Error: ${err.message}` },
              ],
            };
          }
        },
      ),

      tool(
        "poll_events",
        "Poll for new events from ingestors (Discord messages, GitHub webhooks, etc.). " +
          "Returns events received since the given cursor. Pass after_id from the last event " +
          "you received to get only new events. Omit connection to get events from all ingestors.",
        {
          connection: z
            .string()
            .optional()
            .describe("Connection alias to poll (e.g., \"discord-bot\"). Omit for all."),
          after_id: z
            .number()
            .optional()
            .describe("Return events with id > after_id. Omit or -1 for all buffered events."),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [
                { type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." },
              ],
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
              content: [
                { type: "text" as const, text: `Error: ${err.message}` },
              ],
            };
          }
        },
      ),

      tool(
        "test_connection",
        "Verify API credentials with a non-destructive read-only test request. " +
          "Use this to check if a connection's secrets are correctly configured before making real requests.",
        {
          connection: z
            .string()
            .describe("Connection alias to test (e.g., \"github\", \"slack\")"),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [
                { type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." },
              ],
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
              content: [
                { type: "text" as const, text: `Error: ${err.message}` },
              ],
            };
          }
        },
      ),

      tool(
        "test_ingestor",
        "Verify event listener configuration without starting it. " +
          "Checks credentials, webhook secrets, and listener parameters for a connection's ingestor.",
        {
          connection: z
            .string()
            .describe("Connection alias to test (e.g., \"discord-bot\", \"github\")"),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [
                { type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." },
              ],
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
              content: [
                { type: "text" as const, text: `Error: ${err.message}` },
              ],
            };
          }
        },
      ),

      tool(
        "ingestor_status",
        "Get the status of all active ingestors for this caller. " +
          "Shows connection state, buffer sizes, event counts, and any errors.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) {
            return {
              content: [
                { type: "text" as const, text: "Proxy not configured. Set up proxy in Agent Settings." },
              ],
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
              content: [
                { type: "text" as const, text: `Error: ${err.message}` },
              ],
            };
          }
        },
      ),
    ],
  });
}
