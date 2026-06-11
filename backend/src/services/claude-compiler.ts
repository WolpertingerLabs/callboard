import { existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AgentConfig, SystemPromptSection } from "shared";

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

const CORE_WORKSPACE_FILES: { filename: string; label: string }[] = [
  { filename: "SOUL.md", label: "Soul & Personality" },
  { filename: "USER.md", label: "Human Context" },
  { filename: "TOOLS.md", label: "Environment & Tools" },
  { filename: "HEARTBEAT.md", label: "Heartbeat Tasks" },
  { filename: "MEMORY.md", label: "Curated Memory" },
];

interface WorkspaceSectionEntry {
  key: string;
  label: string;
  source: "workspace" | "memory-journal";
  /** The exact text embedded in the prompt, or undefined when the file is missing/empty */
  embedded?: string;
}

/**
 * Collect workspace files (core files + today/yesterday memory journals) as
 * prompt sections. Missing/empty files are returned without `embedded` so
 * callers can list them as not included.
 */
function collectWorkspaceSections(workspacePath: string): WorkspaceSectionEntry[] {
  const entries: WorkspaceSectionEntry[] = [];

  for (const { filename, label } of CORE_WORKSPACE_FILES) {
    const content = readWorkspaceFile(workspacePath, filename);
    entries.push({
      key: filename,
      label,
      source: "workspace",
      embedded: content && content.trim() ? `This is the current content of ${filename}:\n${content.trim()}` : undefined,
    });
  }

  // Memory journal files: today and yesterday
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const date of [formatDateForMemory(today), formatDateForMemory(yesterday)]) {
    const memFile = `memory/${date}.md`;
    const content = readWorkspaceFile(workspacePath, memFile);
    entries.push({
      key: memFile,
      label: `Daily Journal (${date})`,
      source: "memory-journal",
      embedded: content && content.trim() ? `This is the current content of ${memFile}:\n${content.trim()}` : undefined,
    });
  }

  return entries;
}

/**
 * Pre-load workspace files into a string suitable for inclusion in the system prompt.
 *
 * Reads workspace files (SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md,
 * and recent memory journals) and concatenates them for context injection.
 */
export function compileWorkspaceContext(workspacePath: string): string {
  const sections = collectWorkspaceSections(workspacePath)
    .map((s) => s.embedded)
    .filter((s): s is string => Boolean(s));

  if (sections.length === 0) return "";

  const header =
    "# Pre-loaded Workspace Files\n\n" +
    "The following files from your workspace have been pre-loaded into your context. " +
    "You do not need to read them again unless checking for updates made during this session.";

  return header + "\n\n---\n\n" + sections.join("\n\n---\n\n");
}

function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

export interface CompiledSystemPrompt {
  /** The full assembled append string — exactly what sessions receive */
  prompt: string;
  sections: SystemPromptSection[];
  /** Measured on `prompt` (joiners/headers count), not the sum of sections */
  totalChars: number;
  totalEstTokens: number;
}

/**
 * Compile the full per-agent system prompt append (identity + pre-loaded
 * workspace context) along with a per-section breakdown for preview UIs.
 *
 * The `prompt` field is the single source of truth for what gets appended to
 * the session system prompt — all session-launch paths assemble it from here.
 */
export function compileSystemPrompt(config: AgentConfig, workspacePath: string): CompiledSystemPrompt {
  const identity = compileIdentityPrompt(config);
  const workspaceContext = compileWorkspaceContext(workspacePath);
  const prompt = [identity, workspaceContext].filter(Boolean).join("\n\n");

  const sections: SystemPromptSection[] = [
    {
      key: "identity",
      label: "Agent Identity & Instructions",
      source: "agent.json",
      content: identity,
      chars: identity.length,
      estTokens: estimateTokens(identity.length),
      included: identity.length > 0,
    },
    ...collectWorkspaceSections(workspacePath).map((s): SystemPromptSection => {
      const content = s.embedded ?? "";
      return {
        key: s.key,
        label: s.label,
        source: s.source,
        content,
        chars: content.length,
        estTokens: estimateTokens(content.length),
        included: content.length > 0,
      };
    }),
  ];

  return {
    prompt,
    sections,
    totalChars: prompt.length,
    totalEstTokens: estimateTokens(prompt.length),
  };
}
