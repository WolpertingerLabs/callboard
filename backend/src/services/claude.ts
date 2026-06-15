import { getAgentProvider } from "../agents/factory.js";
import type { AgentProviderKind } from "../agents/ports/AgentProvider.js";
import type { EffortLevel } from "../agents/adapters/openrouter/optionsAdapter.js";
import { OR_LIBRARY_DEFAULT_MAX_BUDGET_USD } from "../agents/adapters/openrouter/optionsAdapter.js";
import type { PermissionResult, HookEvent, HookCallbackMatcher, HookCallback, HookInput, HookJSONOutput } from "../agents/adapters/claude-code/types.js";
import { ToolPermissionPolicy } from "../agents/permissions/ToolPermissionPolicy.js";
import { categorizeClaudeTool } from "../agents/adapters/claude-code/permissionAdapter.js";
import { EventEmitter } from "events";
import { execFile } from "child_process";
import { resolve, isAbsolute } from "path";
import { chatFileService } from "./chat-file-service.js";
import { findChat } from "../utils/chat-lookup.js";
import { setSlashCommandsForDirectory } from "./slashCommands.js";
import type { DefaultPermissions } from "shared/types/index.js";
import type { StreamEvent } from "shared/types/index.js";
import type { McpServerConfig } from "shared/types/index.js";
import { serverToolToWire, resolveModelParams } from "shared/types/index.js";
import { getPluginsForDirectory, type Plugin } from "./plugins.js";
import { getEnabledAppPlugins, getEnabledMcpServers } from "./app-plugins.js";
import { customSkillsService, CUSTOM_SKILLS_PLUGIN_NAME } from "./custom-skills-service.js";
import { buildAgentToolsSpec, setMessageSender } from "./agent-tools.js";
import { buildCallboardToolsSpec, setCallboardMessageSender } from "./callboard-tools.js";
import { buildJobStepToolsSpec } from "./job-step-tools.js";
import { buildObjectiveToolsSpec, clearObjectiveCompletion, hasObjectiveCompletion } from "./objective-tools.js";
import { getRun as getJobRun } from "./job-store.js";
import { buildProxyToolsSpec } from "./proxy-tools.js";
import { listConnectionsWithStatus, listRemoteConnections } from "./connection-manager.js";
import {
  getAgentSettings,
  getActiveMcpConfigDir,
  resolveAgentKeyAlias,
  getApiEnvOverrides,
  getClaudeCodeExecutablePath,
  resolveOpenRouterModel,
} from "./agent-settings.js";
import { appendActivity } from "./agent-activity.js";
import { getAgent } from "./agent-file-service.js";
import { generateChatTitle } from "./quick-completion.js";
import { sessionRegistry } from "./session-registry.js";
import { getGitInfo } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("claude");

export type { StreamEvent };

/** Provider kinds that sendMessage knows how to route through. */
const ROUTABLE_PROVIDER_KINDS: ReadonlySet<AgentProviderKind> = new Set(["claude-code", "openrouter", "codex"]);

/**
 * Narrow a free-form metadata.provider value to a usable AgentProviderKind,
 * falling back to "claude-code" on anything unrecognized. Logs a warn for
 * malformed values so corrupted metadata is observable instead of silent.
 */
function resolveProviderKind(value: unknown): AgentProviderKind {
  if (typeof value !== "string" || value === "") return "claude-code";
  if (ROUTABLE_PROVIDER_KINDS.has(value as AgentProviderKind)) {
    return value as AgentProviderKind;
  }
  log.warn(`Unknown chat metadata provider="${value}" — falling back to "claude-code"`);
  return "claude-code";
}

/**
 * Build a system prompt section listing available MCP proxy connections.
 * Returns empty string if no connections are found.
 */
async function buildProxyConnectionsPrompt(proxyKeyAlias: string, proxyMode: string): Promise<string> {
  let connections: Array<{ alias: string; name: string; description?: string; docsUrl?: string; enabled?: boolean }> = [];

  if (proxyMode === "local") {
    const all = listConnectionsWithStatus(proxyKeyAlias);
    connections = all.filter((c) => c.enabled);
  } else if (proxyMode === "remote") {
    const { templates } = await listRemoteConnections(proxyKeyAlias);
    connections = templates;
  }

  if (connections.length === 0) return "";

  const lines = connections.map((c) => {
    let line = `- **${c.name}** (\`${c.alias}\`)`;
    if (c.description) line += ` — ${c.description}`;
    if (c.docsUrl) line += ` | [Docs](${c.docsUrl})`;
    return line;
  });

  return [
    "# Available API Connections",
    "",
    "The following API connections are available through the MCP proxy tools (`mcp__mcp-proxy__*`).",
    "Use `list_routes` for detailed endpoint information, or `secure_request` to make API calls.",
    "",
    ...lines,
  ].join("\n");
}

interface PendingRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: readonly unknown[];
  eventType: "permission_request" | "user_question" | "plan_review";
  eventData: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

interface ActiveSession {
  abortController: AbortController;
  emitter: EventEmitter;
}

const pendingRequests = new Map<string, PendingRequest>();

/**
 * Build plugin configuration for Claude SDK from active plugin IDs.
 * Merges per-directory plugins with enabled app-wide plugins.
 * Per-directory plugins take precedence over app-wide plugins with the same name.
 */
function buildPluginOptions(folder: string, activePluginIds?: string[]): any[] {
  const sdkPlugins: any[] = [];
  const includedNames = new Set<string>();

  // Per-directory plugins (existing behavior)
  if (activePluginIds && activePluginIds.length > 0) {
    try {
      const plugins = getPluginsForDirectory(folder);
      const activePlugins = plugins.filter((p: Plugin) => activePluginIds.includes(p.id));

      for (const plugin of activePlugins) {
        sdkPlugins.push({
          type: "local",
          path: plugin.manifest.source,
          name: plugin.manifest.name,
        });
        includedNames.add(plugin.manifest.name);
      }
    } catch (error) {
      log.warn(`Failed to build per-directory plugin options: ${error}`);
    }
  }

  // App-wide plugins (always included if enabled in settings)
  try {
    const appPlugins = getEnabledAppPlugins();
    for (const appPlugin of appPlugins) {
      // Deduplicate: per-directory plugins take precedence
      if (!includedNames.has(appPlugin.manifest.name)) {
        sdkPlugins.push({
          type: "local",
          path: appPlugin.pluginPath,
          name: appPlugin.manifest.name,
        });
        includedNames.add(appPlugin.manifest.name);
      }
    }
  } catch (error) {
    log.warn(`Failed to build app-wide plugin options: ${error}`);
  }

  // Callboard custom skills — a synthetic plugin so both providers pick them
  // up: the Claude SDK loads it natively, and the OR adapter reads this same
  // descriptor array via extractPluginDirs → loadPlugins. Null when no
  // custom skills exist.
  try {
    const customSkillsDir = customSkillsService.getPluginDir();
    if (customSkillsDir && !includedNames.has(CUSTOM_SKILLS_PLUGIN_NAME)) {
      sdkPlugins.push({
        type: "local",
        path: customSkillsDir,
        name: CUSTOM_SKILLS_PLUGIN_NAME,
      });
      includedNames.add(CUSTOM_SKILLS_PLUGIN_NAME);
    }
  } catch (error) {
    log.warn(`Failed to build custom-skills plugin options: ${error}`);
  }

  return sdkPlugins;
}

/**
 * Build MCP server configuration for Claude SDK from enabled plugin-embedded MCP servers.
 */
function resolveEnvReferences(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Resolve ${VAR_NAME} references from process.env
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (match) {
      resolved[key] = process.env[match[1]] || "";
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve ${CLAUDE_PLUGIN_ROOT} and relative paths in MCP server command/args.
 * Uses the server's mcpJsonDir or the parent plugin's path as the base directory.
 */
function resolveServerPaths(server: McpServerConfig, pluginPath?: string): { command?: string; args?: string[] } {
  const baseDir = server.mcpJsonDir || pluginPath;
  if (!baseDir) return { command: server.command, args: server.args };

  const resolvePath = (value: string): string => {
    // Replace ${CLAUDE_PLUGIN_ROOT} with the base directory
    const replaced = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, baseDir);
    // If still relative after replacement, resolve against baseDir
    if (!isAbsolute(replaced)) {
      return resolve(baseDir, replaced);
    }
    return replaced;
  };

  return {
    command: server.command ? resolvePath(server.command) : server.command,
    args: server.args?.map(resolvePath),
  };
}

function buildMcpServerOptions(): { mcpServers: Record<string, any>; allowedTools: string[]; resolvedEnvVars: Record<string, string> } | undefined {
  try {
    const mcpServers = getEnabledMcpServers();
    if (mcpServers.length === 0) return undefined;

    // Build a map of plugin ID → plugin path for resolving MCP server paths
    const appPlugins = getEnabledAppPlugins();
    const pluginPathMap = new Map<string, string>();
    for (const plugin of appPlugins) {
      pluginPathMap.set(plugin.id, plugin.pluginPath);
    }

    const serverConfig: Record<string, any> = {};
    const allowedTools: string[] = [];
    // Collect all resolved env vars so they can be propagated to the CLI subprocess.
    // Plugins loaded by the CLI re-read .mcp.json and resolve ${VAR} templates from
    // process.env, so we must ensure these vars are present in the subprocess environment.
    const resolvedEnvVars: Record<string, string> = {};

    for (const server of mcpServers) {
      const resolvedEnv = server.env ? resolveEnvReferences(server.env) : undefined;
      if (resolvedEnv) {
        Object.assign(resolvedEnvVars, resolvedEnv);
      }
      if (server.type === "stdio") {
        const pluginPath = pluginPathMap.get(server.sourcePluginId);
        const { command, args } = resolveServerPaths(server, pluginPath);
        serverConfig[server.name] = {
          command,
          args: args || [],
          ...(resolvedEnv && { env: resolvedEnv }),
        };
      } else {
        // HTTP/SSE type
        serverConfig[server.name] = {
          type: server.type,
          url: server.url,
          ...(server.headers && { headers: server.headers }),
          ...(resolvedEnv && { env: resolvedEnv }),
        };
      }
      allowedTools.push(`mcp__${server.name}__*`);
    }

    if (Object.keys(serverConfig).length === 0) return undefined;

    return { mcpServers: serverConfig, allowedTools, resolvedEnvVars };
  } catch (error) {
    log.warn(`Failed to build MCP server options: ${error}`);
    return undefined;
  }
}

/**
 * Create a HookCallback that executes a shell command.
 * Receives HookInput as JSON on stdin, expects HookJSONOutput as JSON on stdout.
 */
function createCommandHookCallback(command: string, pluginPath: string, hookTimeout?: number, hookAskOverride?: { reason: string }): HookCallback {
  return async (input: HookInput, toolUseId: string | undefined, { signal }: { signal: AbortSignal }) => {
    return new Promise<HookJSONOutput>((resolvePromise) => {
      const timeout = (hookTimeout ?? 60) * 1000;
      const child = execFile("bash", ["-c", command], { timeout, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginPath } }, (error, stdout) => {
        if (error) {
          log.warn(`Hook command failed: ${command} — ${error.message}`);
          resolvePromise({ continue: true });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          // When a hook returns permissionDecision "ask", stash the reason
          // so canUseTool can skip auto-approval and prompt the user.
          if (hookAskOverride && result?.hookSpecificOutput?.permissionDecision === "ask") {
            hookAskOverride.reason = result.hookSpecificOutput.permissionDecisionReason || "Hook requested user approval";
          }
          resolvePromise(result);
        } catch {
          log.warn(`Hook command returned non-JSON output: ${command} — ${stdout.slice(0, 200)}`);
          resolvePromise({ continue: true });
        }
      });

      signal.addEventListener("abort", () => child.kill(), { once: true });

      if (child.stdin) {
        child.stdin.write(JSON.stringify({ ...input, tool_use_id: toolUseId }));
        child.stdin.end();
      }
    });
  };
}

/**
 * Build SDK hooks from all enabled plugins' hook configurations.
 * Merges hooks across plugins by event type, resolving ${CLAUDE_PLUGIN_ROOT} in commands.
 */
function buildHookOptions(hookAskOverride?: { reason: string }): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  try {
    const appPlugins = getEnabledAppPlugins();
    const mergedHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
    let hookCount = 0;

    for (const plugin of appPlugins) {
      if (!plugin.hooksConfig?.hooks) continue;

      for (const [eventName, matchers] of Object.entries(plugin.hooksConfig.hooks)) {
        if (!Array.isArray(matchers)) continue;

        const hookEvent = eventName as HookEvent;
        if (!mergedHooks[hookEvent]) {
          mergedHooks[hookEvent] = [];
        }

        for (const matcher of matchers) {
          const callbacks: HookCallback[] = [];

          for (const hookEntry of matcher.hooks) {
            if (hookEntry.type === "command" && hookEntry.command) {
              const resolvedCommand = hookEntry.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.pluginPath);
              callbacks.push(createCommandHookCallback(resolvedCommand, plugin.pluginPath, hookEntry.timeout ?? matcher.timeout, hookAskOverride));
              hookCount++;
            }
          }

          if (callbacks.length > 0) {
            mergedHooks[hookEvent]!.push({
              matcher: matcher.matcher,
              hooks: callbacks,
              timeout: matcher.timeout,
            });
          }
        }
      }
    }

    if (hookCount === 0) return undefined;
    log.info(`Built ${hookCount} hook callback(s) from enabled plugins`);
    return mergedHooks;
  } catch (error) {
    log.warn(`Failed to build hook options: ${error}`);
    return undefined;
  }
}

export function getActiveSession(chatId: string): ActiveSession | undefined {
  const info = sessionRegistry.get(chatId);
  if (!info || !info.abortController || !info.emitter) return undefined;
  return { abortController: info.abortController, emitter: info.emitter };
}

export function hasPendingRequest(chatId: string): boolean {
  return pendingRequests.has(chatId);
}

export function getPendingRequest(chatId: string): Omit<PendingRequest, "resolve"> | null {
  const p = pendingRequests.get(chatId);
  if (!p) return null;
  const { resolve: _, ...rest } = p;
  return rest;
}

export function respondToPermission(
  chatId: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
): { ok: boolean; toolName?: string } {
  const pending = pendingRequests.get(chatId);
  if (!pending) return { ok: false };
  const toolName = pending.toolName;
  pendingRequests.delete(chatId);

  if (allow) {
    // For AskUserQuestion the frontend only sends back the collected `answers`.
    // The SDK tool requires the original `questions` to remain in the input
    // (it builds `{...input, answers}`), so merge rather than replace — otherwise
    // `questions` is undefined and the tool crashes mapping over it.
    const resolvedInput = updatedInput && pending.eventType === "user_question" ? { ...pending.input, ...updatedInput } : updatedInput || pending.input;
    pending.resolve({
      behavior: "allow",
      updatedInput: resolvedInput,
      updatedPermissions: updatedPermissions as any,
    });
  } else {
    pending.resolve({ behavior: "deny", message: "User denied", interrupt: true });
  }
  return { ok: true, toolName };
}

export function stopSession(chatId: string): boolean {
  const info = sessionRegistry.get(chatId);
  if (info && info.abortController) {
    info.abortController.abort();
    sessionRegistry.unregister(chatId);
    pendingRequests.delete(chatId);
    return true;
  }
  return false;
}

/**
 * Build the SDK prompt from text and optional images.
 * Returns either a plain string or an AsyncIterable<SDKUserMessage> for multimodal content.
 */
function buildFormattedPrompt(prompt: string | any, imageMetadata?: { buffer: Buffer; mimeType: string }[]): string | AsyncIterable<any> {
  if (!imageMetadata || imageMetadata.length === 0) {
    return prompt;
  }

  // Build content array for multimodal message (Anthropic API format)
  const content: any[] = [];

  if (prompt && prompt.trim()) {
    content.push({ type: "text", text: prompt.trim() });
  }

  for (const { buffer, mimeType } of imageMetadata) {
    const base64 = buffer.toString("base64");
    content.push({
      type: "image",
      source: { type: "base64", media_type: mimeType, data: base64 },
    });
  }

  // SDK expects AsyncIterable<SDKUserMessage> for multimodal content
  const sdkMessage = {
    type: "user" as const,
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
  };

  return (async function* () {
    yield sdkMessage;
  })();
}

/**
 * Build the canUseTool permission handler for the Claude SDK.
 * Uses a getter function for the tracking ID since it may change mid-session (new chat flow).
 */
export function buildCanUseTool(
  emitter: EventEmitter,
  toolPermissionPolicy: ToolPermissionPolicy,
  getTrackingId: () => string,
  hookAskOverride?: { reason: string },
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    { signal, suggestions }: { signal: AbortSignal; suggestions?: readonly unknown[] },
  ): Promise<PermissionResult> => {
    // If a PreToolUse hook flagged "ask", skip auto-approval and prompt the user
    // regardless of default permissions.
    const hookOverrideReason = hookAskOverride?.reason || "";
    if (hookOverrideReason) {
      hookAskOverride!.reason = ""; // reset for next tool call
      log.info(`[PERM-DIAG] Hook override ASK: tool=${toolName}, reason=${hookOverrideReason}`);
      // Fall through to the permission prompt below
    } else {
      try {
        const { decision, category } = toolPermissionPolicy.decide(toolName);
        log.info(`[PERM-DIAG] tool=${toolName}, category=${category}, decision=${decision}`);
        if (decision === "allow") {
          return { behavior: "allow", updatedInput: input };
        }
        if (decision === "deny") {
          return { behavior: "deny", message: `Auto-denied by default ${category} policy`, interrupt: true };
        }
        // "ask" — fall through to the user-prompt path
      } catch (err) {
        log.info(`[PERM-DIAG] ERROR in permission lookup: tool=${toolName}, error=${err}`);
        // If lookup fails, fall through to normal permission flow
      }
    }

    return new Promise<PermissionResult>((resolve) => {
      if (toolName === "AskUserQuestion") {
        emitter.emit("event", {
          type: "user_question",
          content: "",
          questions: input.questions as unknown[],
        } as StreamEvent);
      } else if (toolName === "ExitPlanMode") {
        emitter.emit("event", {
          type: "plan_review",
          content: JSON.stringify(input),
        } as StreamEvent);
      } else {
        emitter.emit("event", {
          type: "permission_request",
          content: "",
          toolName,
          input,
          suggestions,
        } as StreamEvent);
      }

      let eventType: PendingRequest["eventType"];
      let eventData: Record<string, unknown>;
      if (toolName === "AskUserQuestion") {
        eventType = "user_question";
        eventData = { questions: input.questions };
      } else if (toolName === "ExitPlanMode") {
        eventType = "plan_review";
        eventData = { content: JSON.stringify(input) };
      } else {
        eventType = "permission_request";
        eventData = { toolName, input, suggestions };
      }

      const trackingId = getTrackingId();
      pendingRequests.set(trackingId, { toolName, input, suggestions, eventType, eventData, resolve });

      signal.addEventListener("abort", () => {
        pendingRequests.delete(trackingId);
        resolve({ behavior: "deny", message: "Aborted" });
      });
    });
  };
}

/**
 * Host handler for the OpenRouter library's `ask_user_question` tool.
 *
 * The OR tool calls this with a single question + lettered options and awaits a
 * {@link OrUserQuestionResponse}. We reuse callboard's existing question flow:
 * emit the same `user_question` SSE event the Claude path uses (so the
 * FeedbackPanel renders it) and register a pending request keyed by the current
 * tracking id, so the `/permission-response` endpoint → respondToPermission
 * resolves it. The frontend returns answers keyed by question text with the
 * chosen option's *label*; we map that back to the option id the library wants.
 *
 * The OR library single-question shape can't express Claude's multi-question /
 * multi-select form — we wrap the one question into a length-1 questions array.
 * The library enforces its own timeout (≤10 min), so no timeout is added here;
 * abort cleanup resolves the promise so the run can't hang on a stale pending.
 */
type OrUserQuestionRequest = {
  questionId: string;
  question: string;
  options: Array<{ id: string; label: string; preview?: string }>;
  allowFreeText?: boolean;
};
type OrUserQuestionResponse = {
  questionId: string;
  selectedOptionId?: string;
  freeTextAnswer?: string;
};

export function buildOnAskUserQuestion(emitter: EventEmitter, getTrackingId: () => string, signal: AbortSignal) {
  return (req: OrUserQuestionRequest): Promise<OrUserQuestionResponse> =>
    new Promise<OrUserQuestionResponse>((resolve) => {
      const questions = [
        {
          question: req.question,
          multiSelect: false,
          options: req.options.map((o) => ({
            label: o.label,
            ...(o.preview !== undefined && { description: o.preview }),
          })),
        },
      ];

      emitter.emit("event", { type: "user_question", content: "", questions } as StreamEvent);

      const trackingId = getTrackingId();
      let settled = false;
      const finish = (response: OrUserQuestionResponse): void => {
        if (settled) return;
        settled = true;
        pendingRequests.delete(trackingId);
        resolve(response);
      };

      pendingRequests.set(trackingId, {
        toolName: "ask_user_question",
        input: { questions },
        eventType: "user_question",
        eventData: { questions },
        resolve: (result: PermissionResult) => {
          if (result.behavior !== "allow") {
            // Denied/aborted — return no selection; the library surfaces this
            // as an answerless result and the model can decide how to proceed.
            finish({ questionId: req.questionId });
            return;
          }
          const answers = ((result.updatedInput as Record<string, unknown> | undefined)?.answers ?? {}) as Record<string, string>;
          const chosen = answers[req.question];
          const matched = req.options.find((o) => o.label === chosen);
          if (matched) {
            finish({ questionId: req.questionId, selectedOptionId: matched.id });
          } else if (typeof chosen === "string") {
            // "Other"/free-text answer (or label drift) — hand the raw text back.
            finish({ questionId: req.questionId, freeTextAnswer: chosen });
          } else {
            finish({ questionId: req.questionId });
          }
        },
      });

      signal.addEventListener("abort", () => finish({ questionId: req.questionId }), { once: true });
    });
}

interface SendMessageOptions {
  prompt: string | any;
  imageMetadata?: { buffer: Buffer; mimeType: string }[];
  activePlugins?: string[];
  /** For existing chats: the chat ID to continue */
  chatId?: string;
  /** For new chats: the working directory (used as cwd for the SDK, also stored with chat) */
  folder?: string;
  /** For new chats: initial permission settings */
  defaultPermissions?: DefaultPermissions;
  /** Maximum number of agent turns before stopping (default: 200) */
  maxTurns?: number;
  /** Agent identity prompt — appended to Claude Code's preset system prompt */
  systemPrompt?: string;
  /** Agent alias — when set, injects Callboard custom tools MCP server into the session */
  agentAlias?: string;
  /** Whether this chat was triggered by an automated system (cron, trigger, heartbeat, etc.) */
  triggered?: boolean;
  /** How this chat was triggered — stored in metadata for icon distinction */
  triggeredBy?: "cron" | "event" | "trigger" | "tool" | "job";
  /**
   * Set by the job runner when this session executes a job step. Tags the
   * chat metadata (jobRunId/jobStepId) and injects the job-tools MCP server
   * (complete_job_step) unless the session is advisory.
   */
  jobContext?: import("./job-runner.js").JobContext;
  /**
   * Which agent provider runs this chat. Only honored for new chats —
   * existing chats route by the `provider` field already in their metadata.
   * Defaults to `"claude-code"` when omitted; `"openrouter"` is rejected at
   * the sendMessage boundary if OPENROUTER_API_KEY isn't configured.
   */
  provider?: AgentProviderKind;
  /**
   * Reasoning-effort level. Honored for new chats on the reasoning-capable
   * providers — `provider: "openrouter"` (→ OR `reasoning.effort`) and
   * `provider: "codex"` (→ Codex `modelReasoningEffort`) — written into chat
   * metadata so existing-chat follow-ups reuse the same setting without the
   * caller threading it through. Omitted entirely when undefined (preserves each
   * model's default). Ignored when paired with `claude-code`.
   */
  effort?: EffortLevel;
  /**
   * Model for this chat. Only honored for new chats — written into chat
   * metadata so existing-chat follow-ups reuse it.
   *
   * For `provider: "openrouter"`: an OR slug (e.g. "anthropic/claude-opus-4.7")
   * or an alias like "~anthropic/claude-sonnet-latest". Falls back to the
   * global `agentSettings.openRouterModel` when omitted.
   *
   * For `provider: "claude-code"` (or omitted provider): an Anthropic model
   * alias ("opus", "sonnet", "haiku", "opusplan") or full model ID (e.g.
   * "claude-sonnet-4-6"), passed to the SDK as `options.model`. When omitted,
   * the SDK default applies — including the global ANTHROPIC_MODEL env
   * override from Settings → API.
   */
  model?: string;
  /**
   * When true, the session is not considered done until it explicitly calls
   * a completion tool: objective_complete (injected for this run) for normal
   * sessions, or complete_job_step for job-step sessions. If the message
   * stream ends without that call, the session is resumed with a nudge
   * prompt — up to `maxNudges` times — before giving up with done reason
   * "objective_incomplete". Persisted into chat metadata for new chats so
   * follow-up messages inherit it; pass an explicit boolean on an existing
   * chat to override for that message only. Default: false (current
   * behavior — the session ends when the stream ends).
   */
  requireExplicitCompletion?: boolean;
  /**
   * Max nudge re-prompts per message when requireExplicitCompletion is set
   * (default: 3).
   */
  maxNudges?: number;
}

/** Default number of times a requiring session is nudged to continue before giving up. */
const DEFAULT_MAX_NUDGES = 3;

/**
 * Unified message sending function.
 * Handles both existing chats (provide chatId) and new chats (provide folder).
 * For new chats, creates the chat record when session_id arrives from the SDK
 * and emits a "chat_created" event so the frontend can navigate.
 */
export async function sendMessage(opts: SendMessageOptions): Promise<EventEmitter> {
  const { prompt, imageMetadata, activePlugins, defaultPermissions } = opts;
  const isNewChat = !opts.chatId;
  log.debug(`sendMessage — isNewChat=${isNewChat}, folder=${opts.folder || "n/a"}, chatId=${opts.chatId || "n/a"}`);

  // Resolve chat context: existing chat or new chat setup
  let folder: string; // Working directory for the SDK (may be a worktree) — also stored with the chat
  let resumeSessionId: string | undefined;
  let initialMetadata: Record<string, any>;

  if (opts.chatId) {
    // Existing chat flow — check file storage first, then fall back to filesystem.
    // CLI-created conversations only exist as JSONL files in ~/.claude/projects/
    // and won't have a record in data/chats/ until they're first used from the UI.
    let chat = chatFileService.getChat(opts.chatId);
    if (!chat) {
      // Filesystem fallback: find the session log and create a file storage record
      // so that subsequent interactions (permission tracking, metadata updates) work.
      const fsChat = findChat(opts.chatId, false);
      if (!fsChat) throw new Error("Chat not found");
      log.debug(`Chat ${opts.chatId} found via filesystem fallback, creating file storage record`);
      chat = chatFileService.upsertChat(fsChat.id, fsChat.folder, fsChat.session_id, { metadata: fsChat.metadata });
    }
    folder = chat.folder;
    resumeSessionId = chat.session_id;
    initialMetadata = JSON.parse(chat.metadata || "{}");
    // Recover agentAlias from chat metadata when not explicitly provided.
    // This ensures Callboard tools are re-injected when resuming an agent session.
    if (!opts.agentAlias && initialMetadata.agentAlias) {
      opts.agentAlias = initialMetadata.agentAlias;
      log.debug(`Recovered agentAlias="${opts.agentAlias}" from chat metadata for chatId=${opts.chatId}`);
    }
    // Recover the explicit-completion requirement from chat metadata so
    // follow-up messages inherit it. An explicit boolean from the caller
    // overrides for this message only (metadata stays as-is).
    if (opts.requireExplicitCompletion === undefined && initialMetadata.requireExplicitCompletion === true) {
      opts.requireExplicitCompletion = true;
    }
    stopSession(opts.chatId);
  } else if (opts.folder) {
    // New chat flow — store the actual working directory (may be a worktree).
    // The SDK creates logs keyed by this path, so we must preserve it exactly.
    folder = opts.folder;
    resumeSessionId = undefined;
    initialMetadata = {
      ...(defaultPermissions && { defaultPermissions }),
      ...(opts.agentAlias && { agentAlias: opts.agentAlias }),
      ...(opts.triggered && { triggered: true }),
      ...(opts.triggeredBy && { triggeredBy: opts.triggeredBy }),
      // Tag job-step chats so the UI can badge them and link to the run.
      ...(opts.jobContext && { jobRunId: opts.jobContext.runId, jobStepId: opts.jobContext.stepId }),
      // Pin the provider for the lifetime of this chat. Once written here,
      // the metadata-routing block below sees it and getAgentProvider()
      // returns the matching adapter for every subsequent message in the
      // chat. Only write a value that resolveProviderKind would route —
      // unknown strings would log a warn on every message in the chat,
      // and "claude-code" is the default so writing it is redundant.
      ...(opts.provider && ROUTABLE_PROVIDER_KINDS.has(opts.provider) && opts.provider !== "claude-code" && { provider: opts.provider }),
      // Pin reasoning-effort alongside the provider. Meaningful for the two
      // reasoning-capable providers — openrouter (→ OR `reasoning.effort`) and
      // codex (→ Codex `modelReasoningEffort`); their config blocks below pull it
      // out of metadata. The stream.ts boundary already drops `effort` when the
      // paired provider can't use it, so this second guard is defense-in-depth.
      ...(opts.effort &&
        (opts.provider === "openrouter" || opts.provider === "codex") && { effort: opts.effort }),
      // Pin the per-chat model alongside provider/effort. Meaningful for both
      // user-facing providers: openrouter chats prefer it over the global
      // agentSettings.openRouterModel (OR config block below); claude-code
      // chats pass it to the SDK as options.model. Ignored for other
      // providers (codex/mock).
      ...(opts.model && (opts.provider === "openrouter" || (opts.provider ?? "claude-code") === "claude-code") && { model: opts.model }),
      // Pin the explicit-completion requirement so follow-up messages to
      // this chat keep nudging for objective_complete without every caller
      // having to re-thread the flag.
      ...(opts.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
    };
    // Record initial branch for drift detection on subsequent messages
    const gitInfo = getGitInfo(folder);
    if (gitInfo.branch) {
      initialMetadata.lastBranch = gitInfo.branch;
    }
  } else {
    throw new Error("Either chatId or folder is required");
  }

  // Resolve which agent provider runs this chat. Existing chats with no
  // `provider` in metadata fall back to "claude-code" (preserves all current
  // behavior). New chats default to "claude-code" too; the OpenRouter route
  // is wired up but unreachable until the New Chat UI starts writing
  // `provider: "openrouter"` into metadata (PR D).
  //
  // Validate explicitly rather than casting — `??` only triggers on
  // null/undefined, so a corrupted metadata value like `provider: ""` or
  // `provider: "garbage"` would otherwise hit the factory's exhaustiveness
  // throw and 500 the user's chat permanently.
  const providerKind = resolveProviderKind(initialMetadata.provider);
  const agentProvider = getAgentProvider(providerKind);

  // ── Explicit completion ("Ralph loop") setup ──
  // Job steps already report through complete_job_step and the runner's
  // pendingResult — for them the nudge loop watches that instead of the
  // objective store, and the objective-tools server is not injected.
  const requireCompletion = opts.requireExplicitCompletion === true;
  const isJobStepSession = !!opts.jobContext && !opts.jobContext.advisory;
  const completionToolName = isJobStepSession ? "complete_job_step" : "objective_complete";
  const maxNudges = Math.max(0, opts.maxNudges ?? DEFAULT_MAX_NUDGES);
  if (requireCompletion && opts.chatId && !isJobStepSession) {
    // A new requiring run needs a fresh objective_complete call — drop any
    // completion left over from a previous message and clear the UI badge.
    clearObjectiveCompletion(opts.chatId);
    if (initialMetadata.objectiveComplete) {
      delete initialMetadata.objectiveComplete;
      chatFileService.updateChatMetadata(opts.chatId, { objectiveComplete: null });
      sessionRegistry.notifyMetadata(opts.chatId, { objectiveComplete: null });
    }
  }

  const emitter = new EventEmitter();
  const abortController = new AbortController();

  // Mutable tracking ID: for new chats starts as a temp ID, migrates to real chatId on session_id arrival
  let trackingId = opts.chatId || `new-${Date.now()}`;
  sessionRegistry.register(trackingId, { type: "web", abortController, emitter });

  const formattedPrompt = buildFormattedPrompt(prompt, imageMetadata);

  const getDefaultPermissions = (): DefaultPermissions | null => {
    if (isNewChat) {
      // For new chats, use the permissions passed directly
      log.info(`[PERM-DIAG] getDefaultPermissions: isNewChat=true, raw=${JSON.stringify(defaultPermissions)}`);
      return defaultPermissions ?? null;
    }
    // Re-read from file so mid-conversation permission changes take effect immediately
    try {
      const freshChat = chatFileService.getChat(opts.chatId!);
      if (freshChat) {
        const freshMeta = JSON.parse(freshChat.metadata || "{}");
        if (freshMeta.defaultPermissions) {
          log.info(`[PERM-DIAG] getDefaultPermissions: isNewChat=false, fresh=${JSON.stringify(freshMeta.defaultPermissions)}`);
          return freshMeta.defaultPermissions;
        }
      }
    } catch (err) {
      log.error(`[PERM-DIAG] Error re-reading permissions for ${opts.chatId}: ${err}`);
    }
    // Fall back to initial metadata if re-read fails
    log.info(`[PERM-DIAG] getDefaultPermissions: isNewChat=false, fallback=${JSON.stringify(initialMetadata.defaultPermissions)}`);
    return initialMetadata.defaultPermissions ?? null;
  };

  // Policy: Claude-specific tool-name → category map, neutral allow/deny/ask
  // decision over the user's default-permission settings.
  const toolPermissionPolicy = new ToolPermissionPolicy(categorizeClaudeTool, getDefaultPermissions);

  // Always build plugin options (includes app-wide plugins even when no per-directory plugins are active)
  const plugins = buildPluginOptions(folder, activePlugins);
  const mcpOpts = buildMcpServerOptions();
  // Shared state: when a PreToolUse hook returns permissionDecision "ask",
  // the reason is stashed here so canUseTool can skip auto-approval and
  // prompt the user instead.
  const hookAskOverride: { reason: string } = { reason: "" };
  const hookOpts = buildHookOptions(hookAskOverride);

  // Build MCP servers map: start with configured servers, add Callboard agent tools if this is an agent session
  const mcpServers: Record<string, any> = mcpOpts ? { ...mcpOpts.mcpServers } : {};
  const allowedTools: string[] = mcpOpts ? [...mcpOpts.allowedTools] : [];

  // ── Callboard platform tools: injected for ALL sessions (regular + agent) ──
  try {
    const spec = buildCallboardToolsSpec(
      () => trackingId,
      () => opts.agentAlias,
      // Agent sessions get the job management tools on the "callboard" agent
      // server (alongside deploy_agent etc.) — skip them here to avoid duplicates.
      { includeJobTools: !opts.agentAlias },
    );
    const server = agentProvider.buildToolServer(spec);
    if (server) {
      mcpServers["callboard-tools"] = server;
      allowedTools.push("mcp__callboard-tools__*");
      log.info("Injected callboard-tools MCP server");
    }
  } catch (err: any) {
    log.error(`Failed to build callboard-tools server: ${err.message}`);
  }

  // ── Job step tools: injected only for job runner step sessions ──
  if (opts.jobContext && !opts.jobContext.advisory) {
    try {
      const spec = buildJobStepToolsSpec(() => opts.jobContext);
      const server = agentProvider.buildToolServer(spec);
      if (server) {
        mcpServers["job-tools"] = server;
        allowedTools.push("mcp__job-tools__*");
        log.info(`Injected job-tools MCP server (run=${opts.jobContext.runId}, step=${opts.jobContext.stepId})`);
      }
    } catch (err: any) {
      log.error(`Failed to build job-tools server: ${err.message}`);
    }
  }

  // ── Objective tools: injected only when explicit completion is required ──
  // Job steps are excluded — they report through complete_job_step above.
  if (requireCompletion && !isJobStepSession) {
    try {
      const spec = buildObjectiveToolsSpec(() => trackingId);
      const server = agentProvider.buildToolServer(spec);
      if (server) {
        mcpServers["objective-tools"] = server;
        allowedTools.push("mcp__objective-tools__*");
        log.info("Injected objective-tools MCP server (explicit completion required)");
      }
    } catch (err: any) {
      log.error(`Failed to build objective-tools server: ${err.message}`);
    }
  }

  // ── Proxy tools: injected for ALL sessions (regular + agent) ──
  const agentSettings = getAgentSettings();
  const activeMcpConfigDir = getActiveMcpConfigDir();
  let proxyKeyAlias = "default";
  if (agentSettings.proxyMode && activeMcpConfigDir) {
    // Determine key alias: agent's alias if available, otherwise "default"
    const proxyAgent = opts.agentAlias ? getAgent(opts.agentAlias) : undefined;
    proxyKeyAlias = proxyAgent ? (resolveAgentKeyAlias(proxyAgent).mcpKeyAlias ?? "default") : "default";

    try {
      const spec = buildProxyToolsSpec(proxyKeyAlias);
      const server = agentProvider.buildToolServer(spec);
      if (server) {
        mcpServers["mcp-proxy"] = server;
        allowedTools.push("mcp__mcp-proxy__*");
        log.info(`Injected proxy tools (mode=${agentSettings.proxyMode}, alias=${proxyKeyAlias})`);
      }
    } catch (err: any) {
      log.error(`Failed to build proxy tools server: ${err.message}`);
    }
  }

  // Resolve the agent's MCP key alias for proxy identity.
  // When an agent has mcpKeyAlias set, inject MCP_KEY_ALIAS into each MCP server's
  // env and into the subprocess env so the drawlatch plugin uses the correct
  // caller key identity (keys/callers/<alias>/).
  let agentMcpKeyAlias: string | undefined;
  if (opts.agentAlias) {
    const agentConfig = getAgent(opts.agentAlias);
    agentMcpKeyAlias = agentConfig ? resolveAgentKeyAlias(agentConfig).mcpKeyAlias : undefined;

    if (agentMcpKeyAlias) {
      // Override MCP_KEY_ALIAS in each MCP server's env that declares it
      for (const serverName of Object.keys(mcpServers)) {
        const server = mcpServers[serverName];
        if (server.env && "MCP_KEY_ALIAS" in server.env) {
          server.env = { ...server.env, MCP_KEY_ALIAS: agentMcpKeyAlias };
        }
      }
      log.debug(`Set MCP_KEY_ALIAS="${agentMcpKeyAlias}" for agent=${opts.agentAlias}`);
    }

    try {
      const spec = buildAgentToolsSpec(opts.agentAlias);
      const server = agentProvider.buildToolServer(spec);
      if (server) {
        mcpServers["callboard"] = server;
        allowedTools.push("mcp__callboard__*");
        log.info(`Injected Callboard agent tools for agent="${opts.agentAlias}" (spec.name=${spec.name}, ${spec.tools.length} tools)`);
      } else {
        log.error(`buildAgentToolsSpec produced no server for agent="${opts.agentAlias}"`);
      }
    } catch (err: any) {
      log.error(`Failed to build Callboard agent tools for agent="${opts.agentAlias}": ${err.message}`);
    }
  }

  const hasMcpServers = Object.keys(mcpServers).length > 0;

  // When MCP servers are present, the SDK requires an AsyncIterable prompt.
  // Wrap string/non-iterable prompts in an async generator.
  let effectivePrompt = formattedPrompt;
  if (hasMcpServers && typeof formattedPrompt === "string") {
    effectivePrompt = (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: formattedPrompt },
      };
    })();
  }

  // Log MCP server configuration for debugging
  if (hasMcpServers) {
    const serverSummary = Object.entries(mcpServers)
      .map(([key, val]: [string, any]) => `${key}(${val.type || "stdio"})`)
      .join(", ");
    log.info(`MCP servers for session: [${serverSummary}], allowedTools: [${allowedTools.join(", ")}]`);
  }

  const claudeExecutable = getClaudeCodeExecutablePath();

  // When explicit completion is required, tell the agent up front via the
  // system prompt — the nudge loop below is the enforcement, this is the
  // instruction. Rides alongside any caller-provided systemPrompt append.
  const completionInstruction = requireCompletion
    ? `This session requires explicit completion. When the objective is fully achieved, you MUST call the ${completionToolName} tool` +
      (isJobStepSession ? "" : " (optionally with a summary message and structured result data)") +
      " as the last thing you do. If your turn ends without that call, you will be re-prompted to continue working."
    : "";
  const systemPromptAppend = [opts.systemPrompt, completionInstruction].filter(Boolean).join("\n\n");

  // Per-chat Anthropic model override for claude-code chats. Read from chat
  // metadata (covers both new chats — just written above — and resumed chats
  // loaded from disk) and passed to the SDK as `options.model`, which maps to
  // the CLI's --model flag and takes precedence over the global
  // ANTHROPIC_MODEL env override from Settings → API. When unset, no model is
  // passed so the existing env-var / subscription default behavior is
  // unchanged. OR chats route their model through options.openRouter.model
  // instead (below).
  const claudeCodeModel =
    providerKind === "claude-code" && typeof initialMetadata.model === "string" && initialMetadata.model.trim().length > 0
      ? initialMetadata.model.trim()
      : undefined;

  const queryOpts: any = {
    prompt: effectivePrompt,
    options: {
      abortController,
      cwd: folder,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      ...(claudeCodeModel ? { model: claudeCodeModel } : {}),
      settingSources: ["user", "project", "local"],
      maxTurns: opts.maxTurns ?? 200,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(hasMcpServers ? { mcpServers, allowedTools } : {}),
      ...(hookOpts ? { hooks: hookOpts } : {}),
      ...(systemPromptAppend ? { systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend } } : {}),
      env: {
        ...process.env,
        // Propagate resolved MCP server env vars to the CLI subprocess so that plugins
        // loaded by the CLI can resolve ${VAR} templates in their .mcp.json files.
        ...(mcpOpts?.resolvedEnvVars ?? {}),
        // User-configured API / auth / model overrides from Settings → API.
        // Applied after process.env so they take precedence.
        ...getApiEnvOverrides(agentSettings),
        // Propagate agent's MCP key alias so CLI-level re-resolution of ${MCP_KEY_ALIAS}
        // in .mcp.json templates also picks up the correct identity.
        ...(agentMcpKeyAlias && { MCP_KEY_ALIAS: agentMcpKeyAlias }),
        // Remove CLAUDECODE to prevent "cannot be launched inside another Claude Code session" errors
        // when the backend was started from within a Claude Code session
        CLAUDECODE: undefined,
      },
      canUseTool: buildCanUseTool(emitter, toolPermissionPolicy, () => trackingId, hookAskOverride),
      stderr: (data: string) => {
        log.warn(`[SDK stderr] ${data.trimEnd()}`);
      },
    },
  };

  // For OpenRouter chats, surface the per-provider settings the OR adapter's
  // optionsAdapter looks for. Dormant until PR D writes provider:"openrouter"
  // into chat metadata — included now so PR D is a UI/settings PR with no
  // additional backend wiring required.
  if (providerKind === "openrouter") {
    const apiKey = agentSettings.openRouterApiKey?.trim();
    if (!apiKey) {
      const message = "OpenRouter chat selected but OPENROUTER_API_KEY is not configured in Settings → API.";
      log.error(message);
      throw new Error(message);
    }
    // Reasoning effort is per-chat (not a global setting) — it lives in
    // chat metadata and is recovered on every message in the chat. The
    // initialMetadata read above covers both the new-chat case (just
    // written) and the existing-chat case (loaded from disk).
    const chatEffort = initialMetadata.effort as EffortLevel | undefined;
    // Per-chat model override (from tool params, persisted to metadata) takes
    // precedence over the global default. Covers new chats (just written above)
    // and resumed chats (loaded from disk). Metadata stores the user-facing
    // value — possibly a custom alias like "low coder" — resolved to a real
    // slug here on every session start, so re-pointing an alias in Settings
    // applies to existing chats too.
    const requestedModel = (initialMetadata.model as string | undefined) || agentSettings.openRouterModel;
    const chatModel = resolveOpenRouterModel(requestedModel, agentSettings);
    // Server tools: map the persisted list to the harness's verbatim wire shape.
    // Left undefined when the setting is absent (harness injects its defaults);
    // an explicit empty array is preserved (disable all server tools).
    const serverTools = agentSettings.openRouterServerTools?.map(serverToolToWire);
    // Generation params: merge the global default with the resolved model's
    // per-model override profile, then flatten to the harness's modelParams bag.
    const modelParams = resolveModelParams(
      agentSettings.openRouterModelParamsDefault,
      chatModel ? agentSettings.openRouterModelParamProfiles?.[chatModel] : undefined,
    );
    queryOpts.options.openRouter = {
      apiKey,
      ...(agentSettings.openRouterBaseUrl && { baseUrl: agentSettings.openRouterBaseUrl }),
      ...(chatModel && { model: chatModel }),
      ...(agentSettings.openRouterLogsRoot && { logsRoot: agentSettings.openRouterLogsRoot }),
      ...(chatEffort && { effort: chatEffort }),
      ...(typeof agentSettings.openRouterMaxBudgetUsd === "number" &&
        Number.isFinite(agentSettings.openRouterMaxBudgetUsd) && {
          maxBudgetUsd: agentSettings.openRouterMaxBudgetUsd,
        }),
      ...(serverTools && { serverTools }),
      ...(modelParams && { modelParams }),
      appTitle: "callboard",
    };
    log.info(
      `OpenRouter chat config — trackingId=${trackingId}, model=${chatModel ?? "(default)"}` +
        `${requestedModel && requestedModel !== chatModel ? ` (alias "${requestedModel}")` : ""}, ` +
        `effort=${chatEffort ?? "(unset)"}, ` +
        `maxBudgetUsd=${queryOpts.options.openRouter.maxBudgetUsd ?? "(library default)"}, ` +
        `baseUrl=${queryOpts.options.openRouter.baseUrl ?? "(default)"}, ` +
        `logsRoot=${queryOpts.options.openRouter.logsRoot ?? "(default)"}, ` +
        `apiKeyTail=…${apiKey.slice(-4)}`,
    );
    // Wire the host handler for the OR ask_user_question tool, reusing the same
    // emitter + tracking-id getter the Claude permission flow uses so the
    // question UI and answer path behave identically across providers.
    queryOpts.options.onAskUserQuestion = buildOnAskUserQuestion(emitter, () => trackingId, abortController.signal);
    // Same shared ask-override cell buildCanUseTool (above) closes over. On
    // the Claude path the SDK runs our hook callbacks, which stash into it
    // directly; on the OR path the adapter runs plugin hooks itself, so it
    // needs the cell to honor a PreToolUse "ask" decision. The harness fires
    // PreToolUse hooks before canUseTool, so the stash-then-prompt sequencing
    // matches the Claude path exactly.
    queryOpts.options.hookAskOverride = hookAskOverride;
  }

  // For Codex chats, surface the per-provider settings the Codex adapter's
  // optionsAdapter looks for (the `codex` extras sub-object). Mirrors the
  // OpenRouter block above. Auth defaults to subscription (ChatGPT login via
  // $CODEX_HOME/auth.json — no key passed); api-key mode forwards the key/base
  // url. CODEX_HOME itself rides in via the subprocess env that
  // getApiEnvOverrides() already injected above, so it isn't repeated here.
  if (providerKind === "codex") {
    const authMode = agentSettings.codexAuthMode ?? "subscription";
    // api-key mode needs a key; subscription mode draws on the stored login.
    if (authMode === "api-key" && !agentSettings.codexApiKey?.trim()) {
      const message = "Codex chat selected in api-key mode but OPENAI_API_KEY is not configured in Settings → API.";
      log.error(message);
      throw new Error(message);
    }
    // Per-chat model override (persisted to metadata) takes precedence over the
    // global codexModel default. Covers new chats (just written above) and
    // resumed chats (loaded from disk).
    const requestedModel =
      (typeof initialMetadata.model === "string" && initialMetadata.model.trim()) || agentSettings.codexModel?.trim();
    // Per-chat reasoning effort (the OR-style control), persisted to metadata the
    // same way OR's is — maps onto Codex's modelReasoningEffort in the
    // optionsAdapter.
    const chatEffort = initialMetadata.effort as EffortLevel | undefined;
    // Permissions collapse onto Codex's sandbox + approval policy at thread
    // start (Codex has no per-call canUseTool hook). Surface them so the
    // optionsAdapter can derive the sandbox tier when no explicit one is set.
    const permissions = getDefaultPermissions() ?? undefined;
    queryOpts.options.codex = {
      authMode,
      ...(authMode === "api-key" && agentSettings.codexApiKey?.trim() && { apiKey: agentSettings.codexApiKey.trim() }),
      ...(authMode === "api-key" && agentSettings.codexBaseUrl?.trim() && { baseUrl: agentSettings.codexBaseUrl.trim() }),
      ...(requestedModel && { model: requestedModel }),
      ...(agentSettings.codexSandboxMode && { sandboxMode: agentSettings.codexSandboxMode }),
      ...(chatEffort && { reasoningEffort: chatEffort }),
      ...(permissions && { permissions }),
    };
    log.info(
      `Codex chat config — trackingId=${trackingId}, authMode=${authMode}, ` +
        `model=${requestedModel ?? "(default)"}, effort=${chatEffort ?? "(default)"}, ` +
        `sandbox=${agentSettings.codexSandboxMode ?? "(permission-derived)"}, ` +
        `codexHome=${agentSettings.codexHome?.trim() || "~/.codex"}` +
        `${authMode === "api-key" && agentSettings.codexApiKey ? `, apiKeyTail=…${agentSettings.codexApiKey.trim().slice(-4)}` : ""}`,
    );
  }

  log.debug(
    `SDK query options — provider=${providerKind}, cwd=${folder}, maxTurns=${queryOpts.options.maxTurns}, ` +
      `model=${queryOpts.options.model || "(default)"}, resume=${resumeSessionId || "none"}`,
  );

  (async () => {
    try {
      // Inject proxy connections listing into system prompt before starting the conversation
      if (agentSettings.proxyMode && activeMcpConfigDir) {
        try {
          const connectionsPrompt = await buildProxyConnectionsPrompt(proxyKeyAlias, agentSettings.proxyMode);
          if (connectionsPrompt) {
            const existingAppend = queryOpts.options.systemPrompt?.append || "";
            queryOpts.options.systemPrompt = {
              type: "preset",
              preset: "claude_code",
              append: existingAppend ? `${existingAppend}\n\n${connectionsPrompt}` : connectionsPrompt,
            };
            log.info(`Injected ${connectionsPrompt.split("\n").length} lines of proxy connections into system prompt`);
          }
        } catch (err: any) {
          log.warn(`Failed to build proxy connections prompt: ${err.message}`);
        }
      }

      let sessionId: string | null = null;
      let endReason: string | undefined;
      // When the provider terminates the run with status "error" (e.g. an
      // OpenRouter API error response — bad key, insufficient credits, rate
      // limit, invalid model), the human-readable message rides in the result
      // event's `reason`. Captured here so it can be surfaced to the user as a
      // hard error rather than discarded behind a generic end-of-session note.
      let errorDetail: string | undefined;
      // Cumulative USD spend reported by the underlying adapter on the
      // terminal `result` event. The OR adapter accumulates this across all
      // turns of the streaming-input run; the Claude adapter reports per-
      // message totals. Either way, the latest value is the run total to
      // surface to the UI for the spend indicator + max_budget message.
      let lastCostUsd: number | undefined;

      // The configured OR budget cap, resolved once so the mid-run `budget`
      // events (from per-turn cost beacons) and the final `done` advertise
      // the same ceiling. Surfaced on every `done` for OR chats so the UI
      // can show "$0.84 of $1.00" even on successful completions, not just
      // when max_budget fires. For Claude Code chats there's no equivalent
      // cap to surface — stays undefined.
      const orBudget =
        providerKind === "openrouter"
          ? typeof agentSettings.openRouterMaxBudgetUsd === "number" && Number.isFinite(agentSettings.openRouterMaxBudgetUsd)
            ? agentSettings.openRouterMaxBudgetUsd
            : OR_LIBRARY_DEFAULT_MAX_BUDGET_USD
          : undefined;

      // Whether the chat record exists yet — for new chats it's created on
      // the first session_started; nudge re-queries then take the
      // "existing chat" path and append their session ids.
      let chatRecordCreated = !isNewChat;
      // Completion predicate the nudge loop checks when the stream ends:
      // job steps satisfy it by recording a pendingResult via
      // complete_job_step; everything else via objective_complete.
      const isObjectiveSatisfied = (): boolean => {
        if (isJobStepSession) {
          const run = getJobRun(opts.jobContext!.runId);
          return run?.activeStep?.stepId === opts.jobContext!.stepId && run.activeStep.pendingResult !== undefined;
        }
        return hasObjectiveCompletion(trackingId);
      };
      let nudgesUsed = 0;

      // ── Query loop ──
      // Runs exactly once for normal sessions. When requireExplicitCompletion
      // is set and the stream ends without the completion tool having been
      // called, the session is resumed with a nudge prompt — same emitter,
      // same registry entry, so the UI sees one continuous run and
      // session_stopped (which drives onComplete callbacks and the job
      // runner's harvest) fires only after the loop truly ends.

      while (true) {
        const conversation = agentProvider.query(queryOpts);

        for await (const event of conversation) {
          if (abortController.signal.aborted) break;

          switch (event.type) {
            case "result": {
              // Always the last yielded event: tells us why the conversation ended.
              if (event.status === "max_turns") {
                endReason = "max_turns";
                log.warn(`Session ${trackingId} ended: max turns reached`);
              } else if (event.status === "max_budget") {
                endReason = "max_budget";
                log.warn(`Session ${trackingId} ended: max budget reached`);
              } else if (event.status === "error") {
                errorDetail = event.reason || "The model provider returned an error response.";
                log.error(`Session ${trackingId} (provider=${providerKind}) ended: execution error — ${event.reason || "unknown"}`);
              }
              if (typeof event.usage?.costUsd === "number") {
                lastCostUsd = event.usage.costUsd;
              }
              // "success" → endReason stays undefined (normal completion)
              break;
            }

            case "slash_commands":
              setSlashCommandsForDirectory(folder, event.commands);
              break;

            case "session_started": {
              // The adapter may re-emit this on subsequent messages; only act
              // on first arrival.
              if (sessionId) break;
              sessionId = event.sessionId;
              log.debug(`Session ID arrived: ${sessionId}`);

              if (!chatRecordCreated) {
                // New chat: create the chat record and migrate tracking from temp ID to real chat ID
                chatRecordCreated = true;
                initialMetadata.session_ids = [sessionId];
                const meta = { ...initialMetadata };
                log.debug(`Creating chat record — sessionId=${sessionId}, folder=${folder}`);
                const chat = chatFileService.upsertChat(sessionId, folder, sessionId, {
                  metadata: JSON.stringify(meta),
                });

                const oldTrackingId = trackingId;
                trackingId = sessionId;
                log.debug(`Migrated tracking ID: ${oldTrackingId} → ${trackingId}`);

                sessionRegistry.migrate(oldTrackingId, trackingId);

                const pending = pendingRequests.get(oldTrackingId);
                if (pending) {
                  pendingRequests.delete(oldTrackingId);
                  pendingRequests.set(trackingId, pending);
                }

                emitter.emit("event", {
                  type: "chat_created",
                  content: "",
                  chatId: sessionId,
                  chat: { ...chat, session_id: sessionId },
                } as StreamEvent);

                // Log chat activity for agent sessions
                if (initialMetadata.agentAlias) {
                  appendActivity(initialMetadata.agentAlias as string, {
                    type: "chat",
                    message: "Chat session started",
                    metadata: { chatId: sessionId },
                  });
                }

                // Generate a title for new manual (non-triggered) chats
                if (!opts.triggered) {
                  const promptText = typeof prompt === "string" ? prompt : null;
                  if (promptText) {
                    const chatId = trackingId;
                    generateChatTitle(promptText)
                      .then((title) => {
                        if (title) {
                          chatFileService.updateChatMetadata(chatId, { title });
                          log.debug(`Generated title for chat ${chatId}: "${title}"`);
                        }
                      })
                      .catch(() => {}); // Title generation is non-critical
                  }
                }
              } else {
                // Existing chat: append session_id to metadata
                const ids: string[] = initialMetadata.session_ids || [];
                if (!ids.includes(sessionId)) ids.push(sessionId);
                initialMetadata.session_ids = ids;
                chatFileService.upsertChat(trackingId, folder, sessionId, {
                  metadata: JSON.stringify(initialMetadata),
                });
              }
              break;
            }

            case "compaction_boundary":
              emitter.emit("event", { type: "compacting", content: event.content || "Conversation compacted" } as StreamEvent);
              break;

            case "text":
              emitter.emit("event", { type: "text", content: event.content } as StreamEvent);
              break;

            case "thinking":
              emitter.emit("event", { type: "thinking", content: event.content } as StreamEvent);
              break;

            case "tool_use":
              emitter.emit("event", {
                type: "tool_use",
                content: JSON.stringify(event.input),
                toolName: event.toolName,
                ...(event.toolSource && { toolSource: event.toolSource }),
              } as StreamEvent);
              break;

            case "tool_result":
              emitter.emit("event", {
                type: "tool_result",
                content: event.content,
                ...(event.toolSource && { toolSource: event.toolSource }),
              } as StreamEvent);
              break;

            case "adapter_specific": {
              // OR per-turn cost beacons → live `budget` StreamEvents. The
              // harness reports the CUMULATIVE run cost at each turn boundary;
              // forwarding it lets the UI move the spend indicator mid-run
              // instead of waiting for `done`. Track it as lastCostUsd too so
              // an abnormal end (e.g. abort before the result event) still has
              // the freshest spend on hand.
              if (event.adapter === "openrouter") {
                const payload = event.payload as { kind?: string; costUsd?: number } | null;
                if (payload?.kind === "turn_cost" && typeof payload.costUsd === "number") {
                  lastCostUsd = payload.costUsd;
                  emitter.emit("event", {
                    type: "budget",
                    content: "",
                    costUsd: payload.costUsd,
                    ...(typeof orBudget === "number" && { maxBudgetUsd: orBudget }),
                  } as StreamEvent);
                }
              }
              break;
            }
          }
        }

        // ── Nudge decision ──
        // Only nudge when explicit completion is required and the run ended
        // normally: user aborts, provider errors, /clear, and hard caps
        // (max_turns / max_budget) all end the session as before.
        if (!requireCompletion) break;
        if (abortController.signal.aborted || errorDetail !== undefined || endReason) break;
        if (typeof prompt === "string" && prompt.trim().toLowerCase() === "/clear") break;
        if (isObjectiveSatisfied()) break;
        if (nudgesUsed >= maxNudges) {
          endReason = "objective_incomplete";
          log.warn(`Session ${trackingId} ended without ${completionToolName} after ${nudgesUsed} nudge(s) — giving up`);
          break;
        }
        nudgesUsed++;
        log.info(`Session ${trackingId} stream ended without ${completionToolName} — nudging (${nudgesUsed}/${maxNudges})`);

        const nudgeText =
          `Your previous turn ended without calling the ${completionToolName} tool, but this session requires explicit completion. ` +
          `If the objective is fully achieved, call ${completionToolName} now${isJobStepSession ? "" : " (optionally with a message and result data)"}. ` +
          `Otherwise, continue working toward the objective.`;
        emitter.emit("event", {
          type: "nudge",
          content: nudgeText,
          reason: `nudge_${nudgesUsed}_of_${maxNudges}`,
        } as StreamEvent);

        // Resume the conversation we just watched end. `sessionId` was
        // captured from this iteration's session_started; reset it so the
        // resumed query's new session id is appended to the chat record.
        queryOpts.options.resume = sessionId ?? resumeSessionId;
        queryOpts.prompt = (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: nudgeText },
          };
        })();
        sessionId = null;
      }

      chatFileService.updateChat(trackingId, {});

      // Provider-level error: surface the actual error message to the user as a
      // hard error (red bubble) instead of a normal completion. Skips the
      // done/clear/budget path below — those describe a successful run.
      if (errorDetail !== undefined) {
        log.debug(`Session ${trackingId} surfaced provider error to user: ${errorDetail}`);
        emitter.emit("event", { type: "error", content: errorDetail } as StreamEvent);
        return;
      }

      // Detect /clear command — emit a cleared event before done so the frontend can show a marker
      if (typeof prompt === "string" && prompt.trim().toLowerCase() === "/clear") {
        log.debug(`Session cleared via /clear — trackingId=${trackingId}`);
        emitter.emit("event", { type: "cleared", content: "Conversation was cleared" } as StreamEvent);
      }

      // `orBudget` (hoisted above the event loop, shared with the mid-run
      // `budget` emissions) rides on the `done` here so the final spend
      // display always quotes the same cap the live indicator used.
      log.debug(`Session complete — trackingId=${trackingId}, reason=${endReason || "normal"}, costUsd=${lastCostUsd ?? "n/a"}`);
      emitter.emit("event", {
        type: "done",
        content: "",
        ...(endReason && { reason: endReason }),
        ...(typeof lastCostUsd === "number" && { costUsd: lastCostUsd }),
        ...(typeof orBudget === "number" && { maxBudgetUsd: orBudget }),
        // Whether the explicit-completion requirement was satisfied — only
        // attached when the requirement was on for this run.
        ...(requireCompletion && { objectiveComplete: isObjectiveSatisfied() }),
      } as StreamEvent);
    } catch (err: any) {
      if (err.name === "AbortError") {
        // Emit done with reason so the frontend knows the session was aborted,
        // rather than silently swallowing the event.
        log.warn(`Session ${trackingId} (provider=${providerKind}) ended: aborted`);
        chatFileService.updateChat(trackingId, {});
        emitter.emit("event", { type: "done", content: "", reason: "aborted" } as StreamEvent);
      } else {
        log.error(`Session ${trackingId} (provider=${providerKind}) error: ${err.message}${err.stack ? `\n${err.stack}` : ""}`);
        emitter.emit("event", { type: "error", content: err.message } as StreamEvent);
      }
    } finally {
      // Only clean up if the registry entry still belongs to THIS run. A
      // follow-up sendMessage to the same chat calls stopSession() and then
      // register()s a REPLACEMENT session under the same chatId — and this
      // (aborted) run's unwind can land seconds later. Unregistering here
      // unconditionally would tear down the replacement's registry entry
      // (and its pending permission request), making the UI lose track of a
      // run that is still active. stopSession() already cleaned up our own
      // entries when the replacement took over.
      if (sessionRegistry.get(trackingId)?.emitter === emitter) {
        sessionRegistry.unregister(trackingId);
        pendingRequests.delete(trackingId);
      }
    }
  })();

  return emitter;
}

// Register sendMessage as the message sender for agent-tools.ts (breaks circular dependency)
setMessageSender(sendMessage);

// Register sendMessage for callboard-tools.ts (breaks circular dependency)
setCallboardMessageSender(sendMessage);

// Register sendMessage for the shared agent executor (cron scheduler, heartbeats, event watcher)
import { setExecutorMessageSender } from "./agent-executor.js";
setExecutorMessageSender(sendMessage);

// Wire up the "phone home" completion handler: re-invokes parent chats when the
// child sessions they spawned (via start_chat_session onComplete) finish.
import { initSessionCompletionHandler } from "./session-completion-handler.js";
initSessionCompletionHandler({ sendMessage, getActiveSession });

// Register dependencies for the job runner (deterministic multi-step jobs).
import { setJobRunnerDeps } from "./job-runner.js";
setJobRunnerDeps({ sendMessage, stopSession, getActiveSession });
