/**
 * Custom CCUI Agent Tools — In-process MCP server for agent sessions.
 *
 * Gives agents programmatic access to platform APIs during their Claude Code sessions:
 * - Orchestrate other agents (start sessions, check status, read output)
 * - Manage their own cron jobs
 * - Query and log activity
 * - Discover other agents on the platform
 *
 * Built with createSdkMcpServer() from @anthropic-ai/claude-agent-sdk.
 * Injected into agent sessions via the mcpServers option in sendMessage().
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/custom-tools
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync } from "fs";
import { listAgents, getAgent, createAgent, agentExists, isValidAlias, ensureAgentWorkspaceDir, getAgentWorkspacePath } from "./agent-file-service.js";
import { scaffoldWorkspace, compileIdentityPrompt, compileWorkspaceContext } from "./claude-compiler.js";
import { executeAgent } from "./agent-executor.js";
import { listCronJobs, createCronJob, updateCronJob, deleteCronJob } from "./agent-cron-jobs.js";
import { scheduleJob, cancelJob } from "./cron-scheduler.js";
import { listTriggers, getTrigger, createTrigger, updateTrigger, deleteTrigger } from "./agent-triggers.js";
import { getActivity, appendActivity } from "./agent-activity.js";
import { getActiveSession } from "./claude.js";
import { updateHeartbeatConfig } from "./heartbeat.js";
import { updateConsolidationConfig } from "./memory-consolidation.js";
import { findSessionLogPath } from "../utils/session-log.js";
import { findChat } from "../utils/chat-lookup.js";
import { createLogger } from "../utils/logger.js";

import type { CronJob, Trigger, AgentConfig } from "shared";

const log = createLogger("agent-tools");

// ─── Lazy reference to sendMessage ──────────────────────────────────
// We use a lazy import to avoid circular dependency:
// agent-tools.ts → claude.ts → (uses buildAgentToolsServer from agent-tools.ts)
// Instead, claude.ts registers itself at startup via setMessageSender().

type MessageSender = (opts: {
  prompt: string | AsyncIterable<any>;
  chatId?: string;
  folder?: string;
  systemPrompt?: string;
  agentAlias?: string;
  maxTurns?: number;
  defaultPermissions?: any;
}) => Promise<import("events").EventEmitter>;

let _sendMessage: MessageSender | null = null;

/**
 * Register the sendMessage function. Called by claude.ts on module load
 * to break the circular dependency.
 */
export function setMessageSender(fn: MessageSender): void {
  _sendMessage = fn;
}

function getSendMessage(): MessageSender {
  if (!_sendMessage) throw new Error("sendMessage not registered — call setMessageSender() first");
  return _sendMessage;
}

// ─── Helper: read session JSONL and extract text messages ───────────

function readSessionMessages(sessionId: string, limit: number = 50): string[] {
  const logPath = findSessionLogPath(sessionId);
  if (!logPath) return [];

  try {
    const lines = readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const textMessages: string[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "summary" || msg.type === "system") continue;
        const role = msg.message?.role;
        const content = msg.message?.content;
        if (!content) continue;

        if (typeof content === "string") {
          textMessages.push(`[${role}] ${content}`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              textMessages.push(`[${role}] ${block.text}`);
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    // Return the most recent messages up to limit
    return textMessages.slice(-limit);
  } catch {
    return [];
  }
}

// ─── Tool Definitions ───────────────────────────────────────────────

/**
 * Build a custom MCP server scoped to a specific agent.
 * The agentAlias is baked into the closure so scoped tools (cron jobs, activity)
 * only access that agent's data. Orchestration tools can target other agents.
 */
export function buildAgentToolsServer(agentAlias: string) {
  return createSdkMcpServer({
    name: "ccui",
    version: "1.0.0",
    tools: [
      // ── Chat Sessions ────────────────────────────────────────

      tool(
        "start_chat_session",
        "Start a new Claude Code chat session in any directory. The session runs asynchronously — use get_session_status to check on it later. Returns the chatId of the new session.",
        {
          prompt: z.string().describe("The task or message for the chat session"),
          folder: z.string().describe("Absolute path to the working directory for the session"),
          maxTurns: z.number().optional().describe("Maximum agentic turns before stopping (default: 200)"),
        },
        async (args) => {
          try {
            const sendMessage = getSendMessage();

            // Build async generator prompt (required when MCP servers are present)
            const promptIterable = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: args.prompt },
              };
            })();

            const emitter = await sendMessage({
              prompt: promptIterable,
              folder: args.folder,
              maxTurns: args.maxTurns ?? 200,
              defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
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

            log.info(`Agent ${agentAlias} started chat session ${chatId} in ${args.folder}`);

            appendActivity(agentAlias, {
              type: "system",
              message: `Started chat session in ${args.folder}`,
              metadata: { chatId, folder: args.folder },
            });

            return { content: [{ type: "text" as const, text: JSON.stringify({ chatId, status: "started", folder: args.folder }) }] };
          } catch (err: any) {
            log.error(`start_chat_session failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error starting session: ${err.message}` }] };
          }
        },
      ),

      tool(
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

      tool(
        "read_session_messages",
        "Read the text messages from a Claude Code session. Returns the conversation content (user and assistant messages). Useful for checking what a spawned agent did.",
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

      tool(
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
            });

            // 5. If not waiting, return immediately after session starts
            if (!args.waitForCompletion) {
              log.info(`Agent ${agentAlias} continued chat ${args.chatId} (async)`);
              appendActivity(agentAlias, {
                type: "system",
                message: `Continued chat session ${args.chatId}`,
                metadata: { chatId: args.chatId },
              });

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

            log.info(`Agent ${agentAlias} continued chat ${args.chatId} (sync, complete)`);
            appendActivity(agentAlias, {
              type: "system",
              message: `Continued chat session ${args.chatId} (waited for completion)`,
              metadata: { chatId: args.chatId },
            });

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

      // ── Agent Orchestration ────────────────────────────────────

      tool(
        "talk_to_agent",
        "Send a message to another agent and wait for their response. The target agent runs in its own workspace with its own identity and tools. Use this for inter-agent conversation where you need the result. For fire-and-forget, use deploy_agent instead.",
        {
          targetAlias: z.string().describe("Alias of the agent to talk to"),
          message: z.string().describe("The message to send to the target agent"),
          maxTurns: z.number().optional().describe("Maximum agentic turns for the target agent (default: 50)"),
        },
        async (args) => {
          try {
            // 1. Validate target agent exists
            const targetConfig = getAgent(args.targetAlias);
            if (!targetConfig) {
              return { content: [{ type: "text" as const, text: `Agent "${args.targetAlias}" not found` }] };
            }

            // 2. Prevent self-talk
            if (args.targetAlias === agentAlias) {
              return { content: [{ type: "text" as const, text: "Error: An agent cannot talk to itself" }] };
            }

            // 3. Compile target agent's identity and workspace context
            const identityPrompt = compileIdentityPrompt(targetConfig);
            const workspacePath = getAgentWorkspacePath(args.targetAlias);
            const workspaceContext = compileWorkspaceContext(workspacePath);
            const fullSystemPrompt = [identityPrompt, workspaceContext].filter(Boolean).join("\n\n");

            // 4. Build prompt with caller context
            const callerConfig = getAgent(agentAlias);
            const callerName = callerConfig?.name || agentAlias;
            const contextualPrompt = `[Message from ${callerName} (${agentAlias})]\n\n${args.message}`;

            const sendMessage = getSendMessage();

            // 5. Build async generator prompt
            const promptIterable = (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: contextualPrompt },
              };
            })();

            // 6. Start target agent session
            const emitter = await sendMessage({
              prompt: promptIterable,
              folder: workspacePath,
              systemPrompt: fullSystemPrompt,
              agentAlias: args.targetAlias,
              maxTurns: args.maxTurns ?? 50,
              defaultPermissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
            });

            // 7. Wait for chat_created to get chatId
            const chatId = await new Promise<string>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("Timed out waiting for target agent session to start")), 30_000);
              emitter.on("event", (event: any) => {
                if (event.type === "chat_created" && event.chatId) {
                  clearTimeout(timeout);
                  resolve(event.chatId);
                } else if (event.type === "error") {
                  clearTimeout(timeout);
                  reject(new Error(event.content || "Target agent session failed to start"));
                }
              });
            });

            // 8. Collect text output and wait for completion
            const responseTexts: string[] = [];
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => resolve(), 600_000); // 10 min safety timeout

              emitter.on("event", (event: any) => {
                if (event.type === "text" && event.content) {
                  responseTexts.push(event.content);
                } else if (event.type === "done") {
                  clearTimeout(timeout);
                  resolve();
                } else if (event.type === "error") {
                  clearTimeout(timeout);
                  reject(new Error(event.content || "Target agent session errored"));
                }
              });
            });

            // 9. Log activity
            log.info(`Agent ${agentAlias} talked to ${args.targetAlias}, session ${chatId}`);
            appendActivity(agentAlias, {
              type: "system",
              message: `Talked to agent ${args.targetAlias}`,
              metadata: { chatId, targetAlias: args.targetAlias },
            });

            // 10. Return the collected response
            const response = responseTexts.join("") || "(No text response from target agent)";
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ chatId, targetAlias: args.targetAlias, response }) }],
            };
          } catch (err: any) {
            log.error(`talk_to_agent failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error talking to agent: ${err.message}` }] };
          }
        },
      ),

      tool(
        "deploy_agent",
        "Start a new session AS another agent. The agent runs in its own workspace with its own identity, system prompt, and tools. The session runs asynchronously — use get_session_status and read_session_messages to monitor it. Unlike talk_to_agent, this does NOT wait for completion.",
        {
          targetAlias: z.string().describe("Alias of the agent to deploy (start a session as)"),
          prompt: z.string().describe("The task or message to give the agent"),
          maxTurns: z.number().optional().describe("Maximum agentic turns (default: 200)"),
        },
        async (args) => {
          try {
            // 1. Validate target agent exists
            const targetConfig = getAgent(args.targetAlias);
            if (!targetConfig) {
              return { content: [{ type: "text" as const, text: `Agent "${args.targetAlias}" not found` }] };
            }

            // 2. Execute the agent using the shared helper
            const result = await executeAgent({
              agentAlias: args.targetAlias,
              prompt: args.prompt,
              triggeredBy: "tool",
              metadata: { deployedBy: agentAlias },
              maxTurns: args.maxTurns,
            });

            if (!result) {
              return { content: [{ type: "text" as const, text: `Failed to deploy agent "${args.targetAlias}" — check agent config` }] };
            }

            log.info(`Agent ${agentAlias} deployed agent ${args.targetAlias}, session ${result.chatId}`);
            appendActivity(agentAlias, {
              type: "system",
              message: `Deployed agent ${args.targetAlias}`,
              metadata: { chatId: result.chatId, targetAlias: args.targetAlias },
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ chatId: result.chatId, status: "started", targetAlias: args.targetAlias }),
                },
              ],
            };
          } catch (err: any) {
            log.error(`deploy_agent failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error deploying agent: ${err.message}` }] };
          }
        },
      ),

      // ── Cron Job Management ──────────────────────────────────

      tool("list_cron_jobs", "List all scheduled cron jobs for your agent.", {}, async () => {
        try {
          const jobs = listCronJobs(agentAlias);
          return { content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error listing cron jobs: ${err.message}` }] };
        }
      }),

      tool(
        "create_cron_job",
        "Create a new scheduled cron job for your agent. The job will execute on the specified schedule using local system time.",
        {
          name: z.string().describe("Human-readable name for the job"),
          schedule: z.string().describe("Cron expression (e.g., '0 9 * * *' for daily at 9am, '*/30 * * * *' for every 30 min)"),
          prompt: z.string().describe("The task prompt that will be sent to your agent when the job fires"),
          type: z.enum(["one-off", "recurring", "indefinite"]).optional().describe("Job type (default: recurring)"),
          description: z.string().optional().describe("Description of what this job does"),
        },
        async (args) => {
          try {
            const job = createCronJob(agentAlias, {
              name: args.name,
              schedule: args.schedule,
              type: args.type || "recurring",
              status: "active",
              description: args.description || "",
              action: {
                type: "start_session",
                prompt: args.prompt,
              },
            } as Omit<CronJob, "id">);

            // Sync scheduler: register with node-cron so it actually fires
            if (job.status === "active") {
              scheduleJob(agentAlias, job);
            }

            log.info(`Agent ${agentAlias} created cron job: ${job.id} — ${args.name}`);
            appendActivity(agentAlias, {
              type: "cron",
              message: `Created cron job: ${args.name} (${args.schedule})`,
              metadata: { jobId: job.id },
            });

            return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error creating cron job: ${err.message}` }] };
          }
        },
      ),

      tool(
        "update_cron_job",
        "Update an existing cron job. You can change the name, schedule, prompt, status (active/paused), or type.",
        {
          jobId: z.string().describe("The ID of the cron job to update"),
          name: z.string().optional().describe("New name"),
          schedule: z.string().optional().describe("New cron expression"),
          prompt: z.string().optional().describe("New task prompt"),
          status: z.enum(["active", "paused", "completed"]).optional().describe("New status"),
          type: z.enum(["one-off", "recurring", "indefinite"]).optional().describe("New type"),
        },
        async (args) => {
          try {
            const updates: Partial<CronJob> = {};
            if (args.name !== undefined) updates.name = args.name;
            if (args.schedule !== undefined) updates.schedule = args.schedule;
            if (args.status !== undefined) updates.status = args.status;
            if (args.type !== undefined) updates.type = args.type;
            if (args.prompt !== undefined) {
              updates.action = { type: "start_session", prompt: args.prompt };
            }

            const updated = updateCronJob(agentAlias, args.jobId, updates);
            if (!updated) {
              return { content: [{ type: "text" as const, text: `Cron job "${args.jobId}" not found` }] };
            }

            // Sync scheduler: cancel old schedule, re-schedule if active
            cancelJob(args.jobId);
            if (updated.status === "active") {
              scheduleJob(agentAlias, updated);
            }

            log.info(`Agent ${agentAlias} updated cron job: ${args.jobId}`);
            return { content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error updating cron job: ${err.message}` }] };
          }
        },
      ),

      tool(
        "delete_cron_job",
        "Delete a cron job by its ID.",
        {
          jobId: z.string().describe("The ID of the cron job to delete"),
        },
        async (args) => {
          try {
            // Cancel from scheduler before deleting
            cancelJob(args.jobId);

            const deleted = deleteCronJob(agentAlias, args.jobId);
            if (!deleted) {
              return { content: [{ type: "text" as const, text: `Cron job "${args.jobId}" not found` }] };
            }

            log.info(`Agent ${agentAlias} deleted cron job: ${args.jobId}`);
            return { content: [{ type: "text" as const, text: `Cron job "${args.jobId}" deleted successfully` }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error deleting cron job: ${err.message}` }] };
          }
        },
      ),

      // ── Trigger Management ──────────────────────────────────

      tool("list_triggers", "List all event triggers for your agent. Triggers automatically start sessions when matching events arrive.", {}, async () => {
        try {
          const triggers = listTriggers(agentAlias);
          return { content: [{ type: "text" as const, text: JSON.stringify(triggers, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error listing triggers: ${err.message}` }] };
        }
      }),

      tool(
        "create_trigger",
        "Create a new event trigger. When events matching the filter arrive, a session starts with the prompt template. Use {{event.source}}, {{event.eventType}}, {{event.data}}, {{event.data.fieldPath}} in the prompt. You can add conditions to filter on specific data fields (AND logic).",
        {
          name: z.string().describe("Human-readable name for the trigger"),
          description: z.string().optional().describe("What this trigger does"),
          source: z.string().optional().describe("Connection alias to filter (e.g. 'discord-bot'). Omit for any source."),
          eventType: z.string().optional().describe("Event type to filter (e.g. 'MESSAGE_CREATE'). Omit for any type."),
          conditions: z
            .array(
              z.object({
                field: z.string().describe("Dot-notation path into event.data (e.g. 'author.username')"),
                operator: z.enum(["equals", "contains", "matches", "exists", "not_exists"]).describe("Comparison operator"),
                value: z.string().optional().describe("Value to compare against. Not needed for exists/not_exists. For 'matches', use a regex pattern."),
              }),
            )
            .optional()
            .describe("Data field conditions (AND logic). Each condition checks a field in the event data."),
          prompt: z.string().describe("Prompt template. Use {{event.source}}, {{event.eventType}}, {{event.data}}, {{event.data.fieldPath}} for event data."),
        },
        async (args) => {
          try {
            const trigger = createTrigger(agentAlias, {
              name: args.name,
              description: args.description || "",
              status: "active",
              filter: {
                ...(args.source && { source: args.source }),
                ...(args.eventType && { eventType: args.eventType }),
                ...(args.conditions?.length && { conditions: args.conditions }),
              },
              action: { type: "start_session", prompt: args.prompt },
              triggerCount: 0,
            });

            log.info(`Agent ${agentAlias} created trigger: ${trigger.id} — ${args.name}`);
            appendActivity(agentAlias, {
              type: "event",
              message: `Created trigger: ${args.name}`,
              metadata: { triggerId: trigger.id },
            });

            return { content: [{ type: "text" as const, text: JSON.stringify(trigger, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error creating trigger: ${err.message}` }] };
          }
        },
      ),

      tool(
        "update_trigger",
        "Update an existing event trigger. You can change the name, status, filter source/eventType/conditions, or prompt.",
        {
          triggerId: z.string().describe("The ID of the trigger to update"),
          name: z.string().optional().describe("New name"),
          status: z.enum(["active", "paused"]).optional().describe("New status"),
          source: z.string().optional().describe("New source filter (connection alias)"),
          eventType: z.string().optional().describe("New event type filter"),
          conditions: z
            .array(
              z.object({
                field: z.string().describe("Dot-notation path into event.data (e.g. 'author.username')"),
                operator: z.enum(["equals", "contains", "matches", "exists", "not_exists"]).describe("Comparison operator"),
                value: z.string().optional().describe("Value to compare against. Not needed for exists/not_exists. For 'matches', use a regex pattern."),
              }),
            )
            .optional()
            .describe("New data field conditions (AND logic). Pass empty array to remove all conditions."),
          prompt: z.string().optional().describe("New prompt template"),
        },
        async (args) => {
          try {
            const updates: Partial<Trigger> = {};
            if (args.name !== undefined) updates.name = args.name;
            if (args.status !== undefined) updates.status = args.status;

            if (args.source !== undefined || args.eventType !== undefined || args.conditions !== undefined) {
              const existing = getTrigger(agentAlias, args.triggerId);
              updates.filter = {
                ...(existing?.filter || {}),
                ...(args.source !== undefined && { source: args.source || undefined }),
                ...(args.eventType !== undefined && { eventType: args.eventType || undefined }),
                ...(args.conditions !== undefined && { conditions: args.conditions.length ? args.conditions : undefined }),
              };
            }

            if (args.prompt !== undefined) {
              updates.action = { type: "start_session", prompt: args.prompt };
            }

            const updated = updateTrigger(agentAlias, args.triggerId, updates);
            if (!updated) {
              return { content: [{ type: "text" as const, text: `Trigger "${args.triggerId}" not found` }] };
            }

            log.info(`Agent ${agentAlias} updated trigger: ${args.triggerId}`);
            return { content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error updating trigger: ${err.message}` }] };
          }
        },
      ),

      tool(
        "delete_trigger",
        "Delete an event trigger by its ID.",
        {
          triggerId: z.string().describe("The ID of the trigger to delete"),
        },
        async (args) => {
          try {
            const deleted = deleteTrigger(agentAlias, args.triggerId);
            if (!deleted) {
              return { content: [{ type: "text" as const, text: `Trigger "${args.triggerId}" not found` }] };
            }

            log.info(`Agent ${agentAlias} deleted trigger: ${args.triggerId}`);
            return { content: [{ type: "text" as const, text: `Trigger "${args.triggerId}" deleted successfully` }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error deleting trigger: ${err.message}` }] };
          }
        },
      ),

      // ── Activity & Events ────────────────────────────────────

      tool(
        "get_activity",
        "Query your agent's activity log. Returns recent activity entries sorted newest-first.",
        {
          type: z.enum(["chat", "event", "cron", "connection", "system"]).optional().describe("Filter by activity type"),
          limit: z.number().optional().describe("Maximum entries to return (default: 20)"),
        },
        async (args) => {
          try {
            const entries = getActivity(agentAlias, {
              type: args.type,
              limit: args.limit || 20,
            });
            return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error reading activity: ${err.message}` }] };
          }
        },
      ),

      tool(
        "log_activity",
        "Record an entry in your agent's activity log. Use this to track notable events, decisions, or actions.",
        {
          activityType: z.enum(["chat", "event", "cron", "connection", "system"]).describe("Type of activity"),
          message: z.string().describe("Human-readable description of what happened"),
          metadata: z.record(z.string(), z.unknown()).optional().describe("Additional structured data to store with the entry"),
        },
        async (args) => {
          try {
            const entry = appendActivity(agentAlias, {
              type: args.activityType,
              message: args.message,
              metadata: args.metadata,
            });
            return { content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error logging activity: ${err.message}` }] };
          }
        },
      ),

      // ── Agent Discovery ──────────────────────────────────────

      tool("list_agents", "List all agents on the platform. Returns basic info: alias, name, emoji, role, and description.", {}, async () => {
        try {
          const agents = listAgents();
          const summaries = agents.map((a) => ({
            alias: a.alias,
            name: a.name,
            emoji: a.emoji || null,
            role: a.role || null,
            description: a.description,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify(summaries, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error listing agents: ${err.message}` }] };
        }
      }),

      tool(
        "get_agent_info",
        "Get public information about another agent. Returns name, emoji, role, description, and personality.",
        {
          alias: z.string().describe("The alias of the agent to look up"),
        },
        async (args) => {
          try {
            const config = getAgent(args.alias);
            if (!config) {
              return { content: [{ type: "text" as const, text: `Agent "${args.alias}" not found` }] };
            }
            const info = {
              alias: config.alias,
              name: config.name,
              emoji: config.emoji || null,
              role: config.role || null,
              description: config.description,
              personality: config.personality || null,
              tone: config.tone || null,
              guidelines: config.guidelines || [],
            };
            return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error getting agent info: ${err.message}` }] };
          }
        },
      ),

      // ── Agent Management ──────────────────────────────────

      tool(
        "create_agent",
        "Create a new agent on the platform. The agent will have its own workspace, identity, and can be targeted by start_agent_session. Returns the created agent config.",
        {
          name: z.string().min(1).max(128).describe("Display name for the agent (1-128 characters)"),
          alias: z
            .string()
            .min(2)
            .max(64)
            .describe("Unique alias/identifier (2-64 chars: lowercase letters, numbers, hyphens, underscores, must start with letter or number)"),
          description: z.string().min(1).max(512).describe("What this agent does (1-512 characters)"),
          systemPrompt: z.string().optional().describe("Custom system prompt for the agent"),
          emoji: z.string().optional().describe("Emoji icon for the agent (e.g. '\uD83E\uDD16')"),
          personality: z.string().optional().describe("Personality description"),
          role: z.string().optional().describe("Role description (e.g. 'Research Assistant')"),
          tone: z.string().optional().describe("Communication tone (e.g. 'friendly and concise')"),
        },
        async (args) => {
          try {
            // Validate alias format
            if (!isValidAlias(args.alias)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: Alias must be 2-64 characters: lowercase letters, numbers, hyphens, underscores. Must start with a letter or number.",
                  },
                ],
              };
            }

            // Check uniqueness
            if (agentExists(args.alias)) {
              return {
                content: [{ type: "text" as const, text: `Error: An agent with alias "${args.alias}" already exists` }],
              };
            }

            // Build config
            const config: AgentConfig = {
              name: args.name.trim(),
              alias: args.alias.trim(),
              description: args.description.trim(),
              createdAt: Date.now(),
              ...(args.systemPrompt !== undefined && { systemPrompt: args.systemPrompt.trim() || undefined }),
              ...(args.emoji && { emoji: args.emoji }),
              ...(args.personality && { personality: args.personality.trim() }),
              ...(args.role && { role: args.role.trim() }),
              ...(args.tone && { tone: args.tone.trim() }),
            };

            // Persist agent config
            createAgent(config);

            // Ensure workspace directory exists and scaffold initial files
            const workspacePath = ensureAgentWorkspaceDir(config.alias);
            scaffoldWorkspace(workspacePath);

            log.info(`Agent ${agentAlias} created new agent: ${config.alias}`);
            appendActivity(agentAlias, {
              type: "system",
              message: `Created new agent: ${config.name} (${config.alias})`,
              metadata: { createdAlias: config.alias },
            });

            return { content: [{ type: "text" as const, text: JSON.stringify({ ...config, workspacePath }, null, 2) }] };
          } catch (err: any) {
            log.error(`create_agent failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error creating agent: ${err.message}` }] };
          }
        },
      ),

      tool(
        "update_agent",
        "Update an existing agent's configuration. Only the fields you provide will be changed — all other fields remain unchanged. You can update any agent, including yourself. Returns the full updated config.",
        {
          alias: z.string().describe("The alias of the agent to update"),
          name: z.string().min(1).max(128).optional().describe("New display name (1-128 characters)"),
          description: z.string().min(1).max(512).optional().describe("New description (1-512 characters)"),
          systemPrompt: z.string().optional().describe("New system prompt (pass empty string to clear)"),
          emoji: z.string().optional().describe("New emoji icon (pass empty string to clear)"),
          personality: z.string().optional().describe("New personality description (pass empty string to clear)"),
          role: z.string().optional().describe("New role description (pass empty string to clear)"),
          tone: z.string().optional().describe("New communication tone (pass empty string to clear)"),
          pronouns: z.string().optional().describe("New pronouns (pass empty string to clear)"),
          languages: z.array(z.string()).optional().describe("Languages the agent speaks"),
          guidelines: z.array(z.string()).optional().describe("Behavioral guidelines for the agent"),
          userName: z.string().optional().describe("Name of the user the agent serves"),
          userTimezone: z.string().optional().describe("User's timezone (e.g. 'America/New_York')"),
          userLocation: z.string().optional().describe("User's location"),
          userContext: z.string().optional().describe("Additional context about the user"),
          heartbeat: z
            .object({
              enabled: z.boolean().describe("Whether heartbeat is enabled"),
              intervalMinutes: z.number().describe("Minutes between heartbeats (default: 30)"),
              quietHoursStart: z.string().optional().describe("Start of quiet hours in HH:MM format (e.g. '23:00')"),
              quietHoursEnd: z.string().optional().describe("End of quiet hours in HH:MM format (e.g. '07:00')"),
            })
            .optional()
            .describe("Heartbeat configuration — periodic open-ended check-ins"),
          memoryConsolidation: z
            .object({
              enabled: z.boolean().describe("Whether daily memory consolidation is enabled"),
              timeOfDay: z.string().describe("Time to run daily in HH:MM format (e.g. '03:00')"),
              retentionDays: z.number().describe("How many days of journals to review (default: 14)"),
            })
            .optional()
            .describe("Memory consolidation configuration — daily distillation of journal entries"),
          mcpKeyAlias: z.string().optional().describe("MCP secure proxy key alias for this agent"),
        },
        async (args) => {
          try {
            // Check agent exists
            const existing = getAgent(args.alias);
            if (!existing) {
              return { content: [{ type: "text" as const, text: `Error: Agent "${args.alias}" not found` }] };
            }

            // Build updated config — only override fields present in args
            const updated: AgentConfig = {
              ...existing,
              ...(args.name !== undefined && { name: args.name.trim() }),
              ...(args.description !== undefined && { description: args.description.trim() }),
              ...(args.systemPrompt !== undefined && { systemPrompt: args.systemPrompt?.trim() || undefined }),
              ...(args.emoji !== undefined && { emoji: args.emoji || undefined }),
              ...(args.personality !== undefined && { personality: args.personality?.trim() || undefined }),
              ...(args.role !== undefined && { role: args.role?.trim() || undefined }),
              ...(args.tone !== undefined && { tone: args.tone?.trim() || undefined }),
              ...(args.pronouns !== undefined && { pronouns: args.pronouns?.trim() || undefined }),
              ...(args.languages !== undefined && { languages: args.languages }),
              ...(args.guidelines !== undefined && { guidelines: args.guidelines }),
              ...(args.userName !== undefined && { userName: args.userName?.trim() || undefined }),
              ...(args.userTimezone !== undefined && { userTimezone: args.userTimezone?.trim() || undefined }),
              ...(args.userLocation !== undefined && { userLocation: args.userLocation?.trim() || undefined }),
              ...(args.userContext !== undefined && { userContext: args.userContext?.trim() || undefined }),
              ...(args.heartbeat !== undefined && { heartbeat: args.heartbeat }),
              ...(args.memoryConsolidation !== undefined && { memoryConsolidation: args.memoryConsolidation }),
              ...(args.mcpKeyAlias !== undefined && { mcpKeyAlias: args.mcpKeyAlias }),
            };

            // Validate required fields after merge
            if (!updated.name || updated.name.length === 0 || updated.name.length > 128) {
              return { content: [{ type: "text" as const, text: "Error: Name must be 1-128 characters" }] };
            }

            if (!updated.description || updated.description.length === 0 || updated.description.length > 512) {
              return { content: [{ type: "text" as const, text: "Error: Description must be 1-512 characters" }] };
            }

            // Persist (createAgent acts as upsert)
            createAgent(updated);

            // Sync heartbeat system if heartbeat config changed
            if (args.heartbeat !== undefined) {
              updateHeartbeatConfig(args.alias, args.heartbeat || { enabled: false, intervalMinutes: 30 });
            }

            // Sync memory consolidation system if config changed
            if (args.memoryConsolidation !== undefined) {
              updateConsolidationConfig(args.alias, args.memoryConsolidation || { enabled: false, timeOfDay: "03:00", retentionDays: 14 });
            }

            const workspacePath = ensureAgentWorkspaceDir(args.alias);

            log.info(`Agent ${agentAlias} updated agent: ${args.alias}`);
            appendActivity(agentAlias, {
              type: "system",
              message: `Updated agent: ${updated.name} (${args.alias})`,
              metadata: { updatedAlias: args.alias },
            });

            return { content: [{ type: "text" as const, text: JSON.stringify({ ...updated, workspacePath }, null, 2) }] };
          } catch (err: any) {
            log.error(`update_agent failed: ${err.message}`);
            return { content: [{ type: "text" as const, text: `Error updating agent: ${err.message}` }] };
          }
        },
      ),

      // ── Utilities ──────────────────────────────────────────────

      tool(
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
    ],
  });
}
