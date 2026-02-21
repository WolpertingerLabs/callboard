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
import { listAgents, getAgent, getAgentWorkspacePath } from "./agent-file-service.js";
import { compileIdentityPrompt } from "./claude-compiler.js";
import { listCronJobs, createCronJob, updateCronJob, deleteCronJob } from "./agent-cron-jobs.js";
import { listTriggers, getTrigger, createTrigger, updateTrigger, deleteTrigger } from "./agent-triggers.js";
import { getActivity, appendActivity } from "./agent-activity.js";
import { getActiveSession } from "./claude.js";
import { findSessionLogPath } from "../utils/session-log.js";
import { findChat } from "../utils/chat-lookup.js";
import { createLogger } from "../utils/logger.js";

import type { CronJob, Trigger } from "shared";

const log = createLogger("agent-tools");

// ─── Lazy reference to sendMessage ──────────────────────────────────
// We use a lazy import to avoid circular dependency:
// agent-tools.ts → claude.ts → (uses buildAgentToolsServer from agent-tools.ts)
// Instead, claude.ts registers itself at startup via setMessageSender().

type MessageSender = (opts: {
  prompt: string | AsyncIterable<any>;
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
      // ── Agent Orchestration ──────────────────────────────────

      tool(
        "start_agent_session",
        "Start a new Claude Code session for any agent (including yourself). The session runs asynchronously — use get_session_status to check on it later. Returns the chatId of the new session.",
        {
          targetAgent: z.string().describe("Alias of the agent to start a session for (use your own alias to start a session for yourself)"),
          prompt: z.string().describe("The task or message for the agent session"),
          maxTurns: z.number().optional().describe("Maximum agentic turns before stopping (default: 200)"),
        },
        async (args) => {
          try {
            const config = getAgent(args.targetAgent);
            if (!config) {
              return { content: [{ type: "text" as const, text: `Error: Agent "${args.targetAgent}" not found` }] };
            }

            const identityPrompt = compileIdentityPrompt(config);
            const workspacePath = getAgentWorkspacePath(args.targetAgent);
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
              folder: workspacePath,
              systemPrompt: identityPrompt,
              agentAlias: args.targetAgent,
              maxTurns: args.maxTurns,
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

            log.info(`Agent ${agentAlias} started session ${chatId} for agent ${args.targetAgent}`);

            appendActivity(args.targetAgent, {
              type: "system",
              message: `Session started by agent ${agentAlias}`,
              metadata: { chatId, triggeredBy: agentAlias },
            });

            return { content: [{ type: "text" as const, text: JSON.stringify({ chatId, status: "started", agent: args.targetAgent }) }] };
          } catch (err: any) {
            log.error(`start_agent_session failed: ${err.message}`);
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
        "Create a new scheduled cron job for your agent. The job will execute on the specified schedule.",
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
    ],
  });
}
