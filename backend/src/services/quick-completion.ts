/**
 * Quick Completion Utility — Lightweight one-off completions.
 *
 * Provides a stripped-down wrapper for simple, ephemeral completion tasks
 * (titles, branch names, themes) with no Claude Code tools, no session
 * persistence, and no permission prompts.
 *
 * Two backends, chosen by one setting:
 *  - **OpenRouter**, when the user opted in and a key exists — a single HTTP
 *    POST via {@link ./openrouter-completion.ts}, no agent involved.
 *  - **the Claude Code SDK** otherwise — always available, needs no
 *    configuration, and captures its answer via an in-process MCP server with a
 *    `return_result` tool.
 *
 * They differ only in which credential pays for the call, which is why there is
 * no longer a "run the title on the chat's own harness" preference: that was
 * meaningful while OpenRouter was itself a harness, and is dead weight now.
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
import { defineTool } from "../agents/ports/tools.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import { z } from "zod";
import { tmpdir } from "os";
import { createLogger } from "../utils/logger.js";
import { getApiEnvOverrides } from "./agent-settings.js";
import { getClaudeCodeExecutablePath } from "./claude-binary.js";
import { isOpenRouterUtilityCompletionEnabled, resolveUtilityModel, runOpenRouterCompletion } from "./openrouter-completion.js";
import type { CustomTheme, ThemeVariables, ThemeContrastFailure } from "shared/types/index.js";
import type { Correction } from "./theme-contrast.js";
import { prepareThemeWrite, describeFailures, describeCorrections } from "./theme-write.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";

const log = createLogger("quick-completion");

// ─── Types ───────────────────────────────────────────────────────────

export type QuickModel = "haiku" | "sonnet" | "opus";

export interface QuickCompletionOptions {
  /** The user prompt to send. */
  prompt: string;
  /** System prompt instructing how to respond. */
  systemPrompt?: string;
  /** Model tier to use. Auto-routes to the latest version. Default: "haiku". */
  model?: QuickModel;
  /**
   * Claude Code tools to make available alongside return_result. Default: []
   * (none). Only meaningful on the Claude Code branch — the OpenRouter utility
   * client sends no tools at all, and no caller passes any today.
   */
  tools?: string[];
  /** Effort level for reasoning. Default: "low". */
  effort?: "low" | "medium" | "high";
}

export interface QuickCompletionResult {
  /** The answer — from the return_result MCP tool, or the OpenRouter message. */
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
 * Suffix appended to the Claude Code branch's system prompt. Asks for the
 * structured channel (return_result) but explicitly PERMITS a plain-text answer
 * as a fallback — a harness routed through a third-party gateway may be talking
 * to a model that won't reliably honor a forced tool call, and forbidding plain
 * text would leave us with nothing to capture. The event loop accepts whichever
 * channel actually carries the answer.
 */
const RETURN_RESULT_INSTRUCTION =
  "\n\nWhen you have your answer, return it by calling the `return_result` tool. " +
  "If you are unable to call the tool, write the answer directly as your message — just the answer, nothing else.";

/**
 * Run a single, ephemeral completion request.
 *
 * This is intentionally minimal: no session persistence, no Claude Code tools
 * (unless explicitly requested), no permission prompts, no filesystem settings.
 *
 * Dispatches to OpenRouter when utility completions are configured for it,
 * otherwise to the Claude Code SDK — where the result is captured via a
 * `return_result` MCP tool call.
 *
 * For interactive agent sessions, use claude.ts / sendMessage() instead.
 */
export async function quickCompletion(opts: QuickCompletionOptions): Promise<QuickCompletionResult> {
  const { prompt, systemPrompt, model = "haiku", tools = [], effort = "low" } = opts;

  if (isOpenRouterUtilityCompletionEnabled()) {
    const orModel = resolveUtilityModel(model);
    log.debug(`quickCompletion — backend=openrouter, model=${orModel}, effort=${effort}`);
    return runOpenRouterCompletion({ prompt, systemPrompt, model: orModel, effort });
  }

  const agentProvider = getAgentProvider("claude-code");

  log.debug(`quickCompletion — backend=claude-code, model=${model}, effort=${effort}, extraTools=[${tools.join(",")}]`);

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
  // explicit CC tools. Claude Code matches the tool by this exact
  // `mcp__qc__return_result` spelling.
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
  // usable. A model reached through a gateway is less reliable at honoring a
  // forced tool call, so this keeps the completion from dying when the answer
  // arrives as text instead.
  let assistantText = "";

  try {
    const claudeExecutable = await getClaudeCodeExecutablePath();

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
        env: {
          ...process.env,
          // The user's endpoint/credential/model overrides, exactly as every
          // other Agent-SDK call site assembles them (claude.ts, sdk-info.ts,
          // codex-models.ts). This spread was missing here, which meant a user
          // routing Claude Code through OpenRouter had that override applied to
          // their chats but NOT to their titles and branch names — those quietly
          // went to whatever the ambient environment pointed at.
          ...getApiEnvOverrides(),
          // Prevent "cannot be launched inside another Claude Code session" errors
          CLAUDECODE: undefined,
        },
      },
    });

    // Drive the agent loop to completion; capture usage + duration from the
    // result event and accumulate text as the return_result fallback. We drain
    // fully rather than bailing as soon as the tool fires: the run self-
    // terminates after the one-shot answer (return_result is the only tool it
    // has), and draining keeps usage/duration from the terminal result event
    // intact. A terminal `result` event with status "error" is likewise drained
    // rather than thrown on — if the answer was already captured it is good,
    // and aborting a run mid-flight risks an unhandled rejection from the
    // in-flight model call, which is far worse than a handled log line.
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
 * Uses the haiku tier for speed and cost-efficiency.
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
 * Generate a brief, descriptive title for a chat from the conversation as a
 * whole, rather than from the message it opened with.
 *
 * Same contract as {@link generateChatTitle} in every respect that a caller can
 * observe — haiku tier, low effort, trimmed, null on anything unusable — so the
 * two are interchangeable at the call site and only the framing differs. This
 * one is what the "Regenerate title" action runs; `generateChatTitle` stays the
 * new-chat path, where the first message is all there is.
 *
 * The transcript arrives already condensed and capped (see `chats.ts`), and
 * this function deliberately does not re-truncate it: *which* few thousand
 * characters of a long chat carry its subject is a decision about the
 * conversation, not about what the model will accept, and it belongs with the
 * code that can see the message boundaries.
 */
export async function generateChatTitleFromTranscript(transcript: string): Promise<string | null> {
  try {
    const result = await quickCompletion({
      prompt: transcript,
      systemPrompt:
        "Generate a brief title (3-8 words) for the conversation below, which may have been abridged in the middle. " +
        "Title what the conversation is actually about by the end of it, not merely what it opened with — a long chat often moves on from its first request. " +
        "Return ONLY the title text — no quotes, no punctuation at the end, no prefix like 'Title:'.",
      model: "haiku",
      effort: "low",
    });

    const title = result.text.trim();
    if (!title || title.length > 100) return null;
    return title;
  } catch (err: any) {
    log.warn(`generateChatTitleFromTranscript failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate a git-safe branch name from a natural language request.
 *
 * Output format: <type>/<kebab-case-description>
 *   e.g., "feat/add-dark-mode-toggle", "fix/login-redirect-loop"
 *
 * Uses the haiku tier for speed. Returns null on failure.
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

/**
 * How many times a theme may be regenerated before failure is fatal.
 *
 * One budget, both failure modes. It used to be one retry for a contrast
 * failure and *zero* for a malformed response, which had the budget exactly
 * backwards: a model that answered with prose instead of JSON is the cheapest
 * thing in the world to ask again, and the retry it was denied is the one most
 * likely to succeed.
 */
const THEME_GENERATION_ATTEMPTS = 2;

/** Why a generation attempt did not produce a storable theme. */
export type ThemeGenerationFailure =
  /** Colours that no lightness move brings up to AA. `unsatisfiable` names each one. */
  | { reason: "contrast"; detail: string; unsatisfiable: ThemeContrastFailure[] }
  /** The model did not return a theme: prose, invalid JSON, or missing required variables. */
  | { reason: "malformed"; detail: string };

export type ThemeGenerationResult =
  | { ok: true; theme: CustomTheme; corrections: Correction[]; dropped: string[] }
  | ({ ok: false; attempts: number } & ThemeGenerationFailure);

/**
 * Generate a complete custom theme via AI from a natural language description.
 *
 * Uses Sonnet for higher quality color design. The AI returns a JSON object
 * with dark and light mode CSS variable values.
 *
 * The result goes through `prepareThemeWrite` like every other theme write:
 * filtered to the theme surface, measured against every pairing the UI actually
 * paints, and — where a foreground is merely a little short — nudged into range
 * before it is handed back. A theme that has not been stored yet is not user
 * data, so correcting it here costs nobody anything. Where no legal value clears
 * the pairing, the theme is regenerated with the specific failures quoted back,
 * and if that also fails, refused.
 *
 * **The failure comes back with its reasons attached, and that is deliberate.**
 * Both callers of this function report to something that can act on them — an
 * MCP tool result read by a model, or an HTTP response read by a UI — and
 * neither can read the server log. A caller told only "it failed" retries blind,
 * at the cost of two model calls, against a problem it cannot see.
 */
export async function generateThemeCSS(name: string, description: string): Promise<ThemeGenerationResult> {
  let feedback = "";
  let last: ThemeGenerationFailure = { reason: "malformed", detail: "no attempt was made" };

  for (let attempt = 1; attempt <= THEME_GENERATION_ATTEMPTS; attempt++) {
    const outcome = await generateThemeAttempt(name, description, feedback);

    if (outcome.ok) {
      if (outcome.corrections.length > 0) {
        log.info(`generateThemeCSS: corrected ${outcome.corrections.length} value(s) in "${name}" for contrast — ${describeCorrections(outcome.corrections)}`);
      }
      return outcome;
    }

    last = outcome;
    log.warn(`generateThemeCSS: attempt ${attempt} for "${name}" failed (${outcome.reason}) — ${outcome.detail}`);
    if (attempt === THEME_GENERATION_ATTEMPTS) break;

    feedback =
      outcome.reason === "contrast"
        ? `\n\nA previous attempt failed contrast validation on these pairings, which no adjustment of ` +
          `lightness alone could fix. Choose genuinely different values for the colours involved:\n${outcome.detail}\n`
        : `\n\nA previous attempt could not be read as a theme (${outcome.detail}). Return ONLY the JSON object — ` +
          `no prose, no markdown, no code fences — with both a "dark" and a "light" key.\n`;
  }

  log.warn(`generateThemeCSS: refusing "${name}" after ${THEME_GENERATION_ATTEMPTS} attempts rather than storing a theme that cannot be read`);
  return { ok: false, attempts: THEME_GENERATION_ATTEMPTS, ...last };
}

type ThemeAttempt = { ok: true; theme: CustomTheme; corrections: Correction[]; dropped: string[] } | ({ ok: false } & ThemeGenerationFailure);

async function generateThemeAttempt(name: string, description: string, feedback: string): Promise<ThemeAttempt> {
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
      return { ok: false, reason: "malformed", detail: "the response had no `dark` or no `light` key" };
    }

    // Validate that at least the core variables are present
    const darkKeys = Object.keys(parsed.dark);
    const lightKeys = Object.keys(parsed.light);
    const requiredCore = ["bg", "surface", "text", "accent", "border"];
    const missing = requiredCore.filter((key) => !darkKeys.includes(key) || !lightKeys.includes(key));
    if (missing.length > 0) {
      return { ok: false, reason: "malformed", detail: `required variable(s) missing from one or both modes: ${missing.join(", ")}` };
    }

    // Filtering to the theme surface and correcting happen in the same gate
    // every other theme write goes through — see theme-write.ts. A model that
    // helpfully volunteers `chatlist-badge-triggered-bg` would pin a derived
    // variable to a flat value and cut it off from the primitive it is supposed
    // to follow; that is a rule about theme writes, not about generation.
    const prepared = await prepareThemeWrite({ dark: parsed.dark as ThemeVariables, light: parsed.light as ThemeVariables });
    if (prepared.dropped.length > 0) {
      log.info(`generateThemeCSS: dropped ${prepared.dropped.length} variable(s) outside the theme surface — ${prepared.dropped.join(", ")}`);
    }
    if (prepared.unsatisfiable.length > 0) {
      return { ok: false, reason: "contrast", detail: describeFailures(prepared.unsatisfiable), unsatisfiable: prepared.unsatisfiable };
    }

    const now = new Date().toISOString();
    return {
      ok: true,
      theme: { name, dark: prepared.dark, light: prepared.light, createdAt: now, updatedAt: now },
      corrections: prepared.corrections,
      dropped: prepared.dropped,
    };
  } catch (err: any) {
    // Invalid JSON, a provider error, a timeout — all of them mean this attempt
    // produced nothing readable, and all of them are worth one more try.
    return { ok: false, reason: "malformed", detail: err.message };
  }
}
