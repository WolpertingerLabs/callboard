import { getAgentProvider } from "../agents/factory.js";
import { isInternalProvider, type AgentProviderKind, type AgentQuery } from "../agents/ports/AgentProvider.js";
import type { EffortLevel } from "../agents/adapters/openrouter/optionsAdapter.js";
import { OR_LIBRARY_DEFAULT_MAX_BUDGET_USD } from "../agents/adapters/openrouter/optionsAdapter.js";
import type { PermissionResult, HookEvent, HookCallbackMatcher, HookCallback, HookInput, HookJSONOutput } from "../agents/adapters/claude-code/types.js";
import { ToolPermissionPolicy } from "../agents/permissions/ToolPermissionPolicy.js";
import { getToolCategorizer } from "../agents/permissions/categorizers.js";
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
import { buildModelRoutingToolsSpec, takePendingModelSwitch, clearPendingModelSwitch } from "./model-routing-tools.js";
import { classifyAndResolve, getUsableRoutingConfig } from "./model-routing.js";
import { getRun as getJobRun } from "./job-store.js";
import {
  isStreamClosedToolFailure,
  isStreamClosedSessionError,
  buildStreamRecoveryPrompt,
  MAX_STREAM_RECOVERIES,
  STREAM_CLOSED_TOOL_FAILURE_THRESHOLD,
} from "./stream-recovery.js";
import { buildProxyToolsSpec } from "./proxy-tools.js";
import { ensureCallerEnrolled, fetchProxyRoutes } from "./proxy-singleton.js";
import {
  getAgentSettings,
  getActiveMcpConfigDir,
  resolveAgentKeyAlias,
  resolveDefaultCaller,
  getApiEnvOverrides,
  resolveModelAlias,
  resolveSessionModel,
  getClaudeCodeExecutablePath,
} from "./agent-settings.js";
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { appendActivity } from "./agent-activity.js";
import { getAgent } from "./agent-file-service.js";
import { generateChatTitle } from "./quick-completion.js";
import { createCard as createCardRecord, updateCard, getCard as getCardRecord, deleteCard as deleteCardRecord } from "./card-store.js";
import { sessionRegistry } from "./session-registry.js";
import { resolveParentage } from "./chat-lineage.js";
import { getGitInfo } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("claude");

export type { StreamEvent };

/**
 * Narrow a free-form metadata.provider value to a usable AgentProviderKind,
 * falling back to "claude-code" on anything unrecognized. Logs a warn for
 * malformed values so corrupted metadata is observable instead of silent.
 */
function resolveProviderKind(value: unknown): AgentProviderKind {
  if (typeof value !== "string" || value === "") return "claude-code";
  // Chat metadata, not a request body — so the internal list, which includes
  // kinds that have no picker yet. A chat already pinned to one of those must
  // keep routing there.
  if (isInternalProvider(value)) return value;
  log.warn(`Unknown chat metadata provider="${value}" — falling back to "claude-code"`);
  return "claude-code";
}

/**
 * Build a system prompt section listing available MCP proxy connections.
 *
 * Returns empty string only when the caller has no proxy client at all. If the
 * listing can't be fetched, this still emits the header telling the agent the
 * proxy exists and that it must check `list_routes` — otherwise a transient
 * daemon failure leaves the agent silently believing no services are connected,
 * and it never thinks to look.
 */
async function buildProxyConnectionsPrompt(proxyKeyAlias: string): Promise<string> {
  // Read the caller's available connections from the drawlatch daemon via a
  // short-TTL cache (list_routes) — identical for local and remote.
  const { routes, configured, stale, error } = await fetchProxyRoutes(proxyKeyAlias);
  if (!configured) return "";

  const connections = (routes as any[]).map((r) => ({
    alias: r.alias ?? r.name ?? "",
    name: r.name ?? r.alias ?? "",
    ...(r.description && { description: r.description }),
    ...(r.docsUrl && { docsUrl: r.docsUrl }),
  }));

  const header = [
    "# Available API Connections",
    "",
    "You have authenticated access to external services through the MCP proxy tools",
    "(`mcp__mcp-proxy__*`). The proxy injects credentials on your behalf, so you never need",
    "API keys. Check here before assuming a service is unreachable, and prefer these tools",
    "over generic web requests or asking the user to act on your behalf.",
    "",
  ];

  if (connections.length === 0) {
    return [
      ...header,
      error
        ? `The connection listing could not be retrieved just now (${error}). Do not conclude that`
        : "No connections are currently listed for you. Before concluding a service is unavailable,",
      error
        ? "no services are connected — call `mcp__mcp-proxy__list_routes` yourself to find out."
        : "call `mcp__mcp-proxy__list_routes` to confirm.",
    ].join("\n");
  }

  const lines = connections.map((c) => {
    let line = `- **${c.name}** (\`${c.alias}\`)`;
    if (c.description) line += ` — ${c.description}`;
    if (c.docsUrl) line += ` | [Docs](${c.docsUrl})`;
    return line;
  });

  return [
    ...header,
    ...lines,
    "",
    stale
      ? "This listing is cached and may be out of date — call `list_routes` to refresh it."
      : "Use `list_routes` for detailed endpoint information, or `secure_request` to make API calls.",
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

/**
 * Cancel the run backing `chatId` — the whole request, not just the event
 * stream the UI happens to be reading.
 *
 * Three things have to happen, in this order:
 *  1. `abort()` — the signal every adapter threads into its harness (SDK
 *     subprocess, `codex exec` spawn, OpenRouter fetch) and that the query
 *     loop, nudge/recovery continuations and pending permission requests all
 *     check. This is the cooperative half.
 *  2. `closeQuery()` — hard-terminate the provider run. A run parked in a tool
 *     call (or an adapter whose event stream simply ends instead of throwing)
 *     can otherwise stay alive after the abort, still holding a subprocess and
 *     still billing. Fire-and-forget: the caller shouldn't block on a
 *     harness teardown, and the run's own unwind emits the terminal
 *     `done` (reason: "aborted") that the UI waits on.
 *  3. Drop registry + pending state so the session reads as inactive
 *     immediately.
 *
 * Returns false when there's no stoppable web session (already finished, or a
 * CLI session, whose execution the server doesn't own).
 */
export function stopSession(chatId: string): boolean {
  const info = sessionRegistry.get(chatId);
  if (info && info.abortController) {
    info.abortController.abort();
    void info.closeQuery?.().catch((err: any) => {
      // Already-dead transports throw here — the abort above is the part that
      // must land, so this is diagnostic only.
      log.debug(`stopSession: closing query for ${chatId} threw: ${err?.message ?? err}`);
    });
    sessionRegistry.unregister(chatId);
    pendingRequests.delete(chatId);
    return true;
  }
  return false;
}

/** How long {@link stopSessionAndWait} waits for a run to actually unwind. */
export const SESSION_TEARDOWN_TIMEOUT_MS = 15000;

export type SessionStopOutcome =
  /** Nothing was running. */
  | "not-running"
  /** The run emitted its terminal event (or dropped out of the registry). */
  | "stopped"
  /** A CLI session: the server does not own that process and cannot stop it. */
  | "unstoppable"
  /** Asked to stop and it did not, within the timeout. Still alive. */
  | "timeout";

/**
 * {@link stopSession}, but waiting for the run to actually be over.
 *
 * `stopSession` is fire-and-forget by design: it aborts, fires `closeQuery()`
 * un-awaited, drops the registry entry and returns, so the UI reads inactive
 * immediately. That is right for a user pressing Stop and wrong for a caller
 * that is about to move the directory the agent is working in — the subprocess
 * can still be alive, mid-tool-call, with its cwd inside that directory.
 *
 * So this one keeps the registry entry until the run's own unwind emits the
 * terminal `done`/`error` event (or the entry disappears, which is the same
 * news arriving by a different route), and reports `"timeout"` rather than
 * pretending. Callers that are about to touch the filesystem must refuse on
 * anything but `"stopped"` / `"not-running"`.
 *
 * On timeout nothing is cleaned up: the run is genuinely still there, and
 * unregistering it would only hide that from the UI.
 */
export async function stopSessionAndWait(chatId: string, timeoutMs: number = SESSION_TEARDOWN_TIMEOUT_MS): Promise<SessionStopOutcome> {
  const info = sessionRegistry.get(chatId);
  if (!info) return "not-running";
  // CLI sessions carry no abort controller: the server did not spawn them.
  if (!info.abortController || !info.emitter) return "unstoppable";

  const { abortController, emitter, closeQuery } = info;

  const exited = new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      emitter.off("event", onEvent);
      clearInterval(poll);
      clearTimeout(timer);
      resolvePromise(value);
    };
    const onEvent = (event: any) => {
      if (event?.type === "done" || event?.type === "error") finish(true);
    };
    emitter.on("event", onEvent);
    // Backstop for the narrow window where the run emitted `done` between our
    // registry read and our listener attaching: its `finally` then drops the
    // entry, and that is equally conclusive.
    const poll = setInterval(() => {
      if (sessionRegistry.get(chatId)?.emitter !== emitter) finish(true);
    }, 100);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });

  abortController.abort();
  void closeQuery?.().catch((err: any) => {
    log.debug(`stopSessionAndWait: closing query for ${chatId} threw: ${err?.message ?? err}`);
  });

  const exitedInTime = await exited;
  if (!exitedInTime) {
    log.warn(`stopSessionAndWait: ${chatId} did not unwind within ${timeoutMs}ms — leaving it registered`);
    return "timeout";
  }

  // Same cleanup stopSession does, and only for our own entry: a replacement
  // session may already have taken the slot while we waited.
  if (sessionRegistry.get(chatId)?.emitter === emitter) {
    sessionRegistry.unregister(chatId);
    pendingRequests.delete(chatId);
  }
  return "stopped";
}

/**
 * Build the SDK prompt from text and optional images.
 * Returns either a plain string or an AsyncIterable<SDKUserMessage> for multimodal content.
 */
type PromptImageMetadata = { buffer: Buffer; mimeType: string; storagePath?: string };

function buildFormattedPrompt(
  prompt: string | any,
  imageMetadata?: PromptImageMetadata[],
  providerKind: AgentProviderKind = "claude-code",
): string | AsyncIterable<any> {
  if (!imageMetadata || imageMetadata.length === 0) {
    return prompt;
  }

  // Build content array for multimodal message (Anthropic API format)
  const content: any[] = [];

  if (prompt && prompt.trim()) {
    content.push({ type: "text", text: prompt.trim() });
  }

  for (const { buffer, mimeType, storagePath } of imageMetadata) {
    const base64 = buffer.toString("base64");
    if (providerKind === "codex" && storagePath) {
      // Codex consumes images as `local_image` paths. Keep the durable
      // callboard image-store path in the intermediate block so the Codex
      // adapter can pass it through and future log parsing can rehydrate the
      // same image from a stable path.
      content.push({
        type: "image",
        source: { type: "path", media_type: mimeType, path: storagePath },
      });
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      });
    }
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
  imageMetadata?: PromptImageMetadata[];
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
   * Which ACP vendor runs this chat, paired with `provider: "acp"`. Ignored for
   * every other provider. Only honored for new chats — existing ACP chats route
   * by the `acpProviderId` already in their metadata.
   *
   * Must name a built-in preset in `adapters/acp/vendors.ts` (Phase 2 adds more;
   * Phase 3 lets users define their own). An unknown id fails at send time with
   * an explicit error rather than spawning something arbitrary.
   */
  acpProviderId?: string;
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
   * Model routing (OpenRouter-only). When true AND provider is "openrouter" AND
   * the global model-routing config is enabled/usable, a classifier picks the
   * model for this new chat from the first prompt (and a `reclassify_model` tool
   * is exposed to the agent). Only honored for new chats — persisted into
   * metadata so follow-ups keep routing. Default: false (current behavior).
   */
  modelRouting?: boolean;
  /** The chosen model-routing rank/tier id (paired with modelRouting). */
  modelRoutingRankId?: string;
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
  /**
   * Chat id of the chat that spawned this one. Only honored for new chats —
   * stamps `parentChatId`/`rootChatId` into the new chat's metadata, linking
   * it into the cross-engine chat parentage tree (get_chat_tree,
   * GET /api/chats/:id/tree, sidebar tree view). Silently skipped when the
   * parent has no file-storage record (e.g. a still-temp tracking id).
   */
  parentChatId?: string;
  /**
   * Free-form role label (≤40 chars) for this chat's node in the parentage
   * tree, e.g. "subagent", "monitor", "router", "fork", "engine-switch".
   * Only honored for new chats, and only when parentage resolves.
   */
  chatRole?: string;
  /**
   * Card (ticket) to attach the new chat to — stamps `cardId` into
   * metadata so the chat shows as a member on the /board view. Only
   * honored for new chats; wins over a parent's inherited cardId.
   */
  cardId?: string;
  /**
   * Create a new open card and attach this chat to it. Only honored for
   * new chats, and only when no cardId resolves (an explicit or inherited
   * cardId wins). The card is created alongside the chat record with a
   * prompt-derived placeholder title, replaced by the LLM-generated chat
   * title when that succeeds — one title call covers both.
   */
  createCard?: boolean;
  /**
   * Optional category stamped on the auto-created card (only meaningful with
   * createCard). The board groups open cards by category.
   */
  cardCategory?: string;
  /**
   * Preset title stamped into the new chat's metadata. Used by spawners that
   * already know what the chat is (e.g. job-step sessions), where the
   * LLM title generation for manual chats is deliberately skipped —
   * without a stored title such chats render as "untitled" everywhere that
   * reads chat records directly (card rollup, board). Only honored for new
   * chats; the session can still overwrite it via set_chat_title.
   */
  chatTitle?: string;
  /**
   * Caller-supplied tracking id for a NEW chat, used as the session registry
   * key until the real session id arrives. Without it the key is a
   * server-generated `new-<ts>` the client never learns, so a new chat is
   * uncancellable (POST /:id/stop has no id to address) for the whole
   * provider-startup window. Ignored when a session is already registered
   * under the same id, and irrelevant for existing chats (they key by chatId).
   */
  clientTrackingId?: string;
  /**
   * Workspace this chat runs in — stamped as `Chat.workspaceId` on the new
   * chat record. Only honored for new chats; `upsertChat` enforces that an
   * existing chat keeps whatever linkage its record already has. Opaque:
   * never parsed back into a path. Set by the chat-start entry points when
   * branch resolution produced a worktree; absent for every other chat, and
   * nothing may depend on its presence.
   */
  workspaceId?: string;
}

/** Default number of times a requiring session is nudged to continue before giving up. */
const DEFAULT_MAX_NUDGES = 3;

/**
 * Render the CONFIGURED OpenRouter plugin ids for the chat-config log line — the
 * user's intent, before the `webAccess` gate runs. The effective set is logged by
 * the OR adapter's `translateOptions`, which is where the narrowing happens.
 */
function formatConfiguredPlugins(modelParams: Record<string, unknown> | undefined): string {
  const plugins = modelParams?.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) return "(none)";
  return `[${plugins.map((p) => String((p as { id?: unknown }).id)).join(",")}]`;
}

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
    // Drop any model switch left pending from a prior run of this chat — a new
    // message starts fresh; the loop below re-reads the model from metadata.
    clearPendingModelSwitch(opts.chatId);
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
      // Runs spawned on a card pass their cardId through so step chats
      // become card members (board rollup + inheritance for their children).
      ...(opts.jobContext && {
        jobRunId: opts.jobContext.runId,
        jobStepId: opts.jobContext.stepId,
        // Identity of the spawn that created this chat. The runner writes the
        // same key onto the run before spawning, so a crash between chat
        // creation and the chatId hitting the run file is recoverable.
        ...(opts.jobContext.executionKey && { jobExecutionKey: opts.jobContext.executionKey }),
        ...(opts.jobContext.cardId && { cardId: opts.jobContext.cardId }),
      }),
      // Attach the chat to a card (ticket) when spawned on one.
      ...(opts.cardId && { cardId: opts.cardId }),
      // Preset title from the spawner (e.g. "Repo Branch Prep — prep").
      // Triggered chats skip LLM title generation, so this is the only
      // title they get unless the session overwrites it.
      ...(opts.chatTitle && { title: opts.chatTitle.slice(0, 240) }),
      // Pin the provider for the lifetime of this chat. Once written here,
      // the metadata-routing block below sees it and getAgentProvider()
      // returns the matching adapter for every subsequent message in the
      // chat. Only write a value that resolveProviderKind would route —
      // unknown strings would log a warn on every message in the chat,
      // and "claude-code" is the default so writing it is redundant.
      //
      // The guard is the INTERNAL allowlist, not the routable one: `"acp"` has
      // no user-facing picker yet and is deliberately absent from what routes
      // accept, but sendMessage reaches it directly via `acpProviderId` and must
      // be able to pin it. Values arriving from a request were already narrowed
      // against the routable list at the route boundary.
      ...(isInternalProvider(opts.provider) && opts.provider !== "claude-code" && { provider: opts.provider }),
      // Pin the ACP vendor alongside the kind. `provider: "acp"` alone does not
      // say WHICH ACP agent runs the chat, so without this a follow-up message
      // could not reconstruct the adapter. Only meaningful when paired with
      // provider "acp".
      ...(opts.provider === "acp" && opts.acpProviderId && { acpProviderId: opts.acpProviderId }),
      // Pin reasoning-effort alongside the provider. Meaningful for the two
      // reasoning-capable providers — openrouter (→ OR `reasoning.effort`) and
      // codex (→ Codex `modelReasoningEffort`); their config blocks below pull it
      // out of metadata. The stream.ts boundary already drops `effort` when the
      // paired provider can't use it, so this second guard is defense-in-depth.
      ...(opts.effort && (opts.provider === "openrouter" || opts.provider === "codex") && { effort: opts.effort }),
      // Pin the per-chat model alongside provider/effort. Meaningful for both
      // user-facing providers: openrouter chats prefer it over the global
      // agentSettings.openRouterModel (OR config block below); claude-code
      // chats pass it to the SDK as options.model. Ignored for other
      // providers (codex/mock).
      ...(opts.model && (opts.provider === "openrouter" || (opts.provider ?? "claude-code") === "claude-code") && { model: opts.model }),
      // Pin model routing (OpenRouter-only). When on, the classifier below picks
      // the model for this chat and a reclassify_model tool is exposed. Follow-up
      // messages inherit the flag + chosen rank so re-classification keeps working.
      ...(opts.modelRouting && opts.provider === "openrouter" && { modelRouting: true }),
      ...(opts.modelRouting && opts.provider === "openrouter" && opts.modelRoutingRankId && { modelRoutingRankId: opts.modelRoutingRankId }),
      // Pin the explicit-completion requirement so follow-up messages to
      // this chat keep nudging for objective_complete without every caller
      // having to re-thread the flag.
      ...(opts.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
    };
    // Link this chat into the parentage tree when spawned by another chat.
    // resolveParentage returns null when the parent has no stored record
    // (e.g. temp tracking id) — in that case the chat is simply unlinked.
    if (opts.parentChatId) {
      const lineage = resolveParentage(opts.parentChatId);
      if (lineage) {
        initialMetadata.parentChatId = lineage.parentChatId;
        initialMetadata.rootChatId = lineage.rootChatId;
        if (opts.chatRole) initialMetadata.chatRole = opts.chatRole.slice(0, 40);
        // Children work the same ticket as their parent unless the spawner
        // said otherwise (explicit opts.cardId above wins).
        if (lineage.cardId && !initialMetadata.cardId) initialMetadata.cardId = lineage.cardId;
      }
    }
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
  // `"acp"` is one kind covering many vendors, so the adapter is selected by the
  // paired `acpProviderId` too — the factory memoizes ACP instances per provider
  // id. Ignored for every other kind.
  const acpProviderId = typeof initialMetadata.acpProviderId === "string" ? initialMetadata.acpProviderId : undefined;
  const agentProvider = getAgentProvider(providerKind, acpProviderId);

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

  // Mutable tracking ID: for new chats starts as a temp ID, migrates to real chatId on session_id arrival.
  // A caller-supplied temp id wins so the client can address /stop before the
  // real session id exists — unless it's already taken, which would silently
  // evict a live session's registry entry.
  const clientTrackingId = opts.clientTrackingId && !sessionRegistry.has(opts.clientTrackingId) ? opts.clientTrackingId : undefined;
  let trackingId = opts.chatId || clientTrackingId || `new-${Date.now()}`;
  // The query currently backing this session. Reassigned on every iteration of
  // the query loop below (nudge / stream-recovery / model-switch continuations
  // each build a fresh one), so stopSession always closes the live one rather
  // than a stale handle.
  let activeQuery: AgentQuery | null = null;
  sessionRegistry.register(trackingId, {
    type: "web",
    abortController,
    emitter,
    closeQuery: async () => {
      await activeQuery?.close();
    },
  });

  const formattedPrompt = buildFormattedPrompt(prompt, imageMetadata, providerKind);

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

  // Policy: provider-specific tool-name → category map, neutral allow/deny/ask
  // decision over the user's default-permission settings.
  //
  // The categorizer comes from a per-provider registry rather than a conditional,
  // and that is a correctness requirement rather than tidiness. This used to be
  // `providerKind === "acp" ? categorizeAcpToolName : categorizeClaudeTool`,
  // whose `else` branch is not a neutral default but a *real provider's map*:
  // every non-ACP kind inherited Claude Code's PascalCase table. OpenRouter's
  // tool names are all snake_case, so they matched nothing and fell through
  // `categorizeClaudeTool`'s `return "fileWrite"` — including `bash`, which
  // meant OR's shell tool was gated on the `fileWrite` axis and auto-allowed
  // under the common `{fileWrite: "allow", codeExecution: "ask"}` policy.
  //
  // `TOOL_CATEGORIZERS` is a `Record<AgentProviderKind, …>`, so a new provider
  // kind with no categorizer is a compile error instead of a silent adoption of
  // whichever map happened to be the fallback.
  //
  // For adapters that ALSO evaluate policy on their own side (ACP does; see
  // "The two-pass rule" in adapters/acp/permissionAdapter.ts), routing both
  // passes through this registry is what makes them run the identical function.
  // Same function is necessary but not sufficient — the two passes must also see
  // the same input, which the ACP adapter enforces by categorizing the exact
  // string it passes as `toolName` and never consulting ACP's `ToolKind`, which
  // this pass cannot see.
  const toolPermissionPolicy = new ToolPermissionPolicy(getToolCategorizer(providerKind), getDefaultPermissions);

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

  // ── Model routing (OpenRouter-only) ──
  // For NEW routed chats, classify the first prompt to pick the model before the
  // OpenRouter config block below reads initialMetadata.model. The switch is
  // pinned into metadata so subsequent turns reuse it without re-classifying.
  // The reclassify_model tool (injected below) handles mid-conversation changes.
  if (isNewChat && providerKind === "openrouter" && initialMetadata.modelRouting) {
    const promptText = typeof prompt === "string" ? prompt : null;
    if (promptText) {
      try {
        const decision = await classifyAndResolve(promptText, initialMetadata.modelRoutingRankId);
        if (decision) {
          initialMetadata.modelRoutingClassId = decision.classId;
          if (decision.model) initialMetadata.model = decision.model;
        }
      } catch (err: any) {
        log.warn(`Model routing classification failed: ${err.message} — using default model`);
      }
    }
  }

  // ── Model routing tools: injected only for routed OpenRouter chats ──
  if (providerKind === "openrouter" && initialMetadata.modelRouting && getUsableRoutingConfig()) {
    try {
      const spec = buildModelRoutingToolsSpec(() => trackingId);
      const server = agentProvider.buildToolServer(spec);
      if (server) {
        mcpServers["model-routing"] = server;
        allowedTools.push("mcp__model-routing__*");
        log.info("Injected model-routing MCP server (reclassify_model)");
      }
    } catch (err: any) {
      log.error(`Failed to build model-routing server: ${err.message}`);
    }
  }

  // ── Proxy tools: injected for ALL sessions (regular + agent) ──
  const agentSettings = getAgentSettings();
  const activeMcpConfigDir = getActiveMcpConfigDir();
  // Resolve the caller alias that gives this session its drawlatch identity:
  //   - Agent sessions use ONLY the agent's explicitly-assigned alias. There is
  //     no implicit "default" fallback — an agent must be granted a caller
  //     before it can reach drawlatch, so an unassigned agent can't borrow a
  //     caller it was never given access to.
  //   - Regular (human-operated) sessions use the configured default caller for
  //     the active proxy mode (Proxy Settings → "Default" toggle). When no
  //     default is set, they get NO caller and the proxy tools are not injected.
  let proxyKeyAlias: string | undefined;
  if (opts.agentAlias) {
    const proxyAgent = getAgent(opts.agentAlias);
    proxyKeyAlias = proxyAgent ? resolveAgentKeyAlias(proxyAgent).mcpKeyAlias : undefined;
  } else {
    proxyKeyAlias = resolveDefaultCaller();
  }

  if (agentSettings.proxyMode && activeMcpConfigDir && proxyKeyAlias) {
    // Make sure this caller is enrolled against the daemon (local: auto-enroll
    // a fresh keypair on demand; remote: no-op — sync provisions keys).
    try {
      await ensureCallerEnrolled(proxyKeyAlias);
    } catch (err: any) {
      log.warn(`Caller enrollment for "${proxyKeyAlias}" failed: ${err.message}`);
    }

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
  } else if (opts.agentAlias && !proxyKeyAlias) {
    log.info(`Agent "${opts.agentAlias}" has no caller alias assigned — proxy tools not injected`);
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
      const spec = buildAgentToolsSpec(opts.agentAlias, () => trackingId);
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
  // A cross-harness alias (e.g. "planner") is resolved to its claude-code target
  // here — an Anthropic alias/ID like "opus" or a full model id. A raw value
  // with no matching alias passes through unchanged, so the built-in names
  // (opus/sonnet/haiku/opusplan) and full ids keep working. An alias with no
  // claude-code target resolves to undefined ⇒ no --model passed ⇒ the env-var /
  // subscription default takes over (same as the unset case).
  const claudeCodeModel =
    providerKind === "claude-code" && typeof initialMetadata.model === "string" && initialMetadata.model.trim().length > 0
      ? resolveModelAlias(initialMetadata.model.trim(), "claude-code", agentSettings)
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
        // Inherit the daemon env, MINUS callboard/drawlatch server-internal vars
        // (auth secrets, NODE_ENV, PORT, data dirs, drawlatch/event-watcher wiring —
        // see agentEnvPolicy.ts). Intentional overrides below are applied AFTER, so
        // anything an agent legitimately needs (API keys, MCP env) still lands.
        ...sanitizeInheritedAgentEnv(process.env),
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
    // Per-chat override wins; either it or the global OR default may be a
    // cross-harness alias. A per-chat alias with no openrouter target falls back
    // to the configured OR default rather than the library default.
    const chatModel = resolveSessionModel(initialMetadata.model as string | undefined, agentSettings.openRouterModel, "openrouter", agentSettings);
    // Server tools: map the persisted list to the harness's verbatim wire shape.
    // Left undefined when the setting is absent (harness injects its defaults);
    // an explicit empty array is preserved (disable all server tools).
    //
    // This is the user's INTENT only. OR's server tools execute on OpenRouter's
    // servers and surface as `openrouter:*` output items rather than tool calls,
    // so `canUseTool` never sees them and the categorizer's `webAccess` entries
    // for web_search/web_fetch are unreachable. The `webAccess` axis is applied
    // to this list in the OR adapter, via the `getPermissions` accessor below —
    // see adapters/openrouter/serverToolPolicy.ts.
    const serverTools = agentSettings.openRouterServerTools?.map(serverToolToWire);
    // Generation params: merge the global default with the resolved model's
    // per-model override profile, then flatten to the harness's modelParams bag.
    //
    // Also INTENT only, on the same axis: the `plugins` array inside this bag is
    // a second route to OpenRouter's servers that `canUseTool` never sees (`web`
    // and `fusion` are web access, and a plugin runs once per request whether the
    // model asked or not). The OR adapter narrows it via the same
    // `getPermissions` accessor — see adapters/openrouter/serverToolPolicy.ts.
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
      // The accessor, not its value — same reasoning as the ACP block below.
      // It is read when the request body is assembled, so tightening webAccess
      // mid-conversation takes effect on the next message rather than being
      // frozen at whatever the policy was when this options blob was built.
      getPermissions: getDefaultPermissions,
      appTitle: "callboard",
    };
    log.info(
      `OpenRouter chat config — trackingId=${trackingId}, model=${chatModel ?? "(default)"}` +
        `${requestedModel && requestedModel !== chatModel ? ` (alias "${requestedModel}")` : ""}, ` +
        `effort=${chatEffort ?? "(unset)"}, ` +
        // Both webAccess-gated channels as CONFIGURED, alongside the axis that
        // narrows them. The effective sets (and anything the policy withheld) are
        // logged by the OR adapter's optionsAdapter, which is where the
        // intersections happen.
        `serverToolsConfigured=${serverTools ? `[${serverTools.map((t) => t.type).join(",")}]` : "(harness defaults)"}, ` +
        `pluginsConfigured=${formatConfiguredPlugins(modelParams)}, ` +
        `webAccess=${getDefaultPermissions()?.webAccess ?? "(none — treated as restrictive)"}, ` +
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
    // OpenRouter endpoint routing takes precedence over codexAuthMode: the native
    // Codex harness talks to OpenRouter via the injected config.toml provider
    // block. Requires its dedicated OR key (→ OPENROUTER_API_KEY).
    const useOpenRouter = Boolean(agentSettings.codexUseOpenRouter && agentSettings.codexOpenRouterApiKey?.trim());
    if (agentSettings.codexUseOpenRouter && !agentSettings.codexOpenRouterApiKey?.trim()) {
      const message = "Codex chat selected with OpenRouter routing, but no OpenRouter API key is configured in Settings → API.";
      log.error(message);
      throw new Error(message);
    }
    // api-key mode needs a key; subscription mode draws on the stored login.
    // Skipped entirely when OpenRouter routing is active.
    if (!useOpenRouter && authMode === "api-key" && !agentSettings.codexApiKey?.trim()) {
      const message = "Codex chat selected in api-key mode but OPENAI_API_KEY is not configured in Settings → API.";
      log.error(message);
      throw new Error(message);
    }
    // Per-chat model override (persisted to metadata) takes precedence over the
    // global codexModel default. Covers new chats (just written above) and
    // resumed chats (loaded from disk).
    // Per-chat override wins; either it or the global codexModel default may be a
    // cross-harness alias. A per-chat alias with no codex target falls back to the
    // configured codexModel default rather than the SDK's built-in default.
    const requestedModel = resolveSessionModel(
      typeof initialMetadata.model === "string" ? initialMetadata.model : undefined,
      agentSettings.codexModel,
      "codex",
      agentSettings,
    );
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
      ...(useOpenRouter && { useOpenRouter: true }),
      ...(useOpenRouter && agentSettings.codexOpenRouterBaseUrl?.trim() && { openRouterBaseUrl: agentSettings.codexOpenRouterBaseUrl.trim() }),
      ...(!useOpenRouter && authMode === "api-key" && agentSettings.codexApiKey?.trim() && { apiKey: agentSettings.codexApiKey.trim() }),
      ...(!useOpenRouter && authMode === "api-key" && agentSettings.codexBaseUrl?.trim() && { baseUrl: agentSettings.codexBaseUrl.trim() }),
      ...(requestedModel && { model: requestedModel }),
      ...(agentSettings.codexSandboxMode && { sandboxMode: agentSettings.codexSandboxMode }),
      ...(chatEffort && { reasoningEffort: chatEffort }),
      ...(permissions && { permissions }),
    };
    log.info(
      `Codex chat config — trackingId=${trackingId}, authMode=${useOpenRouter ? "openrouter" : authMode}, ` +
        `model=${requestedModel ?? "(default)"}, effort=${chatEffort ?? "(default)"}, ` +
        `sandbox=${agentSettings.codexSandboxMode ?? "(permission-derived)"}, ` +
        `codexHome=${agentSettings.codexHome?.trim() || "~/.codex"}` +
        `${useOpenRouter ? `, orBaseUrl=${agentSettings.codexOpenRouterBaseUrl?.trim() || "(default)"}` : ""}` +
        `${useOpenRouter && agentSettings.codexOpenRouterApiKey ? `, orKeyTail=…${agentSettings.codexOpenRouterApiKey.trim().slice(-4)}` : ""}` +
        `${!useOpenRouter && authMode === "api-key" && agentSettings.codexApiKey ? `, apiKeyTail=…${agentSettings.codexApiKey.trim().slice(-4)}` : ""}`,
    );
  }

  // For ACP chats, surface the provider id and the permission defaults the ACP
  // adapter needs. Unlike Codex — which must collapse permissions onto a sandbox
  // tier chosen at thread start — ACP gates per call, so the defaults are only
  // the FIRST half of the decision: the adapter consults them, and anything
  // resolving to "ask" escalates through the `canUseTool` already on
  // `queryOpts.options` (the same callback Claude Code uses). No model or effort
  // knob is set here: ACP 1.3.0 exposes models only as a post-session config
  // option and has no reasoning-effort concept at all, so there is nothing
  // honest to pass. See the adapter's `supportedModels` doc-comment.
  if (providerKind === "acp") {
    queryOpts.options.acp = {
      ...(acpProviderId && { providerId: acpProviderId }),
      // The accessor, not its value. `toolPermissionPolicy` above holds this
      // same function and calls it per tool call; handing the adapter a
      // snapshot taken here would let pass 1 auto-allow on a policy the user
      // has since tightened, and pass 2 — the one that would have caught it —
      // is only reached when pass 1 says "ask". Two passes, one input, one
      // moment of reading it.
      getPermissions: getDefaultPermissions,
    };
    log.info(`ACP chat config — trackingId=${trackingId}, providerId=${acpProviderId ?? "(unset)"}`);
  }

  log.debug(
    `SDK query options — provider=${providerKind}, cwd=${folder}, maxTurns=${queryOpts.options.maxTurns}, ` +
      `model=${queryOpts.options.model || "(default)"}, resume=${resumeSessionId || "none"}`,
  );

  (async () => {
    try {
      // Inject proxy connections listing into system prompt before starting the
      // conversation. Skipped when no caller alias resolved (e.g. an agent with
      // no caller assigned) — there's no identity to list connections for.
      if (agentSettings.proxyMode && activeMcpConfigDir && proxyKeyAlias) {
        try {
          const connectionsPrompt = await buildProxyConnectionsPrompt(proxyKeyAlias);
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
      // Stop-and-resume recoveries performed after a "Stream closed"
      // transport failure (see stream-recovery.ts) — capped per run so a
      // persistently-broken environment surfaces as an error instead of
      // restarting forever.
      let recoveriesUsed = 0;

      // ── Query loop ──
      // Runs exactly once for normal sessions. When requireExplicitCompletion
      // is set and the stream ends without the completion tool having been
      // called, the session is resumed with a nudge prompt — same emitter,
      // same registry entry, so the UI sees one continuous run and
      // session_stopped (which drives onComplete callbacks and the job
      // runner's harvest) fires only after the loop truly ends.

      while (true) {
        const conversation = agentProvider.query(queryOpts);
        // Hand this iteration's query to stopSession (via the registry's
        // closeQuery) so a stop kills the live provider run, not just the
        // stream we're draining here.
        activeQuery = conversation;
        // "Stream closed" watch for THIS query: consecutive failing tool
        // results (a healthy one resets the count) and a flag the recovery
        // block below acts on. Claude-Code-only — the failure mode lives in
        // the SDK↔CLI transport.
        let streamClosedFailures = 0;
        let streamRecoveryNeeded = false;
        const canAttemptRecovery = () => providerKind === "claude-code" && recoveriesUsed < MAX_STREAM_RECOVERIES && !abortController.signal.aborted;

        // The SDK can also surface transport death as a thrown error instead
        // of failing tool results. Guard the iteration so that case ends the
        // stream with the recovery flag set, rather than unwinding to the
        // outer catch and killing the session.
        const guardedEvents = async function* () {
          try {
            yield* conversation;
          } catch (err: any) {
            if (err?.name !== "AbortError" && canAttemptRecovery() && isStreamClosedSessionError(err?.message)) {
              log.warn(`Session ${trackingId} query threw "${err.message}" — attempting stream recovery`);
              streamRecoveryNeeded = true;
              return;
            }
            throw err;
          }
        };

        for await (const event of guardedEvents()) {
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
                if (canAttemptRecovery() && isStreamClosedSessionError(event.reason)) {
                  // Transport death reported as an execution-error result —
                  // recoverable by stop-and-resume, not a real provider error.
                  streamRecoveryNeeded = true;
                  log.warn(`Session ${trackingId} result reported "${event.reason}" — attempting stream recovery`);
                } else {
                  errorDetail = event.reason || "The model provider returned an error response.";
                  log.error(`Session ${trackingId} (provider=${providerKind}) ended: execution error — ${event.reason || "unknown"}`);
                }
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
                // Auto-create a card for this chat. Done here — not at the route —
                // so the card exists iff the chat record does (no orphan cards when
                // branch resolution or session startup fails). An explicit or
                // inherited cardId in metadata wins over auto-creation. The
                // placeholder title is replaced by the generated chat title below.
                let autoCreatedCardId: string | undefined;
                let autoCardPlaceholderTitle: string | undefined;
                if (opts.createCard && !initialMetadata.cardId) {
                  try {
                    const promptText = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim() : "";
                    let placeholder = promptText.slice(0, 120);
                    // Don't leave a dangling high surrogate when the cut lands
                    // mid-astral-character (e.g. an emoji at the boundary).
                    if (/[\uD800-\uDBFF]$/.test(placeholder)) placeholder = placeholder.slice(0, -1);
                    const card = createCardRecord({
                      title: placeholder || "New chat",
                      ...(opts.cardCategory && { category: opts.cardCategory }),
                    });
                    initialMetadata.cardId = card.id;
                    autoCreatedCardId = card.id;
                    autoCardPlaceholderTitle = card.title;
                    log.debug(`Auto-created card ${card.id} for new chat`);
                  } catch (err: any) {
                    log.warn(`Auto-create card failed: ${err.message} — chat proceeds without a card`);
                  }
                }
                initialMetadata.session_ids = [sessionId];
                const meta = { ...initialMetadata };
                log.debug(`Creating chat record — sessionId=${sessionId}, folder=${folder}`);
                let chat;
                try {
                  chat = chatFileService.upsertChat(sessionId, folder, sessionId, {
                    metadata: JSON.stringify(meta),
                    // Additive linkage — `folder` above stays the truth for
                    // log paths (plans/workspace-object.md).
                    ...(opts.workspaceId && { workspaceId: opts.workspaceId }),
                  });
                } catch (err) {
                  // Keep the card-exists-iff-chat-exists invariant: the chat
                  // record write failed, so remove the just-created card
                  // rather than leaving a memberless orphan on the board.
                  if (autoCreatedCardId) deleteCardRecord(autoCreatedCardId);
                  throw err;
                }

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
                    // Generate the title on the chat's own harness (providerKind,
                    // resolved at the top of sendMessage) so a claude-code chat
                    // gets a claude-code title and an openrouter chat an
                    // openrouter one. quick-completion falls back internally when
                    // the provider can't do a utility call (codex).
                    generateChatTitle(promptText, providerKind)
                      .then((title) => {
                        if (title) {
                          chatFileService.updateChatMetadata(chatId, { title });
                          log.debug(`Generated title for chat ${chatId}: "${title}"`);
                          // Same title for the auto-created card — one LLM call
                          // covers both. Compare-and-set against the placeholder:
                          // a rename that landed while the title was generating
                          // wins, and pre-existing cards are never retitled.
                          if (autoCreatedCardId && getCardRecord(autoCreatedCardId)?.title === autoCardPlaceholderTitle) {
                            updateCard(autoCreatedCardId, { title });
                          }
                        }
                      })
                      .catch(() => {}); // Title generation is non-critical
                  }
                }
              } else {
                // Existing chat: append the new session id, merging into a
                // FRESH read of the stored record. `initialMetadata` is a
                // snapshot from when this message started, and this branch
                // re-runs on stream-recovery / nudge / model-switch resumes —
                // by then the snapshot can be minutes stale, and overwriting
                // with it would silently drop anything written concurrently
                // (card membership, generated title, read state, ...).
                const stored = chatFileService.getChat(trackingId);
                let meta: Record<string, any> | null = null;
                if (stored) {
                  try {
                    const parsed = JSON.parse(stored.metadata || "{}");
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
                  } catch {}
                }
                // Record missing or unreadable mid-run — fall back to the
                // snapshot so a deleted record is recreated and the live
                // session stays reachable from the UI.
                if (!meta) meta = initialMetadata;
                const ids: string[] = Array.isArray(meta.session_ids) ? meta.session_ids : initialMetadata.session_ids || [];
                if (!ids.includes(sessionId)) ids.push(sessionId);
                meta.session_ids = ids;
                // Keep the snapshot's list in sync so the fallback above
                // stays complete on later resumes in this run.
                initialMetadata.session_ids = ids;
                chatFileService.upsertChat(trackingId, folder, sessionId, {
                  metadata: JSON.stringify(meta),
                  // Only reaches the record when this upsert *recreates* a
                  // deleted one (upsertChat ignores it for an existing chat) —
                  // without it the recreated chat would silently lose its
                  // workspace linkage mid-run.
                  ...(opts.workspaceId && { workspaceId: opts.workspaceId }),
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
              // Watch for the "Stream closed" transport-failure signature.
              // The failing result is still emitted (the transcript shows
              // what happened); recovery triggers only after consecutive
              // failures — one healthy result in between resets the count.
              if (providerKind === "claude-code") {
                if (isStreamClosedToolFailure(event.content, event.isError)) {
                  streamClosedFailures++;
                  log.warn(
                    `Session ${trackingId} tool_result "Stream closed" failure ` +
                      `(${streamClosedFailures}/${STREAM_CLOSED_TOOL_FAILURE_THRESHOLD} before recovery)`,
                  );
                  if (streamClosedFailures >= STREAM_CLOSED_TOOL_FAILURE_THRESHOLD && canAttemptRecovery()) {
                    streamRecoveryNeeded = true;
                  }
                } else {
                  streamClosedFailures = 0;
                }
              }
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

          // A flagged transport failure ends this query immediately — no
          // point letting the model burn more turns against dead tools; the
          // recovery block below stops and resumes the session.
          if (streamRecoveryNeeded) break;
        }

        // ── Stream-closed auto-recovery ──
        // The automated version of what users did manually: stop the broken
        // conversation and resume the session with a "please continue". Runs
        // before the model-switch/nudge blocks so those see only healthy
        // stream ends. Requires a session id to resume into — when the
        // transport died before session_started on a brand-new chat there is
        // nothing to recover into and the failure surfaces as an error.
        if (streamRecoveryNeeded && !abortController.signal.aborted) {
          const resumeTarget = sessionId ?? (queryOpts.options.resume as string | undefined) ?? resumeSessionId;
          if (resumeTarget) {
            recoveriesUsed++;
            log.warn(
              `Session ${trackingId} — "Stream closed" transport failure; auto-recovering ` +
                `(${recoveriesUsed}/${MAX_STREAM_RECOVERIES}) by resuming session ${resumeTarget}`,
            );
            // Kill the broken query's subprocess before starting the
            // replacement — it may still be live and writing to the same
            // session file.
            try {
              await conversation.close();
            } catch {
              // Transport already dead — expected.
            }
            const recoveryText = buildStreamRecoveryPrompt(recoveriesUsed, MAX_STREAM_RECOVERIES);
            emitter.emit("event", {
              type: "auto_recovery",
              content: recoveryText,
              reason: `stream_recovery_${recoveriesUsed}_of_${MAX_STREAM_RECOVERIES}`,
            } as StreamEvent);
            queryOpts.options.resume = resumeTarget;
            queryOpts.prompt = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: recoveryText },
              };
            })();
            sessionId = null;
            continue;
          }
          // No session to resume into — surface as a hard error (matches the
          // pre-recovery behavior of a thrown transport error).
          log.warn(`Session ${trackingId} — stream failure before any session id arrived; cannot auto-recover`);
          errorDetail = 'The session transport failed ("Stream closed") before a session was established.';
        }

        // ── Model switch (reclassify_model) ──
        // If the agent called reclassify_model this turn and it picked a new
        // model, resume the SAME session on that model right away — the agent
        // continues its work without the user sending another message. Skipped
        // on abort / provider error / hard caps (those end the session as usual).
        if (providerKind === "openrouter" && !abortController.signal.aborted && errorDetail === undefined && !endReason && queryOpts.options.openRouter) {
          const sw = takePendingModelSwitch(trackingId);
          if (sw) {
            log.info(`Session ${trackingId} — reclassify_model switch → resuming on model=${sw.model} (class=${sw.classId})`);
            queryOpts.options.openRouter.model = sw.model;
            queryOpts.options.resume = sessionId ?? resumeSessionId;
            const contText =
              `You switched the active model (classification: ${sw.classId}). ` +
              `This turn is now running on the newly selected model — continue working on the task.`;
            queryOpts.prompt = (async function* () {
              yield { type: "user" as const, message: { role: "user" as const, content: contText } };
            })();
            sessionId = null;
            continue;
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

      // A stopped run only reaches here when the provider's stream ended
      // quietly instead of throwing AbortError (OpenRouter and Codex both do:
      // the abort lands as a terminal stream event, and the loop's
      // `signal.aborted` guard breaks before that event is classified). Without
      // this the run would report as a normal completion — the frontend would
      // show no interruption marker, and an errored-then-aborted run would show
      // a red error bubble for a stop the user asked for.
      if (abortController.signal.aborted) {
        endReason = "aborted";
        errorDetail = undefined;
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
      // This run's query is done with — drop the handle so a late stop on a
      // replacement session can never close it a second time.
      activeQuery = null;
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
