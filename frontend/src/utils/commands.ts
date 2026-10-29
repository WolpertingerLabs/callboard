/**
 * Descriptions for common Claude Code slash commands.
 *
 * Used by SlashCommandAutocomplete and SlashCommandsModal.
 * Keys are command names WITHOUT the leading "/" prefix.
 */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  compact: "Switch to compact view mode",
  context: "Show context information",
  cost: "Display API usage costs",
  init: "Initialize a new project or workspace",
  "output-style:new": "Create a new output style",
  "pr-comments": "Generate pull request review comments",
  "release-notes": "Generate release notes from git history",
  todos: "Show or manage todo items",
  review: "Review code changes",
  "security-review": "Perform security review of code",
  help: "Show help information",
  clear: "Clear the conversation",
  model: "Switch AI model",
};

/**
 * Get a human-readable description for a slash command.
 *
 * Accepts command names with or without the leading "/".
 * Returns `null` if no description is available.
 */
export function getCommandDescription(command: string): string | null {
  const key = command.startsWith("/") ? command.slice(1) : command;
  return COMMAND_DESCRIPTIONS[key] ?? null;
}

/** How many rows the composer's `/` menu shows at most. */
export const SLASH_COMMAND_MATCH_LIMIT = 10;

/**
 * The commands the composer's `/` menu lists for `query` — the whole textarea
 * value, leading `/` included.
 *
 * Case-insensitive substring match, prefix matches first then alphabetical,
 * capped at {@link SLASH_COMMAND_MATCH_LIMIT}. A pure function rather than
 * something the menu computes for itself, because the composer has to know the
 * same list: ArrowUp/ArrowDown move a highlight through it and Enter/Tab pick
 * from it, and those keys are handled on the textarea, not on the menu.
 *
 * Anything that is not led by `/` matches nothing. So does a query with
 * prose after the command (`/compact now`) unless some command name contains
 * that whole string — which is what hides the menu once the user moves past
 * the command and starts typing their message.
 */
export function matchSlashCommands(slashCommands: string[], query: string, limit = SLASH_COMMAND_MATCH_LIMIT): string[] {
  if (!query.startsWith("/")) return [];
  const term = query.slice(1).toLowerCase();
  return slashCommands
    .filter((cmd) => cmd.toLowerCase().includes(term))
    .sort((a, b) => {
      const aStartsWith = a.toLowerCase().startsWith(term);
      const bStartsWith = b.toLowerCase().startsWith(term);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.localeCompare(b);
    })
    .slice(0, limit);
}

/**
 * Categorize a slash command for grouping in the UI.
 */
export function getCommandCategory(command: string): string {
  if (["pr-comments", "release-notes", "review", "security-review"].includes(command)) {
    return "Development";
  }
  if (["compact", "output-style:new", "help", "clear", "model"].includes(command)) {
    return "Interface";
  }
  if (["context", "cost", "todos"].includes(command)) {
    return "Information";
  }
  if (["init"].includes(command)) {
    return "Project";
  }
  return "Other";
}
