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
} from "openrouter-agent-coder";

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
}

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
  if (orConfig.logsRoot) orOpts.logsRoot = orConfig.logsRoot;
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
  const mcpTools = collectMcpTools(opts.mcpServers);
  if (mcpTools.length > 0) {
    orOpts.tools = [
      ...allTools({ cwd, ...(orOpts.signal && { signal: orOpts.signal }) }),
      ...mcpTools,
    ];
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
 * a flat list typed as the OR `tools` array's element type so the caller
 * can spread it into `OpenRouterAgentRunOptions.tools` without further
 * casting.
 */
type OrTool = NonNullable<OpenRouterAgentRunOptions["tools"]>[number];

function collectMcpTools(mcpServers: ClaudeShapedOptions["mcpServers"]): OrTool[] {
  if (!mcpServers) return [];
  const tools: OrTool[] = [];
  for (const server of Object.values(mcpServers)) {
    const maybeTools = (server as { tools?: readonly unknown[] }).tools;
    if (Array.isArray(maybeTools)) tools.push(...(maybeTools as OrTool[]));
  }
  return tools;
}

function extractUserMessageContent(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (obj.type !== "user") return null;
  const msg = obj.message;
  if (!msg || msg.role !== "user") return null;
  if (typeof msg.content === "string") return msg.content;
  return null;
}
