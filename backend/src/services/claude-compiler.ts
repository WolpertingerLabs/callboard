import { existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AgentConfig } from "shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
// From backend/dist/services/ (or backend/src/services/ via tsx) → backend/src/scaffold
const SCAFFOLD_DIR = join(__dirname, "..", "..", "src", "scaffold");

const SCAFFOLD_FILES = ["CLAUDE.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];

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

  // --- Custom system prompt section ---
  if (config.systemPrompt && config.systemPrompt.trim()) {
    sections.push(`## Custom Instructions\n\n${config.systemPrompt.trim()}`);
  }

  return sections.join("\n\n");
}

/**
 * Scaffold a new agent workspace with template files.
 * Copies scaffold files into the workspace and creates the memory/ subdirectory.
 *
 * Skips files that already exist in the workspace.
 */
export function scaffoldWorkspace(workspacePath: string): void {
  for (const file of SCAFFOLD_FILES) {
    const src = join(SCAFFOLD_DIR, file);
    const dest = join(workspacePath, file);
    if (existsSync(src) && !existsSync(dest)) {
      copyFileSync(src, dest);
    }
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
 * Pre-load workspace files into a string suitable for inclusion in the system prompt.
 *
 * Reads workspace files (SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md,
 * and recent memory journals) and concatenates them for context injection.
 */
export function compileWorkspaceContext(workspacePath: string): string {
  const sections: string[] = [];

  const coreFiles = ["SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];
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

  if (sections.length === 0) return "";

  const header =
    "# Pre-loaded Workspace Files\n\n" +
    "The following files from your workspace have been pre-loaded into your context. " +
    "You do not need to read them again unless checking for updates made during this session.";

  return header + "\n\n---\n\n" + sections.join("\n\n---\n\n");
}
