import { existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentConfig } from "shared";

const SCAFFOLD_DIR = join(process.cwd(), "backend", "src", "scaffold");

const SCAFFOLD_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];

/**
 * Compile the agent's identity and user context into a markdown string
 * suitable for appending to the Claude Code preset system prompt.
 *
 * Returns an empty string if the config has no meaningful identity data.
 */
export function compileIdentityPrompt(config: AgentConfig): string {
  const sections: string[] = [];

  // --- Identity section ---
  const identityLines: string[] = [];

  const nameDisplay = [config.name, config.emoji].filter(Boolean).join(" ");
  if (nameDisplay) identityLines.push(`- **Name:** ${nameDisplay}`);
  if (config.role) identityLines.push(`- **Role:** ${config.role}`);
  if (config.personality) identityLines.push(`- **Personality:** ${config.personality}`);
  if (config.tone) identityLines.push(`- **Tone:** ${config.tone}`);
  if (config.pronouns) identityLines.push(`- **Pronouns:** ${config.pronouns}`);
  if (config.languages && config.languages.length > 0) {
    identityLines.push(`- **Languages:** ${config.languages.join(", ")}`);
  }

  if (identityLines.length > 0) {
    sections.push(`# Agent Identity\n\n${identityLines.join("\n")}`);
  }

  // --- User context section ---
  const userLines: string[] = [];

  if (config.userName) userLines.push(`- **Name:** ${config.userName}`);
  if (config.userTimezone) userLines.push(`- **Timezone:** ${config.userTimezone}`);
  if (config.userLocation) userLines.push(`- **Location:** ${config.userLocation}`);

  if (userLines.length > 0 || config.userContext) {
    let userSection = `## Your Human\n\n${userLines.join("\n")}`;
    if (config.userContext) {
      userSection += `\n\n${config.userContext}`;
    }
    sections.push(userSection);
  }

  // --- Guidelines section ---
  if (config.guidelines && config.guidelines.length > 0) {
    const guidelineLines = config.guidelines.map((g) => `- ${g}`).join("\n");
    sections.push(`## Guidelines\n\n${guidelineLines}`);
  }

  return sections.join("\n\n");
}

/**
 * Scaffold a new agent workspace with template files.
 * Copies scaffold files into the workspace, creates CLAUDE.md from AGENTS.md,
 * and creates the memory/ subdirectory.
 *
 * Skips files that already exist in the workspace.
 */
export function scaffoldWorkspace(workspacePath: string): void {
  // Copy scaffold template files
  for (const file of SCAFFOLD_FILES) {
    const src = join(SCAFFOLD_DIR, file);
    const dest = join(workspacePath, file);
    if (existsSync(src) && !existsSync(dest)) {
      copyFileSync(src, dest);
    }
  }

  // Copy AGENTS.md as CLAUDE.md (the SDK-loaded behavioral protocol)
  const agentsSrc = join(SCAFFOLD_DIR, "AGENTS.md");
  const claudeDest = join(workspacePath, "CLAUDE.md");
  if (existsSync(agentsSrc) && !existsSync(claudeDest)) {
    copyFileSync(agentsSrc, claudeDest);
  }

  // Create memory subdirectory
  const memoryDir = join(workspacePath, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
}

/**
 * Read a workspace file if it exists. Returns undefined if not found.
 */
export function readWorkspaceFile(workspacePath: string, filename: string): string | undefined {
  const filePath = join(workspacePath, filename);
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath, "utf-8");
}

/**
 * Format a Date as YYYY-MM-DD for memory file lookups.
 */
function formatDateForMemory(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Generate documentation for the CCUI platform tools so agents know what's available.
 * Injected into the system prompt whenever an agent session is started.
 */
export function compileCcuiToolsDocs(): string {
  return `# Platform Tools (CCUI)

You have access to these platform tools via the \`ccui\` MCP server. They are prefixed with \`mcp__ccui__\` in your tool list.

## Agent Orchestration
- **start_agent_session** — Start a new Claude Code session for any agent (including yourself). Pass \`targetAgent\` (alias), \`prompt\`, and optional \`maxTurns\`. Returns a \`chatId\` to track it.
- **get_session_status** — Check if a session is active, complete, or not found. Pass \`chatId\`.
- **read_session_messages** — Read conversation messages from a session. Pass \`chatId\` and optional \`limit\`.

## Cron Job Management
- **list_cron_jobs** — List all your scheduled cron jobs.
- **create_cron_job** — Create a new cron job. Pass \`name\`, \`schedule\` (cron expression), \`prompt\`, optional \`type\` and \`description\`.
- **update_cron_job** — Update an existing cron job by \`jobId\`.
- **delete_cron_job** — Delete a cron job by \`jobId\`.

## Event Trigger Management
- **list_triggers** — List all your event triggers.
- **create_trigger** — Create a trigger that auto-starts sessions on matching events. Supports template placeholders like \`{{event.data.fieldPath}}\` in the prompt. Pass \`name\`, \`prompt\`, optional \`source\` and \`eventType\`.
- **update_trigger** — Update an existing trigger by \`triggerId\`.
- **delete_trigger** — Delete a trigger by \`triggerId\`.

## Activity Log
- **get_activity** — Query your activity log. Optional \`type\` filter and \`limit\`.
- **log_activity** — Record an activity entry. Pass \`activityType\`, \`message\`, optional \`metadata\`.

## Agent Discovery
- **list_agents** — List all agents on the platform (alias, name, role, description).
- **get_agent_info** — Get detailed info about another agent by \`alias\`.`;
}

/**
 * Pre-load workspace files into a string suitable for inclusion in the system prompt.
 *
 * Reads the files that agents are normally instructed to read at session startup
 * (SOUL.md, USER.md, TOOLS.md, memory journals) and concatenates them, prefacing
 * each with "This is the current content of [filename]".
 *
 * Options:
 * - isMainSession: include MEMORY.md (direct human chat — contains personal context)
 * - isHeartbeat: include HEARTBEAT.md (periodic check-in tasks)
 */
export function compileWorkspaceContext(workspacePath: string, opts?: { isMainSession?: boolean; isHeartbeat?: boolean }): string {
  const sections: string[] = [];

  // Always include core workspace files
  const coreFiles = ["SOUL.md", "USER.md", "TOOLS.md"];
  for (const filename of coreFiles) {
    const content = readWorkspaceFile(workspacePath, filename);
    if (content && content.trim()) {
      sections.push(`This is the current content of ${filename}:\n${content.trim()}`);
    }
  }

  // Memory journal files: today and yesterday
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const memoryFiles = [`memory/${formatDateForMemory(today)}.md`, `memory/${formatDateForMemory(yesterday)}.md`];
  for (const memFile of memoryFiles) {
    const content = readWorkspaceFile(workspacePath, memFile);
    if (content && content.trim()) {
      sections.push(`This is the current content of ${memFile}:\n${content.trim()}`);
    }
  }

  // Main sessions: include long-term memory (contains personal context)
  if (opts?.isMainSession) {
    const content = readWorkspaceFile(workspacePath, "MEMORY.md");
    if (content && content.trim()) {
      sections.push(`This is the current content of MEMORY.md:\n${content.trim()}`);
    }
  }

  // Heartbeat sessions: include heartbeat checklist
  if (opts?.isHeartbeat) {
    const content = readWorkspaceFile(workspacePath, "HEARTBEAT.md");
    if (content && content.trim()) {
      sections.push(`This is the current content of HEARTBEAT.md:\n${content.trim()}`);
    }
  }

  if (sections.length === 0) return "";

  const header =
    "# Pre-loaded Workspace Files\n\n" +
    "The following files from your workspace have been pre-loaded into your context. " +
    "You do not need to read them again unless checking for updates made during this session.";

  return header + "\n\n---\n\n" + sections.join("\n\n---\n\n");
}
