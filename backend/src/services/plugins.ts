import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import type { PluginCommand, PluginManifest, Plugin } from "shared/types/index.js";

export type { PluginCommand, PluginManifest, Plugin };

/**
 * Scan a plugin source directory for commands in the commands/ folder
 */
function discoverPluginCommands(pluginSourcePath: string, marketplaceDir: string): PluginCommand[] {
  try {
    const absoluteSourcePath = resolve(marketplaceDir, pluginSourcePath);
    const commandsPath = join(absoluteSourcePath, "commands");

    if (!existsSync(commandsPath)) {
      return [];
    }

    const commandFiles = readdirSync(commandsPath).filter((file) => file.endsWith(".md"));

    return commandFiles.map((file) => {
      const commandName = file.replace(/\.md$/, "");

      // Try to extract description from the first line of the .md file
      let description = "";
      try {
        const commandFilePath = join(commandsPath, file);
        const content = readFileSync(commandFilePath, "utf-8");
        const firstLine = content.split("\n")[0];
        // Extract title from markdown header (# Title) or use file name
        description = firstLine.startsWith("#") ? firstLine.replace(/^#+\s*/, "").trim() : `${commandName} command`;
      } catch {
        description = `${commandName} command`;
      }

      return {
        name: commandName,
        description,
      };
    });
  } catch (error) {
    console.warn(`Failed to discover commands for plugin source ${pluginSourcePath}:`, error);
    return [];
  }
}

/**
 * Discover all plugins from .claude-plugin/marketplace.json
 */
export function discoverPlugins(directory: string): Plugin[] {
  const marketplacePath = join(directory, ".claude-plugin", "marketplace.json");

  if (!existsSync(marketplacePath)) {
    return [];
  }

  try {
    const data = readFileSync(marketplacePath, "utf-8");
    const marketplace = JSON.parse(data);

    if (!Array.isArray(marketplace.plugins)) {
      return [];
    }

    const pluginBaseDir = dirname(dirname(marketplacePath)); // Parent of .claude-plugin folder

    return marketplace.plugins
      .filter((p: any) => p.name && p.source && typeof p.source === "string" && p.description)
      .map((p: any) => {
        const commands = discoverPluginCommands(p.source, pluginBaseDir);

        return {
          id: p.name,
          path: marketplacePath,
          manifest: p,
          commands,
        };
      });
  } catch (error) {
    console.warn(`Failed to parse marketplace.json at ${marketplacePath}:`, error);
    return [];
  }
}

/**
 * Get plugins for a specific directory (looks in current directory only)
 */
export function getPluginsForDirectory(directory: string): Plugin[] {
  return discoverPlugins(directory);
}

/**
 * Convert plugin commands to slash command format
 */
export function pluginToSlashCommands(plugin: Plugin): string[] {
  return plugin.commands.map((command) => `${plugin.manifest.name}:${command.name}`);
}
