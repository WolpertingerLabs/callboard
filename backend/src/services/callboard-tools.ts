import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import { existsSync, statSync } from "fs";
import path from "path";
import { createCanvas, updateCanvas, readCanvas } from "./canvas-service.js";
import { chatFileService } from "./chat-file-service.js";
import { sessionRegistry } from "./session-registry.js";
import { getActiveSession } from "./claude.js";
import { findChat } from "../utils/chat-lookup.js";
import { getSessionProviders } from "../agents/factory.js";
import { resolveBranch } from "../utils/git.js";
import {
  getOpenRouterModelsAsync,
  searchOpenRouterModels,
  getOpenRouterModelAliasesAsync,
  searchOpenRouterModelAliases,
  formatOpenRouterPrice,
} from "./openrouter-models.js";
import { getSdkInfoAsync } from "./sdk-info.js";
import { getUserContact } from "./user-contact.js";
import { customSkillsService, slugifySkillName } from "./custom-skills-service.js";
import { providerModelSchema, resolveProviderModelArgs } from "./tool-provider-args.js";
import { getAgentSettings } from "./agent-settings.js";
import { addCallback, countPending, getChatDepth, DEFAULT_MAX_CALLBACK_CHAIN_DEPTH, DEFAULT_MAX_PENDING_CALLBACKS } from "./session-callbacks.js";
import { buildJobManagementTools } from "./job-management-tools.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("callboard-tools");

// ─── Lazy reference to sendMessage ──────────────────────────────────
// We use a lazy import to avoid circular dependency:
// callboard-tools.ts → claude.ts → (uses buildCallboardToolsSpec from callboard-tools.ts)
// Instead, claude.ts registers itself at startup via setCallboardMessageSender().

type MessageSender = (opts: {
  prompt: string | AsyncIterable<any>;
  chatId?: string;
  folder?: string;
  systemPrompt?: string;
  agentAlias?: string;
  maxTurns?: number;
  defaultPermissions?: any;
  provider?: "claude-code" | "openrouter";
  model?: string;
  requireExplicitCompletion?: boolean;
}) => Promise<import("events").EventEmitter>;

let _sendMessage: MessageSender | null = null;

/**
 * Register the sendMessage function. Called by claude.ts on module load
 * to break the circular dependency.
 */
export function setCallboardMessageSender(fn: MessageSender): void {
  _sendMessage = fn;
}

function getSendMessage(): MessageSender {
  if (!_sendMessage) throw new Error("sendMessage not registered — call setCallboardMessageSender() first");
  return _sendMessage;
}

// ─── Helper: read session JSONL and extract text messages ───────────

function readSessionMessages(sessionId: string, limit: number = 50): string[] {
  // Route through the session-provider abstraction so this works for any
  // provider's transcript format (Claude Code JSONL, OpenRouter transcript,
  // etc.) instead of hand-parsing one provider's on-disk schema.
  const provider = getSessionProviders().find((p) => p.resolveSession(sessionId));
  if (!provider) return [];

  try {
    const messages = provider.parseSessionMessages([sessionId]);
    const textMessages: string[] = [];
    for (const msg of messages) {
      if (msg.type === "text" && msg.content) {
        textMessages.push(`[${msg.role}] ${msg.content}`);
      }
    }
    // Return the most recent messages up to limit
    return textMessages.slice(-limit);
  } catch {
    return [];
  }
}

const MIME_MAP: Record<string, { mime: string; category: string }> = {
  ".png": { mime: "image/png", category: "image" },
  ".jpg": { mime: "image/jpeg", category: "image" },
  ".jpeg": { mime: "image/jpeg", category: "image" },
  ".gif": { mime: "image/gif", category: "image" },
  ".webp": { mime: "image/webp", category: "image" },
  ".svg": { mime: "image/svg+xml", category: "image" },
  ".bmp": { mime: "image/bmp", category: "image" },
  ".mp3": { mime: "audio/mpeg", category: "audio" },
  ".wav": { mime: "audio/wav", category: "audio" },
  ".ogg": { mime: "audio/ogg", category: "audio" },
  ".aac": { mime: "audio/aac", category: "audio" },
  ".flac": { mime: "audio/flac", category: "audio" },
  ".mp4": { mime: "video/mp4", category: "video" },
  ".webm": { mime: "video/webm", category: "video" },
  ".mov": { mime: "video/quicktime", category: "video" },
  ".pdf": { mime: "application/pdf", category: "pdf" },
};

function error(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

// ─── notify_user channel routing ────────────────────────────────────
// Maps a notifiable contact channel to the drawlatch connection the agent
// should use and how to reach the user through it. Phone is intentionally
// excluded — it is a future feature and never offered to the agent.
type NotifyChannelKey = "discord" | "telegram" | "email";

const NOTIFY_CHANNELS: Record<NotifyChannelKey, { label: string; connection: string; instructions: (handle: string) => string }> = {
  discord: {
    label: "Discord",
    connection: "discord-bot",
    instructions: (handle) =>
      `Reach the user on Discord (username "${handle}") via the drawlatch "discord-bot" connection. ` +
      `Use mcp__mcp-proxy__list_routes to find the discord-bot endpoints, then mcp__mcp-proxy__secure_request to ` +
      `open a DM channel (POST /users/@me/channels with the user's recipient_id) and send your message (POST /channels/{channel_id}/messages).`,
  },
  telegram: {
    label: "Telegram",
    connection: "telegram",
    instructions: (handle) =>
      `Reach the user on Telegram (account "${handle}") via the drawlatch "telegram" connection. ` +
      `Use mcp__mcp-proxy__list_routes to find the telegram endpoints, then mcp__mcp-proxy__secure_request to send the message (sendMessage with the user's chat id).`,
  },
  email: {
    label: "Email",
    connection: "agentmail",
    instructions: (handle) =>
      `Reach the user by email (${handle}) via the drawlatch "agentmail" connection. ` +
      `Use mcp__mcp-proxy__list_routes to find the agentmail endpoints, then mcp__mcp-proxy__secure_request to send the email.`,
  },
};

export function buildCallboardToolsSpec(
  getChatId?: () => string,
  getAgentAlias?: () => string | undefined,
  opts?: {
    /**
     * Include the job management tools (default true). Agent sessions set
     * this false — they get the same tools on the "callboard" agent server
     * instead, so each session sees exactly one copy.
     */
    includeJobTools?: boolean;
  },
): ToolServerSpec {
  return {
    name: "callboard-tools",
    version: "1.0.0",
    tools: [
      defineTool(
        "render_file",
        "Render media in the chat UI. Supports images, audio, video, and PDFs from local files (absolute path) or URLs. Use this when the user would benefit from seeing media rather than just hearing about it. Provide either file_path or url, not both. If the content is from an untrusted or suspicious source, set untrusted=true with a reason.",
        {
          file_path: z.string().optional().describe("Absolute path to a local file to render"),
          url: z.string().optional().describe("URL of media content to render (http or https)"),
          display_mode: z
            .enum(["inline", "fullscreen"])
            .optional()
            .describe("inline = compact view in chat flow; fullscreen = expanded modal view (default: inline)"),
          caption: z.string().optional().describe("Optional caption shown below the rendered media"),
          untrusted: z
            .boolean()
            .optional()
            .describe("Set to true if the content may be unsafe or from an untrusted source. The UI will show a warning gate before loading."),
          untrusted_reason: z.string().optional().describe("Human-readable reason why this content is flagged as untrusted"),
        },
        async (args) => {
          const hasFilePath = !!args.file_path;
          const hasUrl = !!args.url;

          // Exactly one source required
          if (!hasFilePath && !hasUrl) {
            return error("Provide either file_path or url");
          }
          if (hasFilePath && hasUrl) {
            return error("Provide either file_path or url, not both");
          }

          // ── URL path ──
          if (hasUrl) {
            let parsed: URL;
            try {
              parsed = new URL(args.url!);
            } catch {
              return error("Invalid URL format");
            }

            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              return error("URL must use http or https protocol");
            }

            const ext = path.extname(parsed.pathname).toLowerCase();
            const info = MIME_MAP[ext];
            if (!info) {
              return error(`Unsupported file type or could not determine type from URL${ext ? `: ${ext}` : ""}`);
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    type: "render_file",
                    url: args.url,
                    media_type: info.category,
                    mime_type: info.mime,
                    display_mode: args.display_mode || "inline",
                    file_size: 0,
                    caption: args.caption || undefined,
                    ...(args.untrusted ? { untrusted: true, untrusted_reason: args.untrusted_reason || undefined } : {}),
                  }),
                },
              ],
            };
          }

          // ── File path ──
          if (!path.isAbsolute(args.file_path!)) {
            return error("file_path must be an absolute path");
          }
          if (args.file_path!.includes("\0")) {
            return error("Invalid file path");
          }

          const resolved = path.resolve(args.file_path!);
          if (!existsSync(resolved)) {
            return error(`File not found: ${resolved}`);
          }

          const ext = path.extname(resolved).toLowerCase();
          const info = MIME_MAP[ext];
          if (!info) {
            return error(`Unsupported file type: ${ext}`);
          }

          const stat = statSync(resolved);
          if (!stat.isFile()) {
            return error("Path is not a regular file");
          }

          const MAX_SIZE = 100 * 1024 * 1024; // 100MB
          if (stat.size > MAX_SIZE) {
            return error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  type: "render_file",
                  file_path: resolved,
                  media_type: info.category,
                  mime_type: info.mime,
                  display_mode: args.display_mode || "inline",
                  file_size: stat.size,
                  caption: args.caption || undefined,
                  ...(args.untrusted ? { untrusted: true, untrusted_reason: args.untrusted_reason || undefined } : {}),
                }),
              },
            ],
          };
        },
      ),

      // ── Canvas Tools ─────────────────────────────────────────────

      defineTool(
        "create_canvas",
        "Create a new versioned canvas to display dynamic content inline in the chat. Supports HTML pages (with inline CSS/JS), SVG graphics, or images. The content is stored as a snapshot and rendered in the chat UI. Use this when you want to show the user a live preview of something you've built — a dashboard, diagram, chart, or any visual output. Provide either content (string) or file_path (absolute path to a generated file), not both.",
        {
          name: z.string().describe("Human-readable name for this canvas (shown in the UI header)"),
          content: z.string().optional().describe("String content: HTML (with inline CSS/JS), or SVG markup"),
          file_path: z.string().optional().describe("Absolute path to a file to snapshot (for images generated by scripts, etc.)"),
          content_type: z.enum(["html", "svg", "image"]).describe("What kind of content: html = full HTML page, svg = SVG markup, image = image file"),
          caption: z.string().optional().describe("Optional caption shown below the rendered content"),
        },
        async (args) => {
          const result = createCanvas({
            name: args.name,
            content: args.content,
            file_path: args.file_path,
            content_type: args.content_type,
          });

          if (result.error) return error(result.error);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  type: "render_canvas",
                  canvas_id: result.result!.canvas_id,
                  version: result.result!.version,
                  name: result.result!.name,
                  content_type: result.result!.content_type,
                  caption: args.caption || undefined,
                }),
              },
            ],
          };
        },
      ),

      defineTool(
        "update_canvas",
        "Update an existing canvas with new content, creating a new versioned snapshot. The previous version is preserved — earlier renders in the chat will continue showing their original state. Provide the full replacement content (not a diff). Provide either content or file_path, not both.",
        {
          canvas_id: z.string().describe("The canvas ID returned by create_canvas"),
          content: z.string().optional().describe("Full replacement string content (HTML or SVG)"),
          file_path: z.string().optional().describe("Absolute path to a new file to snapshot"),
          description: z.string().optional().describe("Brief description of what changed in this version (shown in the UI)"),
          caption: z.string().optional().describe("Optional updated caption"),
        },
        async (args) => {
          const result = updateCanvas({
            canvas_id: args.canvas_id,
            content: args.content,
            file_path: args.file_path,
            description: args.description,
          });

          if (result.error) return error(result.error);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  type: "render_canvas",
                  canvas_id: result.result!.canvas_id,
                  version: result.result!.version,
                  name: result.result!.name,
                  content_type: result.result!.content_type,
                  description: result.result!.description || undefined,
                  caption: args.caption || undefined,
                }),
              },
            ],
          };
        },
      ),

      defineTool(
        "read_canvas",
        "Read back the content of an existing canvas. Use this to recall what you previously created (e.g. after context compaction) so you can reason about it before making updates. For HTML and SVG canvases, returns the full source. For image canvases, returns metadata only.",
        {
          canvas_id: z.string().describe("The canvas ID to read"),
          version: z.number().optional().describe("Specific version to read (defaults to the latest version)"),
        },
        async (args) => {
          const result = readCanvas(args.canvas_id, args.version);

          if (result.error) return error(result.error);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  type: "canvas_content",
                  ...result.result,
                }),
              },
            ],
          };
        },
      ),

      // ── Chat Status & Notification Tools ─────────────────────────────

      defineTool(
        "set_chat_status",
        "Set a custom status label on the current chat, visible in the Callboard dashboard sidebar. Use this to communicate what you're working on (e.g. 'Running tests', 'Deploying to staging', 'Waiting for CI'). Pass an empty status string to clear the status.",
        {
          status: z.string().max(160).describe("Short status label (max 160 chars). Empty string clears the status."),
          emoji: z.string().optional().describe("Single emoji prefix for visual distinction in the sidebar (e.g. '🧪', '🚀')"),
        },
        async (args) => {
          if (!getChatId) return error("Chat context not available");
          const chatId = getChatId();

          const fields: Record<string, unknown> = {
            chatStatus: args.status || null,
            chatStatusEmoji: args.emoji || null,
          };

          const ok = chatFileService.updateChatMetadata(chatId, fields);
          if (!ok) return error("Chat not found — status may not be available until the session is fully initialized");

          sessionRegistry.notifyMetadata(chatId, { chatStatus: args.status || null, chatStatusEmoji: args.emoji || null });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  chatId,
                  status: args.status || null,
                  emoji: args.emoji || null,
                }),
              },
            ],
          };
        },
      ),

      defineTool(
        "summon_user",
        "Alert the user that their attention is needed in this chat. Creates a visible notification in the Callboard dashboard. Use this when you need human input, a decision, or want to flag something important. This is different from permission requests — it's an agent-initiated signal that doesn't block execution.",
        {
          message: z.string().max(400).describe("Why the user is needed (max 400 chars)"),
          urgency: z.enum(["normal", "urgent"]).optional().describe("'urgent' triggers a browser notification if permitted (default: 'normal')"),
        },
        async (args) => {
          if (!getChatId) return error("Chat context not available");
          const chatId = getChatId();

          const summon = {
            message: args.message,
            urgency: (args.urgency || "normal") as "normal" | "urgent",
            createdAt: new Date().toISOString(),
          };

          const ok = chatFileService.updateChatMetadata(chatId, { summon });
          if (!ok) return error("Chat not found — summon may not be available until the session is fully initialized");

          sessionRegistry.addSummon(chatId, summon);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  chatId,
                  summon,
                }),
              },
            ],
          };
        },
      ),

      defineTool(
        "notify_user",
        "Reach the user outside of this chat through one of their configured contact channels (Discord, Telegram, or email). This tool does NOT send the message itself — it returns the user's contact handle plus instructions for which drawlatch connection and mcp-proxy tools to use. After calling it, continue by using the mcp__mcp-proxy__* tools to actually deliver the message. Use this when the user is away and you need to notify them of something (a finished task, a question, an alert).",
        {
          channel: z
            .enum(["discord", "telegram", "email"])
            .optional()
            .describe("Reach the user on a specific channel. Omit to get instructions for all of the user's enabled channels."),
          reason: z.string().optional().describe("Optional note about why you want to reach the user (for your own context; not sent)."),
        },
        async (args) => {
          const contact = getUserContact();

          const keys: NotifyChannelKey[] = args.channel ? [args.channel] : (["discord", "telegram", "email"] as NotifyChannelKey[]);

          const channels = keys
            .map((key) => {
              const entry = contact[key];
              // Silently omit channels the user hasn't enabled or filled in.
              if (!entry || !entry.enabled || !entry.value.trim()) return null;
              const def = NOTIFY_CHANNELS[key];
              return {
                channel: key,
                label: def.label,
                contact: entry.value.trim(),
                connection: def.connection,
                instructions: def.instructions(entry.value.trim()),
              };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);

          if (channels.length === 0) {
            return error(
              args.channel
                ? `The user has not enabled the "${args.channel}" contact channel. Ask them to enable it under Settings → General → Contact Info, or try a different channel.`
                : "The user has no enabled contact channels. Ask them to add and enable their contact info under Settings → General → Contact Info.",
            );
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  guidance:
                    "Use the drawlatch mcp__mcp-proxy__* tools with the connection named below to reach the user. " +
                    "If a connection isn't configured, tell the user it needs to be set up under Settings → Connections.",
                  channels,
                }),
              },
            ],
          };
        },
      ),

      defineTool(
        "set_chat_title",
        "Set or update the title of the current chat. Use this to give the chat a descriptive name that reflects the work being done, replacing the auto-generated title. Pass an empty string to reset to the auto-generated title.",
        {
          title: z.string().max(240).describe("New chat title (max 240 chars). Empty string resets to auto-generated."),
        },
        async (args) => {
          if (!getChatId) return error("Chat context not available");
          const chatId = getChatId();

          const ok = chatFileService.updateChatMetadata(chatId, { title: args.title || null });
          if (!ok) return error("Chat not found — title may not be available until the session is fully initialized");

          sessionRegistry.notifyMetadata(chatId, { title: args.title || null });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  chatId,
                  title: args.title || null,
                }),
              },
            ],
          };
        },
      ),

      // ── Chat Session Tools ──────────────────────────────────────────

      defineTool(
        "start_chat_session",
        "Start a new Claude Code chat session in any directory. The session runs asynchronously — use get_session_status to check on it later. Returns the chatId of the new session. Supports optional git branch/worktree configuration. Set onComplete=true to be automatically notified (a new turn in THIS chat) when the spawned session finishes — no polling required.",
        {
          prompt: z.string().describe("The task or message for the chat session"),
          folder: z.string().describe("Absolute path to the working directory for the session"),
          maxTurns: z.number().optional().describe("Maximum agentic turns before stopping (default: 200)"),
          baseBranch: z.string().optional().describe("Base branch to start from (switches to this branch before starting)"),
          newBranch: z.string().optional().describe("New branch name to create (created from baseBranch or current HEAD)"),
          useWorktree: z.boolean().optional().describe("Create a git worktree instead of switching branches in-place (default: false)"),
          onComplete: z
            .boolean()
            .optional()
            .describe(
              "If true, automatically re-invoke THIS chat with a notification when the spawned session completes (success, error, or stop), so you can read its results and continue without polling. Default: false.",
            ),
          requireExplicitCompletion: z
            .boolean()
            .optional()
            .describe(
              "If true, the spawned session must explicitly call the objective_complete tool before it is considered done — if its message stream ends without the call, it is re-prompted to continue (up to a cap). Default: false.",
            ),
          ...providerModelSchema,
        },
        async (args) => {
          try {
            const sendMessage = getSendMessage();

            const providerModel = resolveProviderModelArgs(args);
            if (!providerModel.ok) {
              return { content: [{ type: "text" as const, text: `Error: ${providerModel.error}` }] };
            }

            // Resolve effective folder based on branch configuration
            const branchResult = resolveBranch({
              folder: args.folder,
              baseBranch: args.baseBranch,
              newBranch: args.newBranch,
              useWorktree: args.useWorktree,
            });

            if (!branchResult.ok) {
              return { content: [{ type: "text" as const, text: JSON.stringify(branchResult) }] };
            }

            const effectiveFolder = branchResult.folder;

            // Build async generator prompt (required when MCP servers are present)
            const promptIterable = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: args.prompt },
              };
            })();

            const emitter = await sendMessage({
              prompt: promptIterable,
              folder: effectiveFolder,
              maxTurns: args.maxTurns ?? 200,
              defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
              provider: providerModel.provider,
              ...(providerModel.model && { model: providerModel.model }),
              ...(args.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
            });

            // Listen for chat_created to get the chatId
            const chatId = await new Promise<string>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("Timed out waiting for session to start")), 30000);
              emitter.on("event", (event: any) => {
                if (event.type === "chat_created" && event.chatId) {
                  clearTimeout(timeout);
                  resolve(event.chatId);
                } else if (event.type === "error") {
                  clearTimeout(timeout);
                  reject(new Error(event.content || "Session failed to start"));
                }
              });
            });

            log.info(`Started chat session ${chatId} in ${effectiveFolder}`);

            // ── "Phone home" on-complete callback registration ──
            let onComplete: { registered: boolean; note?: string } | undefined;
            if (args.onComplete) {
              const parentChatId = getChatId?.();
              if (!parentChatId) {
                onComplete = { registered: false, note: "No parent chat context available — cannot register completion callback." };
              } else {
                const settings = getAgentSettings();
                const maxDepth = settings.maxCallbackChainDepth ?? DEFAULT_MAX_CALLBACK_CHAIN_DEPTH;
                const maxPending = settings.maxPendingCallbacks ?? DEFAULT_MAX_PENDING_CALLBACKS;
                const newDepth = getChatDepth(parentChatId) + 1;

                if (newDepth > maxDepth) {
                  onComplete = {
                    registered: false,
                    note: `Callback chain depth limit reached (${maxDepth}). The session was started, but it will not phone home to avoid runaway loops.`,
                  };
                  log.warn(`start_chat_session: callback depth ${newDepth} exceeds limit ${maxDepth} for parent ${parentChatId} — skipping callback`);
                } else if (countPending() >= maxPending) {
                  onComplete = {
                    registered: false,
                    note: `Pending callback limit reached (${maxPending}). The session was started, but it will not phone home until existing callbacks drain.`,
                  };
                  log.warn(`start_chat_session: pending callbacks at limit ${maxPending} — skipping callback for parent ${parentChatId}`);
                } else {
                  addCallback({
                    childChatId: chatId,
                    parentChatId,
                    parentAgentAlias: getAgentAlias?.(),
                    depth: newDepth,
                  });
                  onComplete = { registered: true, note: `This chat will be notified automatically when session ${chatId} completes.` };
                  log.info(`Registered on-complete callback: child ${chatId} → parent ${parentChatId} (depth ${newDepth})`);
                }
              }
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ chatId, status: "started", folder: effectiveFolder, ...(onComplete && { onComplete }) }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`start_chat_session failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error starting session: ${err.message}` }] };
          }
        },
      ),

      // ── Anthropic Model Discovery ───────────────────────────────────

      defineTool(
        "list_anthropic_models",
        'List the Anthropic models available to this Claude Code installation (reflects the configured auth/subscription). Use the returned value as the `model` param when starting a claude-code session. Aliases like "opus", "sonnet", "haiku", and "opusplan" are also always valid.',
        {},
        async () => {
          try {
            const info = await getSdkInfoAsync();
            const rows = info.models.map((m) => ({
              value: m.value,
              name: m.displayName,
              ...(m.description && { description: m.description }),
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    count: rows.length,
                    aliases: ["opus", "sonnet", "haiku", "opusplan"],
                    models: rows,
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`list_anthropic_models failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error listing models: ${err.message}` }] };
          }
        },
      ),

      // ── OpenRouter Model Discovery ──────────────────────────────────

      defineTool(
        "list_openrouter_models",
        'List OpenRouter models that support tool calling, with their input/output pricing (per 1M tokens). Use the returned slug as the `model` param when starting an openrouter session. Also returns user-defined model aliases (e.g. "low coder" -> a real slug) — an alias is equally valid as the `model` param. The list is cached and refreshed on app start.',
        {
          limit: z.number().optional().describe("Max models to return (default: all). Aliases are always returned in full."),
        },
        async (args) => {
          try {
            const [models, aliases] = await Promise.all([getOpenRouterModelsAsync(), getOpenRouterModelAliasesAsync()]);
            const limited = typeof args.limit === "number" ? models.slice(0, Math.max(1, args.limit)) : models;
            const rows = limited.map((m) => ({
              id: m.id,
              in: formatOpenRouterPrice(m.promptPrice),
              out: formatOpenRouterPrice(m.completionPrice),
            }));
            const aliasRows = aliases.map((a) => ({ alias: a.alias, target: a.modelId }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    count: rows.length,
                    total: models.length,
                    pricingUnit: "per 1M tokens",
                    ...(aliasRows.length > 0 && { aliases: aliasRows }),
                    models: rows,
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`list_openrouter_models failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error listing models: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "search_openrouter_models",
        "Search tool-calling OpenRouter models by slug using subsequence matching (characters in order, e.g. 'claop' matches 'anthropic/claude-opus'). Also matches user-defined model aliases by alias name or target slug — an alias is equally valid as the `model` param. Returns matching slugs with input/output pricing (per 1M tokens).",
        {
          query: z.string().describe("Search text matched as a subsequence against the model slug (and alias names)."),
          limit: z.number().optional().describe("Max results to return (default: 50)."),
        },
        async (args) => {
          try {
            const limit = args.limit ?? 50;
            const [matched, matchedAliases] = await Promise.all([searchOpenRouterModels(args.query, limit), searchOpenRouterModelAliases(args.query, limit)]);
            const rows = matched.map((m) => ({
              id: m.id,
              in: formatOpenRouterPrice(m.promptPrice),
              out: formatOpenRouterPrice(m.completionPrice),
            }));
            const aliasRows = matchedAliases.map((a) => ({ alias: a.alias, target: a.modelId }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    query: args.query,
                    count: rows.length,
                    pricingUnit: "per 1M tokens",
                    ...(aliasRows.length > 0 && { aliases: aliasRows }),
                    models: rows,
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`search_openrouter_models failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error searching models: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "get_session_status",
        "Check the status of a Claude Code session. Returns whether the session is active, complete, or not found.",
        {
          chatId: z.string().describe("The chat/session ID to check"),
        },
        async (args) => {
          try {
            // Check if there's an active web session
            const activeSession = getActiveSession(args.chatId);
            if (activeSession) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ status: "active", chatId: args.chatId }) }] };
            }

            // Check if the session exists in storage
            const chat = findChat(args.chatId, false);
            if (!chat) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ status: "not_found", chatId: args.chatId }) }] };
            }

            // Session exists but not active — it's complete
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "complete",
                    chatId: args.chatId,
                    lastActivity: chat.updated_at,
                  }),
                },
              ],
            };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error checking status: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "read_session_messages",
        "Read the text messages from a Claude Code session. Returns the conversation content (user and assistant messages). Useful for checking what a spawned session did.",
        {
          chatId: z.string().describe("The chat/session ID to read messages from"),
          limit: z.number().optional().describe("Maximum number of messages to return (default: 50, returns most recent)"),
        },
        async (args) => {
          try {
            const chat = findChat(args.chatId, false);
            if (!chat) {
              return { content: [{ type: "text" as const, text: `Session "${args.chatId}" not found` }] };
            }

            // Get all session IDs for this chat
            const meta = JSON.parse(chat.metadata || "{}");
            const sessionIds: string[] = meta.session_ids || [];
            if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);

            // Read messages from all sessions
            const allMessages: string[] = [];
            for (const sid of sessionIds) {
              allMessages.push(...readSessionMessages(sid, args.limit || 50));
            }

            const messages = allMessages.slice(-(args.limit || 50));
            if (messages.length === 0) {
              return { content: [{ type: "text" as const, text: "No messages found in this session" }] };
            }

            return { content: [{ type: "text" as const, text: messages.join("\n\n") }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error reading messages: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "continue_chat",
        "Send a follow-up message to an existing chat or agent session. Resumes the conversation preserving full context. The session must not be currently active. Set waitForCompletion=true to block until the response is ready.",
        {
          chatId: z.string().describe("The chat/session ID to continue"),
          prompt: z.string().describe("The follow-up message to send"),
          maxTurns: z.number().optional().describe("Maximum agentic turns for this continuation (default: 200)"),
          waitForCompletion: z
            .boolean()
            .optional()
            .describe("If true, wait for the session to complete and return the response text. Default: false (returns immediately)"),
          requireExplicitCompletion: z
            .boolean()
            .optional()
            .describe(
              "Override the chat's explicit-completion requirement for this message: true forces the session to call objective_complete before it counts as done (re-prompted if it ends without the call), false disables the requirement for this message. Omit to inherit the chat's persisted setting.",
            ),
        },
        async (args) => {
          try {
            // 1. Verify the chat exists
            const chat = findChat(args.chatId, false);
            if (!chat) {
              return { content: [{ type: "text" as const, text: `Chat "${args.chatId}" not found` }] };
            }

            // 2. Check if session is currently active
            const activeSession = getActiveSession(args.chatId);
            if (activeSession) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Chat "${args.chatId}" already has an active session — wait for it to complete or stop it first`,
                  },
                ],
              };
            }

            const sendMessage = getSendMessage();

            // 3. Build async generator prompt (required when MCP servers are present)
            const promptIterable = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: args.prompt },
              };
            })();

            // 4. Send the continuation message
            const emitter = await sendMessage({
              chatId: args.chatId,
              prompt: promptIterable,
              maxTurns: args.maxTurns ?? 200,
              ...(typeof args.requireExplicitCompletion === "boolean" && { requireExplicitCompletion: args.requireExplicitCompletion }),
            });

            // 5. If not waiting, return immediately after session starts
            if (!args.waitForCompletion) {
              log.info(`Continued chat ${args.chatId} (async)`);

              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ chatId: args.chatId, status: "continued", waitForCompletion: false }),
                  },
                ],
              };
            }

            // 6. Wait for completion and collect response
            const responseTexts: string[] = [];
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => resolve(), 600_000); // 10 min safety

              emitter.on("event", (event: any) => {
                if (event.type === "text" && event.content) {
                  responseTexts.push(event.content);
                } else if (event.type === "done") {
                  clearTimeout(timeout);
                  resolve();
                } else if (event.type === "error") {
                  clearTimeout(timeout);
                  reject(new Error(event.content || "Session errored"));
                }
              });
            });

            log.info(`Continued chat ${args.chatId} (sync, complete)`);

            const response = responseTexts.join("") || "(No text response)";
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ chatId: args.chatId, status: "complete", response }) }],
            };
          } catch (err: any) {
            log.error(`continue_chat failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error continuing chat: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "find_chats",
        "Search chat sessions for a repo folder, including worktrees. Scans all Claude Code sessions in ~/.claude/projects/. Returns matching chats sorted by most recently updated. Use with continue_chat to resume a previous conversation.",
        {
          folder: z.string().describe("Repo working directory path (also searches worktrees of this repo)"),
          grep: z.string().optional().describe("Search term to grep across session conversation content (messages, tool calls, code, etc.)"),
          gitBranch: z.string().optional().describe("Filter by git branch (matches live worktree branches and stored session metadata)"),
          agentAlias: z.string().optional().describe("Filter to chats started by a specific agent"),
          triggered: z.boolean().optional().describe("Filter to automated (true) or manual (false) sessions"),
          updatedAfter: z.string().optional().describe("ISO-8601 date — only chats updated after this time"),
          updatedBefore: z.string().optional().describe("ISO-8601 date — only chats updated before this time"),
          sort: z.enum(["updated", "created"]).optional().describe("Sort field (default: updated)"),
          limit: z.number().optional().describe("Max results to return (default: 10, max: 50)"),
        },
        async (args) => {
          try {
            // Search across all registered session providers
            const allChats: any[] = [];
            for (const provider of getSessionProviders()) {
              const providerResult = provider.searchSessions({
                folder: args.folder,
                grep: args.grep,
                gitBranch: args.gitBranch,
                agentAlias: args.agentAlias,
                triggered: args.triggered,
                updatedAfter: args.updatedAfter,
                updatedBefore: args.updatedBefore,
                sort: args.sort,
                limit: args.limit,
              });
              allChats.push(...providerResult.chats);
            }
            const result = { chats: allChats, total: allChats.length };

            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          } catch (err: any) {
            log.error(`find_chats failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error searching chats: ${err.message}` }] };
          }
        },
      ),

      // ── Custom skills ──────────────────────────────────────────
      // Manages Callboard custom skills only (~/.callboard/custom-skills/) —
      // never framework, plugin, user (~/.claude), or project skills.

      defineTool(
        "list_custom_skills",
        "List Callboard custom skills — user-created skills managed in Settings → Skills and stored by Callboard itself (not framework, plugin, or ~/.claude skills). Each is invocable in chats as callboard:<name>. Returns names, descriptions, and last-updated timestamps.",
        {},
        async () => {
          try {
            const skills = customSkillsService.listSkills();
            return { content: [{ type: "text" as const, text: JSON.stringify({ skills }) }] };
          } catch (err: any) {
            log.error(`list_custom_skills failed: ${err.message}`);
            return error(`Failed to list custom skills: ${err.message}`);
          }
        },
      ),

      defineTool(
        "read_custom_skill",
        "Read a Callboard custom skill's full definition — its description and markdown instructions. Only reads Callboard-managed custom skills (see list_custom_skills), not framework or ~/.claude skills.",
        {
          name: z.string().describe("Skill name (kebab-case, as returned by list_custom_skills)"),
        },
        async (args) => {
          try {
            const skill = customSkillsService.getSkill(args.name);
            if (!skill) {
              return error(`Custom skill "${args.name}" not found — use list_custom_skills to see available skills`);
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ skill }) }] };
          } catch (err: any) {
            log.error(`read_custom_skill failed: ${err.message}`);
            return error(`Failed to read custom skill: ${err.message}`);
          }
        },
      ),

      defineTool(
        "write_custom_skill",
        "Create or update a Callboard custom skill. If a skill with this name exists it is updated (only the provided fields change); otherwise a new one is created (description and content are then required). The name is kebab-cased automatically. Changes apply from the next message in any chat; the skill is invoked as callboard:<name>. Only manages Callboard custom skills — never edits framework, plugin, or ~/.claude skills. Deletion is only available in Settings → Skills.",
        {
          name: z.string().describe("Skill name — kebab-cased automatically (e.g. 'Release Notes' → release-notes)"),
          description: z.string().optional().describe("One-line description the model sees when deciding to use the skill (required when creating)"),
          content: z.string().optional().describe("Markdown instructions — the body of SKILL.md, without frontmatter (required when creating)"),
        },
        async (args) => {
          try {
            const slug = slugifySkillName(args.name);
            const existing = customSkillsService.getSkill(slug);
            let skill;
            let action: "created" | "updated";
            if (existing) {
              skill = customSkillsService.updateSkill(slug, {
                ...(args.description !== undefined && { description: args.description }),
                ...(args.content !== undefined && { content: args.content }),
              });
              action = "updated";
            } else {
              if (!args.description || !args.content) {
                return error(`Custom skill "${slug}" does not exist — provide both description and content to create it`);
              }
              skill = customSkillsService.createSkill({
                name: slug,
                description: args.description,
                content: args.content,
              });
              action = "created";
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    action,
                    skill: { name: skill.name, description: skill.description, updatedAt: skill.updatedAt },
                    note: `Invocable as callboard:${skill.name} starting with the next message in any chat.`,
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`write_custom_skill failed: ${err.message}`);
            return error(`Failed to write custom skill: ${err.message}`);
          }
        },
      ),

      // ── Utilities ──────────────────────────────────────────────

      defineTool(
        "wait",
        "Pause execution for the specified number of seconds (1-300). Useful for waiting between polling operations, giving other processes time to complete, or adding delays between actions. Include a fun, cute flavor description of what you're 'doing' while you wait.",
        {
          seconds: z.number().min(1).max(300).describe("Number of seconds to wait (1-300)"),
          flavor: z.string().describe("A fun, cute flavor description of what you're doing while waiting (e.g. 'Contemplating the meaning of semicolons')"),
          reason: z.string().optional().describe("Optional actual reason for waiting (for your own logging)"),
        },
        async (args) => {
          const seconds = Math.min(Math.max(1, Math.round(args.seconds)), 300);

          await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  waited: seconds,
                  flavor: args.flavor,
                  ...(args.reason && { reason: args.reason }),
                }),
              },
            ],
          };
        },
      ),

      // ── Jobs: deterministic multi-step workflows ────────────────────
      // Definitions are reusable templates; spawning one creates a run — a
      // persisted state machine driven by the backend job runner, with agent
      // sessions doing the work inside steps. Shared with the "callboard"
      // agent server — see job-management-tools.ts.

      ...(opts?.includeJobTools !== false
        ? buildJobManagementTools({
            getCreatedBy: () => {
              const agentAlias = getAgentAlias?.();
              return agentAlias ? { kind: "agent", ref: agentAlias } : { kind: "chat", ref: getChatId?.() };
            },
            via: "chat",
          })
        : []),
    ],
  };
}
