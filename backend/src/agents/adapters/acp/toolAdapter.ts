/**
 * Tool adapter: callboard {@link ToolServerSpec} → a live in-process MCP server
 * an ACP agent reaches over stdio via the {@link file://./mcp-server-shim.ts shim}.
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
 * @see ./mcp-server-shim.ts (the stdio frontend the agent spawns)
 * @see ../codex/toolAdapter.ts (same mechanism, different consumer)
 */
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import type { AnyToolDefinition, ToolServerSpec } from "../../ports/tools.js";
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
 * Register one neutral tool on a high-level MCP server. callboard's
 * `inputSchema` is already a Zod raw shape, which `registerTool` accepts and
 * validates against; the handler's content blocks are structurally MCP's own
 * union, so only `isError` needs forwarding.
 */
function registerSpecTool(server: McpServer, def: AnyToolDefinition): void {
  server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, async (args: unknown) => {
    const result = await def.handler(args as never);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });
}

/** One MCP server per socket connection — servers own their transport 1:1. */
function createServerForSpec(spec: ToolServerSpec): McpServer {
  const server = new McpServer({ name: spec.name, version: spec.version });
  for (const def of spec.tools) registerSpecTool(server, def);
  return server;
}

/** A Unix socket under a private temp dir (POSIX), or a named pipe (win32). */
function allocateSocketPath(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cb-acp-mcp-"));
  if (process.platform === "win32") {
    // Named pipes are not files; the temp dir only anchors a unique name.
    return { dir, socketPath: `\\\\.\\pipe\\${basename(dir)}` };
  }
  return { dir, socketPath: join(dir, "s.sock") };
}

/**
 * Stand up an in-process MCP server for `spec` on a private socket.
 *
 * Each inbound connection (one per shim the agent spawns) gets its own
 * {@link McpServer} on a {@link StdioServerTransport} over the socket —
 * `net.Socket` is a duplex stream, satisfying the transport's `(Readable,
 * Writable)` shape. Connection-scoped errors are logged, never thrown: a flaky
 * agent must not be able to crash the backend.
 */
export function buildAcpToolServer(spec: ToolServerSpec): AcpToolServerHandle {
  const { dir, socketPath } = allocateSocketPath();

  const netServer = net.createServer((socket) => {
    socket.on("error", (err) => {
      log.warn(`acp tool socket error (${spec.name}): ${err.message}`);
    });
    const server = createServerForSpec(spec);
    const transport = new StdioServerTransport(socket, socket);
    server.connect(transport).catch((err) => {
      log.error(`acp tool server connect failed (${spec.name}): ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    });
    socket.once("close", () => {
      void server.close().catch(() => {
        /* best-effort: the transport is already gone */
      });
    });
  });

  netServer.on("error", (err) => {
    log.error(`acp tool net server error (${spec.name}): ${err.message}`);
  });

  // listen() is async, but the agent only spawns the shim once the session
  // starts (well after this synchronous call) and the shim retries its connect —
  // so the listen race is covered without awaiting.
  netServer.listen(socketPath, () => {
    log.debug(`acp tool server listening for ${spec.name} (${spec.tools.length} tools) at ${socketPath}`);
  });

  let closed = false;
  return {
    name: spec.name,
    version: spec.version,
    socketPath,
    toAcpMcpServer: () => acpStdioServer(spec.name, socketPath),
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        netServer.close(() => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            log.warn(`failed to remove acp tool socket dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
          }
          log.debug(`acp tool server closed for ${spec.name}`);
          resolve();
        });
      }),
  };
}

/**
 * Build the ACP `McpServerStdio` entry that points an agent at the shim for
 * `socketPath`.
 *
 * The shim is resolved next to this module so it follows the build:
 * `toolAdapter.js` → `mcp-server-shim.js` in `dist`, `toolAdapter.ts` →
 * `mcp-server-shim.ts` under tsx (dev / vitest). Bare `node` cannot run a `.ts`
 * file, so the dev form goes through tsx's loader.
 *
 * `env: []` — not omitted. ACP types the field as required, and an empty list
 * means "inherit"; the agent process already carries the sanitized environment
 * from `AcpAgentClient`, and the shim needs nothing beyond a socket path.
 *
 * Exported for unit-test access.
 */
export function acpStdioServer(name: string, socketPath: string): McpServerStdio {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts");
  const shimPath = join(dirname(here), `mcp-server-shim${isTs ? ".ts" : ".js"}`);
  const args = isTs ? ["--import", "tsx", shimPath, socketPath] : [shimPath, socketPath];
  return { name, command: process.execPath, args, env: [] };
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
