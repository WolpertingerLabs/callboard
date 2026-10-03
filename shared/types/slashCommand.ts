export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
}

/** One command name resolved to its body, as the `…/slash-commands/content` routes answer it. */
export interface SlashCommandContent {
  name: string;
  source: "custom-skill" | "plugin" | "builtin";
  description: string | null;
  content: string | null;
}
