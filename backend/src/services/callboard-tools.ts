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
import { getVisibleCodexModelsAsync, searchCodexModels } from "./codex-models.js";
import { getSdkInfoAsync } from "./sdk-info.js";
import { getUserContact } from "./user-contact.js";
import { customSkillsService, slugifySkillName } from "./custom-skills-service.js";
import { providerModelSchema, resolveProviderModelArgs } from "./tool-provider-args.js";
import { registerCompletionCallback, removeCallbacks } from "./session-callbacks.js";
import { buildChatTree, getParentChatId, walkToRootId } from "./chat-lineage.js";
import { patchCardFields, isCardEligible, CARD_METADATA_VALUE_MAX, CARD_TITLE_MAX } from "./card-fields.js";
import { buildCardSummaries } from "./card-rollup.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { listRuns } from "./job-store.js";
import { buildMetadataPatch } from "./card-metadata-args.js";
import { CARD_CATEGORY_MAX } from "shared";
import { captureWorktreeWorkspace } from "./workspace-store.js";
import { startActivity, endActivity, openOrContinueWatch, closeWatch, exhaustWatch } from "./chat-activity.js";
import type { ConditionWatch, UiAgentProviderKind } from "shared/types/index.js";
import { buildJobManagementTools } from "./job-management-tools.js";
import { buildModelAliasTools } from "./model-alias-tools.js";
import { buildWorkspaceTools } from "./workspace-tools.js";
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
  provider?: UiAgentProviderKind;
  /** Which ACP vendor, when `provider` is `"acp"`. Ignored for every other kind. */
  acpProviderId?: string;
  model?: string;
  requireExplicitCompletion?: boolean;
  parentChatId?: string;
  chatRole?: string;
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
  // provider's transcript format (Claude Code JSONL, Codex rollout,
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

/**
 * What to tell the model after a `wait` returns.
 *
 * The early-release wording carries real weight: a model that is told only
 * "you waited 42 of 300 seconds" reliably concludes it should wait out the
 * remainder, which defeats the entire point of the button. It has to be told
 * why the wait ended and what to do instead.
 */
function buildWaitNote(opts: { endedEarly: boolean; hasCondition: boolean }): string {
  if (opts.endedEarly) {
    return opts.hasCondition
      ? "The user ended this wait early — they can see the condition you were polling for, and believe it is now satisfied. " +
          "Check it now. If it holds, call wait_condition_met. Do not simply wait again."
      : "The user ended this wait early — they believe whatever you were waiting for has already happened. " +
          "Re-check your assumption and proceed. Do not simply wait again.";
  }
  return opts.hasCondition
    ? "The interval elapsed. Now check the condition yourself. If it is satisfied, call wait_condition_met; " +
        "if not, call wait again with the same require_condition to keep polling."
    : "The interval elapsed.";
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
    /**
     * The engine this session is itself running on, and (for ACP) which vendor.
     * `start_chat_session` inherits it when the caller does not name a provider,
     * so a Pi session spawns Pi children rather than silently handing them to
     * Claude Code.
     *
     * `provider`/`acpProviderId` are plain values, not getters: a chat's
     * provider is immutable by design (see plans/openrouter-adapter.md), so
     * they are fixed for the session's whole lifetime and there is nothing to
     * re-read. `getModel` is the exception — a getter — because a chat's model
     * IS mutable (the user can switch it mid-chat, and the switch lands in the
     * chat record's metadata before the next turn), so a value captured here
     * would go stale for the rest of the session.
     */
    provider?: UiAgentProviderKind;
    acpProviderId?: string;
    /**
     * Live read of the calling chat's current model override. Drives `model`
     * inheritance in the session-starting tools when the caller omits `model`.
     */
    getModel?: () => string | undefined;
  },
): ToolServerSpec {
  /**
   * Resolve the target card for a setter: an explicit card_id (any chat id
   * in a tree resolves to that tree's card — agents know member chat ids
   * far more often than root ids) or, by default, the calling chat's
   * lineage root.
   */
  const resolveCardTarget = (cardId: string | undefined): { rootChatId?: string; error?: string } => {
    const targetId = cardId ?? (getChatId ? getChatId() : undefined);
    if (!targetId) return { error: "Chat context not available — pass card_id explicitly" };
    if (targetId.includes("/") || targetId.includes("\\") || targetId.includes("\0") || targetId === "." || targetId === "..") {
      return { error: `Card "${targetId}" not found` };
    }
    if (!chatFileService.getChat(targetId)) return { error: `Card "${targetId}" not found` };
    const rootChatId = walkToRootId(targetId);
    const rootChat = chatFileService.getChat(rootChatId);
    if (!rootChat || !isCardEligible(rootChat)) {
      return { error: `Chat "${targetId}" has no card — its lineage root is not a card root (triggered or job-step chat)` };
    }
    return { rootChatId };
  };

  /** Full board rollup, shared by list_cards and get_card. */
  const cardSummaries = (includeHidden = false) =>
    buildCardSummaries(listChatsSnapshot(), listRuns({ withRoot: true }), undefined, { includeHidden });

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

      // ── Cards (tickets) ──────────────────────────────────────────────
      // A card IS the lineage root chat of this conversation: the root
      // chat's metadata.card holds the fields, and every chat/job run in
      // the tree is a member by construction. Nothing is created and
      // nothing is joined — "this chat's card" is always the root of its
      // own lineage tree, which is why every setter below resolves the
      // target as the calling chat's lineage root unless an explicit
      // card_id names another tree.

      defineTool(
        "list_cards",
        "List cards (tickets) with their lifecycle and narrative status. Includes closed cards by default — useful to check whether a topic was already handled. Filter with lifecycle: 'open' or 'closed'.",
        {
          lifecycle: z.enum(["open", "closed"]).optional().describe("Only cards in this lifecycle (default: all)"),
        },
        async (args) => {
          const cards = cardSummaries()
            .filter((c) => !args.lifecycle || c.lifecycle === args.lifecycle)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((c) => ({
              cardId: c.id,
              title: c.title,
              emoji: c.emoji,
              lifecycle: c.lifecycle,
              ...(c.category && { category: c.category }),
              ...(c.closedAt && { closedAt: c.closedAt }),
              ...(c.status && { status: c.status }),
              ...(c.statusEmoji && { statusEmoji: c.statusEmoji }),
              ...(c.metadata && { metadata: c.metadata }),
              ...(c.description && { description: c.description.length > 200 ? `${c.description.slice(0, 200)}…` : c.description }),
              updatedAt: c.updatedAt,
            }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ cards }) }] };
        },
      ),

      defineTool(
        "get_card",
        "Get a card (ticket) with its full description and member chats (id, title, live status). card_id is the card's root chat id; any member chat id of the tree resolves to the same card. Defaults to the current chat's card.",
        {
          card_id: z.string().optional().describe("The card id (default: the current chat's lineage root)"),
        },
        async (args) => {
          const target = resolveCardTarget(args.card_id);
          if (target.error || !target.rootChatId) return error(target.error ?? "Card not found");
          const card = cardSummaries(true).find((c) => c.id === target.rootChatId);
          if (!card) return error(`Card "${target.rootChatId}" not found`);
          // memberChats come off the rollup, already newest-first — an agent
          // reads memberChats[0] as "the chat this card is on right now",
          // and any other ordering would make that an arbitrary member.
          const memberChats = card.memberChats.map((m) => ({
            chatId: m.chatId,
            title: m.title,
            ...(m.chatStatus && { chatStatus: m.chatStatus }),
            ...(m.jobRunId && { jobRunId: m.jobRunId }),
            updatedAt: m.updatedAt,
          }));
          const memberRuns = card.memberRuns.map((r) => ({
            runId: r.runId,
            jobId: r.jobId,
            jobName: r.jobName,
            status: r.status,
            updatedAt: r.updatedAt,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ card, memberChats, memberRuns }) }] };
        },
      ),

      defineTool(
        "update_card",
        "Amend the card (ticket) this conversation belongs to: its title, description, and emoji. Omitted fields are left untouched. The card is the board view of this conversation's lineage root — use set_card_status / set_card_category / set_card_metadata for those fields. Defaults to the current chat's card.",
        {
          title: z.string().max(CARD_TITLE_MAX).optional().describe("New card title (blank titles are rejected)"),
          description: z.string().optional().describe("Markdown description of the topic/goal"),
          emoji: z.string().optional().describe("Single emoji shown on the card face"),
          card_id: z.string().optional().describe("Target card id (default: the current chat's lineage root)"),
        },
        async (args) => {
          if (args.title === undefined && args.description === undefined && args.emoji === undefined) {
            return error("Pass at least one of title, description, emoji");
          }
          const target = resolveCardTarget(args.card_id);
          if (target.error || !target.rootChatId) return error(target.error ?? "Card not found");
          let card;
          try {
            card = patchCardFields(target.rootChatId, {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.description !== undefined && { description: args.description }),
              ...(args.emoji !== undefined && { emoji: args.emoji }),
            });
          } catch (err) {
            return error(err instanceof Error ? err.message : "Failed to update card");
          }
          if (!card) return error(`Card "${target.rootChatId}" not found`);
          sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true, cardId: card.id, title: card.title, emoji: card.emoji }) }],
          };
        },
      ),

      defineTool(
        "set_card_status",
        "Set the narrative status shown on a card (ticket) face in the board view, e.g. 'waiting on CI for branch 3/4'. Defaults to the current chat's card. Pass an empty status string to clear it.",
        {
          status: z.string().max(160).describe("Short status line (max 160 chars). Empty string clears the status."),
          emoji: z.string().optional().describe("Single emoji prefix (e.g. '⏳', '🧪')"),
          card_id: z.string().optional().describe("Target card id (default: the current chat's lineage root)"),
        },
        async (args) => {
          const target = resolveCardTarget(args.card_id);
          if (target.error || !target.rootChatId) return error(target.error ?? "Card not found");
          let card;
          try {
            card = patchCardFields(target.rootChatId, { status: args.status || null, statusEmoji: args.emoji || null });
          } catch (err) {
            return error(err instanceof Error ? err.message : "Failed to update card status");
          }
          if (!card) return error(`Card "${target.rootChatId}" not found`);
          sessionRegistry.notifyMetadata(card.id, { cardEvent: "status" });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ success: true, cardId: card.id, status: card.status ?? null, emoji: card.statusEmoji ?? null }) },
            ],
          };
        },
      ),

      defineTool(
        "set_card_category",
        "Set or clear the category on a card (ticket). Categories are optional free-form labels the board groups open cards under — reuse an existing category from list_cards when one fits. Defaults to the current chat's card. Pass an empty string to clear.",
        {
          category: z.string().max(CARD_CATEGORY_MAX).describe(`Category label (max ${CARD_CATEGORY_MAX} chars). Empty string clears the category.`),
          card_id: z.string().optional().describe("Target card id (default: the current chat's lineage root)"),
        },
        async (args) => {
          const target = resolveCardTarget(args.card_id);
          if (target.error || !target.rootChatId) return error(target.error ?? "Card not found");
          let card;
          try {
            card = patchCardFields(target.rootChatId, { category: args.category || null });
          } catch (err) {
            return error(err instanceof Error ? err.message : "Failed to update card category");
          }
          if (!card) return error(`Card "${target.rootChatId}" not found`);
          sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true, cardId: card.id, category: card.category ?? null }) }],
          };
        },
      ),

      defineTool(
        "set_card_metadata",
        "Attach arbitrary key→value cross-references to a card (ticket) — a GitHub PR URL, a Linear/Jira ticket id, a Slack thread link, an external session id, etc. Keys are arbitrary and chosen by you; prefer short stable slugs like 'github-pr' or 'linear'. Updates merge per key: keys you don't mention are left alone, so this is safe to call while the user or another agent is editing the same card. Defaults to the current chat's card.",
        {
          set: z
            .record(z.string(), z.string().max(CARD_METADATA_VALUE_MAX))
            .optional()
            .describe('Keys to write or overwrite, e.g. { "github-pr": "https://github.com/org/repo/pull/42" }'),
          remove: z.array(z.string()).optional().describe("Keys to delete from the card's metadata"),
          card_id: z.string().optional().describe("Target card id (default: the current chat's lineage root)"),
        },
        async (args) => {
          const patch = buildMetadataPatch(args.set, args.remove);
          if (!patch.ok) return error(patch.error);
          const target = resolveCardTarget(args.card_id);
          if (target.error || !target.rootChatId) return error(target.error ?? "Card not found");
          let card;
          try {
            card = patchCardFields(target.rootChatId, { metadata: patch.metadata });
          } catch (err) {
            return error(err instanceof Error ? err.message : "Failed to update card metadata");
          }
          if (!card) return error(`Card "${target.rootChatId}" not found`);
          sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true, cardId: card.id, metadata: card.metadata ?? {} }) }],
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
        "Start a new chat session in any directory, on this session's own engine unless you ask for another one. Returns the chatId of the new " +
          "session. Supports optional git branch/worktree configuration. " +
          "The session runs asynchronously. Prefer onComplete=true to be notified (a new turn in THIS chat) when it finishes — no polling at all. " +
          "If you must poll, use get_session_status and sleep between checks with the `wait` tool. " +
          "Do NOT sleep by running `sleep` as a background Bash command: `wait` shows the user a live countdown they can end early, while a background shell shows nothing and forces this session to be held open until it finishes. " +
          "The spawned chat is automatically linked as a child of THIS chat in the chat parentage tree (see get_chat_tree); pass `role` to label its node.",
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
          role: z
            .string()
            .max(40)
            .optional()
            .describe(
              'Free-form label for the spawned chat\'s node in the chat parentage tree, e.g. "subagent", "monitor", "router", "engine-switch". Shown in the tree UI and get_chat_tree output.',
            ),
          ...providerModelSchema,
        },
        async (args) => {
          try {
            const sendMessage = getSendMessage();

            const providerModel = resolveProviderModelArgs(args, {
              provider: opts?.provider,
              acpProviderId: opts?.acpProviderId,
              getModel: opts?.getModel,
            });
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
            // Record why the worktree exists while we still know — same single
            // write path the /new/message route uses (plans/workspace-object.md).
            const workspaceId = captureWorktreeWorkspace(branchResult);

            // Resolve the calling chat for parentage linking. getChatId can
            // return a temp tracking id (`new-<ts>`) for a still-registering
            // caller — only link when the parent has a real stored record.
            const callerChatId = getChatId?.();
            const parentChat = callerChatId ? chatFileService.getChat(callerChatId) : null;

            // Give the child context about its caller so it can pull details
            // on demand (works across engines — the tools are engine-agnostic).
            const childPrompt = parentChat
              ? `${args.prompt}\n\n(Spawned by chat ${parentChat.id}. For caller context, use the callboard get_chat_tree tool or read_session_messages with chatId "${parentChat.id}".)`
              : args.prompt;

            // Build async generator prompt (required when MCP servers are present)
            const promptIterable = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: childPrompt },
              };
            })();

            const emitter = await sendMessage({
              prompt: promptIterable,
              folder: effectiveFolder,
              maxTurns: args.maxTurns ?? 200,
              defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
              provider: providerModel.provider,
              ...(providerModel.acpProviderId && { acpProviderId: providerModel.acpProviderId }),
              ...(providerModel.model && { model: providerModel.model }),
              ...(args.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
              ...(parentChat && { parentChatId: parentChat.id, ...(args.role && { chatRole: args.role }) }),
              ...(workspaceId && { workspaceId }),
            });

            // Listen for chat_created to get the chatId.
            //
            // The listener is named and detached on all three exits. The
            // emitter outlives this promise by the whole length of the spawned
            // run, so an anonymous handler left attached would go on being
            // called for every event of a session this tool stopped caring
            // about the moment it had the id — and one spawner that starts many
            // children accumulates one dead listener per child.
            const chatId = await new Promise<string>((resolve, reject) => {
              const onEvent = (event: any) => {
                if (event.type === "chat_created" && event.chatId) {
                  clearTimeout(timeout);
                  emitter.off("event", onEvent);
                  resolve(event.chatId);
                } else if (event.type === "error") {
                  clearTimeout(timeout);
                  emitter.off("event", onEvent);
                  reject(new Error(event.content || "Session failed to start"));
                }
              };
              const timeout = setTimeout(() => {
                emitter.off("event", onEvent);
                reject(new Error("Timed out waiting for session to start"));
              }, 30000);
              emitter.on("event", onEvent);
            });

            log.info(`Started chat session ${chatId} in ${effectiveFolder}`);

            // ── "Phone home" on-complete callback registration ──
            let onComplete: { registered: boolean; note?: string } | undefined;
            if (args.onComplete) {
              const { registered, note } = registerCompletionCallback({
                childChatId: chatId,
                parentChatId: getChatId?.(),
                parentAgentAlias: getAgentAlias?.(),
                kind: "spawned",
              });
              onComplete = { registered, ...(note && { note }) };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    chatId,
                    status: "started",
                    folder: effectiveFolder,
                    // What the child will run, and how the model was chosen — so
                    // a caller that expected "same model as me" can see when
                    // that did NOT hold (cross-engine, non-alias) and pass an
                    // explicit model if it cares.
                    ...(providerModel.model && { model: providerModel.model }),
                    modelSource: providerModel.modelSource,
                    ...(providerModel.inheritanceNote && { inheritanceNote: providerModel.inheritanceNote }),
                    ...(parentChat && { parentChatId: parentChat.id, ...(args.role && { role: args.role }) }),
                    ...(onComplete && { onComplete }),
                  }),
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

      // ── Codex Model Discovery ──────────────────────────────────────

      defineTool(
        "list_codex_models",
        "List Codex models from the cached live Codex CLI model catalog. Use the returned slug as the `model` param when starting a codex session. The list is refreshed on app start.",
        {
          limit: z.number().optional().describe("Max models to return (default: all)."),
        },
        async (args) => {
          try {
            const models = await getVisibleCodexModelsAsync();
            const limited = typeof args.limit === "number" ? models.slice(0, Math.max(1, args.limit)) : models;
            const rows = limited.map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.description && { description: m.description }),
              ...(m.defaultReasoningLevel && { defaultReasoningLevel: m.defaultReasoningLevel }),
              ...(m.supportedReasoningLevels && { supportedReasoningLevels: m.supportedReasoningLevels }),
              ...(m.serviceTiers && { serviceTiers: m.serviceTiers }),
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    count: rows.length,
                    total: models.length,
                    models: rows,
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`list_codex_models failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error listing Codex models: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "search_codex_models",
        "Search cached Codex models by slug or display name using subsequence matching (characters in order, e.g. 'g55' matches 'gpt-5.5').",
        {
          query: z.string().describe("Search text matched as a subsequence against the model slug or display name."),
          limit: z.number().optional().describe("Max results to return (default: 50)."),
        },
        async (args) => {
          try {
            const matched = await searchCodexModels(args.query, args.limit ?? 50);
            const rows = matched.map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.description && { description: m.description }),
              ...(m.defaultReasoningLevel && { defaultReasoningLevel: m.defaultReasoningLevel }),
              ...(m.supportedReasoningLevels && { supportedReasoningLevels: m.supportedReasoningLevels }),
              ...(m.serviceTiers && { serviceTiers: m.serviceTiers }),
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    query: args.query,
                    count: rows.length,
                    models: rows,
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`search_codex_models failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error searching Codex models: ${err.message}` }] };
          }
        },
      ),

      // ── OpenRouter Model Discovery ──────────────────────────────────

      defineTool(
        "list_openrouter_models",
        "List OpenRouter models that support tool calling, with their input/output pricing (per 1M tokens). Use the returned slug wherever an OpenRouter model id is configured — the Claude Code / Codex / Cline / pi harnesses can each be pointed at OpenRouter credentials in Settings → API. The list is cached and refreshed on app start. The `aliases` field is vestigial: it reads the deprecated OpenRouter-only alias map, which is retired the first time the unified registry is written, so it is empty for most installs — use list_model_aliases for cross-harness aliases.",
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
        "Search tool-calling OpenRouter models by slug using subsequence matching (characters in order, e.g. 'claop' matches 'anthropic/claude-opus'). Returns matching slugs with input/output pricing (per 1M tokens). Alias matching is vestigial — it reads the deprecated OpenRouter-only alias map, which is retired the first time the unified registry is written, so it matches nothing for most installs. Use list_model_aliases for cross-harness aliases.",
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
        "Check the status of a Claude Code session. Returns whether the session is active, complete, or not found. " +
          "To poll, sleep between checks with the `wait` tool — not a background `sleep` shell, which is invisible to the user and holds this session open until it finishes.",
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
        "Send a follow-up message to an existing chat or agent session. Resumes the conversation preserving full context. The session must not be currently active. " +
          "The continuation runs asynchronously. Prefer onComplete=true to be notified (a new turn in THIS chat) when it finishes — no polling at all. " +
          "If you must poll, use get_session_status and sleep between checks with the `wait` tool. " +
          "Do NOT sleep by running `sleep` as a background Bash command: `wait` shows the user a live countdown they can end early, while a background shell shows nothing and forces this session to be held open until it finishes.",
        {
          chatId: z.string().describe("The chat/session ID to continue"),
          prompt: z.string().describe("The follow-up message to send"),
          maxTurns: z.number().optional().describe("Maximum agentic turns for this continuation (default: 200)"),
          onComplete: z
            .boolean()
            .optional()
            .describe(
              "If true, automatically re-invoke THIS chat with a notification when the continued session completes (success, error, or stop), so you can read its results and continue without polling. Default: false.",
            ),
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

            // 3. "Phone home" on-complete callback registration.
            //    Registered BEFORE the message is sent: unlike start_chat_session
            //    we already know the child chatId, so there is no window in which
            //    a fast continuation could stop before the callback exists (a
            //    completion with nothing pending leaves the callback "waiting"
            //    forever). Rolled back below if the send throws.
            let onComplete: { registered: boolean; note?: string } | undefined;
            let onCompleteId: string | undefined;
            if (args.onComplete) {
              const { registered, id, note } = registerCompletionCallback({
                childChatId: args.chatId,
                parentChatId: getChatId?.(),
                parentAgentAlias: getAgentAlias?.(),
                kind: "continued",
              });
              onComplete = { registered, ...(note && { note }) };
              onCompleteId = id;
            }

            // 4. Build async generator prompt (required when MCP servers are present)
            const promptIterable = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: args.prompt },
              };
            })();

            // 5. Send the continuation message
            try {
              await sendMessage({
                chatId: args.chatId,
                prompt: promptIterable,
                maxTurns: args.maxTurns ?? 200,
                ...(typeof args.requireExplicitCompletion === "boolean" && { requireExplicitCompletion: args.requireExplicitCompletion }),
              });
            } catch (err) {
              // Nothing is running, so nothing will ever mark this ready.
              if (onCompleteId) removeCallbacks([onCompleteId]);
              throw err;
            }

            // 6. Return as soon as the session is running. Results come back
            //    through the onComplete callback, or via get_session_status /
            //    read_session_messages if the caller did not ask for one.
            log.info(`Continued chat ${args.chatId} (async)`);

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    chatId: args.chatId,
                    status: "continued",
                    ...(onComplete && { onComplete }),
                  }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`continue_chat failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error continuing chat: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "find_chats",
        "Search chat sessions for a repo folder, including worktrees. Scans all Claude Code sessions in ~/.claude/projects/, minus any project folder the user has ignored in Settings — those are skipped even when this call names one. Ignoring a folder is the user's instruction to leave it alone, so treat an empty result for an ignored folder as the answer, not as a reason to go read ~/.claude/projects/ directly. Returns matching chats sorted by most recently updated. Use with continue_chat to resume a previous conversation.",
        {
          folder: z.string().describe("Repo working directory path (also searches worktrees of this repo)"),
          grep: z.string().optional().describe("Search term to grep across session conversation content (messages, tool calls, code, etc.)"),
          gitBranch: z.string().optional().describe("Filter by git branch (matches live worktree branches and stored session metadata)"),
          agentAlias: z.string().optional().describe("Filter to chats started by a specific agent"),
          triggered: z.boolean().optional().describe("Filter to automated (true) or manual (false) sessions"),
          updatedAfter: z.string().optional().describe("ISO-8601 date — only chats updated after this time"),
          updatedBefore: z.string().optional().describe("ISO-8601 date — only chats updated before this time"),
          parentChatId: z
            .string()
            .optional()
            .describe("Filter to direct children of this chat in the parentage tree (folder-scoped — use get_chat_tree for the full cross-folder tree)"),
          rootChatId: z
            .string()
            .optional()
            .describe("Filter to chats belonging to the tree rooted at this chat (folder-scoped — use get_chat_tree for the full cross-folder tree)"),
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

            // Lineage post-filters — parentage lives in callboard chat
            // metadata, not in provider transcripts, so filter here instead
            // of widening the provider search seam.
            let filtered = allChats;
            if (args.parentChatId || args.rootChatId) {
              filtered = allChats.filter((c: any) => {
                const stored = chatFileService.getChat(c.chatId ?? c.id);
                if (!stored) return false;
                let meta: Record<string, any> = {};
                try {
                  meta = JSON.parse(stored.metadata || "{}");
                } catch {}
                if (args.parentChatId && getParentChatId(meta) !== args.parentChatId) return false;
                if (args.rootChatId && meta.rootChatId !== args.rootChatId && stored.id !== args.rootChatId) return false;
                return true;
              });
            }
            const result = { chats: filtered, total: filtered.length };

            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          } catch (err: any) {
            log.error(`find_chats failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error searching chats: ${err.message}` }] };
          }
        },
      ),

      defineTool(
        "get_chat_tree",
        "Get the parentage tree for a chat: its ancestors and the full tree of descendant chats spawned from the same root, across all engines (claude-code, codex, cline, pi, acp). Each node includes chatId, title, role, provider, status (ongoing/waiting/stopped), and folder. Defaults to THIS chat when chatId is omitted. Use with read_session_messages / continue_chat to inspect or cooperate with related chats.",
        {
          chatId: z.string().optional().describe("Chat ID to get the tree for (default: the current chat)"),
        },
        async (args) => {
          try {
            const requestedId = args.chatId || getChatId?.();
            if (!requestedId) {
              return error("No chat context available — pass chatId explicitly");
            }
            // Resolve session ids or chat ids to the stored chat record.
            const chat = findChat(requestedId, false);
            const result = buildChatTree(chat?.id ?? requestedId);
            if (!result) {
              return error(`Chat "${requestedId}" not found or has no stored record`);
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          } catch (err: any) {
            log.error(`get_chat_tree failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error getting chat tree: ${err.message}` }] };
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
        "Pause execution for the specified number of seconds (1-300). Useful for waiting between polling operations, giving other processes time to complete, or adding delays between actions. " +
          "Include a fun, cute flavor description of what you're 'doing' while you wait — it is shown to the user alongside a live countdown, and the user can end the wait early if they " +
          "can see the thing you are waiting for has already happened.",
        {
          seconds: z.number().min(1).max(300).describe("Number of seconds to wait (1-300)"),
          flavor: z.string().describe("A fun, cute flavor description of what you're doing while waiting (e.g. 'Contemplating the meaning of semicolons')"),
          reason: z.string().optional().describe("Optional actual reason for waiting (for your own logging)"),
          require_condition: z
            .string()
            .optional()
            .describe(
              "Poll for an external condition this wait cannot observe itself (a CI run finishing, a deploy going green, a file appearing). " +
                "Describe the condition. After the sleep you MUST check it yourself — this tool only sleeps and tracks the attempts. " +
                "If the condition is satisfied, call wait_condition_met. If it is not, call wait again with the SAME require_condition to keep polling. " +
                "Your turn will be nudged if it ends with the condition unresolved.",
            ),
        },
        async (args) => {
          const seconds = Math.min(Math.max(1, Math.round(args.seconds)), 300);
          const chatId = getChatId?.();

          // ── Condition watch bookkeeping ──
          // Opened before the sleep so the countdown the user sees carries the
          // condition and its attempt number, not just the flavor text.
          let watch: ConditionWatch | undefined;
          if (args.require_condition && chatId) {
            watch = openOrContinueWatch(chatId, args.require_condition);
            if (watch.exhausted || watch.attempts > watch.maxAttempts) {
              // Refuse rather than sleep. A loop that has not converged in
              // this many attempts is not going to, and silently stalling
              // again would just burn another interval before the agent
              // discovered the same thing.
              //
              // The watch is marked exhausted rather than closed: closing it
              // would let this same condition be re-opened for a fresh budget,
              // which is exactly what the cap exists to prevent.
              const spent = exhaustWatch(chatId) ?? watch;
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      waited: 0,
                      refused: true,
                      condition: args.require_condition,
                      attempts: spent.attempts,
                      maxAttempts: spent.maxAttempts,
                      note:
                        `This condition has already been polled ${spent.maxAttempts} times without being met, so no further wait was performed — and calling wait again with the same condition will keep being refused. ` +
                        `Stop polling. Either take a different approach to verifying it, or call summon_user to ask the user to check. ` +
                        `If you are done with it either way, call wait_condition_met with satisfied: false.`,
                    }),
                  },
                ],
              };
            }
          }

          // ── The sleep ──
          // Resolves on whichever comes first: the timer, or the user ending
          // the wait from the UI. `release` is handed to the registry so the
          // route can reach it; the activity is torn down in the finally so a
          // throw cannot leave a phantom countdown running.
          let releasedBy: string | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let release!: (reason: string) => void;
          const startedAt = Date.now();

          // The executor runs synchronously, so `release` is assigned before
          // startActivity below ever sees it.
          const sleep = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, seconds * 1000);
            release = (reason: string) => {
              releasedBy = reason;
              if (timer) clearTimeout(timer);
              resolve();
            };
          });

          const activity = chatId
            ? startActivity(
                chatId,
                {
                  kind: "wait",
                  label: args.flavor,
                  ...(args.reason && { detail: args.reason }),
                  expiresAt: startedAt + seconds * 1000,
                  interruptible: true,
                  ...(watch && { condition: { text: watch.text, attempt: watch.attempts, maxAttempts: watch.maxAttempts } }),
                },
                release,
              )
            : undefined;

          try {
            await sleep;
          } finally {
            if (timer) clearTimeout(timer);
            if (activity) endActivity(activity.id);
          }

          const waited = Math.round((Date.now() - startedAt) / 1000);
          const endedEarly = releasedBy !== undefined;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  waited,
                  ...(endedEarly && { requested: seconds, endedEarly: true, releasedBy }),
                  flavor: args.flavor,
                  ...(args.reason && { reason: args.reason }),
                  ...(watch && {
                    condition: watch.text,
                    attempt: watch.attempts,
                    maxAttempts: watch.maxAttempts,
                  }),
                  note: buildWaitNote({ endedEarly, hasCondition: !!watch }),
                }),
              },
            ],
          };
        },
      ),

      defineTool(
        "wait_condition_met",
        "Close the condition watch opened by wait(require_condition): confirm the external condition you were polling for is now satisfied. " +
          "Call this as soon as your check succeeds, instead of calling wait again. Pass satisfied: false to abandon the watch when you have given up " +
          "on the condition or are taking a different approach — either way the watch closes and the user's UI stops showing it. " +
          "This does NOT end your session and is unrelated to objective_complete; it only resolves the polling loop.",
        {
          satisfied: z.boolean().describe("true when the condition you were waiting for is now met; false to abandon the watch"),
          evidence: z.string().optional().describe("Brief note on how you verified it (or why you are abandoning), recorded for the user"),
        },
        async (args) => {
          const chatId = getChatId?.();
          if (!chatId) return error("Chat context not available");

          const watch = closeWatch(chatId, args.satisfied);
          if (!watch) {
            return error(
              "No open condition watch — this session is not polling for anything. A watch is opened by calling wait with require_condition; " +
                "there is nothing to resolve until then.",
            );
          }

          log.info(`Condition "${watch.text}" on ${chatId} resolved after ${watch.attempts} attempt(s): ${args.satisfied ? "met" : "abandoned"}`);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  condition: watch.text,
                  attempts: watch.attempts,
                  satisfied: args.satisfied,
                  ...(args.evidence && { evidence: args.evidence }),
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
            ...(getChatId && { getChatId }),
          })
        : []),

      // ── Model aliases: view/edit the cross-harness alias registry ───
      // Global (not per-chat). `model: "<alias>"` resolves to a different
      // concrete model per provider at session start (resolveModelAlias).
      ...buildModelAliasTools(),

      // ── Workspaces: where work happens, and its lifecycle ───────────
      // Global. archive_workspace is the only path in Callboard that removes
      // a directory, and it removes only worktrees Callboard created, that
      // still prove it, that nothing else references, and that are clean.
      // adopt_worktrees is the only way a worktree Callboard did not create
      // joins that set, and it acts on paths the caller names — never on a
      // pattern, and never on a discovery of its own. create_workspace, despite
      // the name, is not a third way in: it writes local records only and
      // refuses a worktree directory outright.
      ...buildWorkspaceTools(),
    ],
  };
}
