import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "events";
import { resolve, isAbsolute } from "path";
import { chatFileService } from "./chat-file-service.js";
import { findChat } from "../utils/chat-lookup.js";
import { setSlashCommandsForDirectory } from "./slashCommands.js";
import type { DefaultPermissions } from "shared/types/index.js";
import type { StreamEvent } from "shared/types/index.js";
import type { McpServerConfig } from "shared/types/index.js";
import { migratePermissions } from "shared/types/index.js";
import { getPluginsForDirectory, type Plugin } from "./plugins.js";
import { getEnabledAppPlugins, getEnabledMcpServers } from "./app-plugins.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("claude");

export type { StreamEvent };

interface PendingRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  eventType: "permission_request" | "user_question" | "plan_review";
  eventData: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

interface ActiveSession {
  abortController: AbortController;
  emitter: EventEmitter;
}

const activeSessions = new Map<string, ActiveSession>();
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
function resolveServerPaths(
  server: McpServerConfig,
  pluginPath?: string,
): { command?: string; args?: string[] } {
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

function categorizeToolPermission(toolName: string): keyof DefaultPermissions | null {
  // File read operations (read-only)
  if (["Read", "Glob", "Grep"].includes(toolName)) {
    return "fileRead";
  }

  // File write operations (create, modify)
  if (["Write", "Edit", "MultiEdit"].includes(toolName)) {
    return "fileWrite";
  }

  // Code execution (bash commands, notebooks, shell management)
  if (["Bash", "NotebookEdit", "KillShell"].includes(toolName)) {
    return "codeExecution";
  }

  // Web access
  if (["WebFetch", "WebSearch"].includes(toolName)) {
    return "webAccess";
  }

  // Tools that don't need permission checks (always allowed)
  if (
    ["TodoWrite", "Task", "ExitPlanMode", "AskUserQuestion", "SlashCommand", "BashOutput", "Config", "ListMcpResources", "ReadMcpResource"].includes(toolName)
  ) {
    return null;
  }

  // Default to fileWrite for unknown tools (conservative)
  return "fileWrite";
}

export function getActiveSession(chatId: string): ActiveSession | undefined {
  return activeSessions.get(chatId);
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
    pending.resolve({
      behavior: "allow",
      updatedInput: updatedInput || pending.input,
      updatedPermissions: updatedPermissions as any,
    });
  } else {
    pending.resolve({ behavior: "deny", message: "User denied", interrupt: true });
  }
  return { ok: true, toolName };
}

export function stopSession(chatId: string): boolean {
  const session = activeSessions.get(chatId);
  if (session) {
    session.abortController.abort();
    activeSessions.delete(chatId);
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
function buildCanUseTool(emitter: EventEmitter, getDefaultPermissions: () => DefaultPermissions | null, getTrackingId: () => string) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    { signal, suggestions }: { signal: AbortSignal; suggestions?: unknown[] },
  ): Promise<PermissionResult> => {
    const category = categorizeToolPermission(toolName);
    if (category) {
      try {
        const defaultPermissions = getDefaultPermissions();
        if (defaultPermissions && defaultPermissions[category]) {
          const permission = defaultPermissions[category];
          if (permission === "allow") {
            log.debug(`Permission auto-allow: tool=${toolName}, category=${category}`);
            return { behavior: "allow", updatedInput: input };
          } else if (permission === "deny") {
            log.debug(`Permission auto-deny: tool=${toolName}, category=${category}`);
            return { behavior: "deny", message: `Auto-denied by default ${category} policy`, interrupt: true };
          }
        }
      } catch {
        // If permission lookup fails, fall through to normal permission flow
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
 * Emit stream events for content blocks from a Claude SDK message.
 */
function emitContentBlocks(emitter: EventEmitter, message: any): void {
  const blocks = message.message?.content || [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        emitter.emit("event", { type: "text", content: block.text } as StreamEvent);
        break;
      case "thinking":
        emitter.emit("event", { type: "thinking", content: block.thinking } as StreamEvent);
        break;
      case "tool_use":
        emitter.emit("event", {
          type: "tool_use",
          content: JSON.stringify(block.input),
          toolName: block.name,
        } as StreamEvent);
        break;
      case "tool_result": {
        const content =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c))).join("\n")
              : JSON.stringify(block.content);
        emitter.emit("event", { type: "tool_result", content } as StreamEvent);
        break;
      }
    }
  }
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
    stopSession(opts.chatId);
  } else if (opts.folder) {
    // New chat flow — store the actual working directory (may be a worktree).
    // The SDK creates logs keyed by this path, so we must preserve it exactly.
    folder = opts.folder;
    resumeSessionId = undefined;
    initialMetadata = {
      ...(defaultPermissions && { defaultPermissions }),
    };
  } else {
    throw new Error("Either chatId or folder is required");
  }

  const emitter = new EventEmitter();
  const abortController = new AbortController();

  // Mutable tracking ID: for new chats starts as a temp ID, migrates to real chatId on session_id arrival
  let trackingId = opts.chatId || `new-${Date.now()}`;
  activeSessions.set(trackingId, { abortController, emitter });

  const formattedPrompt = buildFormattedPrompt(prompt, imageMetadata);

  const getDefaultPermissions = (): DefaultPermissions | null => {
    if (isNewChat) {
      // For new chats, use the permissions passed directly
      return migratePermissions(defaultPermissions);
    }
    // For existing chats, read from chat metadata (may have been updated)
    return migratePermissions(initialMetadata.defaultPermissions);
  };

  // Always build plugin options (includes app-wide plugins even when no per-directory plugins are active)
  const plugins = buildPluginOptions(folder, activePlugins);
  const mcpOpts = buildMcpServerOptions();

  const queryOpts: any = {
    prompt: formattedPrompt,
    options: {
      abortController,
      cwd: folder,
      settingSources: ["user", "project", "local"],
      maxTurns: opts.maxTurns ?? 200,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(mcpOpts ? { mcpServers: mcpOpts.mcpServers, allowedTools: mcpOpts.allowedTools } : {}),
      env: {
        ...process.env,
        // Propagate resolved MCP server env vars to the CLI subprocess so that plugins
        // loaded by the CLI can resolve ${VAR} templates in their .mcp.json files.
        ...(mcpOpts?.resolvedEnvVars ?? {}),
        // Remove CLAUDECODE to prevent "cannot be launched inside another Claude Code session" errors
        // when the backend was started from within a Claude Code session (e.g. via PM2 redeploy)
        CLAUDECODE: undefined,
      },
      canUseTool: buildCanUseTool(emitter, getDefaultPermissions, () => trackingId),
      stderr: (data: string) => {
        log.warn(`[SDK stderr] ${data.trimEnd()}`);
      },
    },
  };
  log.debug(`SDK query options — cwd=${folder}, maxTurns=${queryOpts.options.maxTurns}, resume=${resumeSessionId || "none"}`);

  (async () => {
    try {
      let sessionId: string | null = null;
      let endReason: string | undefined;

      const conversation = query(queryOpts);

      for await (const message of conversation) {
        if (abortController.signal.aborted) break;

        // Detect SDK result messages (always the last yielded message).
        // These tell us *why* the conversation ended — max turns, budget, error, or success.
        if ("type" in message && (message as any).type === "result") {
          const result = message as any;
          if (result.subtype === "error_max_turns") {
            endReason = "max_turns";
            log.warn(`Session ${trackingId} ended: max turns (${result.num_turns}) reached`);
          } else if (result.subtype === "error_max_budget_usd") {
            endReason = "max_budget";
            log.warn(`Session ${trackingId} ended: max budget reached`);
          } else if (result.subtype === "error_during_execution") {
            endReason = "execution_error";
            log.warn(`Session ${trackingId} ended: execution error — ${result.errors?.join("; ") || "unknown"}`);
          }
          // For "success" subtype, endReason stays undefined (normal completion)
          continue;
        }

        // Capture slash commands from system initialization message
        if ("slash_commands" in message && message.slash_commands) {
          setSlashCommandsForDirectory(folder, message.slash_commands as string[]);
        }

        // Handle session_id arrival
        if ("session_id" in message && message.session_id && !sessionId) {
          sessionId = message.session_id as string;
          log.debug(`Session ID arrived: ${sessionId}`);

          if (isNewChat) {
            // New chat: create the chat record and migrate tracking from temp ID to real chat ID
            const meta = { ...initialMetadata, session_ids: [sessionId] };
            log.debug(`Creating chat record — sessionId=${sessionId}, folder=${folder}`);
            const chat = chatFileService.upsertChat(sessionId, folder, sessionId, {
              metadata: JSON.stringify(meta),
            });

            const oldTrackingId = trackingId;
            trackingId = sessionId;
            log.debug(`Migrated tracking ID: ${oldTrackingId} → ${trackingId}`);

            activeSessions.delete(oldTrackingId);
            activeSessions.set(trackingId, { abortController, emitter });

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
          } else {
            // Existing chat: append session_id to metadata
            const ids: string[] = initialMetadata.session_ids || [];
            if (!ids.includes(sessionId)) ids.push(sessionId);
            initialMetadata.session_ids = ids;
            chatFileService.upsertChat(trackingId, folder, sessionId, {
              metadata: JSON.stringify(initialMetadata),
            });
          }
        }

        // Detect conversation compaction events from the SDK
        if ("type" in message && (message as any).type === "system" && (message as any).subtype === "compact_boundary") {
          emitter.emit("event", { type: "compacting", content: (message as any).content || "Conversation compacted" } as StreamEvent);
        }

        emitContentBlocks(emitter, message);
      }

      chatFileService.updateChat(trackingId, {});
      log.debug(`Session complete — trackingId=${trackingId}, reason=${endReason || "normal"}`);
      emitter.emit("event", { type: "done", content: "", ...(endReason && { reason: endReason }) } as StreamEvent);
    } catch (err: any) {
      if (err.name === "AbortError") {
        // Emit done with reason so the frontend knows the session was aborted,
        // rather than silently swallowing the event.
        log.warn(`Session ${trackingId} ended: aborted`);
        chatFileService.updateChat(trackingId, {});
        emitter.emit("event", { type: "done", content: "", reason: "aborted" } as StreamEvent);
      } else {
        log.error(`Session ${trackingId} error: ${err.message}`);
        emitter.emit("event", { type: "error", content: err.message } as StreamEvent);
      }
    } finally {
      activeSessions.delete(trackingId);
      pendingRequests.delete(trackingId);
    }
  })();

  return emitter;
}
