import type { PluginManifest, PluginCommand } from "./plugins.js";

/** MCP server configuration (stdio or HTTP/SSE) */
export interface McpServerConfig {
  /** Unique ID for this MCP server */
  id: string;
  /** Human-readable name (used as key in SDK mcpServers config) */
  name: string;
  /** Which app plugin this came from (null if standalone) */
  sourcePluginId: string | null;
  /** Whether this MCP server is enabled */
  enabled: boolean;
  /** Server transport type */
  type: "stdio" | "sse" | "http";
  /** For stdio: command to run */
  command?: string;
  /** For stdio: command arguments */
  args?: string[];
  /** For sse/http: server URL */
  url?: string;
  /** For sse/http: request headers */
  headers?: Record<string, string>;
  /** Environment variables to pass to the server */
  env?: Record<string, string>;
}

/** An app-wide plugin discovered from a recursive scan */
export interface AppPlugin {
  /** Unique ID (SHA-256 hash prefix of absolute plugin path) */
  id: string;
  /** Absolute path to the plugin directory */
  pluginPath: string;
  /** Path to the marketplace.json that declared this plugin */
  marketplacePath: string;
  /** The root scan directory this was discovered from */
  scanRoot: string;
  /** Plugin manifest from marketplace.json */
  manifest: PluginManifest;
  /** Discovered slash commands */
  commands: PluginCommand[];
  /** Whether this plugin is enabled (user toggle) */
  enabled: boolean;
  /** MCP servers discovered inside this plugin's .mcp.json (if any) */
  mcpServers?: McpServerConfig[];
}

/** Stored scan root entry with metadata */
export interface PluginScanRoot {
  /** Absolute path to the directory that was scanned */
  path: string;
  /** When this scan was last performed (ISO-8601) */
  lastScanned: string;
  /** Number of plugins found in this scan root */
  pluginCount: number;
  /** Number of MCP servers found in this scan root */
  mcpServerCount: number;
}

/** The complete persisted state for app-wide plugins */
export interface AppPluginsData {
  /** Directories the user has registered for scanning */
  scanRoots: PluginScanRoot[];
  /** All discovered app-wide plugins */
  plugins: AppPlugin[];
  /** Standalone MCP servers (not from plugins) */
  mcpServers: McpServerConfig[];
}

/** API response for scan operations */
export interface ScanResult {
  scanRoot: string;
  pluginsFound: number;
  mcpServersFound: number;
  plugins: AppPlugin[];
  mcpServers: McpServerConfig[];
}
