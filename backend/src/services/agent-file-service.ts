import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DATA_DIR } from "../utils/paths.js";
import type { AgentConfig } from "shared";

const AGENTS_DIR = join(DATA_DIR, "agents");

function ensureAgentsDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

// Ensure directory exists on import
ensureAgentsDir();

function agentDir(alias: string): string {
  return join(AGENTS_DIR, alias);
}

function configPath(alias: string): string {
  return join(agentDir(alias), "agent.json");
}

/** Validate alias: lowercase alphanumeric, hyphens, underscores only */
export function isValidAlias(alias: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(alias) && alias.length >= 2 && alias.length <= 64;
}

export function agentExists(alias: string): boolean {
  return existsSync(configPath(alias));
}

export function createAgent(config: AgentConfig): void {
  const dir = agentDir(config.alias);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(config.alias), JSON.stringify(config, null, 2));
}

export function getAgent(alias: string): AgentConfig | undefined {
  const path = configPath(alias);
  if (!existsSync(path)) return undefined;
  const data = readFileSync(path, "utf8");
  return JSON.parse(data) as AgentConfig;
}

export function listAgents(): AgentConfig[] {
  ensureAgentsDir();
  const entries = readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const config = getAgent(entry.name);
    if (config) agents.push(config);
  }

  // Sort by creation time, newest first
  agents.sort((a, b) => b.createdAt - a.createdAt);
  return agents;
}

export function deleteAgent(alias: string): boolean {
  const dir = agentDir(alias);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Resolve the workspace directory path for an agent (e.g., ~/.ccui-agents/{alias}) */
export function getAgentWorkspacePath(alias: string): string {
  const baseDir = process.env.CCUI_AGENTS_DIR || join(homedir(), ".ccui-agents");
  return join(baseDir, alias);
}

/** Ensure the workspace directory exists and return its path */
export function ensureAgentWorkspaceDir(alias: string): string {
  const workspacePath = getAgentWorkspacePath(alias);
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  return workspacePath;
}
