import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

const queries = vi.hoisted(() => [] as { kind: string; req: any }[]);
const deleted = vi.hoisted(() => [] as string[]);
const script = vi.hoisted(() => ({ events: [] as any[] }));

vi.mock("../agents/factory.js", () => ({
  getAgentProvider: (kind: string) => ({
    query: (req: any) => {
      queries.push({ kind, req });
      return (async function* () {
        for (const e of script.events) yield e;
      })();
    },
  }),
  getSessionProvider: () => ({ deleteSessionFiles: (id: string) => deleted.push(id) }),
}));
vi.mock("./agent-settings.js", () => ({
  getAgentSettings: () => ({}),
  getApiEnvOverrides: () => ({}),
  resolveModelAlias: (v: string) => (v === "planner" ? "claude-opus-5" : v),
}));
const route = vi.hoisted(() => ({ value: { route: "codex", injectedOpenRouter: false, mcpServerNames: ["github"] } as any }));
vi.mock("./codex-execution-route.js", () => ({ resolveCodexExecutionRoute: async () => route.value }));
vi.mock("./claude-binary.js", () => ({ getClaudeCodeExecutablePath: async () => undefined }));
vi.mock("./provider-session-options.js", () => ({
  buildCodexExtras: async (ctx: any) => ({ model: ctx.chatModel, permissions: ctx.getDefaultPermissions(), sandboxMode: "danger-full-access" }),
  buildClineExtras: async () => ({ maxIterations: 50 }),
  buildPiExtras: async () => ({}),
}));

const { runChatModelCompletion, ChatModelCompletionError } = await import("./chat-model-completion.js");

afterEach(() => {
  queries.length = 0;
  deleted.length = 0;
  script.events = [];
});

describe("runChatModelCompletion", () => {
  it("runs Claude Code with no tools, no persistence and the chat's resolved model", async () => {
    script.events = [
      { type: "text", content: "part one" },
      { type: "text", content: "part two" },
      { type: "result", status: "success" },
    ];
    const text = await runChatModelCompletion({ provider: "claude-code", model: "planner", prompt: "summarise", systemPrompt: "You summarise." });
    expect(text).toBe("part one\n\npart two");
    const { kind, req } = queries[0]!;
    expect(kind).toBe("claude-code");
    expect(req.prompt).toBe("summarise");
    expect(req.options).toMatchObject({
      model: "claude-opus-5",
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      systemPrompt: "You summarise.",
    });
    expect(await req.options.canUseTool()).toMatchObject({ behavior: "deny" });
    // The throwaway cwd is gone afterwards.
    expect(existsSync(req.options.cwd)).toBe(false);
  });

  it("runs Codex with deny-all permissions and deletes the session it persisted", async () => {
    script.events = [
      { type: "session_started", sessionId: "rollout-1" },
      { type: "text", content: "summary" },
    ];
    await runChatModelCompletion({ provider: "codex", model: "gpt-5.5", prompt: "p" });
    const codex = queries[0]!.req.options.codex;
    expect(codex).toMatchObject({ model: "gpt-5.5", permissions: { fileRead: "deny", codeExecution: "deny" }, lockdown: { mcpServerNames: ["github"] } });
    // A global sandbox setting never reaches the tool-less run.
    expect(codex).not.toHaveProperty("sandboxMode");
    expect(deleted).toEqual(["rollout-1"]);
  });

  it("refuses a Codex run whose MCP servers it cannot enumerate", async () => {
    route.value = { route: "unknown", injectedOpenRouter: false };
    await expect(runChatModelCompletion({ provider: "codex", prompt: "p" })).rejects.toThrow(/MCP servers/);
    expect(queries).toHaveLength(0);
    route.value = { route: "codex", injectedOpenRouter: false, mcpServerNames: ["github"] };
  });

  it("caps Cline's iterations and replaces its system prompt", async () => {
    script.events = [{ type: "text", content: "s" }];
    await runChatModelCompletion({ provider: "cline", prompt: "p", systemPrompt: "You summarise." });
    expect(queries[0]!.req.options.cline).toMatchObject({ maxIterations: 3, systemPrompt: "You summarise." });
  });

  it("fails with the provider's reason when no text comes back", async () => {
    script.events = [{ type: "result", status: "error", reason: "invalid model" }];
    await expect(runChatModelCompletion({ provider: "pi", prompt: "p" })).rejects.toThrow(/invalid model/);
  });

  it("refuses ACP", async () => {
    await expect(runChatModelCompletion({ provider: "acp", prompt: "p" })).rejects.toBeInstanceOf(ChatModelCompletionError);
  });
});
