import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { getPluginsForDirectory, Plugin, pluginToSlashCommands, readPluginCommandContent } from "./plugins.js";
import { getEnabledAppPlugins, readAppPluginCommandContent } from "./app-plugins.js";
import { customSkillsService, CUSTOM_SKILLS_PLUGIN_NAME } from "./custom-skills-service.js";
import { DATA_DIR, ensureDataDir } from "../utils/paths.js";

const SLASH_COMMANDS_FILE = join(DATA_DIR, "slash-commands.json");

interface SlashCommandsData {
  [directory: string]: string[];
}

export interface DirectoryCommandsAndPlugins {
  slashCommands: string[];
  plugins: Plugin[];
}

/**
 * Load slash commands data from JSON file
 */
function loadSlashCommandsData(): SlashCommandsData {
  ensureDataDir();

  if (!existsSync(SLASH_COMMANDS_FILE)) {
    return {};
  }

  try {
    const data = readFileSync(SLASH_COMMANDS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.warn("Failed to load slash commands data:", error);
    return {};
  }
}

/**
 * Save slash commands data to JSON file
 */
function saveSlashCommandsData(data: SlashCommandsData): void {
  ensureDataDir();

  try {
    writeFileSync(SLASH_COMMANDS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Failed to save slash commands data:", error);
    throw error;
  }
}

/**
 * Get slash commands for a specific directory
 */
export function getSlashCommandsForDirectory(directory: string): string[] {
  const data = loadSlashCommandsData();
  return data[directory] || [];
}

/**
 * Set slash commands for a specific directory
 */
export function setSlashCommandsForDirectory(directory: string, commands: string[]): void {
  const data = loadSlashCommandsData();
  data[directory] = commands;
  saveSlashCommandsData(data);
}

/**
 * Get both slash commands and plugins for a directory.
 * Callboard custom skills are appended as `callboard:<name>` entries (deduped
 * against CLI-reported commands) so they show up in autocomplete immediately,
 * before any session has run in the directory.
 */
export function getCommandsAndPluginsForDirectory(directory: string): DirectoryCommandsAndPlugins {
  const slashCommands = new Set(getSlashCommandsForDirectory(directory));
  const plugins = getPluginsForDirectory(directory);

  try {
    for (const cmd of customSkillsService.listSlashCommands()) {
      slashCommands.add(cmd);
    }
  } catch (error) {
    console.warn("Failed to append custom skill commands:", error);
  }

  return {
    slashCommands: Array.from(slashCommands),
    plugins,
  };
}

export interface SlashCommandContent {
  name: string;
  source: "custom-skill" | "plugin" | "builtin";
  description: string | null;
  content: string | null;
}

/**
 * Resolve one command name to the markdown body behind it.
 *
 * This lives here, next to the listing it mirrors, because there are two doors
 * onto it — a chat (which supplies its own folder) and the new-chat composer
 * (which supplies a folder directly) — and the *name gate* must be identical on
 * both. A second entry point with its own copy of the check is how one of them
 * ends up weaker; there is one copy, and it is here.
 *
 * Resolution order matches {@link getAllCommandsForDirectory}: custom skill,
 * then *active* per-directory plugins, then *enabled* app-wide plugins, so the
 * body a chip shows is the body of the command the composer would have offered.
 *
 * `activePluginIds` is NOT an access control. It arrives as a query parameter,
 * which means any caller picks its own value; it exists so this route and the
 * listing agree about what is on screen, not to keep anything from anyone. The
 * boundary that does hold is {@link readCommandFile}: a name is a bare file
 * name, and the file it names really lives in that plugin's `commands/`. Do not
 * hang an access decision off this argument.
 *
 * Returns `null` — distinct from a `content: null` result — when the string
 * could not be a command name at all, which callers should treat as a 400. A
 * name that is merely unknown is a harness built-in: real, invocable, and with
 * no body Callboard can read.
 */
export function resolveSlashCommandContent(directory: string, name: string, activePluginIds: string[] = []): SlashCommandContent | null {
  // Gate before anything resolves a path: a command name is never a path.
  if (!name || /[/\\\0]/.test(name) || name.includes("..")) return null;

  const builtin: SlashCommandContent = { name, source: "builtin", description: null, content: null };

  const colon = name.indexOf(":");
  if (colon <= 0) return builtin;
  const namespace = name.slice(0, colon);
  const command = name.slice(colon + 1);
  if (!command) return builtin;

  try {
    if (namespace === CUSTOM_SKILLS_PLUGIN_NAME) {
      const skill = customSkillsService.getSkill(command);
      if (skill) return { name, source: "custom-skill", description: skill.description, content: skill.content };
    }

    // Per-directory plugins for this folder win over app-wide ones, matching
    // the precedence the command listing itself builds with. The active-id
    // filter mirrors client-side visibility (see the header) — same list the
    // autocomplete was built from, not a permission check.
    for (const plugin of getPluginsForDirectory(directory)) {
      if (plugin.manifest.name !== namespace || !activePluginIds.includes(plugin.id)) continue;
      const content = readPluginCommandContent(plugin, command);
      if (content !== null) {
        return { name, source: "plugin", description: plugin.commands.find((c) => c.name === command)?.description ?? null, content };
      }
    }

    for (const plugin of getEnabledAppPlugins()) {
      if (plugin.manifest.name !== namespace) continue;
      const content = readAppPluginCommandContent(plugin, command);
      if (content !== null) {
        return { name, source: "plugin", description: plugin.commands.find((c) => c.name === command)?.description ?? null, content };
      }
    }
  } catch (error) {
    // A broken marketplace.json or an unreadable plugin dir must not fail the
    // request — the command is still invocable, we just can't show its body.
    console.warn(`Failed to resolve content for slash command "${name}":`, error);
  }

  return builtin;
}

/**
 * Get all available commands for a directory including plugin commands (for compatibility)
 */
export function getAllCommandsForDirectory(directory: string, activePluginIds: string[] = []): string[] {
  const { slashCommands, plugins } = getCommandsAndPluginsForDirectory(directory);

  // Start with regular slash commands, using a Set to avoid duplicates
  const allCommands = new Set(slashCommands);

  // Add commands from active plugins
  for (const plugin of plugins) {
    if (activePluginIds.includes(plugin.id)) {
      for (const cmd of pluginToSlashCommands(plugin)) {
        allCommands.add(cmd);
      }
    }
  }

  return Array.from(allCommands);
}
