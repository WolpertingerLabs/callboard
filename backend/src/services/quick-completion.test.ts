/**
 * Integration tests for quick-completion.ts.
 *
 * Two backends, so two kinds of test. The Claude Code branch is driven through
 * the MockAgentProvider and proves the AgentEvent-based result extraction works
 * end-to-end: the tool handler that gets built, handed to the provider via
 * buildToolServer, and eventually invoked carries the text back correctly, and
 * the `result` event's usage/duration gets mapped into QuickCompletionResult.
 * The OpenRouter branch is driven through a mocked `fetch` — its own behavior is
 * covered in openrouter-completion.test.ts, so what matters here is only WHICH
 * backend a given settings state selects.
 *
 * agent-settings is mocked so backend selection is deterministic, independent of
 * the host's real data/agent-settings.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "shared";

import { setAgentProviderForTesting } from "../agents/factory.js";
import { MockAgentProvider } from "../agents/adapters/mock/MockAgentProvider.js";
import type { AgentEvent } from "../agents/ports/events.js";

vi.mock("./agent-settings.js", () => ({
  getClaudeCodeExecutablePath: () => undefined,
  getApiEnvOverrides: vi.fn(() => ({}) as Record<string, string>),
  getAgentSettings: vi.fn((): AgentSettings => ({ proxyMode: "local" })),
}));

import { quickCompletion, generateChatTitle, generateBranchName } from "./quick-completion.js";
import { getAgentSettings, getApiEnvOverrides } from "./agent-settings.js";

const mockGetAgentSettings = vi.mocked(getAgentSettings);
const mockGetApiEnvOverrides = vi.mocked(getApiEnvOverrides);

/** Settings with OpenRouter selected for utility completions. */
const orUtility = (extra?: Partial<AgentSettings>): AgentSettings => ({
  proxyMode: "local",
  openRouterApiKey: "sk-or-test",
  openRouterUtilityCompletions: true,
  ...extra,
});

/** Stub `fetch` with one successful chat-completions response. */
function stubOpenRouter(text: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 } }),
    text: async () => "",
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mockGetAgentSettings.mockReturnValue({ proxyMode: "local" });
  mockGetApiEnvOverrides.mockReturnValue({});
});

afterEach(() => {
  setAgentProviderForTesting(null);
  vi.unstubAllGlobals();
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

describe("quickCompletion — the Claude Code branch, through MockAgentProvider", () => {
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

  it("applies the user's API env overrides, as every other Agent-SDK call site does", async () => {
    // The bug this pins: quick completions used to spread only `process.env`, so
    // a user routing Claude Code through OpenRouter got that override on their
    // chats but not on their titles and branch names.
    mockGetApiEnvOverrides.mockReturnValue({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "sk-or-test" });
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "x", model: "haiku" });
    await fireReturnResult(mock, "x");
    await resultPromise;

    const opts = mock.queryRecords[0].request.options as { env?: Record<string, string | undefined> };
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test");
    // Still unset, or the SDK refuses to launch inside a Claude Code session.
    expect(opts.env?.CLAUDECODE).toBeUndefined();
  });

  it("forwards a permissive system prompt that allows a plain-text answer", async () => {
    // Pins the softened RETURN_RESULT_INSTRUCTION: the model is asked to use the
    // tool but explicitly PERMITTED to answer as text. The old wording forbade
    // plain text, which left us nothing to capture when a model reached through
    // a gateway declined the forced tool call.
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
    // A harness that takes one more empty model turn after return_result fires
    // reports it as a `result` EVENT with status "error", not a throw — the
    // completion must still resolve with the already-captured text.
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

describe("quickCompletion — backend selection", () => {
  it("runs on OpenRouter when the opt-in and a key are both present", async () => {
    mockGetAgentSettings.mockReturnValue(orUtility());
    const fetchMock = stubOpenRouter("OR Title");
    // Injected but never used: selecting OpenRouter means no agent runs at all.
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const result = await quickCompletion({ prompt: "title please", model: "haiku", effort: "medium" });

    expect(result.text).toBe("OR Title");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3, costUsd: 0.0001 });
    expect(mock.queryRecords).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The caller's tier wins, and the effort rides along.
    expect(body.model).toBe("~anthropic/claude-haiku-latest");
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("maps each QuickModel tier to its configured (or default) OpenRouter slug", async () => {
    mockGetAgentSettings.mockReturnValue(orUtility({ openRouterUtilitySonnetModel: "google/gemini-2.0-flash" }));

    for (const [tier, slug] of [
      ["haiku", "~anthropic/claude-haiku-latest"],
      ["sonnet", "google/gemini-2.0-flash"],
      ["opus", "~anthropic/claude-opus-latest"],
    ] as const) {
      const fetchMock = stubOpenRouter("x");
      await quickCompletion({ prompt: "x", model: tier });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(slug);
    }
  });

  it("stays on Claude Code when a key exists but the opt-in does not", async () => {
    // The regression this guards: an OpenRouter key saved for the ACP fallback
    // (or a routed native harness) must not silently start paying for titles.
    mockGetAgentSettings.mockReturnValue({ proxyMode: "local", openRouterApiKey: "sk-or-test" });
    const fetchMock = stubOpenRouter("never used");
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "title", model: "haiku" });
    await fireReturnResult(mock, "CC Title");

    await expect(resultPromise).resolves.toMatchObject({ text: "CC Title" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays on Claude Code when the opt-in is on but no key is configured", async () => {
    mockGetAgentSettings.mockReturnValue({ proxyMode: "local", openRouterUtilityCompletions: true });
    const fetchMock = stubOpenRouter("never used");
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "title", model: "haiku" });
    await fireReturnResult(mock, "CC Title");

    await expect(resultPromise).resolves.toMatchObject({ text: "CC Title" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays on Claude Code when OpenRouter is not configured at all", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const resultPromise = quickCompletion({ prompt: "title", model: "haiku" });
    await fireReturnResult(mock, "CC Title");

    await expect(resultPromise).resolves.toMatchObject({ text: "CC Title" });
    expect(mock.queryRecords).toHaveLength(1);
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

  it("works identically on the OpenRouter backend — the wrappers never see which ran", async () => {
    // The whole point of the shared result shape: the four helpers built on
    // quickCompletion were untouched by the re-plumbing.
    mockGetAgentSettings.mockReturnValue(orUtility());
    stubOpenRouter("  feat/add-dark-mode  ");
    expect(await generateBranchName("add dark mode")).toBe("feat/add-dark-mode");
  });

  it("returns null rather than throwing when the backend fails", async () => {
    mockGetAgentSettings.mockReturnValue(orUtility());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad key", json: async () => ({}) } as unknown as Response),
    );
    expect(await generateChatTitle("hello")).toBeNull();
  });
});
