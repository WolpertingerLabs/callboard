/**
 * Quick Completion Utility — Lightweight one-off completions via the Agent SDK.
 *
 * Provides a stripped-down wrapper around the Agent SDK's query() function
 * for simple, ephemeral completion tasks (titles, branch names, summaries, etc.)
 * with no Claude Code tools, no session persistence, and no permission prompts.
 *
 * Results are captured via an in-process MCP server with a `return_result` tool
 * that Claude calls to deliver its answer as structured data.
 *
 * @example
 *   const title = await generateChatTitle("Help me add dark mode to my React app");
 *   // => "Add Dark Mode to React App"
 *
 *   const branch = await generateBranchName("Fix the login redirect loop bug");
 *   // => "fix/login-redirect-loop"
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/custom-tools
 */
import { getAgentProvider } from "../agents/factory.js";
import type { AgentProviderKind } from "../agents/ports/AgentProvider.js";
import { defineTool } from "../agents/ports/tools.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import type { OpenRouterOptionsExtras } from "../agents/adapters/openrouter/optionsAdapter.js";
import { z } from "zod";
import { tmpdir } from "os";
import { createLogger } from "../utils/logger.js";
import { getAgentSettings, getClaudeCodeExecutablePath, isOpenRouterConfigured } from "./agent-settings.js";
import type { CustomTheme, ThemeVariables } from "shared/types/index.js";

const log = createLogger("quick-completion");

// ─── Types ───────────────────────────────────────────────────────────

export type QuickModel = "haiku" | "sonnet" | "opus";

export interface QuickCompletionOptions {
  /** The user prompt to send. */
  prompt: string;
  /** System prompt instructing how to respond. */
  systemPrompt?: string;
  /** Model to use. Auto-routes to latest version. Default: "haiku". */
  model?: QuickModel;
  /** Claude Code tools to make available alongside return_result. Default: [] (none). */
  tools?: string[];
  /** Effort level for reasoning. Default: "low". */
  effort?: "low" | "medium" | "high";
  /**
   * Agent provider to run on. When omitted, resolves automatically:
   * "openrouter" if an OpenRouter API key is configured, otherwise
   * "claude-code". Pass an explicit value to override the auto-resolution
   * (mainly for tests).
   */
  provider?: AgentProviderKind;
}

/**
 * Pick the provider for a quick completion. Mirrors the product decision that
 * quick completions follow whichever provider is configured globally rather
 * than a specific chat's provider: if OpenRouter is set up, use it; otherwise
 * fall back to the Claude Code SDK.
 */
function resolveQuickCompletionProvider(explicit?: AgentProviderKind): AgentProviderKind {
  if (explicit) return explicit;
  return isOpenRouterConfigured() ? "openrouter" : "claude-code";
}

/**
 * Build the `openRouter` config sub-object the OR adapter's optionsAdapter
 * requires, sourced from global agent settings. Throws when no API key is
 * configured — callers should only reach this when {@link isOpenRouterConfigured}
 * is true, but the explicit check keeps the failure mode legible.
 */
function buildOpenRouterExtras(effort: "low" | "medium" | "high"): OpenRouterOptionsExtras {
  const s = getAgentSettings();
  const apiKey = s.openRouterApiKey?.trim();
  if (!apiKey) {
    throw new Error("OpenRouter provider selected for quick completion but OPENROUTER_API_KEY is not configured in Settings → API.");
  }
  return {
    apiKey,
    ...(s.openRouterBaseUrl && { baseUrl: s.openRouterBaseUrl }),
    ...(s.openRouterModel && { model: s.openRouterModel }),
    ...(s.openRouterLogsRoot && { logsRoot: s.openRouterLogsRoot }),
    ...(typeof s.openRouterMaxBudgetUsd === "number" && Number.isFinite(s.openRouterMaxBudgetUsd) && { maxBudgetUsd: s.openRouterMaxBudgetUsd }),
    // quickCompletion's effort union ("low"|"medium"|"high") is a subset of the
    // OR EffortLevel union, so it forwards directly.
    effort,
    appTitle: "callboard",
  };
}

export interface QuickCompletionResult {
  /** The text result returned via the return_result MCP tool. */
  text: string;
  /** Token usage and cost. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

// ─── MCP Server Builder ──────────────────────────────────────────────

/**
 * Build a per-call tool-server spec with a single `return_result` tool.
 * The tool handler resolves the provided callback with the result text,
 * giving us a clean, structured answer channel. Translated to an
 * engine-specific server by the adapter.
 */
function buildReturnResultSpec(onResult: (text: string) => void): ToolServerSpec {
  return {
    name: "qc",
    version: "1.0.0",
    tools: [
      defineTool(
        "return_result",
        "Return your final answer. You MUST call this tool with your result.",
        {
          result: z.string().describe("Your complete answer — the final output text only, no extra commentary"),
        },
        async (args) => {
          onResult(args.result);
          return { content: [{ type: "text" as const, text: "Result received." }] };
        },
      ),
    ],
  };
}

// ─── Core Function ───────────────────────────────────────────────────

/** Suffix appended to every system prompt to ensure the model calls the tool. */
const RETURN_RESULT_INSTRUCTION = "\n\nIMPORTANT: You MUST call the `return_result` tool with your answer. Do NOT write your answer as plain text.";

/**
 * Run a single, ephemeral completion request via the Agent SDK.
 *
 * This is intentionally minimal: no session persistence, no Claude Code tools
 * (unless explicitly requested), no permission prompts, no filesystem settings.
 * The result is captured via a `return_result` MCP tool call.
 *
 * For interactive agent sessions, use claude.ts / sendMessage() instead.
 */
export async function quickCompletion(opts: QuickCompletionOptions): Promise<QuickCompletionResult> {
  const { prompt, systemPrompt, model = "haiku", tools = [], effort = "low" } = opts;

  const provider = resolveQuickCompletionProvider(opts.provider);
  const agentProvider = getAgentProvider(provider);
  const isOpenRouter = provider === "openrouter";

  log.debug(`quickCompletion — provider=${provider}, model=${model}, effort=${effort}, extraTools=[${tools.join(",")}]`);

  // Set up the result capture channel: a Promise resolved by the MCP tool handler
  let capturedResult: string | null = null;
  let resolveResult!: (text: string) => void;
  const resultReady = new Promise<string>((resolve) => {
    resolveResult = resolve;
  });
  const qcSpec = buildReturnResultSpec((text) => {
    capturedResult = text;
    resolveResult(text);
  });
  const mcpServer = agentProvider.buildToolServer(qcSpec);

  // Build the allowed tools list: always include return_result, plus any explicit CC tools
  const allowedTools = ["mcp__qc__return_result", ...tools];

  // Build the effective system prompt
  const effectiveSystemPrompt = (systemPrompt || "You are a helpful assistant.") + RETURN_RESULT_INSTRUCTION;

  // MCP servers require an async generator prompt (SDKUserMessage format)
  const promptGenerator = (async function* () {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: prompt },
      parent_tool_use_id: null,
      session_id: "",
    };
  })();

  // Extract usage/duration from the result message
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let durationMs = 0;

  // Fallback channel: accumulate the assistant's plain-text output so a
  // response that answers directly (without calling return_result) is still
  // usable. Models behind OpenRouter are less reliable at honoring a forced
  // tool call than Claude Code, so this keeps the completion from dying when
  // the answer arrives as text instead.
  let assistantText = "";

  try {
    const claudeExecutable = getClaudeCodeExecutablePath();

    const conversation = agentProvider.query({
      prompt: promptGenerator,
      options: {
        model,
        cwd: tmpdir(), // Explicit throwaway cwd — no tools use it, but avoids polluting the project directory
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        tools: [], // No built-in Claude Code tools
        allowedTools,
        mcpServers: { qc: mcpServer },
        maxTurns: 10,
        persistSession: false,
        settingSources: [],
        effort,
        systemPrompt: effectiveSystemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // OR-specific config the OpenRouter adapter's optionsAdapter requires.
        // Claude-code ignores this key, so it's safe to include only for OR.
        ...(isOpenRouter && { openRouter: buildOpenRouterExtras(effort) }),
        env: {
          ...process.env,
          // Prevent "cannot be launched inside another Claude Code session" errors
          CLAUDECODE: undefined,
        },
      },
    });

    // Drive the agent loop to completion; capture usage + duration from the
    // result event and accumulate text as the return_result fallback.
    for await (const event of conversation) {
      if (event.type === "text") {
        assistantText += event.content;
      } else if (event.type === "result") {
        if (event.usage) {
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            costUsd: event.usage.costUsd ?? 0,
          };
        }
        if (typeof event.durationMs === "number") durationMs = event.durationMs;
      }
    }

    // Prefer the structured return_result value. If the tool wasn't called,
    // fall back to the assistant's plain-text output. Only when there's
    // neither do we wait briefly for a late tool-handler resolution.
    let text: string | null | undefined = capturedResult;
    if (text === undefined || text === null) {
      const trimmed = assistantText.trim();
      text = trimmed ? trimmed : await Promise.race([resultReady, timeout(5000)]);
    }

    if (text === undefined || text === null) {
      throw new Error("Model did not call return_result tool and produced no text — no result captured");
    }

    log.debug(`quickCompletion — done in ${durationMs}ms, tokens=${usage.inputTokens}+${usage.outputTokens}, cost=$${usage.costUsd.toFixed(4)}`);

    return { text, usage, durationMs };
  } catch (err: any) {
    log.error(`quickCompletion failed: ${err.message}`);
    throw err;
  }
}

/** Promise that resolves to undefined after ms. Used as a race timeout. */
function timeout(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

// ─── Pre-Built Helpers ───────────────────────────────────────────────

/**
 * Generate a brief, descriptive title for a chat conversation
 * from the first user message.
 *
 * Uses Haiku for speed and cost-efficiency.
 * Returns null if generation fails (callers should fall back to a truncated message).
 */
export async function generateChatTitle(firstMessage: string): Promise<string | null> {
  try {
    const truncated = firstMessage.length > 500 ? firstMessage.slice(0, 500) + "..." : firstMessage;

    const result = await quickCompletion({
      prompt: truncated,
      systemPrompt:
        "Generate a brief title (3-8 words) for a conversation that starts with the user message below. " +
        "Return ONLY the title text — no quotes, no punctuation at the end, no prefix like 'Title:'.",
      model: "haiku",
      effort: "low",
    });

    const title = result.text.trim();
    if (!title || title.length > 100) return null;
    return title;
  } catch (err: any) {
    log.warn(`generateChatTitle failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate a git-safe branch name from a natural language request.
 *
 * Output format: <type>/<kebab-case-description>
 *   e.g., "feat/add-dark-mode-toggle", "fix/login-redirect-loop"
 *
 * Uses Haiku for speed. Returns null on failure.
 */
export async function generateBranchName(request: string): Promise<string | null> {
  try {
    const truncated = request.length > 500 ? request.slice(0, 500) + "..." : request;

    const result = await quickCompletion({
      prompt: truncated,
      systemPrompt:
        "Generate a git branch name for the request below. " +
        "Format: <type>/<kebab-case-description> where type is one of: feat, fix, refactor, docs, test, chore. " +
        "Rules: lowercase only, hyphens between words, no spaces, max 50 characters total. " +
        "Return ONLY the branch name, nothing else.",
      model: "haiku",
      effort: "low",
    });

    let branch = result.text.trim();

    // Validate basic structure
    if (!branch.match(/^(feat|fix|refactor|docs|test|chore)\/.+$/)) return null;

    // Ensure git-safe characters only
    branch = branch.replace(/[^a-z0-9\-/]/g, "");
    // Clean up consecutive hyphens or slashes
    branch = branch.replace(/--+/g, "-").replace(/\/\/+/g, "/");

    if (!branch || branch.length > 60) return null;

    return branch;
  } catch (err: any) {
    log.warn(`generateBranchName failed: ${err.message}`);
    return null;
  }
}

// ─── Theme variable names that must be provided ─────────────────────
const THEME_VARIABLE_NAMES = [
  "bg",
  "surface",
  "border",
  "text",
  "text-muted",
  "accent",
  "accent-hover",
  "user-bg",
  "assistant-bg",
  "code-bg",
  "danger",
  "error",
  "success",
  "warning",
  "bg-secondary",
  "text-secondary",
  "border-light",
  "text-on-accent",
  "text-on-danger",
  "accent-bg",
  "accent-light",
  "danger-bg",
  "danger-border",
  "warning-bg",
  "success-bg",
  "overlay-bg",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "diff-added-bg",
  "diff-added-border",
  "diff-added-text",
  "diff-added-line-bg",
  "diff-removed-bg",
  "diff-removed-border",
  "diff-removed-text",
  "diff-removed-line-bg",
  "diff-hunk-bg",
  "toggle-knob",
  "status-active",
  "status-triggered",
  "badge-info",
  "badge-info-bg",
  "badge-trigger",
  "badge-worktree",
  "badge-env-text",
  "badge-env-bg",
  "badge-env-border",
  "badge-sse-text",
  "badge-sse-bg",
  "builtin-user-bg",
  "builtin-user-border",
  "builtin-assistant-bg",
  "builtin-assistant-border",
  "builtin-text",
];

/**
 * Generate a complete custom theme via AI from a natural language description.
 *
 * Uses Sonnet for higher quality color design. The AI returns a JSON object
 * with dark and light mode CSS variable values.
 *
 * Returns null if generation fails.
 */
export async function generateThemeCSS(name: string, description: string): Promise<CustomTheme | null> {
  try {
    const variableList = THEME_VARIABLE_NAMES.map((v) => `"${v}"`).join(", ");

    const result = await quickCompletion({
      prompt: `Create a theme called "${name}" based on this description: ${description}`,
      systemPrompt:
        `You are a UI theme designer. Generate CSS variable values for a web application theme. ` +
        `The theme needs BOTH a dark mode and a light mode variant.\n\n` +
        `You must provide values for ALL of these CSS variables (without the -- prefix): ${variableList}\n\n` +
        `Rules:\n` +
        `- Use hex colors (#rrggbb), rgba(), or valid CSS values for shadows\n` +
        `- Dark mode: dark backgrounds, light text. Light mode: light backgrounds, dark text\n` +
        `- Ensure sufficient contrast for readability (WCAG AA minimum)\n` +
        `- text-on-accent and text-on-danger must be readable on accent/danger backgrounds\n` +
        `- shadow-sm/md/lg are full box-shadow values (e.g. "0 1px 3px rgba(0,0,0,0.2)")\n` +
        `- overlay-bg should be semi-transparent (e.g. "rgba(0,0,0,0.5)")\n` +
        `- *-bg variables (accent-bg, danger-bg, etc.) should be very subtle tints\n` +
        `- diff-added-* should be green-ish, diff-removed-* should be red-ish\n` +
        `- Make the theme cohesive and visually appealing\n\n` +
        `Return ONLY valid JSON in this exact format (no markdown, no code fences):\n` +
        `{"dark":{<variable-name>:<value>,...},"light":{<variable-name>:<value>,...}}`,
      model: "sonnet",
      effort: "medium",
    });

    const parsed = JSON.parse(result.text.trim());
    if (!parsed.dark || !parsed.light) {
      log.warn("generateThemeCSS: AI response missing dark or light keys");
      return null;
    }

    // Validate that at least the core variables are present
    const darkKeys = Object.keys(parsed.dark);
    const lightKeys = Object.keys(parsed.light);
    const requiredCore = ["bg", "surface", "text", "accent", "border"];
    for (const key of requiredCore) {
      if (!darkKeys.includes(key) || !lightKeys.includes(key)) {
        log.warn(`generateThemeCSS: Missing required variable "${key}"`);
        return null;
      }
    }

    const now = new Date().toISOString();
    return {
      name,
      dark: parsed.dark as ThemeVariables,
      light: parsed.light as ThemeVariables,
      createdAt: now,
      updatedAt: now,
    };
  } catch (err: any) {
    log.warn(`generateThemeCSS failed: ${err.message}`);
    return null;
  }
}
