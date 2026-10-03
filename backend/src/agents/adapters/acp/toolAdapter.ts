/**
 * Tool adapter: callboard {@link ToolServerSpec} → a live in-process MCP server
 * an ACP agent reaches over stdio via the {@link file://../../shared/mcp-server-shim.ts shim}.
 *
 * ACP registers tools by handing the agent an `McpServer[]` on `session/new`.
 * The agent is the MCP *client*: for the stdio variant it spawns each server
 * itself. Since callboard's tool handlers must run in the backend process (they
 * close over live state), the server is hosted here on a private socket and the
 * agent is given a spawn command for the relay shim. See the shim's doc-comment
 * for the full argument.
 *
 * Only the **stdio** transport is emitted. ACP's `McpServer` union also has
 * `http` and `sse` variants gated behind `mcpCapabilities`, but stdio is the
 * untagged member with no capability flag — every ACP agent accepts it — and it
 * needs no listening HTTP port, so it is both the most portable and the tightest
 * choice.
 *
 * ## Schema note (`anyOf`)
 *
 * A prior incident in this codebase: OpenRouter silently drops **all** server
 * tools when any function-tool schema contains `anyOf`. Nothing equivalent can
 * happen at this layer, and the reason is structural rather than lucky — ACP
 * never sees a tool schema at all. It receives `{name, command, args, env}` and
 * the agent then speaks MCP to the shim; schemas travel inside MCP's own
 * `tools/list`, whose JSON Schema support is complete. There is no ACP-side
 * schema validation step to choke. `toolAdapter.test.ts` pins this with a tool
 * whose schema does produce `anyOf`.
 *
 * @see ../../shared/mcp-server-shim.ts (the stdio frontend the agent spawns)
 * @see ../../shared/socketToolServer.ts (the socket host shared with Codex)
 * @see ../codex/toolAdapter.ts (same mechanism, different consumer)
 */
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import type { ToolServerSpec } from "../../ports/tools.js";
import { buildSocketToolServer, shimSpawnCommand } from "../../shared/socketToolServer.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("acp-tools");

/**
 * Opaque value returned by `AcpAdapter.buildToolServer`. `services/claude.ts`
 * stores it in `options.mcpServers[spec.name]`; the query collects the handles,
 * turns each into an ACP `McpServerStdio` entry for `session/new`, and closes
 * them when the turn ends.
 */
export interface AcpToolServerHandle {
  readonly name: string;
  readonly version: string;
  /** Absolute socket path (POSIX) or pipe name (win32) the backend listens on. */
  readonly socketPath: string;
  /** The ACP `McpServer` entry pointing the agent at the shim → this socket. */
  toAcpMcpServer(): McpServerStdio;
  /** Stop listening and remove the socket + temp dir. Idempotent. */
  close(): Promise<void>;
}

/** Structural marker — picks our handles out of the loosely-typed `options.mcpServers`. */
export function isAcpToolServerHandle(value: unknown): value is AcpToolServerHandle {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AcpToolServerHandle>;
  return typeof v.socketPath === "string" && typeof v.toAcpMcpServer === "function" && typeof v.close === "function";
}

/**
 * Stand up an in-process MCP server for `spec` on a private socket. See
 * `agents/shared/socketToolServer.ts` — each inbound connection (one per shim
 * the agent spawns) gets its own MCP server, and connection-scoped errors are
 * logged, never thrown: a flaky agent must not be able to crash the backend.
 */
export function buildAcpToolServer(spec: ToolServerSpec): AcpToolServerHandle {
  const server = buildSocketToolServer(spec, { label: "acp", log });
  return {
    name: server.name,
    version: server.version,
    socketPath: server.socketPath,
    toAcpMcpServer: () => acpStdioServer(spec.name, server.socketPath),
    close: () => server.close(),
  };
}

/**
 * Build the ACP `McpServerStdio` entry that points an agent at the shim for
 * `socketPath`.
 *
 * The shim follows the build (`.js` in `dist`, `.ts` via tsx's loader under dev
 * / vitest) — see `shimSpawnCommand` in `agents/shared/socketToolServer.ts`.
 *
 * `env: []` — not omitted. ACP types the field as required, and an empty list
 * means "inherit"; the agent process already carries the sanitized environment
 * from `AcpAgentClient`, and the shim needs nothing beyond a socket path.
 *
 * Exported for unit-test access.
 */
export function acpStdioServer(name: string, socketPath: string): McpServerStdio {
  return { name, ...shimSpawnCommand(socketPath, "acp-mcp-server-shim"), env: [] };
}

/**
 * Pick the ACP tool-server handles out of `options.mcpServers`.
 *
 * That record is loosely typed and may also hold other providers' shapes (a
 * Claude in-process bundle, an external HTTP MCP config), so entries that are
 * not ours are skipped rather than coerced.
 */
export function collectAcpToolServers(mcpServers: unknown): AcpToolServerHandle[] {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  const handles: AcpToolServerHandle[] = [];
  for (const value of Object.values(mcpServers as Record<string, unknown>)) {
    if (isAcpToolServerHandle(value)) handles.push(value);
  }
  return handles;
}
