/**
 * Options translation: Claude-SDK-shaped {@link AgentQueryRequest.options} →
 * {@link OpenRouterAgentRunOptions}.
 *
 * `claude.ts:sendMessage` builds a single loose `Record<string, unknown>` that
 * the Claude adapter consumes nearly verbatim. The OR adapter consumes the
 * same shape — fields with a direct equivalent map across (`cwd`, `maxTurns`,
 * `allowedTools`, `canUseTool`); Claude-specific fields are silently dropped
 * (`pathToClaudeCodeExecutable`, `plugins`, `mcpServers`, `env`); OR-specific
 * settings ride in via the `openRouter` sub-object claude.ts will populate
 * for OpenRouter chats (PR D).
 *
 * The `prompt` and `sessionId` are passed in separately rather than read off
 * the options Record — the port carries `prompt` on `AgentQueryRequest` and
 * `sessionId` is the adapter's responsibility (generated fresh per run or
 * resumed from `options.resume`).
 *
 * @see plans/openrouter-adapter.md §4 (options translation table)
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_INSTRUCTIONS,
  allTools,
  type OpenRouterAgentRunOptions,
  type SdkMcpServer,
  type SettingSource,
} from "@cybourgeoisie/openrouter-agent-coder";
import { resolveOpenRouterLogsRoot } from "./logsRoot.js";

/**
 * Reasoning-effort levels accepted by the OR `reasoning.effort` field. OR
 * maps the requested level to each provider's native parameter (Anthropic
 * `thinking.budget_tokens`, OpenAI `reasoning_effort`, Gemini
 * `thinkingConfig.thinkingLevel`, Qwen `thinking_budget`, xAI
 * `reasoning_effort`). Non-reasoning models silently ignore it.
 *
 * Re-declared here rather than imported from
 * `@cybourgeoisie/openrouter-agent-coder` because the SDK doesn't re-export
 * its `EffortLevel` type at the package root. Drift risk is minimal — six
 * string literals — and keeping the union local lets the rest of the
 * backend (stream.ts boundary validation, claude.ts metadata persistence)
 * reference it without a deep-path import.
 */
export type EffortLevel = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

/**
 * Sub-object on the options Record carrying OR-specific configuration. Set
 * by claude.ts when routing a call to the OR adapter.
 */
export interface OpenRouterOptionsExtras {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  logsRoot?: string;
  appTitle?: string;
  /**
   * Reasoning-effort level for the OR `reasoning.effort` field. OR translates
   * this to each provider's native parameter (Anthropic
   * `thinking.budget_tokens`, OpenAI `reasoning_effort`, etc.). Per-chat
   * setting — populated from chat metadata at the claude.ts call site.
   * Omit (undefined) to skip the `reasoning` payload entirely.
   */
  effort?: EffortLevel;
  /**
   * Per-session USD spend cap. Omit to inherit the OR library's own default
   * ($1.00 at the time of writing — see DEFAULT_MAX_BUDGET_USD in
   * openrouter-agent-coder/src/agent.ts). The cap is cumulative across every
   * turn for the lifetime of the streaming-input run, not per-message.
   */
  maxBudgetUsd?: number;
}

/**
 * Library-side default for `maxBudgetUsd` when no override is supplied.
 * Mirrors `DEFAULT_MAX_BUDGET_USD` in openrouter-agent-coder/src/agent.ts so
 * the backend can advertise the effective cap on /system-info without having
 * to import the constant (which the OR package doesn't re-export). If the OR
 * library bumps its own default, update this value to match.
 */
export const OR_LIBRARY_DEFAULT_MAX_BUDGET_USD = 1.0;

/**
 * Loose typing of the Claude-SDK-shaped options blob — narrows the fields
 * the OR adapter actually reads. Unknown keys are tolerated and ignored.
 */
interface ClaudeShapedOptions {
  cwd?: string;
  maxTurns?: number;
  resume?: string;
  systemPrompt?: string | { type: "preset"; preset?: string; append?: string };
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  canUseTool?: OpenRouterAgentRunOptions["canUseTool"];
  abortController?: AbortController;
  settingSources?: readonly SettingSource[];
  onHook?: OpenRouterAgentRunOptions["onHook"];
  stderr?: (data: string) => void;
  /**
   * Callboard's MCP-server bundles built via {@link OpenRouterAdapter.buildToolServer}.
   * Each value is an OR-shaped {@link SdkMcpServer} (Claude's shape is a
   * superset; we tolerate the extra `type`/`command` fields by reading only
   * `.tools` and ignoring the rest).
   */
  mcpServers?: Record<string, SdkMcpServer | { tools?: readonly unknown[] }>;
  openRouter?: OpenRouterOptionsExtras;
}

export interface TranslateOptionsResult {
  orOpts: OpenRouterAgentRunOptions;
  /** The resolved cwd — needed by the message adapter for slash-command discovery. */
  cwd: string;
}

/**
 * Translate a Claude-SDK-shaped options Record and a prompt into a fully
 * formed {@link OpenRouterAgentRunOptions}. Throws when OR-specific config
 * (`openRouter.apiKey`) is missing — the OR adapter is unusable without it.
 */
export function translateOptions(
  options: Record<string, unknown>,
  prompt: string | AsyncIterable<unknown>,
): TranslateOptionsResult {
  const opts = options as ClaudeShapedOptions;
  const orConfig = opts.openRouter;
  if (!orConfig?.apiKey) {
    throw new Error(
      "OpenRouter adapter requires options.openRouter.apiKey — configure OPENROUTER_API_KEY in Settings → API.",
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const sessionId = opts.resume ?? randomUUID();
  const instructions = resolveInstructions(opts.systemPrompt);

  const orOpts: OpenRouterAgentRunOptions = {
    apiKey: orConfig.apiKey,
    sessionId,
    prompt: translatePrompt(prompt),
    cwd,
    appTitle: orConfig.appTitle ?? "callboard",
    settingSources: opts.settingSources ?? ["user", "project", "local"],
  };

  if (orConfig.baseUrl) orOpts.baseUrl = orConfig.baseUrl;
  if (orConfig.model) orOpts.model = orConfig.model;
  if (orConfig.effort) orOpts.effort = orConfig.effort;
  // Forward the user's configured spend cap. `Number.isFinite` excludes
  // NaN/Infinity that could sneak in from a malformed setting; the absence
  // of this field is the signal for OR to use its own DEFAULT_MAX_BUDGET_USD.
  if (typeof orConfig.maxBudgetUsd === "number" && Number.isFinite(orConfig.maxBudgetUsd)) {
    orOpts.maxBudgetUsd = orConfig.maxBudgetUsd;
  }
  // Always set logsRoot — OR's own default is `<cwd>/logs` which would
  // pollute the user's project directory and (more importantly) diverge
  // from the path OpenRouterSessionProvider reads from, producing silent
  // "no chat history" behavior. Route through the shared resolver so write
  // and read sides agree.
  orOpts.logsRoot = orConfig.logsRoot ?? resolveOpenRouterLogsRoot();
  if (instructions) orOpts.instructions = instructions;
  if (opts.maxTurns !== undefined) orOpts.maxTurns = opts.maxTurns;
  if (opts.allowedTools && opts.allowedTools.length > 0) orOpts.allowedTools = opts.allowedTools;
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    orOpts.disallowedTools = opts.disallowedTools;
  }
  if (opts.canUseTool) orOpts.canUseTool = opts.canUseTool;
  if (opts.onHook) orOpts.onHook = opts.onHook;
  if (opts.abortController) orOpts.signal = opts.abortController.signal;

  // When callboard injects MCP server bundles (callboard-tools, mcp-proxy,
  // agent tools), surface their tools alongside OR's built-in client tools
  // (read_file, run_command, …). Without this, supplying any custom `tools`
  // array would replace OR's defaults — the agent would lose its file/exec
  // primitives and the run would be useless.
  const { tools: mcpTools, droppedServerNames } = collectMcpTools(opts.mcpServers);
  if (mcpTools.length > 0) {
    orOpts.tools = [
      ...allTools({ cwd, ...(orOpts.signal && { signal: orOpts.signal }) }),
      ...mcpTools,
    ];
  }
  if (droppedServerNames.length > 0 && opts.stderr) {
    // External stdio/http MCP servers from .mcp.json have shapes like
    // `{ command, args, env }` or `{ url, headers }` — no in-process `.tools`
    // array. The OR adapter has no equivalent transport in v1 (the
    // openrouter-agent-coder library DOES support MCP, but wiring its
    // bridge is deferred to a later PR). Surface dropped names so users
    // can see why their external tools disappeared under OR.
    opts.stderr(
      `[openrouter] dropped external MCP servers (no in-process tools): ${droppedServerNames.join(", ")}`,
    );
  }

  if (opts.stderr) {
    orOpts.logger = (level, message) => {
      if (level === "warn" || level === "error") opts.stderr!(message);
    };
  }

  return { orOpts, cwd };
}

/**
 * Resolve Claude's `systemPrompt` (string OR `{ type: "preset", append }`)
 * into OR's flat `instructions` string.
 *
 * Loses the claude_code preset's implicit content (the OR library doesn't
 * ship Claude's preset prompts) — fall back to OR's DEFAULT_INSTRUCTIONS
 * concatenated with the append so the agent still has a coding-oriented
 * base prompt. A plain string overrides entirely.
 */
function resolveInstructions(
  systemPrompt: ClaudeShapedOptions["systemPrompt"],
): string | undefined {
  if (typeof systemPrompt === "string") return systemPrompt;
  if (systemPrompt && typeof systemPrompt === "object") {
    const append = systemPrompt.append ?? "";
    return append ? `${DEFAULT_INSTRUCTIONS}\n\n${append}` : undefined;
  }
  return undefined;
}

/**
 * Translate the AgentQueryRequest.prompt shape (Claude's string or
 * AsyncIterable<{ type: "user", message: { content } }>) into OR's
 * `string | AsyncIterable<UserInput>`.
 *
 * A plain string passes through. AsyncIterable items are projected onto
 * OR's `UserInput { content }` shape — only the user-message content is
 * extracted; non-user-message items are skipped.
 */
function translatePrompt(
  prompt: string | AsyncIterable<unknown>,
): OpenRouterAgentRunOptions["prompt"] {
  if (typeof prompt === "string") return prompt;
  return (async function* (): AsyncIterable<{ content: string }> {
    for await (const item of prompt) {
      const content = extractUserMessageContent(item);
      if (content !== null) yield { content };
    }
  })();
}

/**
 * Pull the `tools` arrays out of a Claude-shaped mcpServers record. Returns
 * a flat list typed as the OR `tools` array's element type, plus the names
 * of any servers whose shape has no in-process `.tools` (e.g. stdio/http
 * configs from `.mcp.json`) so the caller can surface a warning.
 */
type OrTool = NonNullable<OpenRouterAgentRunOptions["tools"]>[number];

function collectMcpTools(mcpServers: ClaudeShapedOptions["mcpServers"]): {
  tools: OrTool[];
  droppedServerNames: string[];
} {
  if (!mcpServers) return { tools: [], droppedServerNames: [] };
  const tools: OrTool[] = [];
  const droppedServerNames: string[] = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    const maybeTools = (server as { tools?: readonly unknown[] }).tools;
    if (Array.isArray(maybeTools)) {
      tools.push(...(maybeTools as OrTool[]));
    } else {
      droppedServerNames.push(name);
    }
  }
  return { tools, droppedServerNames };
}

function extractUserMessageContent(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (obj.type !== "user") return null;
  const msg = obj.message;
  if (!msg || msg.role !== "user") return null;
  if (typeof msg.content === "string") return msg.content;
  // Claude's multimodal prompts arrive as ContentBlock[] —
  // `[{ type: "text", text }, { type: "image", source }]`. The OR library
  // accepts arrays directly on UserInput.content, but the OR Responses API
  // schema is different from Claude's. For PR B we extract just the text
  // segments and concatenate; image / file blocks are surfaced via a
  // bracketed placeholder so the model knows something was attached but
  // not what. Full multimodal support is deferred.
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block): string => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const b = block as { type?: unknown; text?: unknown; source?: { media_type?: unknown } };
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") {
          const mime = b.source?.media_type;
          return `[image:${typeof mime === "string" ? mime : "unknown"}]`;
        }
        return `[${typeof b.type === "string" ? b.type : "unknown"}]`;
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return null;
}
