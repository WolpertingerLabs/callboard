/**
 * Auto-Journal Stop Hook
 *
 * SDK Stop hook that fires at the end of each agent conversation turn.
 * Instructs the agent to update its daily journal and any other relevant
 * workspace memory files (MEMORY.md, SOUL.md, USER.md, etc.).
 *
 * Uses the SDK's built-in `stop_hook_active` guard to prevent infinite loops:
 * - First stop (stop_hook_active=false): inject journaling instructions, continue
 * - Second stop (stop_hook_active=true): allow the session to end
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../utils/logger.js";

const log = createLogger("auto-journal-hook");

/**
 * Build a Stop hook callback that prompts the agent to update its memory files
 * after each conversation turn.
 */
export function buildAutoJournalStopHook(agentAlias: string, workspacePath: string): HookCallback {
  return async (input, _toolUseId, _options) => {
    if (input.hook_event_name !== "Stop") return {};

    // Prevent infinite loop: if the Stop hook already triggered once, let it end
    if (input.stop_hook_active) {
      log.debug(`[${agentAlias}] Stop hook already active, allowing session to end`);
      return {};
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const journalPath = `${workspacePath}/memory/${today}.md`;

    log.info(`[${agentAlias}] Auto-journal: prompting agent to update memory files`);

    return {
      continue: true,
      systemMessage: [
        `## Auto-Journal: Update Your Memory Files`,
        ``,
        `Before finishing, review this conversation and update any of your workspace memory files that need it.`,
        ``,
        `**Daily journal** (always update):`,
        `- File: ${journalPath}`,
        `- Append 1-3 short bullet points summarizing what was discussed or accomplished.`,
        `- If the file doesn't exist yet, create it with a \`# ${today}\` header.`,
        `- Do NOT rewrite existing content — only append.`,
        ``,
        `**Other memory files** (update if relevant):`,
        `- \`${workspacePath}/MEMORY.md\` — Curated long-term memory. Update if there are important decisions, lessons, or facts worth remembering permanently.`,
        `- \`${workspacePath}/SOUL.md\` — Your personality and self-knowledge. Update if you learned something about yourself or your preferences.`,
        `- \`${workspacePath}/USER.md\` — What you know about your human. Update if you learned new preferences, context, or details about them.`,
        `- \`${workspacePath}/TOOLS.md\` — Tool usage notes. Update if you discovered new tool patterns or capabilities.`,
        `- Or create a new file in \`${workspacePath}/\` if the information doesn't fit existing files.`,
        ``,
        `Keep updates brief and meaningful. Only update files where there's genuinely new information worth preserving. After updating, you are done.`,
      ].join("\n"),
    };
  };
}
