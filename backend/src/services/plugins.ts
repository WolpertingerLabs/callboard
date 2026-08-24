import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, resolve, sep } from "path";
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
 * Read the body of `<commandsDir>/<commandName>.md`, or null when there is none.
 *
 * The command name reaches this function from a query parameter, so it is
 * treated as hostile: it must be a bare file name (no separator, no parent hop,
 * no null byte) *and* the path it resolves to must still sit directly inside
 * `commandsDir`. The second check is not redundant — it is what holds if the
 * first is ever loosened, and it is the one that survives a platform where the
 * separator set differs from the one spelled out below.
 *
 * Shared by both discovery paths (per-directory plugins here, app-wide plugins
 * in app-plugins.ts) so the gate exists once rather than once per caller.
 */
export function readCommandFile(commandsDir: string, commandName: string): string | null {
  if (!commandName || /[/\\\0]/.test(commandName) || commandName.includes("..")) {
    return null;
  }

  const dir = resolve(commandsDir);
  const filePath = resolve(dir, `${commandName}.md`);
  if (!filePath.startsWith(dir + sep)) {
    return null;
  }

  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    console.warn(`Failed to read plugin command file ${filePath}:`, error);
    return null;
  }
}

/**
 * Read the full markdown body of one command belonging to a per-directory
 * plugin. `manifest.source` is relative to the marketplace's own directory —
 * the same resolution `discoverPluginCommands` performs when it lists them.
 */
export function readPluginCommandContent(plugin: Plugin, commandName: string): string | null {
  // plugin.path is <dir>/.claude-plugin/marketplace.json; sources resolve
  // against <dir>.
  const marketplaceDir = dirname(dirname(plugin.path));
  const commandsDir = join(resolve(marketplaceDir, plugin.manifest.source), "commands");
  return readCommandFile(commandsDir, commandName);
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
