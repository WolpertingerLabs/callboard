import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import archiver from "archiver";
import AdmZip from "adm-zip";
import multer from "multer";
import type { AgentConfig } from "shared";
import {
  getAgent,
  agentExists,
  isValidAlias,
  getAgentWorkspacePath,
  ensureAgentWorkspaceDir,
  getAgentDataDir,
  createAgent,
} from "../services/agent-file-service.js";
import { ensureDefaultCronJobs, listCronJobs } from "../services/agent-cron-jobs.js";
import { scheduleJob } from "../services/cron-scheduler.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-export-import");

export const agentExportImportRouter = Router();

// ── Multer config for zip upload ──────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed" ||
      file.originalname.endsWith(".zip")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only .zip files are accepted"));
    }
  },
});

// ── Whitelist for import validation ──────────────────────────────
const ALLOWED_ROOT_FILES = new Set(["agent.json", "cron-jobs.json", "triggers.json"]);

function isAllowedEntry(entryName: string): boolean {
  // Root-level config files
  if (ALLOWED_ROOT_FILES.has(entryName)) return true;

  // workspace/*.md files
  if (entryName.startsWith("workspace/") && entryName.endsWith(".md")) {
    const parts = entryName.split("/");
    // workspace/FILE.md (2 parts) or workspace/memory/FILE.md (3 parts)
    if (parts.length === 2) return true;
    if (parts.length === 3 && parts[1] === "memory") return true;
  }

  return false;
}

// ── Export: GET /api/agents/:alias/export ──────────────────────────
agentExportImportRouter.get("/:alias/export", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const agent = getAgent(alias);

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const dataDir = getAgentDataDir(alias);
  const workspacePath = getAgentWorkspacePath(alias);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${alias}-export.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });

  archive.on("error", (err: Error) => {
    log.error(`Export archive error for ${alias}: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create export archive" });
    }
  });

  archive.pipe(res);

  // Always include agent.json
  const agentJsonPath = join(dataDir, "agent.json");
  if (existsSync(agentJsonPath)) {
    archive.file(agentJsonPath, { name: "agent.json" });
  }

  // Include cron-jobs.json if it exists and has content
  const cronJobsPath = join(dataDir, "cron-jobs.json");
  if (existsSync(cronJobsPath)) {
    try {
      const cronJobs = JSON.parse(readFileSync(cronJobsPath, "utf8"));
      if (Array.isArray(cronJobs) && cronJobs.length > 0) {
        archive.file(cronJobsPath, { name: "cron-jobs.json" });
      }
    } catch {
      // Skip if invalid JSON
    }
  }

  // Include triggers.json if it exists and has content
  const triggersPath = join(dataDir, "triggers.json");
  if (existsSync(triggersPath)) {
    try {
      const triggers = JSON.parse(readFileSync(triggersPath, "utf8"));
      if (Array.isArray(triggers) && triggers.length > 0) {
        archive.file(triggersPath, { name: "triggers.json" });
      }
    } catch {
      // Skip if invalid JSON
    }
  }

  // Include workspace .md files
  if (existsSync(workspacePath)) {
    const entries = readdirSync(workspacePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        archive.file(join(workspacePath, entry.name), { name: `workspace/${entry.name}` });
      }
    }

    // Include workspace/memory/*.md files
    const memoryDir = join(workspacePath, "memory");
    if (existsSync(memoryDir)) {
      const memoryEntries = readdirSync(memoryDir, { withFileTypes: true });
      for (const entry of memoryEntries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          archive.file(join(memoryDir, entry.name), { name: `workspace/memory/${entry.name}` });
        }
      }
    }
  }

  archive.finalize();
});

// ── Import: POST /api/agents/import ──────────────────────────────
agentExportImportRouter.post("/import", upload.single("file"), (req: Request, res: Response): void => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded. Please upload a .zip file." });
    return;
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(req.file.buffer);
  } catch {
    res.status(400).json({ error: "Invalid zip file" });
    return;
  }

  const entries = zip.getEntries();
  const entryNames = entries
    .filter((e: AdmZip.IZipEntry) => !e.isDirectory)
    .map((e: AdmZip.IZipEntry) => e.entryName);

  // 1. Must contain agent.json at root
  if (!entryNames.includes("agent.json")) {
    res.status(400).json({ error: "Zip must contain agent.json at the root level" });
    return;
  }

  // 2. Check all entries are in the whitelist
  const disallowed = entryNames.filter((name: string) => !isAllowedEntry(name));
  if (disallowed.length > 0) {
    log.warn(`Import rejected — unexpected files in zip: ${disallowed.join(", ")}`);
    res.status(400).json({
      error: `Zip contains files outside the allowed whitelist: ${disallowed.join(", ")}`,
    });
    return;
  }

  // 3. Parse and validate agent.json
  const agentEntry = zip.getEntry("agent.json");
  if (!agentEntry) {
    res.status(400).json({ error: "Could not read agent.json from zip" });
    return;
  }

  let agentConfig: AgentConfig;
  try {
    agentConfig = JSON.parse(agentEntry.getData().toString("utf8")) as AgentConfig;
  } catch {
    res.status(400).json({ error: "agent.json is not valid JSON" });
    return;
  }

  if (!agentConfig.name || !agentConfig.alias || !agentConfig.description) {
    res.status(400).json({ error: "agent.json must contain name, alias, and description fields" });
    return;
  }

  // 4. Validate alias format
  if (!isValidAlias(agentConfig.alias)) {
    res.status(400).json({
      error: "Alias must be 2-64 characters: lowercase letters, numbers, hyphens, underscores. Must start with a letter or number.",
    });
    return;
  }

  // 5. Check if agent already exists
  if (agentExists(agentConfig.alias)) {
    res.status(409).json({ error: `An agent with alias "${agentConfig.alias}" already exists` });
    return;
  }

  const alias = agentConfig.alias;

  // ── Write agent data ──────────────────────────────────────
  // Set createdAt to now
  agentConfig.createdAt = Date.now();
  createAgent(agentConfig);

  const dataDir = getAgentDataDir(alias);

  // Write cron-jobs.json if present
  const cronEntry = zip.getEntry("cron-jobs.json");
  if (cronEntry) {
    try {
      const cronData = JSON.parse(cronEntry.getData().toString("utf8"));
      writeFileSync(join(dataDir, "cron-jobs.json"), JSON.stringify(cronData, null, 2));
    } catch {
      log.warn(`Import: invalid cron-jobs.json for ${alias}, skipping`);
    }
  }

  // Write triggers.json if present
  const triggersEntry = zip.getEntry("triggers.json");
  if (triggersEntry) {
    try {
      const triggersData = JSON.parse(triggersEntry.getData().toString("utf8"));
      writeFileSync(join(dataDir, "triggers.json"), JSON.stringify(triggersData, null, 2));
    } catch {
      log.warn(`Import: invalid triggers.json for ${alias}, skipping`);
    }
  }

  // Ensure default cron jobs exist (heartbeat, consolidation)
  const defaultJobs = ensureDefaultCronJobs(alias);

  // Schedule active cron jobs (both imported and defaults)
  const allJobs = listCronJobs(alias);
  for (const job of allJobs) {
    if (job.status === "active") {
      scheduleJob(alias, job);
    }
  }

  // ── Write workspace files ─────────────────────────────────
  const workspacePath = ensureAgentWorkspaceDir(alias);

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    if (entry.entryName.startsWith("workspace/")) {
      // Strip "workspace/" prefix to get the relative path within the workspace
      const relativePath = entry.entryName.slice("workspace/".length);

      if (!relativePath.endsWith(".md")) continue;

      const targetPath = join(workspacePath, relativePath);

      // Ensure parent directory exists (for memory/ subdir)
      const targetDir = join(targetPath, "..");
      mkdirSync(targetDir, { recursive: true });

      writeFileSync(targetPath, entry.getData());
    }
  }

  log.info(`Imported agent "${alias}" successfully`);

  res.status(201).json({
    agent: {
      ...agentConfig,
      workspacePath,
    },
  });
});
