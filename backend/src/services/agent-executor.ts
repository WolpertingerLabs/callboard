/**
 * Shared agent execution helper.
 *
 * Central function used by the cron scheduler and event watcher
 * to start agent sessions without duplicating session-launch logic.
 *
 * Uses the same lazy setMessageSender pattern as agent-tools.ts to break the
 * circular dependency with claude.ts.
 */
import { getAgent, getAgentWorkspacePath } from "./agent-file-service.js";
import { compileSystemPrompt } from "./claude-compiler.js";
import { appendActivity } from "./agent-activity.js";
import { createLogger } from "../utils/logger.js";

import type { ActivityEntry, EffortLevel, UiAgentProviderKind } from "shared";

const log = createLogger("agent-executor");

// ─── Lazy reference to sendMessage ──────────────────────────────────
// Same pattern as agent-tools.ts: claude.ts registers itself at startup.

type MessageSender = (opts: {
  prompt: string | AsyncIterable<any>;
  chatId?: string;
  folder?: string;
  systemPrompt?: string;
  agentAlias?: string;
  maxTurns?: number;
  defaultPermissions?: any;
  triggered?: boolean;
  triggeredBy?: "cron" | "event" | "trigger" | "tool";
  provider?: UiAgentProviderKind;
  /** Which ACP vendor, when `provider` is `"acp"`. Ignored for every other kind. */
  acpProviderId?: string;
  model?: string;
  effort?: EffortLevel;
  requireExplicitCompletion?: boolean;
}) => Promise<import("events").EventEmitter>;

let _sendMessage: MessageSender | null = null;

/**
 * Register the sendMessage function. Called by claude.ts on module load
 * to break the circular dependency.
 */
export function setExecutorMessageSender(fn: MessageSender): void {
  _sendMessage = fn;
}

function getSendMessage(): MessageSender {
  if (!_sendMessage) throw new Error("sendMessage not registered for executor — call setExecutorMessageSender() first");
  return _sendMessage;
}

// ─── Public API ─────────────────────────────────────────────────────

export interface ExecuteAgentOptions {
  agentAlias: string;
  prompt: string;
  triggeredBy: "cron" | "event" | "trigger" | "tool";
  metadata?: Record<string, unknown>;
  maxTurns?: number;
  provider?: UiAgentProviderKind;
  /**
   * Which ACP vendor, when `provider` is `"acp"`. Required there and ignored
   * everywhere else: `"acp"` is one kind covering many CLIs, so the kind alone
   * does not identify a harness.
   */
  acpProviderId?: string;
  model?: string;
  /** OR-only reasoning effort. Ignored when provider is claude-code. */
  effort?: EffortLevel;
  /**
   * Require the session to call objective_complete before it counts as done
   * — ends-without-calling gets nudged to continue. Default: false.
   */
  requireExplicitCompletion?: boolean;
  /**
   * Chat that spawned this agent session — links the new chat into the
   * cross-engine chat parentage tree. Skipped when the parent has no
   * stored record.
   */
  parentChatId?: string;
  /** Free-form role label for the new chat's tree node (e.g. "agent-deploy"). */
  chatRole?: string;
}

export interface ExecuteAgentResult {
  chatId: string;
}

/**
 * Execute an agent session.
 *
 * Loads agent config, compiles identity, starts a Claude Code session
 * with Callboard tools injected, and logs the activity.
 *
 * Returns the chatId of the new session, or null if it failed.
 */
export async function executeAgent(opts: ExecuteAgentOptions): Promise<ExecuteAgentResult | null> {
  const { agentAlias, prompt, triggeredBy, metadata, maxTurns, provider, acpProviderId, model, effort, requireExplicitCompletion } = opts;

  try {
    const config = getAgent(agentAlias);
    if (!config) {
      log.error(`Agent "${agentAlias}" not found for ${triggeredBy} execution`);
      return null;
    }

    if (config.enabled === false) {
      log.warn(`Agent "${agentAlias}" is disabled — skipping ${triggeredBy} execution`);
      return null;
    }

    const workspacePath = getAgentWorkspacePath(agentAlias);
    const fullSystemPrompt = compileSystemPrompt(config, workspacePath).prompt;
    const sendMessage = getSendMessage();

    // Build async generator prompt (required when MCP servers are present)
    const promptIterable = (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: prompt },
      };
    })();

    const emitter = await sendMessage({
      prompt: promptIterable,
      folder: workspacePath,
      systemPrompt: fullSystemPrompt,
      agentAlias,
      maxTurns: maxTurns ?? 200,
      triggered: true,
      triggeredBy,
      defaultPermissions: {
        fileRead: "allow",
        fileWrite: "allow",
        codeExecution: "allow",
        webAccess: "allow",
      },
      ...(provider && { provider }),
      ...(provider === "acp" && acpProviderId && { acpProviderId }),
      ...(model && { model }),
      ...(effort && { effort }),
      ...(requireExplicitCompletion === true && { requireExplicitCompletion: true }),
      ...(opts.parentChatId && { parentChatId: opts.parentChatId, ...(opts.chatRole && { chatRole: opts.chatRole }) }),
    });

    // Wait for chat_created event to get chatId
    const chatId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for session to start")), 30_000);
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

    log.info(`[${triggeredBy}] Started session ${chatId} for agent ${agentAlias}`);

    // Log activity
    const activityType: ActivityEntry["type"] = triggeredBy === "tool" ? "system" : triggeredBy;
    appendActivity(agentAlias, {
      type: activityType,
      message: `${triggeredBy} session started`,
      metadata: {
        chatId,
        triggeredBy,
        ...metadata,
      },
    });

    return { chatId };
  } catch (err: any) {
    log.error(`[${triggeredBy}] Failed to execute agent ${agentAlias}: ${err.message}`);
    appendActivity(agentAlias, {
      type: "system",
      message: `${triggeredBy} execution failed: ${err.message}`,
      metadata: { triggeredBy, error: err.message, ...metadata },
    });
    return null;
  }
}
