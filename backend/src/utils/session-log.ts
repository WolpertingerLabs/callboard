import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR } from "./paths.js";

/**
 * Find the session JSONL file in ~/.claude/projects/.
 * The SDK names project dirs by replacing / with - in the cwd.
 * We search all project dirs for the session ID since the SDK may
 * resolve the cwd differently than what we passed.
 */
export function findSessionLogPath(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  try {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Silently handle errors (directory not accessible, etc.)
  }
  return null;
}

/**
 * Find all subagent JSONL files for a given session.
 * Subagent files live at:
 *   ~/.claude/projects/<project-dir>/<sessionId>/subagents/agent-<shortId>.jsonl
 *
 * Returns an array of { agentId, filePath } objects.
 */
export function findSubagentFiles(sessionId: string): { agentId: string; filePath: string }[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const results: { agentId: string; filePath: string }[] = [];
  try {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const subagentsDir = join(CLAUDE_PROJECTS_DIR, dir, sessionId, "subagents");
      if (!existsSync(subagentsDir)) continue;

      for (const file of readdirSync(subagentsDir)) {
        if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
        const agentId = file.replace("agent-", "").replace(".jsonl", "");
        results.push({
          agentId,
          filePath: join(subagentsDir, file),
        });
      }
    }
  } catch {
    // Silently handle errors (directory not accessible, etc.)
  }
  return results;
}
