import { getAgentProvider, getSessionProvider } from "../agents/factory.js";
import { isInternalProvider, isRetiredProvider, type AgentProviderKind, type AgentQuery, type InternalProviderKind } from "../agents/ports/AgentProvider.js";
import type { EffortLevel } from "shared/types/index.js";
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
import type { StreamEvent, TaskListItem } from "shared/types/index.js";
import { TASK_LIST_TOOLS } from "shared/types/index.js";
import type { McpServerConfig } from "shared/types/index.js";
import { getPluginsForDirectory, type Plugin } from "./plugins.js";
import { getEnabledAppPlugins, getEnabledMcpServers } from "./app-plugins.js";
import { customSkillsService, CUSTOM_SKILLS_PLUGIN_NAME } from "./custom-skills-service.js";
import { buildAgentToolsSpec, setMessageSender } from "./agent-tools.js";
import { buildCallboardToolsSpec, setCallboardMessageSender } from "./callboard-tools.js";
import { buildJobStepToolsSpec } from "./job-step-tools.js";
import { buildObjectiveToolsSpec, clearObjectiveCompletion, hasObjectiveCompletion } from "./objective-tools.js";
import { clearActivitiesForChat, migrateActivities, getWatch, startActivity, endActivity } from "./chat-activity.js";
import { decideNudge } from "./nudge-decision.js";
import { decideHold, HeldPrompt, OutstandingTasks, DEFAULT_MAX_HOLD_MS, createHoldEpisodeBudget } from "./background-task-hold.js";
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
  getCodexExecutablePath,
} from "./agent-settings.js";
import { getClaudeCodeExecutablePath } from "./claude-binary.js";
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { isCodexRoutedThroughOpenRouter, detectCodexOpenRouterEnv } from "../agents/adapters/codex/codexAuth.js";
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

/** Thrown for a chat pinned to a harness this build no longer implements. */
export class RetiredProviderError extends Error {}

/**
 * Narrow a free-form metadata.provider value to an InternalProviderKind — a
 * kind that can actually back a chat, so never `"mock"` — falling back to
 * "claude-code" on anything unrecognized. Logs a warn for malformed values so
 * corrupted metadata is observable instead of silent. The narrower return type
 * is what lets the session hand its own kind to the tool specs below as the
 * engine children inherit, with no re-validation at that call site.
 *
 * A retired kind refuses instead of falling back. `"openrouter"`'s harness was
 * removed with 155 chat records still naming it, and the fallback would hand
 * those chats to Claude Code — which would then try to resume a session id only
 * the OR harness could resolve. That fails somewhere deep in the SDK, after the
 * UI has already started a run. A named refusal at the boundary is the whole
 * difference between "this chat can't run any more" and a confusing half-start.
 */
function resolveProviderKind(value: unknown): InternalProviderKind {
  if (typeof value !== "string" || value === "") return "claude-code";
  if (isRetiredProvider(value)) {
    throw new RetiredProviderError(
      "This chat ran on the OpenRouter agent harness, which has been removed. It cannot be resumed. " +
        "Start a new chat — to keep using OpenRouter credentials, route a native harness through them in Settings → API.",
    );
  }
  // Chat metadata, not a request body — so the internal list, which may include
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
      error ? "no services are connected — call `mcp__mcp-proxy__list_routes` yourself to find out." : "call `mcp__mcp-proxy__list_routes` to confirm.",
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
export function buildPluginOptions(folder: string, activePluginIds?: string[]): any[] {
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

  // Callboard custom skills — a synthetic plugin, so the Claude Code SDK loads
  // them through the same path as any other local plugin: this descriptor goes
  // into `options.plugins` below, the CLI loads the directory, and the skills
  // surface as `callboard:<name>`. Null when no custom skills exist.
  //
  // This is the only consumer of the descriptor. pi reaches the same skills by
  // a different door — `customSkillsService.getSkillsDir()` into pi's
  // `additionalSkillPaths` (agents/adapters/pi/optionsAdapter.ts) — because it
  // has no plugin concept at all.
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

/**
 * A value that changes whenever the set of chats awaiting a permission answer
 * changes — the "waiting" half of a folder row's `status`.
 *
 * Derived from the map rather than maintained as a counter alongside it. There
 * are seven places that add to or remove from `pendingRequests` (permission
 * request, response, abort, two unregister paths, the tracking-id rekey, and
 * cleanup), and a hand-bumped counter is one forgotten call site away from
 * silently pinning a folder row to "waiting" forever. Reading the keys cannot
 * drift, and the map holds one entry per chat currently blocked on a prompt —
 * normally zero, a handful at worst — so it costs nothing to ask.
 *
 * Consumed by the folder-list cache; see services/folder-list-cache.ts.
 */
export function pendingRequestFingerprint(): string {
  if (pendingRequests.size === 0) return "";
  return [...pendingRequests.keys()].sort().join(",");
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
 *     subprocess, `codex exec` spawn, ACP transport) and that the query
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
    clearActivitiesForChat(chatId);
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
    clearActivitiesForChat(chatId);
  }
  return "stopped";
}

/**
 * An agent's running task list → the wire, as a `tool_use` rather than a
 * StreamEvent type of its own.
 *
 * `shared/types/stream.ts` is a published interface and its rule 3 says a new
 * `type` value must be capability-gated, because an old client hits its `switch`
 * default and drops the event whole. Gating would buy nothing here:
 * `createSSEHandler` collapses `tool_use` into a bare `message_update` and the
 * browser answers by refetching the transcript, so no list payload rides the
 * wire in either design. What this event is actually for is being that nudge —
 * without it a list arriving between two tool calls waits for the next event
 * before the user sees it, and a list arriving alone waits forever.
 *
 * `TodoWrite` / `{todos}` rather than the emitting engine's own names because
 * that pair is the one shape every callboard bundle ever shipped already renders
 * as a list. A tab on an older bundle talking to this daemon is therefore no
 * worse off than a current one, which is the test the wire rules ask for. The
 * *persisted* transcript keeps each engine's native vocabulary; only the
 * ephemeral nudge is normalized.
 */
export function taskListStreamEvent(items: TaskListItem[]): StreamEvent {
  return {
    type: "tool_use",
    content: JSON.stringify({ todos: items }),
    toolName: TASK_LIST_TOOLS.claudeCode,
  };
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
   * Defaults to `"claude-code"` when omitted.
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
   * providers — `provider: "codex"` (→ Codex `modelReasoningEffort`),
   * `"cline"` and `"pi"` — written into chat
   * metadata so existing-chat follow-ups reuse the same setting without the
   * caller threading it through. Omitted entirely when undefined (preserves each
   * model's default). Ignored when paired with `claude-code`.
   */
  effort?: EffortLevel;
  /**
   * Model for this chat. Only honored for new chats — written into chat
   * metadata so existing-chat follow-ups reuse it.
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
   *
   * Ignored outright for `triggered` runs and for anything with a
   * `parentChatId`: cards are per top-level chat, and a card per subagent
   * would silently flood a board nothing drains automatically.
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
 * Unified message sending function.
 * Handles both existing chats (provide chatId) and new chats (provide folder).
 * For new chats, creates the chat record when session_id arrives from the SDK
 * and emits a "chat_created" event so the frontend can navigate.
 */
export async function sendMessage(opts: SendMessageOptions): Promise<EventEmitter> {
  const { prompt, imageMetadata, activePlugins, defaultPermissions } = opts;
  const isNewChat = !opts.chatId;
  // A job step or cron action authored before the OpenRouter harness was removed
  // can still name it, and `opts.provider` is no longer typed to admit the value.
  // Refuse it here rather than letting it fall off the internal allowlist, which
  // would leave the metadata `provider` unwritten and quietly start a Claude Code
  // session in its place — a run that reports success on the wrong engine.
  if (isRetiredProvider(opts.provider)) {
    throw new RetiredProviderError(
      "This job or cron action targets the OpenRouter agent harness, which has been removed. " +
        "Re-point it at another harness — to keep using OpenRouter credentials, route a native harness through them in Settings → API.",
    );
  }
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
      // Pin reasoning-effort alongside the provider. Meaningful for the
      // reasoning-capable providers — codex (→ Codex `modelReasoningEffort`) and
      // pi; their config blocks below pull it out of metadata. The stream.ts
      // boundary already drops `effort` when the paired provider can't use it, so
      // this second guard is defense-in-depth.
      // ...and cline (→ Cline `thinking` / `reasoningEffort`), whose vocabulary is
      // callboard's `EffortLevel` minus `"none"` — see cline/optionsAdapter.
      ...(opts.effort && (opts.provider === "codex" || opts.provider === "cline" || opts.provider === "pi") && { effort: opts.effort }),
      // Pin the per-chat model alongside provider/effort. claude-code chats pass
      // it to the SDK as options.model. Ignored for codex/mock.
      // ...and for acp, where it names one of the vendor's own models and is
      // applied via `session/set_config_option` once the session exists.
      // ...and for cline, where it names a model within the configured Cline
      // provider and is passed on `CoreSessionConfig.modelId`.
      // ...and for pi, where it names a model within the configured pi provider
      // and is resolved through `ModelRegistry.find()`.
      ...(opts.model &&
        (opts.provider === "acp" || opts.provider === "cline" || opts.provider === "pi" || (opts.provider ?? "claude-code") === "claude-code") && {
          model: opts.model,
        }),
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
  // behavior). New chats default to "claude-code" too.
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
  // This run's held-open input stream, when the provider supports the
  // background-task hold. Declared out here, alongside `activeQuery` and for
  // the same reason: the run's `finally` has to be able to release it, and a
  // `try`-scoped binding is invisible from the `finally` that guards it.
  //
  // A ref cell rather than a bare `let` because it is reassigned inside a
  // closure (`setQueryPrompt`): control-flow analysis cannot follow that, so a
  // plain binding stays narrowed to `null` and every later use is a type error.
  const heldPromptRef: { current: HeldPrompt | null } = { current: null };
  /**
   * This run's allowance of hold episodes, shared by every {@link HeldPrompt}
   * the run installs.
   *
   * Out here with `heldPromptRef` because `setQueryPrompt` mints a replacement
   * on every nudge and every stream recovery, and the cap it feeds is a
   * property of the *run*. Left on the object it would have been up to seven
   * separate allowances of twenty — thirty-five hours of holding against the
   * five that `background-task-hold.ts` documents.
   */
  const holdEpisodeBudget = createHoldEpisodeBudget();
  /**
   * Background tasks this session started and has not seen end.
   *
   * Out here rather than inside the run's `try`, alongside `heldPromptRef` and
   * for a related reason: the `catch` blocks have to be able to read it. A
   * provider error and a user stop are the two endings *most* likely to leave
   * tasks running, and both need to name them on the way out or the client
   * draws a killed task exactly as it draws a finished one.
   */
  const outstandingTasks = new OutstandingTasks();
  /**
   * The `abandonedBackgroundTaskIds` payload for whichever ending is being
   * emitted, and the log line that goes with it.
   *
   * A helper rather than three inline copies because there are three endings
   * and it is the *unusual* ones that matter most here — a provider error and
   * a user stop are far likelier to leave shells running than a clean finish,
   * and both used to say nothing, so the client drew a killed task exactly as
   * it draws a completed one.
   *
   * Spreads to `{}` when nothing was left running, so the key stays absent
   * rather than becoming an empty array on every ordinary session.
   */
  const abandonedTaskFields = (): { abandonedBackgroundTaskIds?: string[] } => {
    const ids = outstandingTasks.ids();
    if (ids.length === 0) return {};
    log.warn(`Session ${trackingId} ended with ${ids.length} background task(s) still outstanding [${ids.join(", ")}] — they die with the subprocess`);
    return { abandonedBackgroundTaskIds: ids };
  };
  /**
   * The `holding` ChatActivity open for the current hold episode, if any.
   *
   * A hold is the third way a chat can legitimately be busy — after the `wait`
   * tool and an `onComplete` callback — and until this it was the only one with
   * nothing on screen: a session patiently keeping a subprocess alive rendered
   * as idle and finished.
   *
   * Out here with `heldPromptRef`, and a ref cell for the same two reasons: the
   * run's `finally` has to be able to end it, and it is assigned from a closure.
   *
   * `chat-activity.ts` has no lifecycle listeners of its own by design (see its
   * header), so the session owner drives it. Every path that ends a hold calls
   * {@link endHoldActivity} — the turn-boundary release, the wall-clock expiry,
   * the task set draining to zero, a replacement prompt being installed, the
   * abort listener, and the run's `finally`. A phantom countdown that never
   * clears would be worse than no row at all.
   */
  const holdActivityRef: { current: string | null } = { current: null };
  const endHoldActivity = (): void => {
    if (!holdActivityRef.current) return;
    endActivity(holdActivityRef.current);
    holdActivityRef.current = null;
  };
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
  // every non-ACP kind inherited Claude Code's PascalCase table. The
  // since-removed OpenRouter harness named its tools in snake_case, so they
  // matched nothing and fell through `categorizeClaudeTool`'s
  // `return "fileWrite"` — including `bash`, which meant its shell tool was
  // gated on the `fileWrite` axis and auto-allowed under the common
  // `{fileWrite: "allow", codeExecution: "ask"}` policy.
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
      {
        // Agent sessions get the job management tools on the "callboard" agent
        // server (alongside deploy_agent etc.) — skip them here to avoid duplicates.
        includeJobTools: !opts.agentAlias,
        // The engine this session runs on, so start_chat_session spawns children
        // onto it by default instead of always handing them to Claude Code.
        provider: providerKind,
        ...(providerKind === "acp" && acpProviderId && { acpProviderId }),
      },
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
      const spec = buildAgentToolsSpec(opts.agentAlias, () => trackingId, {
        provider: providerKind,
        ...(providerKind === "acp" && acpProviderId && { acpProviderId }),
      });
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

  const claudeExecutable = await getClaudeCodeExecutablePath();

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
  // unchanged.
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

  // For Codex chats, surface the per-provider settings the Codex adapter's
  // optionsAdapter looks for (the `codex` extras sub-object). Auth defaults to
  // subscription (ChatGPT login via
  // $CODEX_HOME/auth.json — no key passed); api-key mode forwards the key/base
  // url. CODEX_HOME itself rides in via the subprocess env that
  // getApiEnvOverrides() already injected above, so it isn't repeated here.
  if (providerKind === "codex") {
    const authMode = agentSettings.codexAuthMode ?? "subscription";
    // OpenRouter endpoint routing takes precedence over codexAuthMode: the native
    // Codex harness talks to OpenRouter via the injected config.toml provider
    // block, keyed from OPENROUTER_API_KEY. Credentials may come from the stored
    // key or from an ambient OpenRouter setup — see isCodexRoutedThroughOpenRouter
    // for why the env case additionally requires an explicit endpoint override.
    const useOpenRouter = isCodexRoutedThroughOpenRouter(agentSettings);
    // Routing requested with no credentials anywhere — no stored key and no
    // ambient OpenRouter setup — is a misconfiguration rather than a silent
    // fallback onto codexAuthMode.
    if (agentSettings.codexUseOpenRouter && !useOpenRouter && !detectCodexOpenRouterEnv()) {
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
    // global default. Covers new chats (just written above) and resumed chats
    // (loaded from disk).
    // Per-chat override wins; either it or the global default may be a
    // cross-harness alias. A per-chat alias with no codex target falls back to the
    // configured default rather than the SDK's built-in default.
    // Which global default applies is mode-specific: routing through OpenRouter
    // reads codexOpenRouterModel (an OR slug), native Codex reads codexModel (a
    // bare CLI slug). Sharing one field made toggling lossy — see the
    // AgentSettings doc-comment on codexOpenRouterModel.
    const requestedModel = resolveSessionModel(
      typeof initialMetadata.model === "string" ? initialMetadata.model : undefined,
      useOpenRouter ? agentSettings.codexOpenRouterModel : agentSettings.codexModel,
      "codex",
      agentSettings,
    );
    // Per-chat reasoning effort, read back out of metadata — maps onto Codex's
    // modelReasoningEffort in the optionsAdapter.
    const chatEffort = initialMetadata.effort as EffortLevel | undefined;
    // Permissions collapse onto Codex's sandbox + approval policy at thread
    // start (Codex has no per-call canUseTool hook). Surface them so the
    // optionsAdapter can derive the sandbox tier when no explicit one is set.
    const permissions = getDefaultPermissions() ?? undefined;
    // Which `codex` binary this chat spawns. `undefined` — the answer for every
    // chat before Phase 4, and still the default — leaves the SDK to resolve the
    // platform binary nested under `@openai/codex-sdk`. A configured override
    // that failed its `stat`/execute check also lands here as `undefined`, with
    // a warning already logged by the resolver: a typo in a settings field must
    // not break every Codex chat, and the status card is where it is reported.
    const codexBinary = getCodexExecutablePath(agentSettings);
    queryOpts.options.codex = {
      authMode,
      ...(codexBinary && { pathOverride: codexBinary }),
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
        `binary=${codexBinary ?? "(bundled)"}, ` +
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
  // `queryOpts.options` (the same callback Claude Code uses). A model IS passed
  // now — ACP exposes models only as a post-session config option, so the
  // adapter applies it with `session/set_config_option` after attaching rather
  // than requesting it on `session/new`. There is still no effort knob: ACP has
  // no reasoning-effort concept at all, so there would be nothing honest to send.
  if (providerKind === "acp") {
    // The vendor's own model id, e.g. "opencode/nemotron-3-ultra-free". Empty
    // means "whatever the vendor CLI is already configured for" — callboard has
    // no global ACP model default to fall back to, because one kind covers many
    // vendors whose catalogs share nothing.
    // Through the alias registry like every other harness, so `planner` resolves
    // to whatever the user pointed the `acp` target at. There is no global ACP
    // model default to pass as a fallback: one kind covers many vendors whose
    // catalogs share nothing, so "leave the vendor CLI's own choice alone" is
    // the only honest default.
    const acpModel = resolveSessionModel(typeof initialMetadata.model === "string" ? initialMetadata.model : undefined, undefined, "acp", agentSettings);
    // OpenRouter credential, when the user turned it on. The dedicated key wins,
    // then the account-wide one — unlike the Codex pair, which requires its own,
    // because nothing here rewrites the agent's provider config and there is no
    // reason to make a user re-enter a key they have already given. The adapter
    // still drops it unless the vendor's preset names an env var for it.
    const acpOpenRouterApiKey = agentSettings.acpUseOpenRouter
      ? agentSettings.acpOpenRouterApiKey?.trim() || agentSettings.openRouterApiKey?.trim() || undefined
      : undefined;
    queryOpts.options.acp = {
      ...(acpProviderId && { providerId: acpProviderId }),
      ...(acpModel && { model: acpModel }),
      ...(acpOpenRouterApiKey && { openRouterApiKey: acpOpenRouterApiKey }),
      // The accessor, not its value. `toolPermissionPolicy` above holds this
      // same function and calls it per tool call; handing the adapter a
      // snapshot taken here would let pass 1 auto-allow on a policy the user
      // has since tightened, and pass 2 — the one that would have caught it —
      // is only reached when pass 1 says "ask". Two passes, one input, one
      // moment of reading it.
      getPermissions: getDefaultPermissions,
    };
    log.info(
      `ACP chat config — trackingId=${trackingId}, providerId=${acpProviderId ?? "(unset)"}, model=${acpModel ?? "(agent default)"}, ` +
        `openRouter=${acpOpenRouterApiKey ? "on" : "off"}`,
    );
  }

  // For Cline chats, surface the per-provider settings the Cline adapter's
  // optionsAdapter looks for. Closest in shape to the ACP block above rather than
  // the Codex one: Cline gates per call through `requestToolApproval`, so the
  // permission defaults are only the FIRST half of the decision and anything
  // resolving to "ask" escalates through the same `canUseTool` Claude Code uses.
  //
  // Unlike every other provider there is no credential *mode* to resolve and no
  // "not configured" error to raise here. `@cline/sdk` runs in this process and
  // falls back to its own environment lookup when no key is set, so a user whose
  // machine already has ANTHROPIC_API_KEY exported gets a working chat with an
  // empty Settings → API form. A genuinely missing credential surfaces as the
  // provider's own error on the terminal `result`, which is both more accurate
  // and more specific than anything a pre-flight check here could say.
  if (providerKind === "cline") {
    // Per-chat override wins over the global default; either may be a
    // cross-harness alias, resolved through the same registry as every other
    // harness so `planner` lands on whatever the user pointed the `cline` target
    // at.
    const clineModel = resolveSessionModel(
      typeof initialMetadata.model === "string" ? initialMetadata.model : undefined,
      agentSettings.clineModel,
      "cline",
      agentSettings,
    );
    const chatEffort = initialMetadata.effort as EffortLevel | undefined;
    queryOpts.options.cline = {
      ...(agentSettings.clineProviderId?.trim() && { providerId: agentSettings.clineProviderId.trim() }),
      ...(clineModel && { model: clineModel }),
      ...(agentSettings.clineApiKey?.trim() && { apiKey: agentSettings.clineApiKey.trim() }),
      ...(agentSettings.clineBaseUrl?.trim() && { baseUrl: agentSettings.clineBaseUrl.trim() }),
      ...(typeof agentSettings.clineMaxIterations === "number" && { maxIterations: agentSettings.clineMaxIterations }),
      ...(chatEffort && { effort: chatEffort }),
      // The accessor, not its value — see the ACP block above for why. Both
      // permission passes must read the policy at the same moment.
      getPermissions: getDefaultPermissions,
    };
    log.info(
      `Cline chat config — trackingId=${trackingId}, provider=${agentSettings.clineProviderId?.trim() || "(anthropic)"}, ` +
        `model=${clineModel ?? "(provider default)"}, effort=${chatEffort ?? "(default)"}, ` +
        `baseUrl=${agentSettings.clineBaseUrl?.trim() || "(default)"}, ` +
        `apiKey=${agentSettings.clineApiKey?.trim() ? `…${agentSettings.clineApiKey.trim().slice(-4)}` : "(from environment)"}`,
    );
  }

  // pi chats. Same shape as the Cline block above — pi also runs in this process
  // and takes its credentials as config fields — with one difference that is not
  // cosmetic: **pi resumes by file path, not by session id**.
  //
  // `queryOpts.options.resume` carries the id, as it does for every other
  // harness. Handing that to pi would silently start a fresh session with the
  // chat's history gone, so the id is resolved to a path here and travels in its
  // own explicitly named field. `PiAdapter.assertPiResumePath` throws if a value
  // that is not an absolute `.jsonl` path ever reaches it.
  if (providerKind === "pi") {
    const piModel = resolveSessionModel(
      typeof initialMetadata.model === "string" ? initialMetadata.model : undefined,
      agentSettings.piModel,
      "pi",
      agentSettings,
    );
    const chatEffort = initialMetadata.effort as EffortLevel | undefined;

    // id → path. A chat whose session file has been removed resolves to nothing;
    // that is a real (if rare) state — the history is genuinely gone — so it
    // starts fresh with a warning rather than failing the turn outright. The
    // thing that must never happen quietly is the *type* confusion above, and
    // that is what throws.
    let piResumePath: string | undefined;
    if (resumeSessionId) {
      const resolved = getSessionProvider("pi")?.resolveSession(resumeSessionId) ?? null;
      if (resolved) {
        piResumePath = resolved.logPath;
      } else {
        log.warn(`pi chat ${opts.chatId ?? "(new)"} references session ${resumeSessionId} but no session file exists — starting a fresh session`);
      }
    }

    queryOpts.options.pi = {
      ...(agentSettings.piProviderId?.trim() && { providerId: agentSettings.piProviderId.trim() }),
      ...(piModel && { model: piModel }),
      ...(agentSettings.piApiKey?.trim() && { apiKey: agentSettings.piApiKey.trim() }),
      ...(agentSettings.piBaseUrl?.trim() && { baseUrl: agentSettings.piBaseUrl.trim() }),
      ...(chatEffort && { effort: chatEffort }),
      ...(piResumePath && { resumeSessionPath: piResumePath }),
      // The accessor, not its value — both permission passes must read the
      // policy at the same moment. See the Cline block above.
      getPermissions: getDefaultPermissions,
    };
    log.info(
      `pi chat config — trackingId=${trackingId}, provider=${agentSettings.piProviderId?.trim() || "(openrouter)"}, ` +
        `model=${piModel ?? "(provider default)"}, effort=${chatEffort ?? "(default)"}, ` +
        `resume=${piResumePath ? "path resolved" : resumeSessionId ? "UNRESOLVED — fresh session" : "new"}, ` +
        `apiKey=${agentSettings.piApiKey?.trim() ? `…${agentSettings.piApiKey.trim().slice(-4)}` : "(from environment)"}`,
    );
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
      // upstream API error response — bad key, insufficient credits, rate
      // limit, invalid model), the human-readable message rides in the result
      // event's `reason`. Captured here so it can be surfaced to the user as a
      // hard error rather than discarded behind a generic end-of-session note.
      let errorDetail: string | undefined;
      // Cumulative USD spend reported by the underlying adapter on the
      // terminal `result` event. Adapters differ on how they accumulate it, but
      // either way the latest value is the run total to surface to the UI for
      // the spend indicator + max_budget message.
      let lastCostUsd: number | undefined;

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

      // ── Background-task hold ──
      // Background tasks this session started and has not seen end. A turn that
      // ends with any outstanding is held open rather than torn down, because
      // the shells belong to the CLI subprocess and die with it — see
      // background-task-hold.ts for the measurements behind that.
      //
      // Claude Code only: it is the sole provider that reports background tasks
      // (`background_task` events), so for every other provider `heldPrompt`
      // stays null and the prompt is passed through exactly as before.
      //
      // `outstandingTasks` itself lives out with `heldPromptRef`, because the
      // catch blocks need it — see its declaration.
      const holdEnabled = providerKind === "claude-code";
      /**
       * Set once the current hold's wall-clock bound elapses, so later turns
       * stop re-holding it. Scoped to the {@link HeldPrompt} it describes, not
       * to the run — see `setQueryPrompt`, which clears it.
       */
      let holdExpired = false;
      /**
       * Open (or re-open) the dock row for the hold this turn boundary is
       * arming.
       *
       * Re-minted rather than mutated on each held turn: the task set changes
       * across an episode as one task ends and another starts, and the record
       * in `chat-activity.ts` is immutable once written. The deadline it counts
       * down to is the hold's own, so a re-mint mid-episode keeps the same
       * expiry rather than restarting the clock.
       */
      const beginHoldActivity = (taskIds: string[], expiresAt: number | null): void => {
        endHoldActivity();
        const activity = startActivity(trackingId, {
          kind: "holding",
          label: `${taskIds.length} background task${taskIds.length === 1 ? "" : "s"}`,
          detail: taskIds.join(", "),
          ...(expiresAt !== null && { expiresAt }),
          // Not interruptible. Releasing would close the input stream, which
          // kills the very shells the hold exists to let finish — the opposite
          // of what "end this early" means everywhere else in the dock. Ending
          // the run is what /stop is for, and it already closes the hold.
          interruptible: false,
        });
        holdActivityRef.current = activity.id;
      };
      /**
       * Install this turn's prompt, wrapping it so it can be held open. Closes
       * any previous hold first — a continuation (nudge, stream recovery) has
       * already finished with the stream it replaces.
       */
      const setQueryPrompt = (source: AsyncIterable<unknown> | string): void => {
        if (!holdEnabled) {
          queryOpts.prompt = source;
          return;
        }
        heldPromptRef.current?.close();
        const held = new HeldPrompt(source, holdEpisodeBudget);
        heldPromptRef.current = held;
        queryOpts.prompt = held.iterable();
        // The row belonged to the hold just closed, and the replacement has
        // not held anything yet.
        endHoldActivity();
        // The new hold has a new (unset) deadline, so it must not inherit the
        // old one's verdict. Left latched, a single expiry killed the hold for
        // the rest of the run: a stream recovery installs a fresh HeldPrompt,
        // but `decideHold` still saw `expired: true` and released every
        // subsequent turn at once — in production a task started 47 seconds
        // after a recovery was released, and killed, 13 seconds later, having
        // never been held at all.
        holdExpired = false;
      };
      if (holdEnabled) setQueryPrompt(effectivePrompt as AsyncIterable<unknown> | string);
      // A stop pressed *during* a hold must not wait it out. The SDK tears the
      // subprocess down on abort anyway, but a held input stream is the one
      // thing that stop cannot reach on its own: nothing else ever resolves
      // that promise, so the release has to be wired to the signal directly.
      abortController.signal.addEventListener(
        "abort",
        () => {
          heldPromptRef.current?.close();
          endHoldActivity();
        },
        { once: true },
      );
      // Registration happens well after the session was registered and after at
      // least one await, so a stop can land in the gap — and `abort` has then
      // already dispatched, leaving the listener above inert. Cover the gap
      // rather than leave the guarantee the comment claims quietly false.
      if (abortController.signal.aborted) {
        heldPromptRef.current?.close();
        endHoldActivity();
      }

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

          // Anything that isn't the turn-ending `result` means the CLI is
          // working, and a hold that expires while it is must not close stdin
          // out from under it — see HeldPrompt.armTimeout. The matching
          // markTurnEnded() is at the bottom of the `result` case, after the
          // hold decision has had its say.
          //
          // `background_task` is excluded, and not as a nicety: it is the one
          // event class the hold exists to receive, and it arrives precisely
          // *because* nothing else is happening. Counting it as a live turn
          // made the common case — a task ending during a hold — look like
          // work in progress, so the expiry would defer and then wait on a
          // `result` that a hold has no reason to produce.
          if (event.type !== "result" && event.type !== "background_task") heldPromptRef.current?.markTurnActive();

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

              // ── Should this turn actually end? ──
              // `result` is the last event of a *turn*, not necessarily of the
              // run. If background tasks are still going we leave the input
              // stream open and keep draining: the CLI notices its own tasks
              // finishing and opens a fresh turn to report them, with no prompt
              // from us. Releasing closes stdin and the stream ends (~0.3s),
              // which is the path every ordinary session takes.
              const held = heldPromptRef.current;
              if (holdEnabled && held && !held.closed) {
                const hold = decideHold({
                  outstanding: outstandingTasks.size,
                  aborted: abortController.signal.aborted,
                  errored: errorDetail !== undefined,
                  endReason,
                  expired: holdExpired,
                  streamRecoveryNeeded,
                });
                if (hold.action === "hold") {
                  log.info(
                    `Session ${trackingId} turn ended with ${hold.taskCount} background task(s) outstanding ` +
                      `[${outstandingTasks.ids().join(", ")}] — holding the session open`,
                  );
                  held.armTimeout(DEFAULT_MAX_HOLD_MS, () => {
                    holdExpired = true;
                    // The wait is over whatever the stream does next, so the
                    // row goes now rather than at the deferred close — leaving
                    // it up would show a countdown that has already run out.
                    endHoldActivity();
                    const stillRunning = outstandingTasks.ids();
                    const minutes = Math.round(DEFAULT_MAX_HOLD_MS / 60_000);
                    // Two different events wear this callback. With tasks
                    // outstanding it is the cap doing its job. With none, it is
                    // the post-drain floor firing because no turn boundary ever
                    // came to release us — a hang averted, not a task
                    // abandoned, and saying "gave up on []" for it is how the
                    // production log came to name an empty list.
                    log.warn(
                      stillRunning.length > 0
                        ? `Session ${trackingId} held ${minutes}m for background task(s) [${stillRunning.join(", ")}] — ` +
                            `giving up waiting; they end with the subprocess`
                        : `Session ${trackingId} held ${minutes}m with no background task outstanding and no turn boundary — ` +
                            `closing the input stream rather than waiting on one that may never come`,
                    );
                  });
                  // After arming, so the row carries the deadline the bound is
                  // actually enforcing — on the second and later turns of an
                  // episode that is the original deadline, not a fresh one.
                  // Skipped when arming expired on the spot (an already-elapsed
                  // deadline), which would otherwise post a countdown that is
                  // over before it renders.
                  if (!holdExpired) beginHoldActivity(outstandingTasks.ids(), held.deadline);
                } else {
                  if (hold.reason !== "none-outstanding") {
                    log.info(`Session ${trackingId} releasing background-task hold (${hold.reason})`);
                  }
                  endHoldActivity();
                  held.close();
                }
              }
              // The turn is over. An expiry that fired while it was running
              // deferred its close to here; on the ordinary path the decision
              // above has already closed and this is a no-op backstop.
              heldPromptRef.current?.markTurnEnded();
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
                //
                // Only ever for a top-level, human-started chat. Triggered runs
                // (cron, triggers, jobs) and agent-spawned children reach this
                // line too, and a card each would flood a board that has no
                // automatic drain — silently, since nothing errors. The route
                // already declines to ask for one, but the rule belongs here as
                // well: this is the path EVERY spawn takes, and `executeAgent`
                // and the MCP tools bypass the route entirely.
                //
                // Parentage is checked on both `opts` and the metadata: the
                // metadata field is only written when `resolveParentage`
                // succeeds, so a child whose parent has no stored record (a temp
                // tracking id) would otherwise read as top-level and get a card.
                let autoCreatedCardId: string | undefined;
                let autoCardPlaceholderTitle: string | undefined;
                if (opts.createCard && !initialMetadata.cardId && !opts.triggered && !opts.parentChatId && !initialMetadata.parentChatId) {
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

                // Same promotion for in-flight activities and any condition
                // watch: an activity opened under the temp id would otherwise
                // be unreachable by the route the UI polls.
                migrateActivities(oldTrackingId, trackingId);

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

            case "task_list":
              emitter.emit("event", taskListStreamEvent(event.items));
              break;

            case "background_task": {
              // Bookkeeping only — nothing is emitted to the client here. The
              // transcript already carries both edges (the launching
              // tool_result, and the CLI's own `<task-notification>` record),
              // and the frontend renders the pending state by pairing them, so
              // a wire event would be a third copy of what the UI already has.
              if (event.phase === "started") {
                outstandingTasks.start(event.taskId);
                log.info(`Session ${trackingId} started background task ${event.taskId}${event.summary ? ` — ${event.summary}` : ""}`);
                break;
              }
              if (outstandingTasks.end(event.taskId)) {
                log.info(
                  `Session ${trackingId} background task ${event.taskId} ended` +
                    `${event.status ? ` (${event.status})` : ""} — ${outstandingTasks.size} still outstanding`,
                );
              }
              // Draining to zero ends the hold *episode*, and with it the
              // fifteen-minute budget: the work we were being patient for
              // actually finished, so anything started later deserves a fresh
              // window rather than the remainder of this one. Without this the
              // budget is per-run, and a session polling with successive
              // background sleeps has its last one killed part-way through on a
              // timer armed for the first.
              //
              // Not a release: the stream stays open until the turn boundary,
              // which is where `decideHold` sees nothing outstanding and closes
              // it on the one path that also reports why.
              if (outstandingTasks.size === 0) {
                heldPromptRef.current?.disarmTimeout();
                // The episode's *verdict*, not just its clock. `disarmTimeout`
                // clears the deadline and the HeldPrompt's own deferred-expiry
                // flag; this is the third latch, and a fresh window with any
                // one of the three still set is vetoed the moment it opens —
                // `decideHold` would read `expired: true` at the next boundary
                // and release a task that has been running for seconds.
                holdExpired = false;
                // Nothing left to be patient for, so the dock stops saying we
                // are. The turn boundary re-opens a row if a later task starts.
                endHoldActivity();
              }
              break;
            }

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
              // Per-turn cost beacons → live `budget` StreamEvents. Adapters
              // report the CUMULATIVE run cost at each turn boundary;
              // forwarding it lets the UI move the spend indicator mid-run
              // instead of waiting for `done`. Track it as lastCostUsd too so
              // an abnormal end (e.g. abort before the result event) still has
              // the freshest spend on hand.
              //
              // Keyed on the payload rather than on the adapter. `turn_cost` was
              // one adapter's alone when it was written, but nothing about it is
              // adapter-shaped — it is a number in USD — and the ACP adapter emits
              // it too, from ACP's own `usage_update.cost`. Gating on the
              // emitter's name would have meant a second identical branch.
              //
              // No `maxBudgetUsd` rides along: the field is a per-session spend
              // CAP, and the only harness that had one was OpenRouter's. It stays
              // on the wire type (published interface) with no producer today.
              const payload = event.payload as { kind?: string; costUsd?: number } | null;
              if (payload?.kind === "turn_cost" && typeof payload.costUsd === "number") {
                lastCostUsd = payload.costUsd;
                emitter.emit("event", {
                  type: "budget",
                  content: "",
                  costUsd: payload.costUsd,
                } as StreamEvent);
              }
              break;
            }

            default:
              // Compile-time exhaustiveness. A new AgentEvent member with no
              // branch here doesn't crash, it goes *quiet* — which is how
              // Codex's and ACP's task lists were produced, translated, and
              // then dropped without anything failing. `never` makes the
              // omission a build error instead of a silence.
              ((_exhaustive: never) => _exhaustive)(event);
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
            // session file. Release the hold first: closing a query whose
            // input stream is still open leaves the generator parked on a
            // promise nothing will ever resolve.
            heldPromptRef.current?.close();
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
            setQueryPrompt(
              (async function* () {
                yield {
                  type: "user" as const,
                  message: { role: "user" as const, content: recoveryText },
                };
              })(),
            );
            sessionId = null;
            continue;
          }
          // No session to resume into — surface as a hard error (matches the
          // pre-recovery behavior of a thrown transport error).
          log.warn(`Session ${trackingId} — stream failure before any session id arrived; cannot auto-recover`);
          errorDetail = 'The session transport failed ("Stream closed") before a session was established.';
        }

        // ── Nudge decision ──
        // A turn can end owing two different things: the session-terminal
        // objective (requireExplicitCompletion) and a loop-scoped condition
        // watch left open by wait(require_condition). User aborts, provider
        // errors, /clear and hard caps still end the session as before.
        // See nudge-decision.ts — the logic is pure so it can be tested.
        const watch = getWatch(trackingId);
        const decision = decideNudge({
          requireCompletion,
          objectiveSatisfied: isObjectiveSatisfied(),
          watchOpen: watch !== undefined,
          ...(watch && { watchText: watch.text, watchAttempts: watch.attempts, watchMaxAttempts: watch.maxAttempts }),
          nudgesUsed,
          maxNudges,
          aborted: abortController.signal.aborted,
          errored: errorDetail !== undefined,
          endReason,
          isClear: typeof prompt === "string" && prompt.trim().toLowerCase() === "/clear",
          completionToolName,
          isJobStepSession,
        });

        if (decision.action === "break") break;
        if (decision.action === "giveUp") {
          endReason = decision.endReason;
          log.warn(`Session ${trackingId} ended owing [${decision.obligations.join(", ")}] after ${nudgesUsed} nudge(s) — giving up`);
          break;
        }

        nudgesUsed++;
        log.info(`Session ${trackingId} stream ended owing [${decision.obligations.join(", ")}] — nudging (${nudgesUsed}/${maxNudges})`);

        const nudgeText = decision.text;
        emitter.emit("event", {
          type: "nudge",
          content: nudgeText,
          reason: `nudge_${nudgesUsed}_of_${maxNudges}`,
        } as StreamEvent);

        // Resume the conversation we just watched end. `sessionId` was
        // captured from this iteration's session_started; reset it so the
        // resumed query's new session id is appended to the chat record.
        queryOpts.options.resume = sessionId ?? resumeSessionId;
        setQueryPrompt(
          (async function* () {
            yield {
              type: "user" as const,
              message: { role: "user" as const, content: nudgeText },
            };
          })(),
        );
        sessionId = null;
      }

      // A stopped run only reaches here when the provider's stream ended
      // quietly instead of throwing AbortError (Codex does:
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
        // This path returns instead of falling through to `done`, so it has to
        // name its own casualties. A provider error is one of the two endings
        // most likely to have left shells running.
        emitter.emit("event", { type: "error", content: errorDetail, ...abandonedTaskFields() } as StreamEvent);
        return;
      }

      // Detect /clear command — emit a cleared event before done so the frontend can show a marker
      if (typeof prompt === "string" && prompt.trim().toLowerCase() === "/clear") {
        log.debug(`Session cleared via /clear — trackingId=${trackingId}`);
        emitter.emit("event", { type: "cleared", content: "Conversation was cleared" } as StreamEvent);
      }

      log.debug(`Session complete — trackingId=${trackingId}, reason=${endReason || "normal"}, costUsd=${lastCostUsd ?? "n/a"}`);
      emitter.emit("event", {
        type: "done",
        content: "",
        ...(endReason && { reason: endReason }),
        ...(typeof lastCostUsd === "number" && { costUsd: lastCostUsd }),
        // Whether the explicit-completion requirement was satisfied — only
        // attached when the requirement was on for this run.
        ...(requireCompletion && { objectiveComplete: isObjectiveSatisfied() }),
        // Background tasks that never reported an outcome. The run is ending,
        // so the subprocess that owns their shells goes with it and they are
        // dead whatever they were doing.
        ...abandonedTaskFields(),
      } as StreamEvent);
    } catch (err: any) {
      if (err.name === "AbortError") {
        // Emit done with reason so the frontend knows the session was aborted,
        // rather than silently swallowing the event.
        log.warn(`Session ${trackingId} (provider=${providerKind}) ended: aborted`);
        chatFileService.updateChat(trackingId, {});
        // A stop is the other ending most likely to leave shells running — the
        // user pressed it precisely because something was still going.
        emitter.emit("event", { type: "done", content: "", reason: "aborted", ...abandonedTaskFields() } as StreamEvent);
      } else {
        log.error(`Session ${trackingId} (provider=${providerKind}) error: ${err.message}${err.stack ? `\n${err.stack}` : ""}`);
        emitter.emit("event", { type: "error", content: err.message, ...abandonedTaskFields() } as StreamEvent);
      }
    } finally {
      // Release any background-task hold, and take its dock row down with it.
      // Idempotent, and unconditional on purpose: every other exit from the
      // loop closes its own hold, and this is the one that catches the paths
      // that throw past them. The `clearActivitiesForChat` below only runs when
      // the registry entry is still ours, so it is not a substitute — a run
      // whose entry was taken over by a replacement would leave the row up.
      heldPromptRef.current?.close();
      endHoldActivity();
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
        clearActivitiesForChat(trackingId);
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
