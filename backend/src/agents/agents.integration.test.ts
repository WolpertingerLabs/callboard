/**
 * Integration tests that exercise callboard code paths through a non-Claude
 * {@link AgentProvider} (MockAgentProvider), proving the ports-and-adapters
 * seam introduced in the agent-abstraction-layer plan (Phases 1–3).
 *
 * If these tests fail, it means a caller is coupling to Claude-specific
 * details instead of the port — the exact kind of leak the abstraction exists
 * to prevent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { getAgentProvider, setAgentProviderForTesting } from "./factory.js";
import { MockAgentProvider } from "./adapters/mock/MockAgentProvider.js";
import type { AgentEvent } from "./ports/events.js";
import { decidePermission, ToolPermissionPolicy } from "./permissions/ToolPermissionPolicy.js";
import { defineTool } from "./ports/tools.js";

afterEach(() => {
  setAgentProviderForTesting(null);
});

describe("AgentProvider port — factory injection", () => {
  it("getAgentProvider returns the injected instance", () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);
    expect(getAgentProvider()).toBe(mock);
    expect(getAgentProvider().kind).toBe("mock");
  });

  it("resets to the default (ClaudeCodeAdapter) after passing null", () => {
    setAgentProviderForTesting(new MockAgentProvider());
    expect(getAgentProvider().kind).toBe("mock");
    setAgentProviderForTesting(null);
    expect(getAgentProvider().kind).toBe("claude-code");
  });
});

describe("AgentProvider port — event iteration", () => {
  it("iterates scripted AgentEvents end-to-end", async () => {
    const events: AgentEvent[] = [
      { type: "session_started", sessionId: "mock-session-1" },
      { type: "text", content: "hello" },
      { type: "tool_use", toolName: "Read", input: { path: "/tmp/x" }, callId: "t1" },
      { type: "tool_result", callId: "t1", content: "ok" },
      { type: "result", status: "success", usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.001 }, durationMs: 123 },
    ];
    const mock = new MockAgentProvider({ events });

    const collected: AgentEvent[] = [];
    const query = mock.query({ prompt: "hi", options: {} });
    for await (const event of query) {
      collected.push(event);
    }

    expect(collected).toEqual(events);
    expect(mock.queryRecords).toHaveLength(1);
    expect(mock.queryRecords[0].events).toEqual(events);
  });

  it("honours close() by short-circuiting iteration", async () => {
    const events: AgentEvent[] = [
      { type: "text", content: "a" },
      { type: "text", content: "b" },
      { type: "text", content: "c" },
    ];
    const mock = new MockAgentProvider({ events });
    const query = mock.query({ prompt: "", options: {} });

    const seen: string[] = [];
    for await (const event of query) {
      if (event.type === "text") seen.push(event.content);
      if (seen.length === 1) await query.close();
    }

    expect(seen).toEqual(["a"]);
    expect(mock.queryRecords[0].closed).toBe(true);
  });

  it("returns configured accountInfo / supportedModels without iteration", async () => {
    const mock = new MockAgentProvider({
      accountInfo: { email: "alice@example.com" },
      supportedModels: [{ value: "mock-small", displayName: "Mock Small", description: "fast" }],
    });
    const query = mock.query({ prompt: "", options: {} });
    await expect(query.accountInfo()).resolves.toEqual({ email: "alice@example.com" });
    await expect(query.supportedModels()).resolves.toEqual([{ value: "mock-small", displayName: "Mock Small", description: "fast" }]);
  });
});

describe("AgentProvider port — tool server translation", () => {
  it("buildToolServer accepts a ToolServerSpec with inferred handler args", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const spec = {
      name: "test-server",
      version: "1.0.0",
      tools: [
        defineTool(
          "echo",
          "echo the value back",
          {
            value: z.string().describe("text to echo"),
            loud: z.boolean().optional().describe("uppercase"),
          },
          async (args) => {
            // args.value is string; args.loud is boolean | undefined
            const text = args.loud ? args.value.toUpperCase() : args.value;
            return { content: [{ type: "text" as const, text }] };
          },
        ),
      ],
    };

    const server = getAgentProvider().buildToolServer(spec);
    expect(server).toBeTruthy();
    expect(mock.toolSpecs).toHaveLength(1);
    expect(mock.toolSpecs[0].name).toBe("test-server");
    expect(mock.toolSpecs[0].tools).toHaveLength(1);
    expect(mock.toolSpecs[0].tools[0].name).toBe("echo");

    // Tool handler is callable directly — exercise the spec to prove
    // nothing in the port requires the engine to be running.
    const result = await mock.toolSpecs[0].tools[0].handler({ value: "hi", loud: true });
    expect(result.content[0]).toEqual({ type: "text", text: "HI" });
  });
});

describe("ToolPermissionPolicy", () => {
  it("defaults to 'ask' when category or settings are missing", () => {
    expect(decidePermission(null, null)).toBe("ask");
    expect(decidePermission("fileRead", null)).toBe("ask");
    expect(decidePermission(null, { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" })).toBe("ask");
  });

  it("maps category policy → decision", () => {
    const perms = { fileRead: "allow", fileWrite: "deny", codeExecution: "ask", webAccess: "deny" } as const;
    expect(decidePermission("fileRead", perms)).toBe("allow");
    expect(decidePermission("fileWrite", perms)).toBe("deny");
    expect(decidePermission("codeExecution", perms)).toBe("ask");
    expect(decidePermission("webAccess", perms)).toBe("deny");
  });

  it("class form re-reads settings on every decide() (live policy changes)", () => {
    let current: "allow" | "deny" | "ask" = "allow";
    const categorize = (_: string) => "fileRead" as const;
    const getPerms = () => ({ fileRead: current, fileWrite: "ask", codeExecution: "ask", webAccess: "ask" }) as const;

    const policy = new ToolPermissionPolicy(categorize, getPerms);
    expect(policy.decide("Read").decision).toBe("allow");
    current = "deny";
    expect(policy.decide("Read").decision).toBe("deny");
  });

  it("null category from the adapter collapses to 'ask' regardless of settings", () => {
    const policy = new ToolPermissionPolicy(
      () => null,
      () => ({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" }),
    );
    expect(policy.decide("TodoWrite").decision).toBe("ask");
  });
});
