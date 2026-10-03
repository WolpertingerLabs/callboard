/**
 * A callboard {@link ToolServerSpec} hosted as a live, in-process MCP server on
 * a private socket, for agents that are MCP *clients* (Codex, ACP agents) and
 * reach it over stdio through the {@link file://./mcp-server-shim.ts shim}.
 *
 * The provider adapters (`adapters/codex/toolAdapter.ts`,
 * `adapters/acp/toolAdapter.ts`) wrap the returned {@link SocketToolServer} in
 * their own handle type and emit their own config shape for the spawn command;
 * everything below — tool registration, socket allocation, the `net.Server`
 * lifecycle and the shim's location — is shared.
 *
 * Lifecycle: a server owns a listening `net.Server` and a temp dir holding the
 * socket. The adapter's query closes every handle it was given once the turn
 * ends (normal completion, abort, or error).
 *
 * @see ./mcp-server-shim.ts (the stdio frontend the agent actually spawns)
 */
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type winston from "winston";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnyToolDefinition, ToolServerSpec } from "../ports/tools.js";

export interface SocketToolServerOptions {
  /**
   * Short provider name (`"codex"`, `"acp"`). Prefixes log lines (`"<label> tool
   * server …"`) and the socket's temp dir (`cb-<label>-mcp-`).
   */
  label: string;
  log: winston.Logger;
  /** MCP server `instructions`, sent once per session in `initialize`. */
  instructions?: string;
  /**
   * Text block prepended to a failed call's content, or `undefined` for none.
   * Decided per tool, once, at registration.
   */
  errorPreamble?: (spec: ToolServerSpec, def: AnyToolDefinition) => string | undefined;
}

/** The provider-neutral half of a socket-backed tool server handle. */
export interface SocketToolServer {
  readonly name: string;
  readonly version: string;
  /** Absolute socket path (POSIX) or pipe name (win32) the backend listens on. */
  readonly socketPath: string;
  /** Stop listening and remove the socket + its temp dir. Idempotent. */
  close(): Promise<void>;
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
function registerSpecTool(server: McpServer, def: AnyToolDefinition, errorPreamble: string | undefined): void {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.inputSchema,
    },
    async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const result = await def.handler(args as never, { signal: extra.signal, toolCallId: String(extra.requestId) });
      return {
        content:
          result.isError && errorPreamble !== undefined ? [{ type: "text" as const, text: errorPreamble }, ...result.content] : result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}

/** Build a fresh MCP server instance wired to the spec's live handlers. One per
 *  socket connection — MCP servers own their transport 1:1. */
function createServerForSpec(spec: ToolServerSpec, opts: SocketToolServerOptions): McpServer {
  const server =
    opts.instructions === undefined
      ? new McpServer({ name: spec.name, version: spec.version })
      : new McpServer({ name: spec.name, version: spec.version }, { instructions: opts.instructions });
  for (const def of spec.tools) registerSpecTool(server, def, opts.errorPreamble?.(spec, def));
  return server;
}

/** Allocate a listen address: a Unix socket under a private temp dir (POSIX) or
 *  a named pipe (win32, which has no filesystem socket). */
function allocateSocketPath(label: string): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `cb-${label}-mcp-`));
  if (process.platform === "win32") {
    // Named pipes are not files; the temp dir only anchors a unique name.
    return { dir, socketPath: `\\\\.\\pipe\\${basename(dir)}` };
  }
  return { dir, socketPath: join(dir, "s.sock") };
}

/**
 * Stand up an in-process MCP server for `spec`, listening on a private socket.
 *
 * Each inbound connection (one per shim the agent spawns for this server) gets
 * its own {@link McpServer} bound to a {@link StdioServerTransport} reading/
 * writing the socket — `net.Socket` is a duplex stream, so it satisfies the
 * transport's `(Readable, Writable)` shape. Connection-scoped errors are logged,
 * never thrown, so a flaky client can't crash the backend.
 */
export function buildSocketToolServer(spec: ToolServerSpec, opts: SocketToolServerOptions): SocketToolServer {
  const { label, log } = opts;
  const { dir, socketPath } = allocateSocketPath(label);

  let closed = false;
  let closing: Promise<void> | undefined;
  const sockets = new Set<net.Socket>();
  const netServer = net.createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", (err) => {
      log.warn(`${label} tool socket error (${spec.name}): ${err.message}`);
    });
    const server = createServerForSpec(spec, opts);
    const transport = new StdioServerTransport(socket, socket);
    server.connect(transport).catch((err) => {
      log.error(`${label} tool server connect failed (${spec.name}): ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    });
    socket.once("close", () => {
      sockets.delete(socket);
      void server.close().catch(() => {
        /* best-effort: the transport is already gone */
      });
    });
  });

  netServer.on("error", (err) => {
    log.error(`${label} tool net server error (${spec.name}): ${err.message}`);
  });

  // listen() is async, but the agent spawns the shim only once the turn starts
  // (well after this synchronous call), and the shim retries its connect — so
  // the listen race is covered without awaiting here.
  netServer.listen(socketPath, () => {
    log.debug(`${label} tool server listening for ${spec.name} (${spec.tools.length} tools) at ${socketPath}`);
  });

  return {
    name: spec.name,
    version: spec.version,
    socketPath,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        // Only turn-local relays are owned here, never the persistent MCP service.
        // net.Server.close alone waits indefinitely for clients/pending calls.
        for (const socket of sockets) socket.destroy();
        netServer.close(() => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            log.warn(`failed to remove ${label} tool socket dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
          }
          log.debug(`${label} tool server closed for ${spec.name}`);
          resolve();
        });
      })),
  };
}

/**
 * The `{ command, args }` that spawns the shim for `socketPath`.
 *
 * Resolves the shim next to this module so it follows the build:
 * `socketToolServer.js` → `mcp-server-shim.js` in `dist`, `socketToolServer.ts` →
 * `mcp-server-shim.ts` under tsx (dev / vitest). A `.ts` shim can't be run by
 * bare `node`, so dev spawns it through tsx's loader (`node --import tsx`); the
 * compiled `.js` runs directly. The socket path is always the last argument.
 *
 * `shimLabel` is the shim's stderr prefix.
 */
export function shimSpawnCommand(socketPath: string, shimLabel: string): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts");
  const shimPath = join(dirname(here), `mcp-server-shim${isTs ? ".ts" : ".js"}`);
  const shimArgs = [shimPath, `--label=${shimLabel}`, socketPath];
  return { command: process.execPath, args: isTs ? ["--import", "tsx", ...shimArgs] : shimArgs };
}
