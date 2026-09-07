/**
 * Contract test: every in-process MCP tool server must be able to answer
 * `tools/list`.
 *
 * This is the check that was missing when zod 4.5.3 shipped. `zod` is declared
 * as `^4.4.3`, so a fresh `npm i -g` resolved 4.5.3+, and from that version the
 * Claude Agent SDK's `tool()` helper can no longer convert a `z.record(...)`
 * shape: the server throws `MCP error -32603: Cannot read properties of
 * undefined (reading 'push')` the first time a client calls `tools/list`.
 *
 * The failure is silent in production and total. Registration succeeds, so
 * `buildToolServer` returns an object and callboard logs `Injected … MCP
 * server`; the SDK partitions it correctly into its in-process map; and then
 * the CLI asks for the tool list, gets an error, and exposes **zero** tools
 * from that server. Nothing in any log says so — the only symptom is an agent
 * that cannot see `mcp__callboard-tools__*`, `mcp__callboard__*` or
 * `mcp__mcp-proxy__*`. Stdio servers are unaffected (separate process, own
 * dependency tree), which is what makes the breakage look selective and
 * mysterious rather than like a dependency problem.
 *
 * Unit-testing the specs cannot catch this: every one of these tools registers
 * fine and converts fine one at a time through `McpServer.registerTool`. The
 * bug only appears through the *SDK's* `tool()` path, on a real `tools/list`
 * round trip. So that round trip is what this asserts.
 *
 * If this fails after a dependency bump, do not weaken the assertion — find
 * the schema construct the new version cannot serialise, or pin the dependency
 * back. See the `zod` range in package.json.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeCodeToolServer } from "../agents/adapters/claude-code/toolAdapter.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
// `callboard-tools` and `claude` are mutually recursive at module scope
// (callboard-tools -> claude -> setCallboardMessageSender). Importing
// callboard-tools first hits the TDZ and throws `Cannot access '_sendMessage'
// before initialization`. Production always enters through claude.ts, so enter
// the cycle from the same side here rather than reordering the modules.
import "./claude.js";
import { buildProxyToolsSpec } from "./proxy-tools.js";
import { buildAgentToolsSpec } from "./agent-tools.js";
import { buildComputerUseToolsSpec } from "./computer-use-tools.js";
import { buildObjectiveToolsSpec } from "./objective-tools.js";
import { buildJobStepToolsSpec } from "./job-step-tools.js";
import { buildCallboardToolsSpec } from "./callboard-tools.js";

/** Build the server the way `services/claude.ts` does, then do one real `tools/list`. */
async function listToolsOver(spec: ToolServerSpec): Promise<string[]> {
  const built = buildClaudeCodeToolServer(spec) as { instance: { connect(t: unknown): Promise<void> } };
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

const SERVERS: Array<[string, () => ToolServerSpec]> = [
  ["mcp-proxy", () => buildProxyToolsSpec("default")],
  ["callboard (agent tools)", () => buildAgentToolsSpec("test-agent", () => "chat-1")],
  ["computer_use", () => buildComputerUseToolsSpec(() => "chat-1")],
  ["objective-tools", () => buildObjectiveToolsSpec(() => "chat-1")],
  ["job-tools", () => buildJobStepToolsSpec(() => undefined)],
  ["callboard-tools", () => buildCallboardToolsSpec(() => "chat-1", () => undefined)],
];

describe("in-process MCP tool servers answer tools/list", () => {
  for (const [label, build] of SERVERS) {
    it(`${label} lists every tool it registered`, async () => {
      const spec = build();
      expect(spec.tools.length).toBeGreaterThan(0);

      const listed = await listToolsOver(spec);

      // Every registered tool must survive schema serialisation. A single
      // unserialisable schema takes down the whole server, not just its own
      // tool, so an exact set comparison is the right assertion.
      expect([...listed].sort()).toEqual([...spec.tools.map((t) => t.name)].sort());
    });
  }
});

describe("the schema constructs those servers rely on", () => {
  // Narrower guards, so a future dependency bump names the broken construct
  // instead of just failing a 35-tool server with no clue why.
  const CONSTRUCTS: Array<[string, z.ZodRawShape]> = [
    ["z.record(string, string)", { headers: z.record(z.string(), z.string()).optional().describe("h") }],
    ["z.record(string, unknown)", { params: z.record(z.string(), z.unknown()).describe("p") }],
    ["z.enum", { method: z.enum(["GET", "POST"]).describe("m") }],
    ["z.array(z.object)", { items: z.array(z.object({ path: z.string() })).optional().describe("i") }],
    ["deep optional/nullable", { x: z.string().optional().nullable().describe("x") }],
  ];

  for (const [label, shape] of CONSTRUCTS) {
    it(`${label} survives tools/list through the SDK's tool() helper`, async () => {
      const server = createSdkMcpServer({
        name: "construct-probe",
        version: "1.0.0",
        tools: [tool("probe", "probe", shape, async () => ({ content: [{ type: "text", text: "ok" }] }))],
      }) as { instance: { connect(t: unknown): Promise<void> } };

      const client = new Client({ name: "contract-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["probe"]);
      } finally {
        await client.close();
      }
    });
  }
});
