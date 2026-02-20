import { Router } from "express";
import type { Request, Response } from "express";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentConfig } from "shared";
import { createAgent, listAgents, getAgent, deleteAgent, agentExists, isValidAlias } from "../services/agent-file-service.js";

export const agentsRouter = Router();

function getAgentWorkspacePath(alias: string): string {
  const baseDir = process.env.CCUI_AGENTS_DIR || join(homedir(), ".ccui-agents");
  return join(baseDir, alias);
}

function ensureWorkspaceDir(alias: string): string {
  const workspacePath = getAgentWorkspacePath(alias);
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  return workspacePath;
}

function withWorkspacePath(agent: AgentConfig): AgentConfig & { workspacePath: string } {
  const workspacePath = ensureWorkspaceDir(agent.alias);
  return { ...agent, workspacePath };
}

agentsRouter.get("/", (_req: Request, res: Response): void => {
  const agents = listAgents().map(withWorkspacePath);
  res.json({ agents });
});

agentsRouter.post("/", (req: Request, res: Response): void => {
  const { name, alias, description, systemPrompt } = req.body as Partial<AgentConfig>;

  if (!name || !alias || !description) {
    res.status(400).json({ error: "Name, alias, and description are required" });
    return;
  }

  if (typeof name !== "string" || name.trim().length === 0 || name.length > 128) {
    res.status(400).json({ error: "Name must be 1-128 characters" });
    return;
  }

  if (!isValidAlias(alias)) {
    res.status(400).json({
      error: "Alias must be 2-64 characters: lowercase letters, numbers, hyphens, underscores. Must start with a letter or number.",
    });
    return;
  }

  if (typeof description !== "string" || description.trim().length === 0 || description.length > 512) {
    res.status(400).json({ error: "Description must be 1-512 characters" });
    return;
  }

  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt !== "string") {
    res.status(400).json({ error: "System prompt must be a string" });
    return;
  }

  if (agentExists(alias)) {
    res.status(409).json({ error: `An agent with alias "${alias}" already exists` });
    return;
  }

  const config: AgentConfig = {
    name: name.trim(),
    alias: alias.trim(),
    description: description.trim(),
    systemPrompt: systemPrompt?.trim() || undefined,
    createdAt: Date.now(),
  };

  createAgent(config);

  // Ensure workspace directory exists
  const workspacePath = ensureWorkspaceDir(config.alias);

  res.status(201).json({ agent: { ...config, workspacePath } });
});

agentsRouter.get("/:alias", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const agent = getAgent(alias);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json({ agent: withWorkspacePath(agent) });
});

agentsRouter.delete("/:alias", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const deleted = deleteAgent(alias);

  if (!deleted) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Clean up workspace directory
  const workspacePath = getAgentWorkspacePath(alias);
  if (existsSync(workspacePath)) {
    rmSync(workspacePath, { recursive: true, force: true });
  }

  res.json({ ok: true });
});
