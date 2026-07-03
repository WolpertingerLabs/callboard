/**
 * Model Routing tools — the MCP server injected ONLY into chats that have model
 * routing enabled (OpenRouter chats started with the router toggle on).
 *
 * `reclassify_model` lets the running agent re-run the classifier over text it
 * supplies (e.g. a shift in the task) and switch the routed model. The switch
 * takes effect immediately: the handler updates the chat's `model` metadata
 * (and broadcasts so the UI/badge update) AND records a pending model switch
 * that the sendMessage query loop consumes — when the current turn ends it
 * resumes the SAME session on the newly selected model, so the agent continues
 * its work without the user sending another message.
 *
 * Mirrors objective-tools.ts: a `getChatId` closure supplies the chat context,
 * the handler persists via chatFileService + sessionRegistry, and a small
 * in-memory store bridges the tool call to the running loop (keyed by chatId).
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import { chatFileService } from "./chat-file-service.js";
import { sessionRegistry } from "./session-registry.js";
import { classifyAndResolve, getUsableRoutingConfig } from "./model-routing.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("model-routing-tools");

/** A model switch requested by reclassify_model, awaiting the query loop to apply it. */
export interface PendingModelSwitch {
  /** Resolved OpenRouter model slug to switch to. */
  model: string;
  /** The class the classifier chose. */
  classId: string;
}

// In-memory bridge from the tool call to the running sendMessage loop, keyed by
// chatId. The loop drains it via takePendingModelSwitch() when a run ends and, if
// present, resumes the session on the new model. Cleared at the start of each new
// sendMessage so a switch that never got consumed (errored/aborted run) can't leak
// into a later, unrelated message.
const pendingSwitches = new Map<string, PendingModelSwitch>();

export function requestModelSwitch(chatId: string, model: string, classId: string): void {
  pendingSwitches.set(chatId, { model, classId });
}

/** Get and remove the pending switch for a chat (if any). */
export function takePendingModelSwitch(chatId: string): PendingModelSwitch | undefined {
  const sw = pendingSwitches.get(chatId);
  pendingSwitches.delete(chatId);
  return sw;
}

export function clearPendingModelSwitch(chatId: string): void {
  pendingSwitches.delete(chatId);
}

export function buildModelRoutingToolsSpec(getChatId: () => string): ToolServerSpec {
  return {
    name: "model-routing",
    version: "1.0.0",
    tools: [
      defineTool(
        "reclassify_model",
        "Re-run the model router's classifier on the text you provide and switch this chat to the model it selects. " +
          "Use this when the nature of the task shifts (e.g. from casual chat to heavy coding) and a different model tier " +
          "would serve better. The classifier picks a task category, which combines with this chat's tier to pick a model. " +
          "The switch takes effect immediately: END YOUR TURN right after calling this tool and the session will continue " +
          "automatically on the newly selected model. Returns the chosen category and model.",
        {
          input: z
            .string()
            .describe(
              "The text to classify — typically a summary of the current or upcoming task (e.g. 'refactor the auth module and add tests'). The classifier reads this to choose the category.",
            ),
        },
        async (args) => {
          const chatId = getChatId();
          const config = getUsableRoutingConfig();
          if (!config) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "Model routing is not enabled/configured." }) }],
            };
          }

          // Recover the chat's chosen rank/tier from metadata.
          let rankId: string | undefined;
          const chat = chatFileService.getChat(chatId);
          if (chat) {
            try {
              const meta = JSON.parse(chat.metadata || "{}");
              rankId = typeof meta.modelRoutingRankId === "string" ? meta.modelRoutingRankId : undefined;
            } catch {
              /* ignore malformed metadata */
            }
          }

          const decision = await classifyAndResolve(args.input, rankId);
          if (!decision) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "Model routing is not enabled/configured." }) }],
            };
          }

          let applied = false;
          if (decision.model) {
            applied = chatFileService.updateChatMetadata(chatId, {
              model: decision.model,
              modelRoutingClassId: decision.classId,
            });
            if (applied) {
              sessionRegistry.notifyMetadata(chatId, { model: decision.model, modelRoutingClassId: decision.classId });
            } else {
              log.warn(`reclassify_model: failed to persist model onto chat ${chatId} (record may not exist yet)`);
            }
            // Record the switch so the running query loop resumes this session on
            // the new model as soon as the current turn ends — no user message needed.
            requestModelSwitch(chatId, decision.model, decision.classId);
          }

          log.info(
            `reclassify_model — chat=${chatId}, class=${decision.classId}, rank=${decision.rankId ?? "(none)"}, ` +
              `model=${decision.model ?? "(no cell — unchanged)"}, applied=${applied}`,
          );

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  classId: decision.classId,
                  classLabel: decision.classLabel,
                  rankId: decision.rankId,
                  selectedModel: decision.model,
                  matched: decision.matched,
                  applied,
                  note: decision.model
                    ? "Model switched. End your turn now — the session will continue automatically on the newly selected model."
                    : "No matrix cell matched this category/tier — the chat's current model is unchanged.",
                }),
              },
            ],
          };
        },
      ),
    ],
  };
}
