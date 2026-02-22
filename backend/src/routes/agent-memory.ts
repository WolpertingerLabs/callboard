import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { agentExists } from "../services/agent-file-service.js";

export const agentMemoryRouter = Router({ mergeParams: true });

function getAgentWorkspacePath(alias: string): string {
  const baseDir = process.env.CCUI_AGENTS_DIR || join(homedir(), ".ccui-agents");
  return join(baseDir, alias);
}

/** GET /api/agents/:alias/memory — list daily memory files + curated memory */
agentMemoryRouter.get("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const workspacePath = getAgentWorkspacePath(alias);
  const memoryDir = join(workspacePath, "memory");

  // Read curated long-term memory (MEMORY.md)
  const memoryMdPath = join(workspacePath, "MEMORY.md");
  const curatedMemory = existsSync(memoryMdPath) ? readFileSync(memoryMdPath, "utf-8") : "";

  // List daily journal files
  let dailyFiles: string[] = [];
  if (existsSync(memoryDir)) {
    dailyFiles = readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse(); // newest first
  }

  res.json({
    curatedMemory,
    dailyFiles,
  });
});

/** GET /api/agents/:alias/memory/:date — read a specific daily memory file */
agentMemoryRouter.get("/:date", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const date = req.params.date as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Validate date format (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Date must be in YYYY-MM-DD format" });
    return;
  }

  const workspacePath = getAgentWorkspacePath(alias);
  const filePath = join(workspacePath, "memory", `${date}.md`);

  if (!existsSync(filePath)) {
    res.json({ date, content: "" });
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  res.json({ date, content });
});
