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
  CALLBOARD_TOOL_TIMEOUT_SEC,
  CODEX_TOOL_IDENTITY_NOTE,
  buildCodexToolServer,
  isCodexToolServerHandle,
  shimSpawnConfig,
  type CodexToolServerHandle,
} from "./toolAdapter.js";
import { HUMAN_APPROVAL_TIMEOUT_MS } from "../../../services/pending-requests.js";

/** The `wait` tool's ceiling (services/callboard-tools.ts: `z.number().min(1).max(300)`). */
const MAX_WAIT_SECONDS = 300;

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

  it("outlasts every callboard tool that parks on purpose, so codex never abandons a live call", () => {
    // Codex is an MCP client with its own per-call patience, and unset it uses
    // an internal default callboard does not control (`codex mcp list --json`
    // reports `tool_timeout_sec: null` for a server that omits it). The
    // computer-use confirmation is the one that must not lose this race: if
    // codex gave up while the prompt stayed open, a human confirming later
    // would run an action the harness had already moved past.
    expect(shimSpawnConfig("/tmp/x/s.sock").tool_timeout_sec).toBe(CALLBOARD_TOOL_TIMEOUT_SEC);
    expect(CALLBOARD_TOOL_TIMEOUT_SEC * 1000).toBeGreaterThan(HUMAN_APPROVAL_TIMEOUT_MS);
    expect(CALLBOARD_TOOL_TIMEOUT_SEC).toBeGreaterThan(MAX_WAIT_SECONDS);
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

// The relay's private Unix socket is forbidden in Codex's network-disabled
// sandbox. Unit coverage above still runs there; the real transport proof runs
// in normal development and CI environments.
describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1")("live connectivity (Codex ⇄ shim ⇄ in-process server over stdio)", () => {
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
      // Descriptions are the spec's own: the exec identity note is said once
      // per session (server `instructions` + the instructions file), not per tool.
      expect(listed.tools.map((t) => t.description).sort()).toEqual(["Always errors", "Echo a greeting"]);
      expect(client.getInstructions()).toBe(CODEX_TOOL_IDENTITY_NOTE);

      // The actual round-trip: the call must execute the in-process handler.
      const result = await client.callTool({ name: "echo", arguments: { name: "codex" } });
      expect(handlerCalls).toEqual([{ name: "codex" }]);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toEqual({ type: "text", text: "hello codex" });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("keeps a success-shaped UI failure non-renderable even when Codex discards isError in history", async () => {
    const payload = JSON.stringify({
      type: "render_file",
      url: "https://example.com/smoke.png",
      media_type: "image",
      mime_type: "image/png",
      display_mode: "inline",
      file_size: 0,
    });
    const handle = track(
      buildCodexToolServer(
        specWith({
          name: "render_file",
          description: "Test failed UI result",
          inputSchema: {},
          handler: async () => ({ isError: true, content: [{ type: "text", text: payload }] }),
        }),
      ),
    );
    const client = await connectClient(handle);
    try {
      expect(await client.callTool({ name: "render_file", arguments: {} })).toMatchObject({
        isError: true,
        content: [
          { type: "text", text: "Callboard UI tool failed." },
          { type: "text", text: payload },
        ],
      });
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
