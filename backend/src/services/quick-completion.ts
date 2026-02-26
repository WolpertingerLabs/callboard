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
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { tmpdir } from "os";
import { createLogger } from "../utils/logger.js";

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
 * Build a per-call in-process MCP server with a single `return_result` tool.
 * The tool handler resolves the provided callback with the result text,
 * giving us a clean, structured answer channel.
 */
function buildReturnResultServer(onResult: (text: string) => void) {
  return createSdkMcpServer({
    name: "qc",
    version: "1.0.0",
    tools: [
      tool(
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
  });
}

// ─── Core Function ───────────────────────────────────────────────────

/** Suffix appended to every system prompt to ensure the model calls the tool. */
const RETURN_RESULT_INSTRUCTION =
  "\n\nIMPORTANT: You MUST call the `return_result` tool with your answer. Do NOT write your answer as plain text.";

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

  log.debug(`quickCompletion — model=${model}, effort=${effort}, extraTools=[${tools.join(",")}]`);

  // Set up the result capture channel: a Promise resolved by the MCP tool handler
  let capturedResult: string | null = null;
  let resolveResult!: (text: string) => void;
  const resultReady = new Promise<string>((resolve) => {
    resolveResult = resolve;
  });
  const mcpServer = buildReturnResultServer((text) => {
    capturedResult = text;
    resolveResult(text);
  });

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

  try {
    const conversation = query({
      prompt: promptGenerator,
      options: {
        model,
        cwd: tmpdir(), // Explicit throwaway cwd — no tools use it, but avoids polluting the project directory
        tools: [], // No built-in Claude Code tools
        allowedTools,
        mcpServers: { qc: mcpServer },
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        effort,
        thinking: { type: "disabled" },
        systemPrompt: effectiveSystemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: {
          ...process.env,
          // Prevent "cannot be launched inside another Claude Code session" errors
          CLAUDECODE: undefined,
        },
      },
    });

    // Drive the SDK event loop to completion
    for await (const message of conversation) {
      // Capture usage/cost from the result message
      if ("type" in message && (message as any).type === "result") {
        const result = message as any;
        if (result.usage) {
          usage = {
            inputTokens: result.usage.input_tokens ?? 0,
            outputTokens: result.usage.output_tokens ?? 0,
            costUsd: result.total_cost_usd ?? 0,
          };
        }
        durationMs = result.duration_ms ?? 0;
      }
    }

    // If the tool was called, resultReady resolves immediately (already resolved).
    // If not (e.g. model responded with text instead), we need a fallback.
    // Use a short timeout to avoid hanging indefinitely.
    const text = capturedResult ?? (await Promise.race([resultReady, timeout(5000)]));

    if (text === undefined || text === null) {
      throw new Error("Model did not call return_result tool — no result captured");
    }

    log.debug(
      `quickCompletion — done in ${durationMs}ms, tokens=${usage.inputTokens}+${usage.outputTokens}, cost=$${usage.costUsd.toFixed(4)}`,
    );

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
