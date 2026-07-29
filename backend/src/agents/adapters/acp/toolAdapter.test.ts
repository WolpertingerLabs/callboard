/**
 * Tool-bridge tests, including the `anyOf` question the plan asked us to settle.
 *
 * ## Background: why `anyOf` is worth a dedicated test
 *
 * OpenRouter silently drops **all** server tools when any function-tool schema
 * contains `anyOf` — a real incident in this codebase, and the kind of failure
 * that is invisible until an agent inexplicably stops using its tools. The plan
 * asked whether ACP tool registration has an equivalent sensitivity.
 *
 * The test below answers it with evidence rather than reasoning: it registers a
 * bundle containing a tool whose Zod schema unavoidably compiles to `anyOf`
 * (a union member), hands the bundle to a **real ACP agent process**, and has
 * that agent perform a real MCP `tools/list` through the relay shim and report
 * what it received. If ACP registration had OpenRouter's behaviour, the agent
 * would come back with a short list or none at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AcpAdapter } from "./AcpAdapter.js";
import { ACP_SESSIONS_DIRNAME } from "./transcript.js";
import { acpStdioServer, buildAcpToolServer, collectAcpToolServers, isAcpToolServerHandle } from "./toolAdapter.js";
import { defineTool, type ToolServerSpec } from "../../ports/tools.js";
import { acpTestAgentPreset } from "./__fixtures__/testAgent.js";
import type { AgentEvent } from "../../ports/events.js";

const TEST_TIMEOUT = 45_000;

// The anyOf probe below opens a real ACP session, and a real session gets a real
// transcript. Point the callboard-owned transcript root at a scratch dir — same
// as `AcpAdapter.e2e.test.ts` — or the fake agent's session is discovered as a
// chat in the developer's own sidebar.
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.CALLBOARD_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cb-acp-tools-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CALLBOARD_DATA_DIR;
  else process.env.CALLBOARD_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A bundle with three tools, one of which has a union-typed argument.
 *
 * `z.union([z.string(), z.number()])` is the canonical shape that produces
 * `"anyOf"` in the emitted JSON Schema — that is what makes this a real probe
 * and not a tool that merely happens to be named after one.
 */
function buildSpec(): ToolServerSpec {
  return {
    name: "acp-test-tools",
    version: "1.0.0",
    tools: [
      defineTool("echo", "Echo a value back", { value: z.string() }, async (args) => ({ content: [{ type: "text", text: `echo:${args.value}` }] })),
      defineTool(
        "any_of_tool",
        "A tool whose input schema contains anyOf",
        { flexible: z.union([z.string(), z.number()]), tagged: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      ),
      defineTool("plain", "A plain tool", { n: z.number() }, async () => ({ content: [{ type: "text", text: "plain" }] })),
    ],
  };
}

describe("ACP tool server handle", () => {
  it("produces a stdio McpServer descriptor pointing at the relay shim", async () => {
    const handle = buildAcpToolServer(buildSpec());
    try {
      const descriptor = handle.toAcpMcpServer();
      expect(descriptor.name).toBe("acp-test-tools");
      expect(descriptor.command).toBe(process.execPath);
      expect(descriptor.args.at(-1)).toBe(handle.socketPath);
      expect(descriptor.args.join(" ")).toContain("mcp-server-shim");
      // ACP types `env` as required; an empty list means "inherit".
      expect(descriptor.env).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("is recognized structurally and picked out of a mixed mcpServers record", async () => {
    const handle = buildAcpToolServer(buildSpec());
    try {
      expect(isAcpToolServerHandle(handle)).toBe(true);
      expect(isAcpToolServerHandle({ socketPath: "/tmp/x" })).toBe(false);
      expect(isAcpToolServerHandle(null)).toBe(false);

      // Other providers' shapes share the record and must not be coerced.
      const collected = collectAcpToolServers({
        ours: handle,
        claudeInProcess: { name: "claude-bundle", server: {} },
        externalHttp: { url: "https://example.test/mcp" },
      });
      expect(collected).toEqual([handle]);
    } finally {
      await handle.close();
    }
  });

  it("close() is idempotent", async () => {
    const handle = buildAcpToolServer(buildSpec());
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("resolves the shim next to this module so it follows the build", () => {
    const descriptor = acpStdioServer("n", "/tmp/s.sock");
    // Under vitest this module is .ts, so the shim must be launched via tsx.
    expect(descriptor.args).toContain("--import");
    expect(descriptor.args).toContain("tsx");
  });
});

describe("anyOf in tool schemas (the OpenRouter failure mode)", () => {
  it(
    "registers every tool with a real ACP agent, including one whose schema contains anyOf",
    async () => {
      const handle = buildAcpToolServer(buildSpec());
      const adapter = new AcpAdapter("test-double");

      const query = adapter.query({
        prompt: "list your tools",
        options: {
          cwd: process.cwd(),
          // Exactly how services/claude.ts passes tool servers to a provider.
          mcpServers: { "acp-test-tools": handle },
          acp: { preset: acpTestAgentPreset("mcp"), getPermissions: () => null },
        },
      });

      const events: AgentEvent[] = [];
      try {
        for await (const event of query) events.push(event);
      } finally {
        await query.close();
      }

      const reported = events
        .filter((e): e is AgentEvent & { type: "text" } => e.type === "text")
        .map((e) => e.content)
        .join("");

      // The agent connected to the shim and enumerated the bundle. All three
      // tools are present: ACP registration does NOT drop tools over `anyOf`.
      expect(reported).toContain("tools:any_of_tool,echo,plain");
      // The anyOf tool specifically survived, and its schema still carries the
      // anyOf on arrival — nothing flattened or rejected it in transit.
      expect(reported).toContain("anyOf:present");
      expect(reported).toContain("anyOfSchema:kept");
      // A real call round-trips through the shim to the in-process handler.
      expect(reported).toContain("echo:echo:ping");

      // The session this test opened was transcribed into the scratch dir. It
      // once landed in the developer's real ~/.callboard, where discovery turned
      // the fake agent into a permanent chat-list entry.
      expect(existsSync(join(dataDir, ACP_SESSIONS_DIRNAME, "test-double", "fake-session-1.jsonl"))).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
