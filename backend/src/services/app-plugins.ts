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
    return { scanRoots: [], plugins: [], mcpServers: [] };
  }

  try {
    const data = readFileSync(APP_PLUGINS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    log.warn(`Failed to load app plugins data: ${error}`);
    return { scanRoots: [], plugins: [], mcpServers: [] };
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
 * Parse a .mcp.json file and return MCP server configs.
 * Used for both plugin-embedded and standalone .mcp.json discovery.
 */
function parseMcpJsonFile(
  mcpJsonPath: string,
  sourcePluginId: string | null,
  scanRoot: string | undefined,
): McpServerConfig[] {
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
        ...(scanRoot && { scanRoot }),
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
        server.env = serverConfig.env as Record<string, string>;
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
  return parseMcpJsonFile(mcpJsonPath, sourcePluginId, undefined);
}

// ─── Recursive Directory Scanning ──────────────────────────────────────────

interface DiscoveredMarketplace {
  marketplacePath: string;
  marketplaceDir: string;
}

interface DiscoveredMcpFile {
  mcpJsonPath: string;
  directory: string;
}

interface DiscoveredFiles {
  marketplaces: DiscoveredMarketplace[];
  mcpFiles: DiscoveredMcpFile[];
}

/**
 * Recursively scan a directory for .claude-plugin/marketplace.json and .mcp.json files.
 * Uses iterative DFS with an explicit stack to avoid stack overflow.
 */
function findDiscoverableFiles(rootDir: string): DiscoveredFiles {
  const marketplaces: DiscoveredMarketplace[] = [];
  const mcpFiles: DiscoveredMcpFile[] = [];
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

    // Check for .mcp.json at this level
    const mcpJsonPath = join(currentPath, ".mcp.json");
    if (existsSync(mcpJsonPath)) {
      mcpFiles.push({
        mcpJsonPath,
        directory: currentPath,
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

  log.debug(
    `Scan of ${rootDir}: visited ${dirsVisited} directories, found ${marketplaces.length} marketplace files, ${mcpFiles.length} .mcp.json files`,
  );
  return { marketplaces, mcpFiles };
}

/**
 * Scan a directory recursively and return all discovered plugins and MCP servers.
 * Discovers both plugin-embedded MCP servers and standalone .mcp.json files.
 */
function scanDirectory(rootDir: string): { plugins: AppPlugin[]; mcpServers: McpServerConfig[] } {
  const resolvedRoot = resolve(rootDir);

  if (!existsSync(resolvedRoot)) {
    throw new Error(`Directory does not exist: ${resolvedRoot}`);
  }

  const stat = statSync(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedRoot}`);
  }

  const { marketplaces, mcpFiles } = findDiscoverableFiles(resolvedRoot);
  const plugins: AppPlugin[] = [];
  const allMcpServers: McpServerConfig[] = [];
  const seenPluginPaths = new Set<string>();

  // Track directories claimed by plugins (to avoid double-counting their .mcp.json)
  const pluginClaimedDirs = new Set<string>();

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

        pluginClaimedDirs.add(absolutePluginPath);

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
        allMcpServers.push(...mcpServers);
      }
    } catch (error) {
      log.warn(`Failed to parse marketplace.json at ${marketplacePath}: ${error}`);
    }
  }

  // Process standalone .mcp.json files (not already claimed by a plugin)
  const seenMcpServerIds = new Set(allMcpServers.map((s) => s.id));

  for (const { mcpJsonPath, directory } of mcpFiles) {
    // Skip .mcp.json files inside directories already claimed by a plugin source
    if (pluginClaimedDirs.has(directory)) continue;

    const standaloneServers = parseMcpJsonFile(mcpJsonPath, null, resolvedRoot);
    for (const server of standaloneServers) {
      if (!seenMcpServerIds.has(server.id)) {
        seenMcpServerIds.add(server.id);
        allMcpServers.push(server);
      }
    }
  }

  return { plugins, mcpServers: allMcpServers };
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

  const { plugins, mcpServers } = scanDirectory(resolvedDir);

  // Add scan root
  data.scanRoots.push({
    path: resolvedDir,
    lastScanned: new Date().toISOString(),
    pluginCount: plugins.length,
    mcpServerCount: mcpServers.length,
  });

  // Add plugins (deduplicate against existing by path)
  const existingPaths = new Set(data.plugins.map((p) => p.pluginPath));
  for (const plugin of plugins) {
    if (!existingPaths.has(plugin.pluginPath)) {
      data.plugins.push(plugin);
    }
  }

  // Add standalone MCP servers (discovered from .mcp.json files outside plugin dirs)
  const existingServerIds = new Set(data.mcpServers.map((s) => s.id));
  for (const server of mcpServers) {
    if (!existingServerIds.has(server.id) && !server.sourcePluginId) {
      data.mcpServers.push(server);
      existingServerIds.add(server.id);
    }
  }

  saveAppPluginsData(data);

  log.info(`Added scan root ${resolvedDir}: ${plugins.length} plugins, ${mcpServers.length} MCP servers`);

  return {
    scanRoot: resolvedDir,
    pluginsFound: plugins.length,
    mcpServersFound: mcpServers.length,
    plugins,
    mcpServers,
  };
}

/**
 * Remove a scan root and all its associated plugins/MCP servers.
 */
export function removeScanRoot(directory: string): void {
  const resolvedDir = resolve(directory);
  const data = loadAppPluginsData();

  // Collect plugin IDs from this scan root for cascading MCP server removal
  const pluginIdsToRemove = new Set(data.plugins.filter((p) => p.scanRoot === resolvedDir).map((p) => p.id));

  data.scanRoots = data.scanRoots.filter((r) => r.path !== resolvedDir);
  data.plugins = data.plugins.filter((p) => p.scanRoot !== resolvedDir);
  data.mcpServers = data.mcpServers.filter((s) => {
    // Remove standalone servers from this scan root
    if (s.scanRoot === resolvedDir) return false;
    // Remove servers whose parent plugin is being removed
    if (s.sourcePluginId && pluginIdsToRemove.has(s.sourcePluginId)) return false;
    return true;
  });

  saveAppPluginsData(data);
  log.info(`Removed scan root ${resolvedDir}`);
}

/**
 * Re-scan an existing root, preserving enabled states for previously discovered items.
 */
export function rescanRoot(directory: string): ScanResult {
  const resolvedDir = resolve(directory);
  const data = loadAppPluginsData();

  // Save current enabled states
  const pluginEnabledStates = new Map<string, boolean>();
  const mcpEnabledStates = new Map<string, boolean>();

  for (const p of data.plugins) {
    if (p.scanRoot === resolvedDir) {
      pluginEnabledStates.set(p.pluginPath, p.enabled);
      if (p.mcpServers) {
        for (const s of p.mcpServers) {
          mcpEnabledStates.set(`${p.pluginPath}:${s.name}`, s.enabled);
        }
      }
    }
  }

  // Save standalone MCP server enabled states
  for (const s of data.mcpServers) {
    if (s.scanRoot === resolvedDir) {
      mcpEnabledStates.set(`standalone:${s.name}`, s.enabled);
    }
  }

  // Remove old entries for this scan root
  const pluginIdsToRemove = new Set(data.plugins.filter((p) => p.scanRoot === resolvedDir).map((p) => p.id));
  data.plugins = data.plugins.filter((p) => p.scanRoot !== resolvedDir);
  data.mcpServers = data.mcpServers.filter((s) => {
    if (s.scanRoot === resolvedDir) return false;
    if (s.sourcePluginId && pluginIdsToRemove.has(s.sourcePluginId)) return false;
    return true;
  });

  // Re-scan
  const { plugins, mcpServers } = scanDirectory(resolvedDir);

  // Restore enabled states for plugins and their embedded MCP servers
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
      }
    }
  }

  // Restore enabled states for standalone MCP servers
  for (const server of mcpServers) {
    if (!server.sourcePluginId) {
      const prev = mcpEnabledStates.get(`standalone:${server.name}`);
      if (prev !== undefined) {
        server.enabled = prev;
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

  // Update data — add standalone MCP servers
  const existingServerIds = new Set(data.mcpServers.map((s) => s.id));
  for (const server of mcpServers) {
    if (!server.sourcePluginId && !existingServerIds.has(server.id)) {
      data.mcpServers.push(server);
      existingServerIds.add(server.id);
    }
  }

  // Update scan root metadata
  const rootIdx = data.scanRoots.findIndex((r) => r.path === resolvedDir);
  if (rootIdx >= 0) {
    data.scanRoots[rootIdx].lastScanned = new Date().toISOString();
    data.scanRoots[rootIdx].pluginCount = plugins.length;
    data.scanRoots[rootIdx].mcpServerCount = mcpServers.length;
  }

  saveAppPluginsData(data);
  log.info(`Rescanned ${resolvedDir}: ${plugins.length} plugins, ${mcpServers.length} MCP servers`);

  return {
    scanRoot: resolvedDir,
    pluginsFound: plugins.length,
    mcpServersFound: mcpServers.length,
    plugins,
    mcpServers,
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

  // Cascade: if disabling plugin, also disable its MCP servers
  if (!enabled && plugin.mcpServers) {
    for (const server of plugin.mcpServers) {
      server.enabled = false;
    }
    // Also disable standalone MCP servers linked to this plugin
    for (const server of data.mcpServers) {
      if (server.sourcePluginId === pluginId) {
        server.enabled = false;
      }
    }
  }

  saveAppPluginsData(data);
  log.debug(`Plugin ${pluginId} (${plugin.manifest.name}) set to ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Toggle an MCP server's enabled state.
 */
export function setMcpServerEnabled(serverId: string, enabled: boolean): void {
  const data = loadAppPluginsData();
  let found = false;

  // Check standalone MCP servers
  for (const server of data.mcpServers) {
    if (server.id === serverId) {
      server.enabled = enabled;
      found = true;
      break;
    }
  }

  // Check MCP servers embedded in plugins
  if (!found) {
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
  }

  if (!found) {
    throw new Error(`MCP server not found: ${serverId}`);
  }

  saveAppPluginsData(data);
  log.debug(`MCP server ${serverId} set to ${enabled ? "enabled" : "disabled"}`);
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
 * Get all enabled MCP servers from all sources (for inclusion in SDK query options).
 * Includes both standalone MCP servers and those embedded in enabled plugins.
 */
export function getEnabledMcpServers(): McpServerConfig[] {
  const data = loadAppPluginsData();
  const servers: McpServerConfig[] = [];

  // Standalone MCP servers
  for (const server of data.mcpServers) {
    if (server.enabled) {
      servers.push(server);
    }
  }

  // MCP servers from enabled plugins
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
