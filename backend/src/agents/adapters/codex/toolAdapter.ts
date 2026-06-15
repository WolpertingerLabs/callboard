/**
 * Tool adapter: callboard {@link ToolServerSpec} → a live, in-process MCP server
 * that Codex reaches over stdio via the {@link file://./mcp-server-shim.ts shim}.
 *
 * ## The mechanism (why this is the highest-risk slice)
 *
 * Claude Code and OpenRouter take callboard's tools as an **in-process** bundle
 * (`createSdkMcpServer`) — handlers run inside the backend. Codex is an MCP
 * *client*: it spawns the servers listed in its `mcp_servers` config and talks to
 * them over stdio. The naive route — let Codex spawn a child that rebuilds the
 * spec — would sever every stateful callboard tool from the backend's live state
 * (SSE emitter, registered `sendMessage`, in-memory job runs). So instead:
 *
 *  1. {@link buildCodexToolServer} stands up the **real** MCP server *here, in the
 *     backend process*, with the spec's live handlers, bound to a per-spec Unix
 *     domain socket. This is the value `CodexAdapter.buildToolServer` returns;
 *     `claude.ts` drops it into `options.mcpServers[name]` exactly like the other
 *     providers' opaque server objects.
 *  2. {@link CodexToolServerHandle.toMcpServerConfig} emits the Codex
 *     `mcp_servers.<name>` entry — `node <shim> <socketPath>`. The
 *     {@link optionsAdapter} collects these into `codexOpts.config.mcp_servers`.
 *  3. Codex spawns the shim; the shim relays its stdio to our socket; our
 *     in-process server answers with the live handler. Handlers run in the
 *     backend, same as Claude/OR — only the transport differs.
 *
 * Lifecycle: a handle owns a listening `net.Server` and a temp dir holding the
 * socket. {@link CodexAgentQuery} closes every handle it was given once the turn
 * ends (normal completion, abort, or error), mirroring how it reaps the temp
 * instructions file.
 *
 * @see plans/codex-adapter-job.md (Step 6 tool-bridge — "Codex is an MCP client")
 * @see ./mcp-server-shim.ts (the stdio frontend Codex actually spawns)
 */
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnyToolDefinition, ToolServerSpec } from "../../ports/tools.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-adapter");

/**
 * A single Codex `mcp_servers.<name>` config entry. Codex speaks MCP either over
 * a spawned subprocess's stdio (`command` + `args` [+ `env`]) or to a streamable
 * HTTP server (`url` [+ `bearer_token_env_var`]); the SDK flattens whichever set
 * is present into `--config mcp_servers.<name>.*` overrides for the Codex CLI.
 * callboard's own tool bundles always use the stdio form (the relay shim); the
 * HTTP form is only emitted when bridging a user-configured external HTTP/SSE MCP
 * server (see {@link collectCodexMcpServers}).
 */
// A `type` (not `interface`) so it carries an implicit index signature and stays
// assignable to the Codex SDK's `CodexConfigObject` when nested under
// `config.mcp_servers`. Both transports' fields are optional on the one shape so
// the union stays index-signature-assignable; exactly one set is populated.
export type CodexMcpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  bearer_token_env_var?: string;
};

/**
 * The stdio specialization callboard's own bundles always use: the relay shim is
 * spawned, so `command` + `args` are guaranteed present (narrower than the
 * general {@link CodexMcpServerConfig}, which also covers the HTTP transport).
 */
export type CodexStdioServerConfig = CodexMcpServerConfig & { command: string; args: string[] };

/**
 * Opaque value returned by {@link buildCodexToolServer} and handed back from
 * `CodexAdapter.buildToolServer`. Carries the live socket-backed server plus the
 * lifecycle + config-emission surface the rest of the adapter consumes.
 */
export interface CodexToolServerHandle {
  readonly name: string;
  readonly version: string;
  /** Absolute path (POSIX) or pipe name (win32) the backend MCP server listens on. */
  readonly socketPath: string;
  /** The Codex `mcp_servers.<name>` entry pointing Codex at the shim → this socket. */
  toMcpServerConfig(): CodexStdioServerConfig;
  /** Stop listening and remove the socket + its temp dir. Idempotent. */
  close(): Promise<void>;
}

/** Structural marker — `optionsAdapter` uses this to pick our handles out of the
 *  loosely-typed `options.mcpServers` record (which may also carry other shapes). */
export function isCodexToolServerHandle(value: unknown): value is CodexToolServerHandle {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CodexToolServerHandle>;
  return (
    typeof v.socketPath === "string" &&
    typeof v.toMcpServerConfig === "function" &&
    typeof v.close === "function"
  );
}

/**
 * Register one neutral {@link AnyToolDefinition} on a high-level MCP server.
 *
 * callboard's `inputSchema` is already a Zod raw shape, which `registerTool`
 * accepts directly (it validates incoming args against it). The handler's
 * {@link ToolCallResult} content blocks (`text` / `image`) are structurally the
 * MCP content-block union, so the result passes through unchanged — only
 * `isError` needs forwarding.
 */
function registerSpecTool(server: McpServer, def: AnyToolDefinition): void {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.inputSchema },
    async (args: unknown) => {
      const result = await def.handler(args as never);
      return {
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}

/** Build a fresh MCP server instance wired to the spec's live handlers. One per
 *  socket connection — MCP servers own their transport 1:1. */
function createServerForSpec(spec: ToolServerSpec): McpServer {
  const server = new McpServer({ name: spec.name, version: spec.version });
  for (const def of spec.tools) registerSpecTool(server, def);
  return server;
}

/** Allocate a listen address: a Unix socket under a private temp dir (POSIX) or
 *  a named pipe (win32, which has no filesystem socket). */
function allocateSocketPath(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cb-codex-mcp-"));
  if (process.platform === "win32") {
    // Named pipes are not files; the temp dir only anchors a unique name.
    return { dir, socketPath: `\\\\.\\pipe\\${basename(dir)}` };
  }
  return { dir, socketPath: join(dir, "s.sock") };
}

/**
 * Stand up an in-process MCP server for `spec`, listening on a private socket,
 * and return a {@link CodexToolServerHandle}.
 *
 * Each inbound connection (one per shim Codex spawns for this server) gets its
 * own {@link McpServer} bound to a {@link StdioServerTransport} reading/writing
 * the socket — `net.Socket` is a duplex stream, so it satisfies the transport's
 * `(Readable, Writable)` shape. Connection-scoped errors are logged, never
 * thrown, so a flaky client can't crash the backend.
 */
export function buildCodexToolServer(spec: ToolServerSpec): CodexToolServerHandle {
  const { dir, socketPath } = allocateSocketPath();

  const netServer = net.createServer((socket) => {
    socket.on("error", (err) => {
      log.warn(`codex tool socket error (${spec.name}): ${err.message}`);
    });
    const server = createServerForSpec(spec);
    const transport = new StdioServerTransport(socket, socket);
    server.connect(transport).catch((err) => {
      log.error(`codex tool server connect failed (${spec.name}): ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    });
    socket.once("close", () => {
      void server.close().catch(() => {
        /* best-effort: the transport is already gone */
      });
    });
  });

  netServer.on("error", (err) => {
    log.error(`codex tool net server error (${spec.name}): ${err.message}`);
  });

  // listen() is async, but Codex spawns the shim only once the turn starts (well
  // after this synchronous call), and the shim retries its connect — so the
  // listen race is covered without awaiting here.
  netServer.listen(socketPath, () => {
    log.debug(`codex tool server listening for ${spec.name} (${spec.tools.length} tools) at ${socketPath}`);
  });

  let closed = false;
  return {
    name: spec.name,
    version: spec.version,
    socketPath,
    toMcpServerConfig: () => shimSpawnConfig(socketPath),
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        netServer.close(() => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            log.warn(`failed to remove codex tool socket dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
          }
          log.debug(`codex tool server closed for ${spec.name}`);
          resolve();
        });
      }),
  };
}

/**
 * Build the `{ command, args }` Codex uses to spawn the shim for `socketPath`.
 *
 * Resolves the shim next to this module so it follows the build: `toolAdapter.js`
 * → `mcp-server-shim.js` in `dist`, `toolAdapter.ts` → `mcp-server-shim.ts` under
 * tsx (dev / vitest). A `.ts` shim can't be run by bare `node`, so dev spawns it
 * through tsx's loader (`node --import tsx`); the compiled `.js` runs directly.
 *
 * Exported for unit-test access.
 */
export function shimSpawnConfig(socketPath: string): CodexStdioServerConfig {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts");
  const shimPath = join(dirname(here), `mcp-server-shim${isTs ? ".ts" : ".js"}`);
  const args = isTs ? ["--import", "tsx", shimPath, socketPath] : [shimPath, socketPath];
  return { command: process.execPath, args };
}
