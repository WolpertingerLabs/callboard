import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { DATA_DIR, ensureDataDir } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { AppPlugin, McpServerConfig, AppPluginsData, ScanResult } from "shared/types/index.js";
import type { PluginManifest, PluginCommand } from "shared/types/index.js";

const log = createLogger("app-plugins");

const APP_PLUGINS_FILE = join(DATA_DIR, "app-plugins.json");

/** Directories to skip during recursive scanning */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "vendor",
  ".cache",
  "coverage",
  ".tox",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".cargo",
  "target",
]);

const MAX_SCAN_DEPTH = 6;
const MAX_DIRS_VISITED = 10_000;

// ─── Storage ───────────────────────────────────────────────────────────────

function loadAppPluginsData(): AppPluginsData {
  ensureDataDir();

  if (!existsSync(APP_PLUGINS_FILE)) {
    return { scanRoots: [], plugins: [] };
  }

  try {
    const raw = readFileSync(APP_PLUGINS_FILE, "utf-8");
    const data = JSON.parse(raw);

    // Migration: drop any top-level mcpServers (standalone servers from old format).
    // After migration, all MCP servers must come from plugins.
    if (Array.isArray(data.mcpServers) && data.mcpServers.length > 0) {
      log.info(
        `Migrating: dropping ${data.mcpServers.length} standalone MCP server(s) from old format. ` +
          `Re-scan roots to discover them as plugin-embedded servers.`,
      );
      delete data.mcpServers;
      writeFileSync(APP_PLUGINS_FILE, JSON.stringify(data, null, 2));
    }

    return { scanRoots: data.scanRoots || [], plugins: data.plugins || [] };
  } catch (error) {
    log.warn(`Failed to load app plugins data: ${error}`);
    return { scanRoots: [], plugins: [] };
  }
}

function saveAppPluginsData(data: AppPluginsData): void {
  ensureDataDir();

  try {
    writeFileSync(APP_PLUGINS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log.error(`Failed to save app plugins data: ${error}`);
    throw error;
  }
}

// ─── ID Generation ─────────────────────────────────────────────────────────

function generateId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

// ─── Plugin Command Discovery ──────────────────────────────────────────────
// (Mirrors logic from backend/src/services/plugins.ts)

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

      let description = "";
      try {
        const commandFilePath = join(commandsPath, file);
        const content = readFileSync(commandFilePath, "utf-8");
        const firstLine = content.split("\n")[0];
        description = firstLine.startsWith("#") ? firstLine.replace(/^#+\s*/, "").trim() : `${commandName} command`;
      } catch {
        description = `${commandName} command`;
      }

      return { name: commandName, description };
    });
  } catch (error) {
    log.warn(`Failed to discover commands for plugin source ${pluginSourcePath}: ${error}`);
    return [];
  }
}

// ─── MCP Server Discovery ──────────────────────────────────────────────────

/**
 * Resolve env var template values from .mcp.json into concrete values + defaults.
 *
 * Patterns handled:
 *   "${VAR}"         → env value = "", envDefaults template = "${VAR}"
 *   "${VAR:-default}" → env value = "default", envDefaults template = "${VAR:-default}"
 *   "literal"        → env value = "literal", envDefaults template = "literal"
 */
function resolveEnvDefaults(rawEnv: Record<string, string>): {
  env: Record<string, string>;
  envDefaults: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const envDefaults: Record<string, string> = {};

  for (const [key, value] of Object.entries(rawEnv)) {
    envDefaults[key] = value;

    // Match ${VAR} or ${VAR:-default}
    const match = value.match(/^\$\{([^}:]+)(?::-(.*))?\}$/);
    if (match) {
      // match[2] is the default value (undefined if no :- syntax)
      env[key] = match[2] ?? "";
    } else {
      // Plain literal value
      env[key] = value;
    }
  }

  return { env, envDefaults };
}

/**
 * Parse a .mcp.json file and return MCP server configs.
 * All MCP servers must belong to a plugin.
 */
function parseMcpJsonFile(mcpJsonPath: string, sourcePluginId: string): McpServerConfig[] {
  try {
    const fileData = readFileSync(mcpJsonPath, "utf-8");
    const mcpConfig = JSON.parse(fileData);

    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object") {
      return [];
    }

    const servers: McpServerConfig[] = [];
    const mcpDir = resolve(mcpJsonPath, "..");

    for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
      const serverConfig = config as Record<string, unknown>;
      const serverId = generateId(`${mcpDir}:${name}`);

      const server: McpServerConfig = {
        id: serverId,
        name,
        sourcePluginId,
        enabled: true,
        type: "stdio",
        mcpJsonDir: mcpDir,
      };

      // Determine server type
      if (serverConfig.type === "sse" || serverConfig.type === "http") {
        server.type = serverConfig.type;
        if (typeof serverConfig.url === "string") server.url = serverConfig.url;
        if (serverConfig.headers && typeof serverConfig.headers === "object") {
          server.headers = serverConfig.headers as Record<string, string>;
        }
      } else {
        // Default: stdio
        if (typeof serverConfig.command === "string") server.command = serverConfig.command;
        if (Array.isArray(serverConfig.args)) server.args = serverConfig.args as string[];
      }

      if (serverConfig.env && typeof serverConfig.env === "object") {
        const { env, envDefaults } = resolveEnvDefaults(serverConfig.env as Record<string, string>);
        server.env = env;
        server.envDefaults = envDefaults;
      }

      servers.push(server);
    }

    return servers;
  } catch (error) {
    log.warn(`Failed to parse .mcp.json at ${mcpJsonPath}: ${error}`);
    return [];
  }
}

/**
 * Discover MCP servers from a plugin's source directory.
 */
function discoverMcpServers(pluginSourcePath: string, marketplaceDir: string, sourcePluginId: string): McpServerConfig[] {
  const absoluteSourcePath = resolve(marketplaceDir, pluginSourcePath);
  const mcpJsonPath = join(absoluteSourcePath, ".mcp.json");
  if (!existsSync(mcpJsonPath)) {
    return [];
  }
  return parseMcpJsonFile(mcpJsonPath, sourcePluginId);
}

// ─── Recursive Directory Scanning ──────────────────────────────────────────

interface DiscoveredMarketplace {
  marketplacePath: string;
  marketplaceDir: string;
}

/**
 * Recursively scan a directory for .claude-plugin/marketplace.json files.
 * Uses iterative DFS with an explicit stack to avoid stack overflow.
 */
function findMarketplaceFiles(rootDir: string): DiscoveredMarketplace[] {
  const marketplaces: DiscoveredMarketplace[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: rootDir, depth: 0 }];
  let dirsVisited = 0;

  while (stack.length > 0) {
    if (dirsVisited >= MAX_DIRS_VISITED) {
      log.warn(`Scan of ${rootDir} hit max directory limit (${MAX_DIRS_VISITED})`);
      break;
    }

    const { path: currentPath, depth } = stack.pop()!;

    if (depth > MAX_SCAN_DEPTH) continue;

    dirsVisited++;

    // Check for .claude-plugin/marketplace.json at this level
    const marketplacePath = join(currentPath, ".claude-plugin", "marketplace.json");
    if (existsSync(marketplacePath)) {
      marketplaces.push({
        marketplacePath,
        marketplaceDir: currentPath,
      });
    }

    // Recurse into subdirectories
    if (depth < MAX_SCAN_DEPTH) {
      try {
        const entries = readdirSync(currentPath);
        for (const entry of entries) {
          // Skip known non-useful directories
          if (SKIP_DIRS.has(entry)) continue;
          // Skip hidden directories (except .claude-plugin which we already checked)
          if (entry.startsWith(".")) continue;

          const entryPath = join(currentPath, entry);
          try {
            const stat = statSync(entryPath);
            if (stat.isDirectory()) {
              stack.push({ path: entryPath, depth: depth + 1 });
            }
          } catch {
            // Skip entries we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }
  }

  log.debug(`Scan of ${rootDir}: visited ${dirsVisited} directories, found ${marketplaces.length} marketplace files`);
  return marketplaces;
}

/**
 * Scan a directory recursively and return all discovered plugins.
 * MCP servers are embedded inside the plugins they belong to.
 */
function scanDirectory(rootDir: string): { plugins: AppPlugin[] } {
  const resolvedRoot = resolve(rootDir);

  if (!existsSync(resolvedRoot)) {
    throw new Error(`Directory does not exist: ${resolvedRoot}`);
  }

  const stat = statSync(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedRoot}`);
  }

  const marketplaces = findMarketplaceFiles(resolvedRoot);
  const plugins: AppPlugin[] = [];
  const seenPluginPaths = new Set<string>();

  for (const { marketplacePath, marketplaceDir } of marketplaces) {
    try {
      const data = readFileSync(marketplacePath, "utf-8");
      const marketplace = JSON.parse(data);

      if (!Array.isArray(marketplace.plugins)) continue;

      for (const p of marketplace.plugins) {
        if (!p.name || !p.source || !p.description) continue;

        const absolutePluginPath = resolve(marketplaceDir, p.source);

        // Deduplicate by resolved plugin path
        if (seenPluginPaths.has(absolutePluginPath)) continue;
        seenPluginPaths.add(absolutePluginPath);

        const pluginId = generateId(absolutePluginPath);
        const commands = discoverPluginCommands(p.source, marketplaceDir);
        const mcpServers = discoverMcpServers(p.source, marketplaceDir, pluginId);

        const manifest: PluginManifest = {
          name: p.name,
          description: p.description,
          source: p.source,
        };

        const plugin: AppPlugin = {
          id: pluginId,
          pluginPath: absolutePluginPath,
          marketplacePath,
          scanRoot: resolvedRoot,
          manifest,
          commands,
          enabled: true,
          ...(mcpServers.length > 0 && { mcpServers }),
        };

        plugins.push(plugin);
      }
    } catch (error) {
      log.warn(`Failed to parse marketplace.json at ${marketplacePath}: ${error}`);
    }
  }

  return { plugins };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get the full app-wide plugins data (for Settings UI).
 */
export function getAllAppPluginsData(): AppPluginsData {
  return loadAppPluginsData();
}

/**
 * Scan a new directory and add it as a scan root.
 * Returns the scan result for the newly added root.
 */
export function addScanRoot(directory: string): ScanResult {
  const resolvedDir = resolve(directory);
  const data = loadAppPluginsData();

  // Check if already registered
  if (data.scanRoots.some((r) => r.path === resolvedDir)) {
    // Re-scan existing root instead
    return rescanRoot(resolvedDir);
  }

  const { plugins } = scanDirectory(resolvedDir);
  const mcpServerCount = plugins.reduce((sum, p) => sum + (p.mcpServers?.length || 0), 0);

  // Add scan root
  data.scanRoots.push({
    path: resolvedDir,
    lastScanned: new Date().toISOString(),
    pluginCount: plugins.length,
    mcpServerCount,
  });

  // Add plugins (deduplicate against existing by path)
  const existingPaths = new Set(data.plugins.map((p) => p.pluginPath));
  for (const plugin of plugins) {
    if (!existingPaths.has(plugin.pluginPath)) {
      data.plugins.push(plugin);
    }
  }

  saveAppPluginsData(data);

  log.info(`Added scan root ${resolvedDir}: ${plugins.length} plugins, ${mcpServerCount} MCP servers`);

  return {
    scanRoot: resolvedDir,
    pluginsFound: plugins.length,
    mcpServersFound: mcpServerCount,
    plugins,
  };
}

/**
 * Remove a scan root and all its associated plugins.
 */
export function removeScanRoot(directory: string): void {
  const resolvedDir = resolve(directory);
  const data = loadAppPluginsData();

  data.scanRoots = data.scanRoots.filter((r) => r.path !== resolvedDir);
  data.plugins = data.plugins.filter((p) => p.scanRoot !== resolvedDir);

  saveAppPluginsData(data);
  log.info(`Removed scan root ${resolvedDir}`);
}

/**
 * Re-scan an existing root, preserving enabled states for previously discovered items.
 */
export function rescanRoot(directory: string): ScanResult {
  const resolvedDir = resolve(directory);
  const data = loadAppPluginsData();

  // Save current enabled states and user-set env values
  const pluginEnabledStates = new Map<string, boolean>();
  const mcpEnabledStates = new Map<string, boolean>();
  const mcpEnvStates = new Map<string, Record<string, string>>();

  for (const p of data.plugins) {
    if (p.scanRoot === resolvedDir) {
      pluginEnabledStates.set(p.pluginPath, p.enabled);
      if (p.mcpServers) {
        for (const s of p.mcpServers) {
          const key = `${p.pluginPath}:${s.name}`;
          mcpEnabledStates.set(key, s.enabled);
          if (s.env) mcpEnvStates.set(key, s.env);
        }
      }
    }
  }

  // Remove old entries for this scan root
  data.plugins = data.plugins.filter((p) => p.scanRoot !== resolvedDir);

  // Re-scan
  const { plugins } = scanDirectory(resolvedDir);

  // Restore enabled states and user-set env values for plugins and their embedded MCP servers
  for (const plugin of plugins) {
    const prevEnabled = pluginEnabledStates.get(plugin.pluginPath);
    if (prevEnabled !== undefined) {
      plugin.enabled = prevEnabled;
    }
    if (plugin.mcpServers) {
      for (const server of plugin.mcpServers) {
        const key = `${plugin.pluginPath}:${server.name}`;
        const prevServerEnabled = mcpEnabledStates.get(key);
        if (prevServerEnabled !== undefined) {
          server.enabled = prevServerEnabled;
        }
        const prevEnv = mcpEnvStates.get(key);
        if (prevEnv) {
          server.env = prevEnv;
        }
      }
    }
  }

  // Update data — add plugins
  const existingPaths = new Set(data.plugins.map((p) => p.pluginPath));
  for (const plugin of plugins) {
    if (!existingPaths.has(plugin.pluginPath)) {
      data.plugins.push(plugin);
    }
  }

  // Update scan root metadata
  const mcpServerCount = plugins.reduce((sum, p) => sum + (p.mcpServers?.length || 0), 0);
  const rootIdx = data.scanRoots.findIndex((r) => r.path === resolvedDir);
  if (rootIdx >= 0) {
    data.scanRoots[rootIdx].lastScanned = new Date().toISOString();
    data.scanRoots[rootIdx].pluginCount = plugins.length;
    data.scanRoots[rootIdx].mcpServerCount = mcpServerCount;
  }

  saveAppPluginsData(data);
  log.info(`Rescanned ${resolvedDir}: ${plugins.length} plugins, ${mcpServerCount} MCP servers`);

  return {
    scanRoot: resolvedDir,
    pluginsFound: plugins.length,
    mcpServersFound: mcpServerCount,
    plugins,
  };
}

/**
 * Re-scan all registered roots.
 */
export function rescanAll(): ScanResult[] {
  const data = loadAppPluginsData();
  const results: ScanResult[] = [];

  for (const root of data.scanRoots) {
    try {
      results.push(rescanRoot(root.path));
    } catch (error) {
      log.warn(`Failed to rescan ${root.path}: ${error}`);
    }
  }

  return results;
}

/**
 * Toggle a plugin's enabled state.
 * When disabling, also disables associated MCP servers.
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const data = loadAppPluginsData();

  const plugin = data.plugins.find((p) => p.id === pluginId);
  if (!plugin) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }

  plugin.enabled = enabled;

  // Cascade: if disabling plugin, also disable its embedded MCP servers
  if (!enabled && plugin.mcpServers) {
    for (const server of plugin.mcpServers) {
      server.enabled = false;
    }
  }

  saveAppPluginsData(data);
  log.debug(`Plugin ${pluginId} (${plugin.manifest.name}) set to ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Toggle an MCP server's enabled state.
 * Searches MCP servers embedded in plugins.
 */
export function setMcpServerEnabled(serverId: string, enabled: boolean): void {
  const data = loadAppPluginsData();
  let found = false;

  for (const plugin of data.plugins) {
    if (plugin.mcpServers) {
      for (const server of plugin.mcpServers) {
        if (server.id === serverId) {
          server.enabled = enabled;
          found = true;
          break;
        }
      }
    }
    if (found) break;
  }

  if (!found) {
    throw new Error(`MCP server not found: ${serverId}`);
  }

  saveAppPluginsData(data);
  log.debug(`MCP server ${serverId} set to ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Update an MCP server's environment variables.
 * Searches MCP servers embedded in plugins.
 */
export function setMcpServerEnv(serverId: string, env: Record<string, string>): void {
  const data = loadAppPluginsData();
  let found = false;

  for (const plugin of data.plugins) {
    if (plugin.mcpServers) {
      for (const server of plugin.mcpServers) {
        if (server.id === serverId) {
          server.env = env;
          found = true;
          break;
        }
      }
    }
    if (found) break;
  }

  if (!found) {
    throw new Error(`MCP server not found: ${serverId}`);
  }

  saveAppPluginsData(data);
  log.debug(`MCP server ${serverId} env updated (${Object.keys(env).length} vars)`);
}

// ─── SDK Integration Getters ───────────────────────────────────────────────

/**
 * Get all enabled app-wide plugins (for inclusion in SDK query options).
 */
export function getEnabledAppPlugins(): AppPlugin[] {
  const data = loadAppPluginsData();
  return data.plugins.filter((p) => p.enabled);
}

/**
 * Get all enabled MCP servers from enabled plugins (for inclusion in SDK query options).
 */
export function getEnabledMcpServers(): McpServerConfig[] {
  const data = loadAppPluginsData();
  const servers: McpServerConfig[] = [];

  for (const plugin of data.plugins) {
    if (plugin.enabled && plugin.mcpServers) {
      for (const server of plugin.mcpServers) {
        if (server.enabled) {
          servers.push(server);
        }
      }
    }
  }

  return servers;
}
