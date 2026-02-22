import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync, rmSync } from "fs";
import type { AgentConfig } from "shared";
import {
  createAgent,
  listAgents,
  getAgent,
  deleteAgent,
  agentExists,
  isValidAlias,
  getAgentWorkspacePath,
  ensureAgentWorkspaceDir,
} from "../services/agent-file-service.js";
import { compileIdentityPrompt, compileWorkspaceContext, scaffoldWorkspace } from "../services/claude-compiler.js";
import { agentWorkspaceRouter } from "./agent-workspace.js";
import { agentMemoryRouter } from "./agent-memory.js";
import { agentCronJobsRouter } from "./agent-cron-jobs.js";
import { agentActivityRouter } from "./agent-activity.js";
import { agentTriggersRouter } from "./agent-triggers.js";
import { updateHeartbeatConfig, stopHeartbeat } from "../services/heartbeat.js";
import { updateConsolidationConfig, stopConsolidation } from "../services/memory-consolidation.js";
import { cancelAllJobsForAgent, scheduleJob } from "../services/cron-scheduler.js";
import { ensureDefaultCronJobs } from "../services/agent-cron-jobs.js";

export const agentsRouter = Router();

// Mount sub-routers for agent operational data
agentsRouter.use("/:alias/workspace", agentWorkspaceRouter);
agentsRouter.use("/:alias/memory", agentMemoryRouter);
agentsRouter.use("/:alias/cron-jobs", agentCronJobsRouter);
agentsRouter.use("/:alias/activity", agentActivityRouter);
agentsRouter.use("/:alias/triggers", agentTriggersRouter);

function withWorkspacePath(agent: AgentConfig): AgentConfig & { workspacePath: string } {
  const workspacePath = ensureAgentWorkspaceDir(agent.alias);
  return { ...agent, workspacePath };
}

agentsRouter.get("/", (_req: Request, res: Response): void => {
  const agents = listAgents().map(withWorkspacePath);
  res.json({ agents });
});

agentsRouter.post("/", (req: Request, res: Response): void => {
  const { name, alias, description, systemPrompt, emoji, personality, role, tone } = req.body as Partial<AgentConfig>;

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
    ...(emoji && { emoji }),
    ...(personality && { personality: personality.trim() }),
    ...(role && { role: role.trim() }),
    ...(tone && { tone: tone.trim() }),
  };

  createAgent(config);

  // Ensure workspace directory exists and scaffold initial files
  const workspacePath = ensureAgentWorkspaceDir(config.alias);
  scaffoldWorkspace(workspacePath);

  // Create default cron jobs (e.g., heartbeat) and schedule them
  const defaultJobs = ensureDefaultCronJobs(config.alias);
  for (const job of defaultJobs) {
    if (job.status === "active") {
      scheduleJob(config.alias, job);
    }
  }

  res.status(201).json({ agent: { ...config, workspacePath } });
});

// Identity prompt — returns compiled identity + pre-loaded workspace context for SDK systemPrompt.append
agentsRouter.get("/:alias/identity-prompt", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const agent = getAgent(alias);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const identityPrompt = compileIdentityPrompt(agent);
  const workspacePath = getAgentWorkspacePath(alias);
  const workspaceContext = compileWorkspaceContext(workspacePath);
  const prompt = [identityPrompt, workspaceContext].filter(Boolean).join("\n\n");
  res.json({ prompt });
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

agentsRouter.put("/:alias", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const existing = getAgent(alias);

  if (!existing) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const {
    name,
    description,
    systemPrompt,
    emoji,
    personality,
    role,
    tone,
    pronouns,
    languages,
    guidelines,
    userName,
    userTimezone,
    userLocation,
    userContext,
    eventSubscriptions,
    heartbeat,
    memoryConsolidation,
    mcpKeyAlias,
  } = req.body as Partial<AgentConfig>;

  // Build updated config — only override fields present in request body
  const updated: AgentConfig = {
    ...existing,
    ...(name !== undefined && { name: name.trim() }),
    ...(description !== undefined && { description: description.trim() }),
    ...(systemPrompt !== undefined && { systemPrompt: systemPrompt?.trim() || undefined }),
    ...(emoji !== undefined && { emoji: emoji || undefined }),
    ...(personality !== undefined && { personality: personality?.trim() || undefined }),
    ...(role !== undefined && { role: role?.trim() || undefined }),
    ...(tone !== undefined && { tone: tone?.trim() || undefined }),
    ...(pronouns !== undefined && { pronouns: pronouns?.trim() || undefined }),
    ...(languages !== undefined && { languages }),
    ...(guidelines !== undefined && { guidelines }),
    ...(userName !== undefined && { userName: userName?.trim() || undefined }),
    ...(userTimezone !== undefined && { userTimezone: userTimezone?.trim() || undefined }),
    ...(userLocation !== undefined && { userLocation: userLocation?.trim() || undefined }),
    ...(userContext !== undefined && { userContext: userContext?.trim() || undefined }),
    ...(eventSubscriptions !== undefined && { eventSubscriptions }),
    ...(heartbeat !== undefined && { heartbeat }),
    ...(memoryConsolidation !== undefined && { memoryConsolidation }),
    ...(mcpKeyAlias !== undefined && { mcpKeyAlias }),
  };

  // Validate required fields
  if (!updated.name || updated.name.length === 0 || updated.name.length > 128) {
    res.status(400).json({ error: "Name must be 1-128 characters" });
    return;
  }

  if (!updated.description || updated.description.length === 0 || updated.description.length > 512) {
    res.status(400).json({ error: "Description must be 1-512 characters" });
    return;
  }

  // Persist (createAgent acts as upsert — mkdirSync with recursive is a no-op)
  createAgent(updated);

  // Sync heartbeat system if heartbeat config changed
  if (heartbeat !== undefined) {
    updateHeartbeatConfig(alias, heartbeat || { enabled: false, intervalMinutes: 30 });
  }

  // Sync memory consolidation system if config changed
  if (memoryConsolidation !== undefined) {
    updateConsolidationConfig(alias, memoryConsolidation || { enabled: false, timeOfDay: "03:00", retentionDays: 14 });
  }

  const workspacePath = ensureAgentWorkspaceDir(alias);
  res.json({ agent: { ...updated, workspacePath } });
});

agentsRouter.delete("/:alias", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  // Stop heartbeat, consolidation, and cancel all cron jobs before deleting
  stopHeartbeat(alias);
  stopConsolidation(alias);
  cancelAllJobsForAgent(alias);

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
