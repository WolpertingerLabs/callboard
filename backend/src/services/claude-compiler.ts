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

/**
 * Default per-file token budget for previous-day journals.
 *
 * Sized as a backstop against a runaway log, not as a tight budget: journals are
 * meant to be verbose (see the scaffold CLAUDE.md), and an ordinary day should
 * pass through untouched. It exists so that one pathological journal — a pasted
 * build log, a loop that wrote the same entry ten thousand times — cannot crowd
 * out the rest of the system prompt.
 */
export const DEFAULT_JOURNAL_TOKEN_BUDGET = 16000;

/** Chars-per-token ratio used for both estimation and budgeting. */
const CHARS_PER_TOKEN = 4;

interface WorkspaceSectionEntry {
  key: string;
  label: string;
  source: "workspace" | "memory-journal";
  /** The exact text embedded in the prompt, or undefined when the file is missing/empty */
  embedded?: string;
  /** True when the file was over budget and only its tail is embedded */
  truncated?: boolean;
}

/**
 * Trim a previous-day journal to `budgetTokens`, keeping the tail.
 *
 * The tail is what matters on an older journal: entries are appended
 * chronologically, so the end holds the most recent work and the end-of-day
 * summary of open threads. The elision notice names the file and tells the
 * agent how to recover what was dropped — the content is still on disk, so
 * truncating here costs a tool call, not the memory.
 */
function truncateJournal(content: string, filename: string, budgetTokens: number): { text: string; truncated: boolean } {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  if (budgetTokens <= 0 || content.length <= budgetChars) {
    return { text: content, truncated: false };
  }

  // Cut on a line boundary so the kept text never starts mid-entry
  const tail = content.slice(content.length - budgetChars);
  const firstBreak = tail.indexOf("\n");
  const kept = (firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail).trimStart();
  const omittedTokens = estimateTokens(content.length - kept.length);

  const notice =
    `[Earlier entries omitted — this journal exceeded the ${budgetTokens.toLocaleString()}-token pre-load budget, ` +
    `so roughly ${omittedTokens.toLocaleString()} tokens from the start of the day were dropped. ` +
    `The full day is still on disk: read \`${filename}\` or search it if you need what came before.]`;

  return { text: `${notice}\n\n${kept}`, truncated: true };
}

/**
 * Collect workspace files (core files + today/yesterday memory journals) as
 * prompt sections. Missing/empty files are returned without `embedded` so
 * callers can list them as not included.
 *
 * `journalTokenBudget` caps each *previous*-day journal. Today's journal is
 * always embedded in full — it is the session's working context — as are the
 * core files, MEMORY.md among them, which are already curated.
 */
function collectWorkspaceSections(workspacePath: string, journalTokenBudget: number = DEFAULT_JOURNAL_TOKEN_BUDGET): WorkspaceSectionEntry[] {
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
  const todayKey = formatDateForMemory(today);

  for (const date of [todayKey, formatDateForMemory(yesterday)]) {
    const memFile = `memory/${date}.md`;
    const content = readWorkspaceFile(workspacePath, memFile);
    if (!content || !content.trim()) {
      entries.push({ key: memFile, label: `Daily Journal (${date})`, source: "memory-journal" });
      continue;
    }

    const { text, truncated } = date === todayKey ? { text: content.trim(), truncated: false } : truncateJournal(content.trim(), memFile, journalTokenBudget);

    entries.push({
      key: memFile,
      label: `Daily Journal (${date})`,
      source: "memory-journal",
      embedded: `This is the current content of ${memFile}:\n${text}`,
      truncated,
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
export function compileWorkspaceContext(workspacePath: string, journalTokenBudget?: number): string {
  const sections = collectWorkspaceSections(workspacePath, journalTokenBudget)
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
  const budget = config.journalTokenBudget;
  const workspaceContext = compileWorkspaceContext(workspacePath, budget);
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
    ...collectWorkspaceSections(workspacePath, budget).map((s): SystemPromptSection => {
      const content = s.embedded ?? "";
      return {
        key: s.key,
        label: s.label,
        source: s.source,
        content,
        chars: content.length,
        estTokens: estimateTokens(content.length),
        included: content.length > 0,
        ...(s.truncated && { truncated: true }),
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
