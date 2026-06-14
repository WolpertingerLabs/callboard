/**
 * Tests for the Codex tool bridge — the callboard {@link ToolServerSpec} →
 * in-process socket-hosted MCP server, reached by Codex through the relay shim.
 *
 * The headline test is `live connectivity`: it spawns the real shim as a
 * subprocess and connects to it with an MCP {@link Client} (standing in for
 * Codex, which is itself an MCP client), then calls a tool and asserts the live
 * in-process handler ran and its result round-tripped back over stdio. That is
 * the one place this slice exercises real stdio end-to-end — the connectivity
 * proof the tool-bridge step gates on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AnyToolDefinition, ToolDefinition, ToolServerSpec } from "../../ports/tools.js";
import {
  buildCodexToolServer,
  isCodexToolServerHandle,
  shimSpawnConfig,
  type CodexToolServerHandle,
} from "./toolAdapter.js";

// Track handles opened in a test so afterEach always tears down their sockets,
// even when an assertion throws mid-test.
const openHandles: CodexToolServerHandle[] = [];
function track(handle: CodexToolServerHandle): CodexToolServerHandle {
  openHandles.push(handle);
  return handle;
}
afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((h) => h.close()));
});

function specWith(...tools: AnyToolDefinition[]): ToolServerSpec {
  // The type-erased AnyToolDefinition is exactly what ToolServerSpec.tools holds
  // (function-parameter variance — see ports/tools.ts), so narrow defs pass in.
  return { name: "callboard-tools", version: "1.2.3", tools };
}

describe("shimSpawnConfig", () => {
  it("spawns node and points at the shim + socket path", () => {
    const cfg = shimSpawnConfig("/tmp/x/s.sock");
    expect(cfg.command).toBe(process.execPath);
    // Last arg is always the socket path; the shim file precedes it.
    expect(cfg.args[cfg.args.length - 1]).toBe("/tmp/x/s.sock");
    expect(cfg.args.some((a) => a.includes("mcp-server-shim"))).toBe(true);
  });

  it("runs a .ts shim through the tsx loader (dev/test), a .js shim directly", () => {
    const cfg = shimSpawnConfig("/tmp/x/s.sock");
    const shimArg = cfg.args.find((a) => a.includes("mcp-server-shim"))!;
    if (shimArg.endsWith(".ts")) {
      expect(cfg.args.slice(0, 2)).toEqual(["--import", "tsx"]);
    } else {
      expect(shimArg.endsWith(".js")).toBe(true);
      expect(cfg.args[0]).toBe(shimArg);
    }
  });
});

describe("isCodexToolServerHandle", () => {
  it("recognizes a real handle", () => {
    const handle = track(buildCodexToolServer(specWith()));
    expect(isCodexToolServerHandle(handle)).toBe(true);
  });

  it("rejects foreign shapes (e.g. a Claude/OR server object)", () => {
    expect(isCodexToolServerHandle({ name: "x", tools: [] })).toBe(false);
    expect(isCodexToolServerHandle(null)).toBe(false);
    expect(isCodexToolServerHandle("nope")).toBe(false);
    expect(isCodexToolServerHandle({ socketPath: "/tmp/s", toMcpServerConfig: 1, close: 2 })).toBe(false);
  });
});

describe("buildCodexToolServer", () => {
  it("returns a handle carrying the spec name/version and a socket path", () => {
    const handle = track(buildCodexToolServer(specWith()));
    expect(handle.name).toBe("callboard-tools");
    expect(handle.version).toBe("1.2.3");
    expect(typeof handle.socketPath).toBe("string");
    expect(handle.socketPath.length).toBeGreaterThan(0);
  });

  it("emits a Codex mcp_servers config pointing the shim at its own socket", () => {
    const handle = track(buildCodexToolServer(specWith()));
    const cfg = handle.toMcpServerConfig();
    expect(cfg.command).toBe(process.execPath);
    expect(cfg.args[cfg.args.length - 1]).toBe(handle.socketPath);
  });

  it("close() is idempotent", async () => {
    const handle = buildCodexToolServer(specWith());
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

describe("live connectivity (Codex ⇄ shim ⇄ in-process server over stdio)", () => {
  // A spec whose handler observably runs in THIS process — the call asserts the
  // backend-hosted handler executed, not a child rebuild.
  let handlerCalls: Array<{ name: string }> = [];

  const echoTool: ToolDefinition<{ name: z.ZodString }> = {
    name: "echo",
    description: "Echo a greeting",
    inputSchema: { name: z.string() },
    handler: async ({ name }) => {
      handlerCalls.push({ name });
      return { content: [{ type: "text", text: `hello ${name}` }] };
    },
  };

  const boomTool: ToolDefinition<Record<string, never>> = {
    name: "boom",
    description: "Always errors",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }),
  };

  async function connectClient(handle: CodexToolServerHandle): Promise<Client> {
    const { command, args } = handle.toMcpServerConfig();
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: "codex-test-client", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  it("round-trips a real tool call: client → shim → live handler → back", async () => {
    handlerCalls = [];
    const handle = track(buildCodexToolServer(specWith(echoTool, boomTool)));
    const client = await connectClient(handle);
    try {
      // The shim served the spec — both tools are visible to the client.
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);

      // The actual round-trip: the call must execute the in-process handler.
      const result = await client.callTool({ name: "echo", arguments: { name: "codex" } });
      expect(handlerCalls).toEqual([{ name: "codex" }]);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toEqual({ type: "text", text: "hello codex" });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("surfaces a handler isError result as an MCP tool error", async () => {
    const handle = track(buildCodexToolServer(specWith(echoTool, boomTool)));
    const client = await connectClient(handle);
    try {
      const result = await client.callTool({ name: "boom", arguments: {} });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toBe("kaboom");
    } finally {
      await client.close();
    }
  }, 20_000);
});
