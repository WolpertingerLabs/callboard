import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { getPluginsForDirectory, Plugin, pluginToSlashCommands } from "./plugins.js";
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
 * Get both slash commands and plugins for a directory
 */
export function getCommandsAndPluginsForDirectory(directory: string): DirectoryCommandsAndPlugins {
  const slashCommands = getSlashCommandsForDirectory(directory);
  const plugins = getPluginsForDirectory(directory);

  return {
    slashCommands,
    plugins,
  };
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
