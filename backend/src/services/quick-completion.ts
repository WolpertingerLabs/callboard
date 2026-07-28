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
import type { CustomTheme, ThemeVariables, ThemeContrastFailure } from "shared/types/index.js";
import { correctThemeContrast } from "./theme-contrast.js";
import type { Correction } from "./theme-contrast.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";

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
  /**
   * OpenRouter-only: an explicit OR slug/alias to run this completion on,
   * overriding the {@link QuickModel} → OR-slug mapping. Ignored on other
   * providers. Used by model routing's classifier call, which runs on a
   * user-configured classifier model rather than a fixed haiku/sonnet/opus tier.
   */
  openRouterModel?: string;
  /** Claude Code tools to make available alongside return_result. Default: [] (none). */
  tools?: string[];
  /** Effort level for reasoning. Default: "low". */
  effort?: "low" | "medium" | "high";
  /**
   * The chat's own agent provider (its "harness"). Quick completions PREFER to
   * run on the same provider as the chat they belong to — a claude-code chat
   * gets a claude-code title, an openrouter chat an openrouter title — so the
   * utility call honors the user's per-chat harness choice instead of a single
   * global guess.
   *
   * When omitted, or when the preferred provider can't service a cheap utility
   * call (codex) / isn't configured (openrouter with no API key), resolution
   * falls back to the best AVAILABLE utility provider. See
   * {@link resolveQuickCompletionProvider}. Tests pass this to pin a provider.
   */
  provider?: AgentProviderKind;
}

/**
 * Whether a provider can service a cheap, one-shot "haiku-tier" utility
 * completion (chat title, branch name, theme).
 *
 * - `claude-code` — always available; needs no extra configuration and is the
 *   universal fallback utility backend.
 * - `openrouter` — only when an API key is configured.
 * - `codex` — NO. Codex models are heavyweight reasoning agents with no
 *   cheap/fast tier appropriate for a throwaway utility call, so a codex chat
 *   always falls back to another provider for its title/branch generation.
 * - anything else (`mock`) — not a real utility backend.
 */
function canRunQuickCompletion(provider: AgentProviderKind): boolean {
  switch (provider) {
    case "claude-code":
      return true;
    case "openrouter":
      return isOpenRouterConfigured();
    case "codex":
    case "mock":
    default:
      return false;
  }
}

/**
 * Pick the provider for a quick completion.
 *
 * 1. PREFER the chat's own harness when it can run a utility completion — this
 *    is the structural fix: claude-code chat → claude-code, openrouter chat →
 *    openrouter. (Before, every quick completion was funneled through a single
 *    global guess that ignored the chat entirely.)
 * 2. Otherwise fall back to the best AVAILABLE utility provider so we never
 *    dead-end: OpenRouter if a key is configured (fast/cheap haiku tier), else
 *    the Claude Code SDK (always available). This is the codex path — codex
 *    can't do a cheap utility call, so its chats borrow whichever working
 *    provider is configured.
 */
function resolveQuickCompletionProvider(preferred?: AgentProviderKind): AgentProviderKind {
  if (preferred && canRunQuickCompletion(preferred)) return preferred;
  // Fallback chain — OpenRouter first (cheap haiku tier) when configured,
  // otherwise the always-available Claude Code SDK. Never returns codex.
  return isOpenRouterConfigured() ? "openrouter" : "claude-code";
}

/**
 * QuickModel → OpenRouter model translation. OR's adapter only reads the
 * model inside the `openRouter` extras sub-object (the top-level `model`
 * option is a Claude-SDK field it ignores), so without this mapping every
 * quick completion silently ran on the global `openRouterModel` default —
 * typically an opus-class model — instead of the cheap/fast tier the caller
 * asked for. The `~` names are OpenRouter's own dynamic aliases, resolved
 * server-side to the current model of each tier.
 */
const QUICK_MODEL_TO_OPENROUTER: Record<QuickModel, string> = {
  haiku: "~anthropic/claude-haiku-latest",
  sonnet: "~anthropic/claude-sonnet-latest",
  opus: "~anthropic/claude-opus-latest",
};

/**
 * Build the `openRouter` config sub-object the OR adapter's optionsAdapter
 * requires, sourced from global agent settings. The model comes from the
 * caller's {@link QuickModel} (via {@link QUICK_MODEL_TO_OPENROUTER}), NOT
 * the global `openRouterModel` chat default — quick completions are
 * ephemeral utility calls and should run on the tier the caller picked.
 * Throws when no API key is configured — callers should only reach this when
 * {@link isOpenRouterConfigured} is true, but the explicit check keeps the
 * failure mode legible.
 */
function buildOpenRouterExtras(
  model: QuickModel,
  effort: "low" | "medium" | "high",
  modelOverride?: string,
): OpenRouterOptionsExtras {
  const s = getAgentSettings();
  const apiKey = s.openRouterApiKey?.trim();
  if (!apiKey) {
    throw new Error("OpenRouter provider selected for quick completion but OPENROUTER_API_KEY is not configured in Settings → API.");
  }
  return {
    apiKey,
    ...(s.openRouterBaseUrl && { baseUrl: s.openRouterBaseUrl }),
    model: modelOverride?.trim() || QUICK_MODEL_TO_OPENROUTER[model],
    ...(s.openRouterLogsRoot && { logsRoot: s.openRouterLogsRoot }),
    ...(typeof s.openRouterMaxBudgetUsd === "number" && Number.isFinite(s.openRouterMaxBudgetUsd) && { maxBudgetUsd: s.openRouterMaxBudgetUsd }),
    // quickCompletion's effort union ("low"|"medium"|"high") is a subset of the
    // OR EffortLevel union, so it forwards directly.
    effort,
    appTitle: "callboard",
    // Expose ONLY the return_result tool — no default file/bash client tools,
    // no server tools. Without this the OR adapter arms the utility model with
    // the full coding toolset and it edits files instead of answering. This is
    // the primary capture fix; see OpenRouterOptionsExtras.bareToolset.
    bareToolset: true,
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

/**
 * Suffix appended to every system prompt. Asks for the structured channel
 * (return_result) but explicitly PERMITS a plain-text answer as a fallback —
 * some OpenRouter-routed models won't reliably honor a forced tool call, and
 * forbidding plain text would leave us with nothing to capture. The event loop
 * accepts whichever channel actually carries the answer.
 */
const RETURN_RESULT_INSTRUCTION =
  "\n\nWhen you have your answer, return it by calling the `return_result` tool. " +
  "If you are unable to call the tool, write the answer directly as your message — just the answer, nothing else.";

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

  // Build the allowed tools list: the MCP-prefixed return_result plus any
  // explicit CC tools. The `mcp__qc__return_result` spelling is required: the
  // OpenRouter harness eagerly validates allowedTools and THROWS on a bare,
  // non-MCP-prefixed name like "return_result" (it must contain "__"). On both
  // providers this prefixed entry is enough — Claude Code matches the tool by
  // this exact name, and under OR's bypassPermissions mode the gate auto-allows
  // the tool regardless (the rule name need not match the bare OR tool name).
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
        ...(isOpenRouter && { openRouter: buildOpenRouterExtras(model, effort, opts.openRouterModel) }),
        env: {
          ...process.env,
          // Prevent "cannot be launched inside another Claude Code session" errors
          CLAUDECODE: undefined,
        },
      },
    });

    // Drive the agent loop to completion; capture usage + duration from the
    // result event and accumulate text as the return_result fallback. We drain
    // fully rather than bailing as soon as the tool fires: the run self-
    // terminates after the one-shot answer (bareToolset means the only tool is
    // return_result), and draining keeps usage/duration from the terminal
    // result event intact.
    //
    // BENIGN-ERROR NOTE (OpenRouter): after the model calls return_result, the
    // OR harness takes one more (empty) model turn to produce a "final
    // response", which it logs as `stream_complete status=error — Invalid final
    // response: empty or invalid output`. That error arrives as an EVENT, not a
    // throw — the loop completes normally and `capturedResult` is already set,
    // so the title/branch is produced correctly despite the scary log line. We
    // deliberately do NOT abort the run on capture to silence it: aborting mid-
    // run leaves the harness's in-flight model call to reject in the background
    // as an UNHANDLED rejection (it can crash the process), which is far worse
    // than a handled log line.
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
 *
 * @param provider The chat's own harness, so the title is generated on the same
 *   provider as the chat (with fallback for codex / unconfigured providers).
 *   Omit to use the global fallback resolution.
 */
export async function generateChatTitle(
  firstMessage: string,
  provider?: AgentProviderKind,
): Promise<string | null> {
  try {
    const truncated = firstMessage.length > 500 ? firstMessage.slice(0, 500) + "..." : firstMessage;

    const result = await quickCompletion({
      prompt: truncated,
      systemPrompt:
        "Generate a brief title (3-8 words) for a conversation that starts with the user message below. " +
        "Return ONLY the title text — no quotes, no punctuation at the end, no prefix like 'Title:'.",
      model: "haiku",
      effort: "low",
      ...(provider && { provider }),
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
 *
 * @param provider The chat/request's own harness, so the branch name is
 *   generated on the same provider (with fallback for codex / unconfigured
 *   providers). Omit to use the global fallback resolution.
 */
export async function generateBranchName(
  request: string,
  provider?: AgentProviderKind,
): Promise<string | null> {
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
      ...(provider && { provider }),
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

/** How many times a theme may be regenerated before contrast failure is fatal. */
const THEME_GENERATION_ATTEMPTS = 2;

/**
 * Generate a complete custom theme via AI from a natural language description.
 *
 * Uses Sonnet for higher quality color design. The AI returns a JSON object
 * with dark and light mode CSS variable values.
 *
 * The result is measured against every pairing the UI actually paints and, where
 * a foreground is merely a little short, nudged into range before it is handed
 * back — a theme that has not been stored yet is not user data, so correcting it
 * here costs nobody anything. Where no legal value clears the pairing, the theme
 * is regenerated with the specific failures quoted back, and if that also fails,
 * rejected. Nothing sub-AA is returned silently.
 *
 * Returns null if generation fails.
 */
export async function generateThemeCSS(name: string, description: string): Promise<CustomTheme | null> {
  let feedback = "";
  for (let attempt = 1; attempt <= THEME_GENERATION_ATTEMPTS; attempt++) {
    const outcome = await generateThemeAttempt(name, description, feedback);
    if (!outcome) return null;
    if (outcome.unsatisfiable.length === 0) {
      if (outcome.corrections.length > 0) {
        log.info(
          `generateThemeCSS: corrected ${outcome.corrections.length} value(s) in "${name}" for contrast — ` +
            outcome.corrections.map((c) => `${c.mode} --${c.variable} ${c.from}→${c.to}`).join(", "),
        );
      }
      return outcome.theme;
    }

    const summary = outcome.unsatisfiable
      .map((f) =>
        f.unmeasurable
          ? `${f.mode} ${f.where}: ${f.unmeasurable} is not a colour this checker can read — use #rrggbb or rgba(), not a named colour`
          : `${f.mode} ${f.fg} on ${f.bg} over ${f.backdrop} (${f.where}) is ${f.ratio}, needs ${f.required}`,
      )
      .join("; ");
    log.warn(`generateThemeCSS: attempt ${attempt} for "${name}" left ${outcome.unsatisfiable.length} pairing(s) below AA — ${summary}`);

    if (attempt === THEME_GENERATION_ATTEMPTS) {
      log.warn(`generateThemeCSS: rejecting "${name}" rather than storing a theme that cannot be read`);
      return null;
    }
    feedback =
      `\n\nA previous attempt failed contrast validation on these pairings, which no adjustment of ` +
      `lightness alone could fix. Choose genuinely different values for the colours involved:\n${summary}\n`;
  }
  return null;
}

interface ThemeAttempt {
  theme: CustomTheme;
  corrections: Correction[];
  unsatisfiable: ThemeContrastFailure[];
}

async function generateThemeAttempt(name: string, description: string, feedback: string): Promise<ThemeAttempt | null> {
  try {
    const variableList = THEME_VARIABLE_NAMES.map((v) => `"${v}"`).join(", ");

    const result = await quickCompletion({
      prompt: `Create a theme called "${name}" based on this description: ${description}${feedback}`,
      systemPrompt:
        `You are a UI theme designer. Generate CSS variable values for a web application theme. ` +
        `The theme needs BOTH a dark mode and a light mode variant.\n\n` +
        `You must provide values for ALL of these CSS variables (without the -- prefix): ${variableList}\n\n` +
        `Rules:\n` +
        `- Use hex colors (#rrggbb), rgba(), or valid CSS values for shadows\n` +
        `- Dark mode: dark backgrounds, light text. Light mode: light backgrounds, dark text\n` +
        `- Contrast is checked mechanically after you answer, and a theme that cannot be ` +
        `brought up to standard is rejected. The rules, precisely:\n` +
        `  * Every "<name>" colour must reach 4.5:1 against its matching "<name>-bg" tint, ` +
        `once that tint is composited over the surface behind it. This applies to every such ` +
        `pair: warning/warning-bg, danger/danger-bg, success/success-bg, accent/accent-bg, ` +
        `badge-info/badge-info-bg, badge-info/info-bg, badge-env-text/badge-env-bg, ` +
        `badge-sse-text/badge-sse-bg, diff-added-text/diff-added-bg, diff-removed-text/diff-removed-bg.\n` +
        `  * Because the tints are only 8-15% opaque, the colour on top has to be much darker ` +
        `(light mode) or much lighter (dark mode) than the tint suggests. In light mode use the ` +
        `700-800 step of a ramp for these, not the 400-500 step.\n` +
        `  * text, text-muted and text-secondary must reach 4.5:1 on bg, bg-sidebar, bg-popout, ` +
        `surface and bg-secondary.\n` +
        `  * text-on-accent must reach 4.5:1 on accent, accent-hover, badge-worktree, ` +
        `badge-provider-codex-bg and status-active; text-on-danger must reach 4.5:1 on danger. ` +
        `Pick whichever of near-white or near-black clears all of them — do not default to white.\n` +
        `  * status-active, status-green and warning are painted as small dots on bg-sidebar and ` +
        `need 3:1 there; toggle-knob needs 3:1 on accent.\n` +
        `  * status-triggered and accent are each painted as text on a 15% tint of themselves ` +
        `over bg-sidebar, which is the hardest pairing in the UI — give them plenty of headroom.\n` +
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

    // Keep only names the theme is allowed to define. A model that helpfully
    // volunteers `chatlist-badge-triggered-bg` would pin a derived variable to a
    // flat value and cut it off from the primitive it is supposed to follow —
    // the same class of half-overridden feature this branch exists to close.
    const allowed = new Set(THEME_VARIABLE_NAMES);
    const keep = (vars: ThemeVariables): ThemeVariables => Object.fromEntries(Object.entries(vars).filter(([name]) => allowed.has(name)));
    const dropped = [...Object.keys(parsed.dark), ...Object.keys(parsed.light)].filter((name) => !allowed.has(name));
    if (dropped.length > 0) {
      log.info(`generateThemeCSS: dropped ${dropped.length} variable(s) outside the theme surface — ${[...new Set(dropped)].join(", ")}`);
    }

    const corrected = correctThemeContrast(keep(parsed.dark as ThemeVariables), keep(parsed.light as ThemeVariables));

    const now = new Date().toISOString();
    return {
      theme: {
        name,
        dark: corrected.dark,
        light: corrected.light,
        createdAt: now,
        updatedAt: now,
      },
      corrections: corrected.corrections,
      unsatisfiable: corrected.unsatisfiable,
    };
  } catch (err: any) {
    log.warn(`generateThemeCSS failed: ${err.message}`);
    return null;
  }
}
