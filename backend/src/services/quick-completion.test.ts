/**
 * Integration tests for quick-completion.ts driven through the MockAgentProvider.
 *
 * Proves the AgentEvent-based result extraction works end-to-end: the tool
 * handler that gets built, handed to the provider via buildToolServer, and
 * eventually invoked carries the text back correctly, and the `result` event's
 * usage/duration gets mapped into QuickCompletionResult.
 *
 * agent-settings is mocked so provider auto-resolution and the OpenRouter
 * config sourcing are deterministic, independent of the host's real
 * data/agent-settings.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAgentProviderForTesting } from "../agents/factory.js";
import { MockAgentProvider } from "../agents/adapters/mock/MockAgentProvider.js";
import type { AgentEvent } from "../agents/ports/events.js";

vi.mock("./agent-settings.js", () => ({
  getClaudeCodeExecutablePath: () => undefined,
  isOpenRouterConfigured: vi.fn(() => false),
  getAgentSettings: vi.fn(() => ({ proxyMode: "local" })),
}));

import { quickCompletion, generateChatTitle, generateBranchName } from "./quick-completion.js";
import { getAgentSettings, isOpenRouterConfigured } from "./agent-settings.js";

const mockIsOpenRouterConfigured = vi.mocked(isOpenRouterConfigured);
const mockGetAgentSettings = vi.mocked(getAgentSettings);

beforeEach(() => {
  mockIsOpenRouterConfigured.mockReturnValue(false);
  mockGetAgentSettings.mockReturnValue({ proxyMode: "local" });
});

afterEach(() => {
  setAgentProviderForTesting(null);
  vi.clearAllMocks();
});

/** Poll until the mock has captured at least one tool-server spec. */
async function waitForSpec(mock: MockAgentProvider, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (mock.toolSpecs.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("timed out waiting for buildToolServer to be called");
}

/**
 * Invoke the captured qc.return_result handler with the given text.
 *
 * Fidelity gap: this calls the tool handler DIRECTLY rather than dispatching a
 * tool_use stream event through the harness, so it does not exercise the
 * allowedTools / permission gate the real adapters apply before a tool runs.
 * Driving a gated tool_use event would be a larger MockAgentProvider change; the
 * gate itself is covered by the OR harness's own tool-filter tests, and these
 * tests focus on quick-completion's capture/routing logic above that seam.
 */
async function fireReturnResult(mock: MockAgentProvider, text: string): Promise<void> {
  await waitForSpec(mock);
  const spec = mock.toolSpecs.find((s) => s.name === "qc");
  if (!spec) throw new Error("qc tool-server spec not found");
  const returnResult = spec.tools.find((t) => t.name === "return_result");
  if (!returnResult) throw new Error("return_result tool not found in qc spec");
  await returnResult.handler({ result: text });
}

describe("quickCompletion — through MockAgentProvider", () => {
  it("returns the text captured by the return_result handler", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "Make me a title", model: "haiku" });
    await fireReturnResult(mock, "A Great Title");

    const result = await resultPromise;
    expect(result.text).toBe("A Great Title");
  });

  it("extracts usage + durationMs from a scripted result event", async () => {
    const script: AgentEvent[] = [
      { type: "text", content: "thinking..." },
      {
        type: "result",
        status: "success",
        usage: { inputTokens: 123, outputTokens: 45, costUsd: 0.00678 },
        durationMs: 2345,
      },
    ];
    const mock = new MockAgentProvider({ events: script });
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "anything", model: "haiku" });
    await fireReturnResult(mock, "captured");

    const result = await resultPromise;
    expect(result.text).toBe("captured");
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45, costUsd: 0.00678 });
    expect(result.durationMs).toBe(2345);
  });

  it("registers the qc MCP server with the provider", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku" });
    await fireReturnResult(mock, "x");
    await resultPromise;

    // Exactly one spec, named "qc", with one tool "return_result"
    expect(mock.toolSpecs).toHaveLength(1);
    expect(mock.toolSpecs[0].name).toBe("qc");
    expect(mock.toolSpecs[0].tools).toHaveLength(1);
    expect(mock.toolSpecs[0].tools[0].name).toBe("return_result");
  });

  it("calls query() with qc MCP server bound on mcpServers and allowedTools", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "y", model: "sonnet" });
    await fireReturnResult(mock, "y");
    await resultPromise;

    expect(mock.queryRecords).toHaveLength(1);
    const opts = mock.queryRecords[0].request.options as {
      mcpServers?: { qc?: unknown };
      allowedTools?: string[];
      model?: string;
      permissionMode?: string;
    };
    expect(opts.mcpServers?.qc).toBeTruthy();
    expect(opts.allowedTools).toContain("mcp__qc__return_result");
    expect(opts.model).toBe("sonnet");
    expect(opts.permissionMode).toBe("bypassPermissions");
  });

  it("defaults usage to zeros when the result event carries none", async () => {
    // Script: just a result event with no usage info
    const mock = new MockAgentProvider({ events: [{ type: "result", status: "success" }] });
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "z", model: "haiku" });
    await fireReturnResult(mock, "z");

    const result = await resultPromise;
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.durationMs).toBe(0);
  });

  it("forwards a permissive system prompt that allows a plain-text answer", async () => {
    // Pins the softened RETURN_RESULT_INSTRUCTION: the model is asked to use the
    // tool but explicitly PERMITTED to answer as text. The old wording forbade
    // plain text, which left us nothing to capture when an OR model declined the
    // forced tool call.
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "hi", model: "haiku" });
    await fireReturnResult(mock, "ok");
    await resultPromise;

    const opts = mock.queryRecords[0].request.options as { systemPrompt?: string };
    expect(opts.systemPrompt).toMatch(/write the answer directly/i);
    expect(opts.systemPrompt).not.toMatch(/Do NOT write your answer as plain text/i);
  });

  it("resolves with the captured text even when a trailing error result follows return_result", async () => {
    // Guards the documented OpenRouter quirk: after return_result fires, the OR
    // harness takes one more empty model turn and emits a stream_complete with
    // status "error". That arrives as an EVENT, not a throw — the completion
    // must still resolve with the already-captured text.
    const mock = new MockAgentProvider({
      events: [
        { type: "text", content: "partial" },
        {
          type: "result",
          status: "error",
          reason: "Invalid final response: empty or invalid output",
        },
      ],
    });
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "title", model: "haiku" });
    await fireReturnResult(mock, "Captured Title");

    await expect(resultPromise).resolves.toMatchObject({ text: "Captured Title" });
  });

  it("falls back to the assistant's text when return_result is never called", async () => {
    // No tool call — model answers directly via text events. The completion
    // should still resolve using the accumulated text rather than dying.
    const mock = new MockAgentProvider({
      events: [
        { type: "text", content: "Fallback " },
        { type: "text", content: "Title" },
        { type: "result", status: "success" },
      ],
    });
    setAgentProviderForTesting(mock);

    const result = await quickCompletion({ prompt: "no tool", model: "haiku" });
    expect(result.text).toBe("Fallback Title");
  });
});

describe("quickCompletion — provider auto-resolution", () => {
  it("routes to the openrouter provider and forwards OR config when configured", async () => {
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({
      proxyMode: "local",
      openRouterApiKey: "sk-or-test",
      openRouterBaseUrl: "https://example.test/api/v1",
      // Global chat default — must NOT leak into quick completions: the
      // caller's QuickModel ("haiku") wins so titles/branches stay on the
      // cheap tier instead of whatever (typically opus-class) model chats use.
      openRouterModel: "~anthropic/claude-opus-latest",
      openRouterMaxBudgetUsd: 2.5,
    });

    const mock = new MockAgentProvider();
    // Inject under the openrouter slot — auto-resolution should land here.
    setAgentProviderForTesting(mock, "openrouter");

    const resultPromise = quickCompletion({ prompt: "title please", model: "haiku", effort: "medium" });
    await fireReturnResult(mock, "OR Title");
    const result = await resultPromise;

    expect(result.text).toBe("OR Title");
    expect(mock.queryRecords).toHaveLength(1);
    const opts = mock.queryRecords[0].request.options as {
      openRouter?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        maxBudgetUsd?: number;
        effort?: string;
        appTitle?: string;
        bareToolset?: boolean;
      };
    };
    expect(opts.openRouter).toMatchObject({
      apiKey: "sk-or-test",
      baseUrl: "https://example.test/api/v1",
      model: "~anthropic/claude-haiku-latest",
      maxBudgetUsd: 2.5,
      effort: "medium",
      appTitle: "callboard",
      // The capture fix: quick completions must run with ONLY the return_result
      // tool, never OR's default file/bash toolset (which would make the model
      // edit files instead of answering). See OpenRouterOptionsExtras.bareToolset.
      bareToolset: true,
    });
  });

  it("maps each QuickModel tier to its OpenRouter alias", async () => {
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({
      proxyMode: "local",
      openRouterApiKey: "sk-or-test",
    });

    for (const [quick, orModel] of [
      ["haiku", "~anthropic/claude-haiku-latest"],
      ["sonnet", "~anthropic/claude-sonnet-latest"],
      ["opus", "~anthropic/claude-opus-latest"],
    ] as const) {
      const mock = new MockAgentProvider();
      setAgentProviderForTesting(mock, "openrouter");

      const resultPromise = quickCompletion({ prompt: "x", model: quick });
      await fireReturnResult(mock, "x");
      await resultPromise;

      const opts = mock.queryRecords[0].request.options as { openRouter?: { model?: string } };
      expect(opts.openRouter?.model).toBe(orModel);
    }
  });

  it("stays on claude-code (no openRouter config) when OR is not configured", async () => {
    mockIsOpenRouterConfigured.mockReturnValue(false);

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock); // claude-code slot

    const resultPromise = quickCompletion({ prompt: "title", model: "haiku" });
    await fireReturnResult(mock, "CC Title");
    await resultPromise;

    const opts = mock.queryRecords[0].request.options as { openRouter?: unknown };
    expect(opts.openRouter).toBeUndefined();
  });
});

describe("quickCompletion — harness routing (prefers the chat's provider)", () => {
  it("runs a claude-code chat on claude-code even when OpenRouter is configured", async () => {
    // OR is set up globally, but the chat's own harness is claude-code — the
    // title must follow the chat, not the global guess. (Pre-fix, an OR key
    // funneled EVERY chat's title through OpenRouter.)
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({
      proxyMode: "local",
      openRouterApiKey: "sk-or-test",
    });

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock); // claude-code slot

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku", provider: "claude-code" });
    await fireReturnResult(mock, "CC Title");
    const result = await resultPromise;

    expect(result.text).toBe("CC Title");
    // No OR config means it resolved to (and ran on) the claude-code provider.
    const opts = mock.queryRecords[0].request.options as { openRouter?: unknown };
    expect(opts.openRouter).toBeUndefined();
  });

  it("runs an openrouter chat on openrouter", async () => {
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({
      proxyMode: "local",
      openRouterApiKey: "sk-or-test",
    });

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock, "openrouter");

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku", provider: "openrouter" });
    await fireReturnResult(mock, "OR Title");
    const result = await resultPromise;

    expect(result.text).toBe("OR Title");
    const opts = mock.queryRecords[0].request.options as { openRouter?: { bareToolset?: boolean } };
    expect(opts.openRouter?.bareToolset).toBe(true);
  });

  it("falls back a codex chat to openrouter when OR is configured (codex can't do utility calls)", async () => {
    // Codex has no cheap/fast tier for a throwaway utility call, so a codex
    // chat borrows the best available utility provider — OR here.
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({
      proxyMode: "local",
      openRouterApiKey: "sk-or-test",
    });

    const mock = new MockAgentProvider();
    // Inject under openrouter — the codex preference must fall back to here, NOT
    // a codex slot (codex would never resolve for a quick completion).
    setAgentProviderForTesting(mock, "openrouter");

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku", provider: "codex" });
    await fireReturnResult(mock, "Codex→OR Title");
    const result = await resultPromise;

    expect(result.text).toBe("Codex→OR Title");
    const opts = mock.queryRecords[0].request.options as { openRouter?: { apiKey?: string } };
    expect(opts.openRouter?.apiKey).toBe("sk-or-test");
  });

  it("falls back a codex chat to claude-code when OR is not configured", async () => {
    mockIsOpenRouterConfigured.mockReturnValue(false);

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock); // claude-code slot

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku", provider: "codex" });
    await fireReturnResult(mock, "Codex→CC Title");
    const result = await resultPromise;

    expect(result.text).toBe("Codex→CC Title");
    // Never dead-ends on codex: it resolved to claude-code (no OR config).
    const opts = mock.queryRecords[0].request.options as { openRouter?: unknown };
    expect(opts.openRouter).toBeUndefined();
  });

  it("falls back an openrouter chat to claude-code when OR is NOT configured", async () => {
    // Covers the FALSE branch of canRunQuickCompletion("openrouter"): the chat
    // prefers openrouter, but with no API key it can't run a utility call, so it
    // falls back to the always-available claude-code rather than dead-ending.
    mockIsOpenRouterConfigured.mockReturnValue(false);

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock); // claude-code slot

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku", provider: "openrouter" });
    await fireReturnResult(mock, "OR→CC Title");
    const result = await resultPromise;

    expect(result.text).toBe("OR→CC Title");
    const opts = mock.queryRecords[0].request.options as { openRouter?: unknown };
    expect(opts.openRouter).toBeUndefined();
  });
});

describe("generateChatTitle / generateBranchName — public wrappers", () => {
  it("generateChatTitle trims whitespace from the captured title", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = generateChatTitle("Add dark mode to my app");
    await fireReturnResult(mock, "  Add Dark Mode  ");
    expect(await resultPromise).toBe("Add Dark Mode");
  });

  it("generateChatTitle returns null on an empty (whitespace-only) result", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = generateChatTitle("anything");
    await fireReturnResult(mock, "   ");
    expect(await resultPromise).toBeNull();
  });

  it("generateChatTitle returns null when the result exceeds 100 chars", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = generateChatTitle("anything");
    await fireReturnResult(mock, "x".repeat(101));
    expect(await resultPromise).toBeNull();
  });

  it("generateBranchName accepts a well-formed <type>/<kebab> name unchanged", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = generateBranchName("add a dark mode toggle");
    await fireReturnResult(mock, "feat/add-dark-mode-toggle");
    expect(await resultPromise).toBe("feat/add-dark-mode-toggle");
  });

  it("generateBranchName sanitizes invalid chars and collapses repeats", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    // Passes the structural <type>/<desc> check, then sanitization strips chars
    // outside [a-z0-9-/] (spaces, punctuation, uppercase) and collapses runs of
    // "-"/"/" — proving the regex pipeline at the tail of generateBranchName.
    const resultPromise = generateBranchName("fix the thing");
    await fireReturnResult(mock, "fix/Login  Redirect!!--loop");
    const branch = await resultPromise;

    expect(branch).not.toBeNull();
    expect(branch).toMatch(/^[a-z0-9/-]+$/); // only git-safe chars survive
    expect(branch).not.toMatch(/--/); // consecutive hyphens collapsed
    expect(branch!.startsWith("fix/")).toBe(true);
  });

  it("generateBranchName returns null when the structure is invalid (no <type>/ prefix)", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = generateBranchName("whatever");
    await fireReturnResult(mock, "just some free text");
    expect(await resultPromise).toBeNull();
  });

  it("generateBranchName returns null when the sanitized name exceeds 60 chars", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = generateBranchName("long one");
    await fireReturnResult(mock, "feat/" + "a".repeat(70));
    expect(await resultPromise).toBeNull();
  });

  it("forwards the provider to quickCompletion when supplied (claude-code over the OR default)", async () => {
    // OR is configured, so the global fallback would pick openrouter. Passing
    // provider="claude-code" must override that — proven by the absence of OR
    // config on the recorded query.
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({ proxyMode: "local", openRouterApiKey: "sk-or-test" });

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock, "claude-code");

    const resultPromise = generateChatTitle("hello", "claude-code");
    await fireReturnResult(mock, "Hello Title");
    expect(await resultPromise).toBe("Hello Title");

    const opts = mock.queryRecords[0].request.options as { openRouter?: unknown };
    expect(opts.openRouter).toBeUndefined();
  });

  it("omits the provider when not supplied → uses the global fallback (openrouter when configured)", async () => {
    mockIsOpenRouterConfigured.mockReturnValue(true);
    mockGetAgentSettings.mockReturnValue({ proxyMode: "local", openRouterApiKey: "sk-or-test" });

    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock, "openrouter");

    const resultPromise = generateBranchName("add dark mode");
    await fireReturnResult(mock, "feat/add-dark-mode");
    expect(await resultPromise).toBe("feat/add-dark-mode");

    // No provider passed → fell through to the OR default, so OR config is present.
    const opts = mock.queryRecords[0].request.options as { openRouter?: { apiKey?: string } };
    expect(opts.openRouter?.apiKey).toBe("sk-or-test");
  });
});
