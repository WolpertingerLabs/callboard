import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { agentExists } from "../services/agent-file-service.js";

export const agentWorkspaceRouter = Router({ mergeParams: true });

/** Workspace files that are editable via the dashboard */
const ALLOWED_FILES = new Set(["SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md", "CLAUDE.md"]);

function getAgentWorkspacePath(alias: string): string {
  const baseDir = process.env.CCUI_AGENTS_DIR || join(homedir(), ".ccui-agents");
  return join(baseDir, alias);
}

/** GET /api/agents/:alias/workspace — list workspace files */
agentWorkspaceRouter.get("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const workspacePath = getAgentWorkspacePath(alias);
  if (!existsSync(workspacePath)) {
    res.json({ files: [] });
    return;
  }

  const entries = readdirSync(workspacePath, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && ALLOWED_FILES.has(e.name)).map((e) => e.name);

  res.json({ files });
});

/** GET /api/agents/:alias/workspace/:filename — read a workspace file */
agentWorkspaceRouter.get("/:filename", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const filename = req.params.filename as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  if (!ALLOWED_FILES.has(filename)) {
    res.status(400).json({ error: `File "${filename}" is not a recognized workspace file` });
    return;
  }

  const workspacePath = getAgentWorkspacePath(alias);
  const filePath = join(workspacePath, filename);

  if (!existsSync(filePath)) {
    res.json({ filename, content: "" });
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  res.json({ filename, content });
});

/** PUT /api/agents/:alias/workspace/:filename — write a workspace file */
agentWorkspaceRouter.put("/:filename", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const filename = req.params.filename as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  if (!ALLOWED_FILES.has(filename)) {
    res.status(400).json({ error: `File "${filename}" is not a recognized workspace file` });
    return;
  }

  const { content } = req.body as { content?: string };
  if (typeof content !== "string") {
    res.status(400).json({ error: "Content must be a string" });
    return;
  }

  const workspacePath = getAgentWorkspacePath(alias);
  const filePath = join(workspacePath, filename);
  writeFileSync(filePath, content);

  res.json({ filename, ok: true });
});
