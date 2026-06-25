/**
 * Options translation: Claude-SDK-shaped {@link AgentQueryRequest.options} →
 * {@link OpenRouterAgentRunOptions}.
 *
 * `claude.ts:sendMessage` builds a single loose `Record<string, unknown>` that
 * the Claude adapter consumes nearly verbatim. The OR adapter consumes the
 * same shape — fields with a direct equivalent map across (`cwd`, `maxTurns`,
 * `allowedTools`, `canUseTool`, `mcpServers` — in-process bundles become
 * tools, external stdio/http/sse configs become harness `mcpServers` bridge
 * entries, see {@link collectMcpTools}); `env` is deliberately dropped (the
 * harness is in-process — see the secret-leak note in
 * {@link translateOptions}); truly Claude-specific fields are silently
 * dropped (`pathToClaudeCodeExecutable`); OR-specific settings ride in via
 * the `openRouter` sub-object claude.ts populates for OpenRouter chats.
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
  type McpServerConfig,
  type OpenRouterAgentRunOptions,
  type SdkMcpServer,
  type SettingSource,
} from "@wolpertingerlabs/openrouter-agent-harness";
import { resolveOpenRouterLogsRoot } from "./logsRoot.js";
import { formatLogFields } from "./logFields.js";
import { createLogger } from "../../../utils/logger.js";
import type { EffortLevel } from "shared/types/index.js";

const log = createLogger("openrouter");

export type { EffortLevel };

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
   * openrouter-agent-harness/src/agent.ts). The cap is cumulative across every
   * turn for the lifetime of the streaming-input run, not per-message.
   */
  maxBudgetUsd?: number;
  /**
   * OpenRouter server tools to inject, already in the harness's verbatim wire
   * shape (`{ type }` or `{ type, parameters }`). claude.ts builds this from the
   * persisted `openRouterServerTools` setting via `serverToolToWire`.
   *   - `undefined` ⇒ omit the option so the harness injects its
   *     `DEFAULT_SERVER_TOOLS` (datetime/web_search/web_fetch).
   *   - `[]` ⇒ disable all server tools (the agent's `tools` array is sent
   *     exactly as built).
   * Typed structurally (rather than importing the harness's `ServerToolConfig`,
   * which is not exported from the package root) so the shape stays decoupled
   * from the harness's internal type names.
   */
  serverTools?: Array<{ type: string } & Record<string, unknown>>;
  /**
   * Flattened OpenRouter generation params (camelCase sampling fields plus an
   * optional `plugins` array), as produced by `resolveModelParams`. Forwarded
   * to the harness's own `modelParams` option, which rides
   * `Partial<ResponsesRequest>`. Omit to send no extra params.
   */
  modelParams?: Record<string, unknown>;
  /**
   * Utility/quick-completion marker: expose ONLY the explicitly-supplied
   * in-process MCP tools, with NO default client tools (read_file / write_file /
   * bash / …) and NO server tools (web_search / web_fetch / datetime).
   *
   * Why this exists: {@link translateOptions} normally PREPENDS OR's full
   * default client toolset whenever any in-process MCP bundle is present (so
   * real chats keep file/exec primitives alongside callboard-tools). For a
   * one-shot utility call — generating a chat title, a branch name, a theme —
   * that is actively harmful: armed with file/bash tools and a prompt like
   * "Help me add dark mode", the model treats the prompt as a coding task and
   * starts editing files instead of returning a title, never calling
   * `return_result` and never producing a final answer. Set by
   * quick-completion.ts; see the `bareToolset` branch in {@link translateOptions}.
   */
  bareToolset?: boolean;
}

/**
 * Library-side default for `maxBudgetUsd` when no override is supplied.
 * Mirrors `DEFAULT_MAX_BUDGET_USD` in openrouter-agent-harness/src/agent.ts so
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
  persistSession?: boolean;
  settingSources?: readonly SettingSource[];
  onHook?: OpenRouterAgentRunOptions["onHook"];
  onAskUserQuestion?: OpenRouterAgentRunOptions["onAskUserQuestion"];
  /**
   * Shared mutable cell claude.ts also closes `buildCanUseTool` over. Not
   * consumed by translateOptions — OpenRouterAdapter threads it into the
   * plugin hook dispatcher so a PreToolUse `ask` decision can stash its
   * reason where the forwarded canUseTool will see it (and prompt the user
   * instead of auto-approving). Declared here so the claude.ts ↔ OR-adapter
   * options contract is visible in one place.
   */
  hookAskOverride?: { reason: string };
  stderr?: (data: string) => void;
  /**
   * MCP servers, two distinct shapes under one record:
   *
   * - In-process bundles built via {@link OpenRouterAdapter.buildToolServer}
   *   — OR-shaped {@link SdkMcpServer}s whose `.tools` arrays we splice into
   *   `orOpts.tools` directly (no bridge round-trip needed).
   * - External server configs from `.mcp.json` / plugin manifests — Claude's
   *   stdio shape (`{ command, args?, env? }`) or http/sse shape
   *   (`{ type: "http" | "sse", url, headers? }`). These translate to the
   *   harness's `mcpServers` bridge configs (see {@link collectMcpTools}).
   */
  mcpServers?: Record<string, SdkMcpServer | ClaudeExternalMcpServer | { tools?: readonly unknown[] }>;
  /**
   * Subprocess environment the Claude path hands to the SDK CLI. The harness
   * runs in-process, so there is no subprocess to populate — this field is
   * accepted for shape compatibility and deliberately NOT forwarded (see the
   * secret-leak note in {@link translateOptions}).
   */
  env?: Record<string, string | undefined>;
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
  // Utility/quick-completion runs expose only their supplied in-process tools —
  // no default client toolset, no server tools. See OpenRouterOptionsExtras.bareToolset.
  const bareToolset = orConfig.bareToolset === true;

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
  // Forward configured OpenRouter generation params (sampling knobs + plugins).
  // claude.ts resolves the global default merged with any per-model override via
  // `resolveModelParams`; absence here leaves the harness on its own defaults.
  // The shared catalog hands us a validated camelCase bag (`Record`); the harness
  // types it as `Partial<ResponsesRequest>` (not re-exported from the package), so
  // cast through the harness option's own type to stay in lockstep with it.
  if (orConfig.modelParams) {
    orOpts.modelParams = orConfig.modelParams as OpenRouterAgentRunOptions["modelParams"];
  }
  // Always-on auto prompt caching. OR honors this only for Anthropic Claude
  // models (the directive turns into a cache breakpoint on the last cacheable
  // block); other providers silently ignore it, so it's safe to set
  // unconditionally. TTL is omitted so OR's own default (~5min) applies.
  orOpts.cacheControl = { type: "ephemeral" };
  // OpenRouter's built-in server tools (`openrouter:datetime`/`web_search`/
  // `web_fetch` and friends). Pass through whatever claude.ts resolved from the
  // user's `openRouterServerTools` setting, already in wire shape (see step 4 of
  // the tools-config feature). Leaving it unset is meaningful:
  //   - `undefined` ⇒ omit the option so the harness injects its
  //     `DEFAULT_SERVER_TOOLS` (datetime/web_search/web_fetch).
  //   - `[]` ⇒ disable all server tools (the request `tools` array is sent
  //     exactly as the agent built it).
  if (bareToolset) {
    // A utility completion never needs OR's server tools; disabling them keeps
    // the model from wandering off (web_search/web_fetch) mid-answer. `[]`
    // means "send the request `tools` array exactly as built" (see above).
    orOpts.serverTools = [];
  } else if (orConfig.serverTools) {
    orOpts.serverTools = orConfig.serverTools;
  }
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
  // Forward persistSession so callers that opt out of on-disk session records
  // (e.g. quick completions passing `persistSession: false`) are honored.
  // Without this the OR library falls back to its own default (true) and writes
  // a full session/transcript/state record for every ephemeral one-off call.
  if (typeof opts.persistSession === "boolean") orOpts.persistSession = opts.persistSession;
  if (opts.canUseTool) orOpts.canUseTool = opts.canUseTool;
  if (opts.onHook) orOpts.onHook = opts.onHook;
  // Host handler for the OR library's ask_user_question tool. Without it the
  // tool returns "no host handler registered". claude.ts builds this with the
  // session emitter + pending-request plumbing in closure.
  if (opts.onAskUserQuestion) orOpts.onAskUserQuestion = opts.onAskUserQuestion;
  if (opts.abortController) orOpts.signal = opts.abortController.signal;

  // `opts.env` is deliberately NOT forwarded. The Claude path needs it because
  // the SDK runs as a CLI subprocess whose environment must be populated; the
  // harness runs IN-PROCESS, so every place env actually matters is already
  // covered: bash/monitor children and skill `` !`cmd` `` shell execution
  // inherit process.env, and per-MCP-server env rides on each server's bridge
  // config (translated below). The only remaining harness surface is
  // `skillEnv` — values resolvable via generic `${VAR}` substitution in skill
  // BODIES, i.e. rendered straight into the model prompt. claude.ts builds
  // `opts.env` from the full process.env plus API-key overrides, and Claude
  // Code does not substitute arbitrary env vars into skill bodies either, so
  // forwarding it here would let any skill render `${OPENROUTER_API_KEY}`
  // into a prompt — a secret-leak vector, not parity. skillEnv stays at its
  // narrow library default (only the well-known `CLAUDE_*` keys resolve).

  // When callboard injects MCP server bundles (callboard-tools, mcp-proxy,
  // agent tools), surface their tools alongside OR's built-in client tools
  // (read_file, bash, …). Without this, supplying any custom `tools`
  // array would replace OR's defaults — the agent would lose its file/exec
  // primitives and the run would be useless.
  const { tools: mcpTools, externalServers, droppedServerNames } = collectMcpTools(opts.mcpServers);
  if (bareToolset) {
    // Utility/quick-completion path: expose ONLY the supplied in-process tools
    // (e.g. `return_result`) — never OR's default client toolset. Injecting
    // read_file/write_file/bash here would arm a one-shot utility model with
    // file/exec tools, and it then treats the prompt as a coding task and edits
    // files instead of answering (see OpenRouterOptionsExtras.bareToolset).
    // Pinning a custom `tools` array (even an empty one) also flips the
    // harness's `hasCustomTools`, so it won't fall back to its own default
    // bundle for a no-tool, text-only completion either.
    orOpts.tools = [...mcpTools];
  } else if (mcpTools.length > 0) {
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
  if (externalServers.length > 0) {
    // External stdio/http/sse servers ride the harness's own MCP bridge: it
    // spawns/connects them at run start, lists their tools over the
    // `initialize` handshake, and merges the resulting bridge tools into the
    // model's pool EVEN when a custom `tools` array (above) is supplied —
    // agent.ts builds `initialPool = [...baseTools, ...bridgeTools]` where
    // baseTools is the custom array. Per-server init failures are logged and
    // skipped by the bridge; they never fail the run.
    //
    // Known asymmetry (not fixed here): the claude path auto-allowlists
    // external servers as `mcp__<server>__*`, but the bridge names its tools
    // `<server>__<tool>` — those allowedTools patterns don't match, so bridge
    // tools aren't auto-approved and fall through to the canUseTool prompt.
    // Allowlist-pattern translation is a follow-up.
    orOpts.mcpServers = externalServers;
    const summary = externalServers.map((s) => `${s.name}(${s.transport})`).join(", ");
    log.info(`wired external MCP servers via harness bridge: ${summary}`);
    if (opts.stderr) opts.stderr(`[openrouter] wired external MCP servers: ${summary}`);
  }
  if (droppedServerNames.length > 0 && opts.stderr) {
    // Only genuinely untranslatable shapes land here now: no in-process
    // `.tools` array AND no recognizable stdio/http/sse config. Surface the
    // names so users can see why a server's tools disappeared under OR.
    opts.stderr(
      `[openrouter] dropped MCP servers with unrecognized config shape: ${droppedServerNames.join(", ")}`,
    );
  }

  // Forward every level from the OR library through Winston so debugging the
  // OR path is symmetrical with the Claude path (which gets full SDK logging
  // via createLogger("claude")). Also keep the stderr forward for warn/error
  // so user-facing diagnostics still surface via the existing channel.
  // The harness puts the actual failure context (error message, structured
  // detail, serialized failed event, retry telemetry) in the third `fields`
  // argument — append it or the log line is just a bare label.
  orOpts.logger = (level, message, fields) => {
    const suffix = formatLogFields(fields);
    log[level](`[or-lib] ${message}${suffix}`);
    if ((level === "warn" || level === "error") && opts.stderr) {
      opts.stderr(`${message}${suffix}`);
    }
  };

  log.debug(
    `translateOptions resolved — sessionId=${sessionId}, model=${orOpts.model ?? "(default)"}, ` +
      `effort=${orOpts.effort ?? "(unset)"}, maxBudgetUsd=${orOpts.maxBudgetUsd ?? "(library default)"}, ` +
      `baseUrl=${orOpts.baseUrl ?? "(default)"}, logsRoot=${orOpts.logsRoot}, ` +
      `maxTurns=${orOpts.maxTurns ?? "(default)"}, persistSession=${orOpts.persistSession ?? "(default)"}, ` +
      `cwd=${cwd}, instructions=${orOpts.instructions ? `${orOpts.instructions.length}chars` : "(none)"}, ` +
      `tools=${orOpts.tools?.length ?? 0}, mcpServers=${orOpts.mcpServers?.length ?? 0}, ` +
      `allowedTools=${orOpts.allowedTools?.length ?? 0}, ` +
      `disallowedTools=${orOpts.disallowedTools?.length ?? 0}`,
  );

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

export type OrTool = NonNullable<OpenRouterAgentRunOptions["tools"]>[number];

/**
 * Claude-SDK-shaped EXTERNAL MCP server config, as claude.ts's
 * buildMcpServerOptions emits them: stdio servers are `{ command, args?,
 * env? }` (no `type` field — the SDK infers stdio from `command`), remote
 * servers are `{ type: "http" | "sse", url, headers? }`. Extra fields (e.g.
 * the `env` claude.ts attaches to remote entries for the CLI's `${VAR}`
 * resolution) are tolerated and ignored where the harness has no slot for
 * them.
 */
interface ClaudeExternalMcpServer {
  type?: string;
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Synthetic `source` marker for harness {@link McpServerConfig}s built from
 * callboard's options blob. The harness normally stamps the originating
 * `.mcp.json` path here and uses it ONLY in log/notification context (see
 * its src/mcp/bridge.ts failure paths) — there is no file for it to point at
 * on this path, so a recognizable marker keeps the logs honest.
 */
const MCP_SOURCE_MARKER = "callboard:options";

/**
 * Translate one Claude-shaped external server config into a harness
 * {@link McpServerConfig}, or `null` when the shape is unrecognizable.
 *
 * - stdio (`command` present) → `{ transport: "stdio", command, args?, env? }`
 * - http/sse (`type` + `url`) → `{ transport: "http", url, headers? }` — the
 *   harness has no separate SSE transport config; its bridge speaks
 *   streamableHttp first and falls back to SSE on its own, so Claude's
 *   `type: "sse"` entries map to the same http config.
 */
function translateExternalMcpServer(name: string, server: ClaudeExternalMcpServer): McpServerConfig | null {
  if (typeof server.command === "string" && server.command.length > 0) {
    return {
      transport: "stdio",
      name,
      command: server.command,
      ...(Array.isArray(server.args) && { args: [...server.args] as string[] }),
      ...(server.env && typeof server.env === "object" && { env: { ...server.env } }),
      source: MCP_SOURCE_MARKER,
    };
  }
  if ((server.type === "http" || server.type === "sse") && typeof server.url === "string" && server.url.length > 0) {
    return {
      transport: "http",
      name,
      url: server.url,
      ...(server.headers && typeof server.headers === "object" && { headers: { ...server.headers } }),
      source: MCP_SOURCE_MARKER,
    };
  }
  return null;
}

/**
 * Materialize OR's built-in client tool set (read_file, bash, …) bound
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

/**
 * Split a Claude-shaped mcpServers record into the three things the OR run
 * can do with it:
 *
 * - `tools` — flattened `.tools` arrays from in-process bundles, spliced
 *   straight into `orOpts.tools` (no bridge round-trip).
 * - `externalServers` — harness {@link McpServerConfig}s translated from
 *   external stdio/http/sse configs, destined for `orOpts.mcpServers`.
 * - `droppedServerNames` — entries matching neither shape, so the caller can
 *   surface a warning instead of silently losing them.
 */
function collectMcpTools(mcpServers: ClaudeShapedOptions["mcpServers"]): {
  tools: OrTool[];
  externalServers: McpServerConfig[];
  droppedServerNames: string[];
} {
  if (!mcpServers) return { tools: [], externalServers: [], droppedServerNames: [] };
  const tools: OrTool[] = [];
  const externalServers: McpServerConfig[] = [];
  const droppedServerNames: string[] = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    const maybeTools = (server as { tools?: readonly unknown[] }).tools;
    if (Array.isArray(maybeTools)) {
      tools.push(...(maybeTools as OrTool[]));
      continue;
    }
    const external = translateExternalMcpServer(name, server as ClaudeExternalMcpServer);
    if (external) {
      externalServers.push(external);
    } else {
      droppedServerNames.push(name);
    }
  }
  return { tools, externalServers, droppedServerNames };
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
