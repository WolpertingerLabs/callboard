/**
 * Objective tools — the MCP server injected ONLY into sessions started with
 * requireExplicitCompletion (the "explicit completion" toggle on cron jobs,
 * triggers, start_chat_session, the New Chat panel, etc.).
 *
 * objective_complete is how such a session signals that its objective is
 * actually done: the handler records the completion in an in-memory store
 * keyed by chatId, which the sendMessage nudge loop checks when the message
 * stream ends. If the stream ends without a recorded completion, the session
 * is resumed with a nudge prompt (up to a cap) instead of being treated as
 * finished. The completion is also persisted onto chat metadata so the UI
 * can badge the chat.
 *
 * Job-step sessions never get this server — they report through
 * complete_job_step (job-step-tools.ts) and the nudge loop watches the run's
 * pendingResult instead.
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import { chatFileService } from "./chat-file-service.js";
import { sessionRegistry } from "./session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("objective-tools");

export interface ObjectiveCompletion {
  message?: string;
  data?: Record<string, unknown>;
  completedAt: string;
}

// In-memory store of completions reported by currently/recently running
// sessions. Entries are cleared by sendMessage when a new requiring run
// starts for the chat, so a follow-up message needs a fresh
// objective_complete call.
const completions = new Map<string, ObjectiveCompletion>();

export function hasObjectiveCompletion(chatId: string): boolean {
  return completions.has(chatId);
}

export function getObjectiveCompletion(chatId: string): ObjectiveCompletion | undefined {
  return completions.get(chatId);
}

export function clearObjectiveCompletion(chatId: string): void {
  completions.delete(chatId);
}

export function buildObjectiveToolsSpec(getChatId: () => string): ToolServerSpec {
  return {
    name: "objective-tools",
    version: "1.0.0",
    tools: [
      defineTool(
        "objective_complete",
        "Declare the objective of this session complete. This session was started with explicit completion required — " +
          "it is NOT considered finished until you call this tool. If your turn ends without it, you will be re-prompted to " +
          "continue working. Call it exactly once, as the LAST thing you do, when the objective is fully achieved. " +
          "You may call it again before the session ends to overwrite an earlier report.",
        {
          message: z.string().optional().describe("Short human-readable summary of the outcome (shown in the chat UI)"),
          data: z
            .record(z.string(), z.any())
            .optional()
            .describe("Optional structured result data (keyed values for whoever spawned this session to consume)"),
        },
        async (args) => {
          const chatId = getChatId();
          const completion: ObjectiveCompletion = {
            ...(args.message && { message: args.message }),
            ...(args.data && { data: args.data }),
            completedAt: new Date().toISOString(),
          };
          completions.set(chatId, completion);

          // Persist onto chat metadata + broadcast so the UI can badge the
          // chat — same flow set_chat_status uses.
          const ok = chatFileService.updateChatMetadata(chatId, { objectiveComplete: completion });
          if (ok) {
            sessionRegistry.notifyMetadata(chatId, { objectiveComplete: completion });
          } else {
            log.warn(`objective_complete: failed to persist completion onto chat ${chatId} metadata (record may not exist yet)`);
          }

          log.info(`Objective marked complete for chat ${chatId}${args.message ? ` — ${args.message}` : ""}`);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  chatId,
                  note: "Objective recorded as complete. Finish your turn — the session will end normally.",
                }),
              },
            ],
          };
        },
      ),
    ],
  };
}
