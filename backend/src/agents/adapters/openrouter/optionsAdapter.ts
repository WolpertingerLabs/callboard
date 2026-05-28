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
  onAskUserQuestion?: OpenRouterAgentRunOptions["onAskUserQuestion"];
  stderr?: (data: string) => void;
  /**
   * Callboard's MCP-server bundles built via {@link OpenRouterAdapter.buildToolServer}.
   * Each value is an OR-shaped {@link SdkMcpServer} (Claude's shape is a
   * superset; we tolerate the extra `type`/`command` fields by reading only
   * `.tools` and ignoring the rest).
   */
  mcpServers?: Record<string, SdkMcpServer | { tools?: readonly unknown[] }>;
  /**
   * Claude-SDK-shaped plugin descriptors built by claude.ts#buildPluginOptions
   * (`{ type: "local", path, name }`). The Claude path forwards these to the SDK
   * directly; the OR adapter reads only `.path` (the plugin's root directory) and
   * feeds it to the OR library's `loadPlugins({ pluginDirs })`. Resolution is
   * async, so it happens in OpenRouterAdapter's lazy run construction rather than
   * here. See {@link extractPluginDirs}.
   */
  plugins?: ReadonlyArray<{ type?: string; path?: string; name?: string }>;
  openRouter?: OpenRouterOptionsExtras;
}

/**
 * Pull the absolute plugin-root directories out of the Claude-shaped `plugins`
 * descriptor array. Entries without a usable `path` (or non-`local` types the OR
 * library can't resolve from a directory) are skipped. Exported for the OR
 * adapter's plugin-loading step and for unit tests.
 */
export function extractPluginDirs(options: Record<string, unknown>): string[] {
  const plugins = (options as ClaudeShapedOptions).plugins;
  if (!Array.isArray(plugins)) return [];
  const dirs: string[] = [];
  for (const p of plugins) {
    // Only `type: "local"` descriptors carry a filesystem path loadPlugins can
    // walk. Other plugin source types (e.g. remote/marketplace refs) have no
    // local directory and are skipped — the Claude path resolves those via the
    // CLI, which the OR adapter has no equivalent for.
    if (p && typeof p.path === "string" && p.path.length > 0 && (p.type === undefined || p.type === "local")) {
      dirs.push(p.path);
    }
  }
  return dirs;
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
  // Host handler for the OR library's ask_user_question tool. Without it the
  // tool returns "no host handler registered". claude.ts builds this with the
  // session emitter + pending-request plumbing in closure.
  if (opts.onAskUserQuestion) orOpts.onAskUserQuestion = opts.onAskUserQuestion;
  if (opts.abortController) orOpts.signal = opts.abortController.signal;

  // When callboard injects MCP server bundles (callboard-tools, mcp-proxy,
  // agent tools), surface their tools alongside OR's built-in client tools
  // (read_file, run_command, …). Without this, supplying any custom `tools`
  // array would replace OR's defaults — the agent would lose its file/exec
  // primitives and the run would be useless.
  const { tools: mcpTools, droppedServerNames } = collectMcpTools(opts.mcpServers);
  if (mcpTools.length > 0) {
    // Build OR's built-in tools and forward the ask_user_question host handler,
    // then append callboard's MCP-bundled tools. Because callboard always
    // supplies a custom `tools` array, the library uses these tools verbatim
    // (the top-level orOpts.onAskUserQuestion is only consulted on the library's
    // own default tool set, which we bypass), so this is the only place the
    // handler lands. The plugin/skill wiring in OpenRouterAdapter later appends
    // the `skill` tool to this same array — see buildDefaultOrTools' note on why
    // the base set must be materialized here rather than left to the library.
    orOpts.tools = [
      ...buildDefaultOrTools(cwd, orOpts.signal, opts.onAskUserQuestion),
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
 * extracted; non-user-message items are skipped. Content is either a
 * string (text-only) or an OR-shaped content-block array when images
 * are attached (see {@link extractUserMessageContent}).
 */
function translatePrompt(
  prompt: string | AsyncIterable<unknown>,
): OpenRouterAgentRunOptions["prompt"] {
  if (typeof prompt === "string") return prompt;
  return (async function* (): AsyncIterable<{ content: string | readonly unknown[] }> {
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
export type OrTool = NonNullable<OpenRouterAgentRunOptions["tools"]>[number];

/**
 * Materialize OR's built-in client tool set (read_file, run_command, …) bound
 * to the run's cwd / abort signal, with the host `ask_user_question` handler
 * forwarded.
 *
 * `allTools`' signature is `(ctx, opts)` — the handler MUST go in the second
 * arg; passing it inside the ctx object silently no-ops and the tool errors with
 * "no host handler registered".
 *
 * Why this exists as a standalone export: callboard always supplies a custom
 * `tools` array, and the OR library appends its `skill` built-in (and binds the
 * ask_user_question handler) ONLY when constructing its OWN default bundle —
 * which a custom `tools` array bypasses entirely (see agent.ts `hasCustomTools`).
 * So whenever callboard needs to add a tool the library would normally bundle
 * (the `skill` tool, here), it must first reconstruct this default set itself and
 * append to it, rather than relying on the library. Both the MCP-tools branch in
 * {@link translateOptions} and the skill-wiring path in OpenRouterAdapter call
 * through here so the base set is built identically in both places.
 */
export function buildDefaultOrTools(
  cwd: string,
  signal: AbortSignal | undefined,
  onAskUserQuestion: ClaudeShapedOptions["onAskUserQuestion"],
): readonly OrTool[] {
  return allTools(
    { cwd, ...(signal && { signal }) },
    { ...(onAskUserQuestion && { onAskUserQuestion }) },
  );
}

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

/**
 * Convert one Anthropic-shape image block into OR's `input_image` form. Returns
 * `null` when the source shape isn't one we recognize so the caller can decide
 * whether to drop the block or surface a placeholder.
 *
 * Recognized source shapes:
 * - `{ type: "base64", media_type, data }` → `data:<media_type>;base64,<data>`
 * - `{ type: "url", url }` → forwarded verbatim (URL passes through)
 */
function claudeImageToOrBlock(
  source: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown } | undefined,
): { type: "input_image"; image_url: string } | null {
  if (!source) return null;
  if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
    return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  return null;
}

function extractUserMessageContent(item: unknown): string | readonly unknown[] | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (obj.type !== "user") return null;
  const msg = obj.message;
  if (!msg || msg.role !== "user") return null;
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return null;

  // Claude's multimodal prompts arrive as ContentBlock[] —
  // `[{ type: "text", text }, { type: "image", source }]`. Translate to OR's
  // Responses-API content blocks: text → `input_text`, image → `input_image`
  // with a data: URI (base64) or URL passthrough. UserInput.content accepts a
  // readonly array; the OR library forwards it to `callModel` unchanged.
  //
  // Text-only arrays collapse back into a plain string so single-shot text
  // turns stay on the simple wire form.
  const orBlocks: unknown[] = [];
  let hasImage = false;
  for (const block of msg.content) {
    if (typeof block === "string") {
      if (block.length > 0) orBlocks.push({ type: "input_text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    };
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.length > 0) orBlocks.push({ type: "input_text", text: b.text });
      continue;
    }
    if (b.type === "image") {
      const orImage = claudeImageToOrBlock(b.source);
      if (orImage) {
        orBlocks.push(orImage);
        hasImage = true;
      } else {
        // Unknown source shape — fall back to a text placeholder so the model
        // sees that something was attached even if we couldn't forward it.
        const mime = b.source?.media_type;
        orBlocks.push({
          type: "input_text",
          text: `[image:${typeof mime === "string" ? mime : "unknown"}]`,
        });
      }
      continue;
    }
    // Unknown block kind — placeholder so the turn isn't silently dropped.
    orBlocks.push({
      type: "input_text",
      text: `[${typeof b.type === "string" ? b.type : "unknown"}]`,
    });
  }

  if (orBlocks.length === 0) return null;
  if (!hasImage) {
    // Text-only: collapse to a single string for the simple wire shape.
    return orBlocks.map((b) => (b as { text: string }).text).join("\n");
  }
  return orBlocks;
}
