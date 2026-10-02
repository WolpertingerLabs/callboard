import { Router } from "express";
import type { Request, Response } from "express";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  type Stats,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import archiver from "archiver";
import AdmZip from "adm-zip";
import multer from "multer";
import { MULTIPART_FIELD_LIMITS, withUploadErrors } from "../utils/multipart-limits.js";
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
import { assertStoredReasoningEffort } from "../services/reasoning-capabilities.js";

const log = createLogger("agent-export-import");

/**
 * Every other writer of a cron/trigger action validates its reasoning effort
 * fail-closed at save time, and the executor relies on that. An archive was
 * exported on some other machine whose catalog may differ, so an imported
 * action gets the stored-value check instead: an effort the local catalog
 * positively rules out is dropped (the action still runs, on the default),
 * one it cannot verify is kept. Mutates the parsed file in place.
 */
export async function dropUnsupportedActionEfforts(alias: string, fileName: string, parsed: unknown): Promise<void> {
  if (!Array.isArray(parsed)) return;
  const cwd = getAgentWorkspacePath(alias);
  for (const entry of parsed) {
    const action = entry && typeof entry === "object" ? (entry as { action?: Record<string, unknown> }).action : undefined;
    if (!action || typeof action !== "object" || action.effort === undefined || action.effort === "") continue;
    try {
      await assertStoredReasoningEffort({ ...action, cwd } as Parameters<typeof assertStoredReasoningEffort>[0]);
    } catch (error) {
      const label = typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name : (entry as { id?: string }).id ?? "?";
      log.warn(`Import: ${fileName} for ${alias}: dropping reasoning effort "${String(action.effort)}" on "${label}": ${(error as Error).message}`);
      delete action.effort;
    }
  }
}

export const agentExportImportRouter = Router();

// ── Multer config for zip upload ──────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
    ...MULTIPART_FIELD_LIMITS,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/zip" || file.mimetype === "application/x-zip-compressed" || file.originalname.endsWith(".zip")) {
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

// ── Hostile-archive guards ───────────────────────────────────────
// Import never calls adm-zip's extractAllTo/extractEntryTo, so the extraction
// advisories (destination symlinks, SUID/SGID bits) don't reach the library —
// but the same classes of bug apply to this route's own reads and writes.

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

/** Why an archive entry is refused before anything is read, or null if it is acceptable. */
export function rejectEntryReason(entry: AdmZip.IZipEntry): string | null {
  // Unix mode lives in the high 16 bits of the external attributes.
  if (((entry.attr >>> 16) & S_IFMT) === S_IFLNK) return "symbolic links are not allowed";
  if (entry.header.flags & 0x1) return "encrypted entries are not supported";
  if (entry.header.method !== ZIP_STORED && entry.header.method !== ZIP_DEFLATED) return "unsupported compression method";
  return null;
}

/**
 * Read one entry's bytes without the adm-zip ≤0.6.0 decompression-bomb bypass
 * (GHSA-rcw4-f5rp-g42v): when the declared uncompressed size is 0, adm-zip
 * inflates with no output cap. A declared-empty entry is therefore treated as
 * empty instead of being inflated. Any other declared size caps both the
 * allocation and the inflate, and the caller has already bounded it by the
 * ratio and total-size checks. Throws on CRC or format errors.
 */
export function readEntryData(entry: AdmZip.IZipEntry): Buffer {
  if (entry.header.size === 0) return Buffer.alloc(0);
  return entry.getData();
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface PlannedWrite {
  target: string;
  data: Buffer;
  existing: boolean;
}

export interface WorkspacePlan {
  root: string;
  rootExists: boolean;
  /** Directories to create, parents before children. */
  dirs: string[];
  writes: PlannedWrite[];
}

/**
 * Validate every workspace write before any of them happens — no filesystem
 * changes. ensureAgentWorkspaceDir adopts whatever directory already exists,
 * and every agent has a shell in a sibling of it under the same workspaces
 * root, so an import can meet a planted `<alias>/memory -> ~/.ssh`. Every path
 * component under the root must be a real directory or absent, and every
 * target a regular file or absent; a symlink anywhere refuses the whole import.
 */
export function planWorkspaceWrites(root: string, files: [relativePath: string, data: Buffer][]): WorkspacePlan {
  const rootStat = lstatOrNull(root);
  if (rootStat?.isSymbolicLink()) throw new Error("workspace directory is a symbolic link");
  if (rootStat && !rootStat.isDirectory()) throw new Error("workspace path exists and is not a directory");

  const dirs = new Set<string>();
  const targets = new Set<string>();
  const writes: PlannedWrite[] = [];
  for (const [relativePath, data] of files) {
    const target = resolve(root, relativePath);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${relativePath}`);
    if (targets.has(target)) throw new Error(`duplicate target: ${relativePath}`);
    targets.add(target);

    let dir = root;
    for (const part of rel.split(sep).slice(0, -1)) {
      dir = join(dir, part);
      const st = lstatOrNull(dir);
      if (!st) dirs.add(dir);
      else if (st.isSymbolicLink()) throw new Error(`path escapes the workspace through a symbolic link: ${relativePath}`);
      else if (!st.isDirectory()) throw new Error(`${relative(root, dir)} exists and is not a directory`);
    }
    const st = lstatOrNull(target);
    if (st?.isSymbolicLink()) throw new Error(`${relativePath} is a symbolic link`);
    if (st && !st.isFile()) throw new Error(`${relativePath} exists and is not a regular file`);
    writes.push({ target, data, existing: st !== null });
  }
  return { root, rootExists: rootStat !== null, dirs: [...dirs], writes };
}

/** O_NOFOLLOW: a symlink at the final component fails with ELOOP instead of being written through. */
function writeNoFollow(target: string, data: Buffer, flag: number): void {
  const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | flag, 0o644);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Carry out a validated plan, all or nothing: an existing file is backed up
 * before it is truncated, and on any failure every backup is restored and
 * every file and directory this call created is removed. New files are
 * created O_EXCL with mode 0o644; archive permission bits are never applied.
 *
 * Accepted TOCTOU: between planWorkspaceWrites' lstat walk (and the realpath
 * check below) and openSync, a parent directory could be swapped for a
 * symlink — O_NOFOLLOW covers only the last component, and Node has no
 * openat() to pin the parent. Racing it needs a same-user shell, which can
 * already write anywhere the daemon can; the window is microseconds; and the
 * only reachable names are `*.md` at most two levels deep.
 */
export function applyWorkspacePlan(plan: WorkspacePlan): void {
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const backups: [string, Buffer][] = [];
  try {
    if (!plan.rootExists) {
      mkdirSync(dirname(plan.root), { recursive: true });
      mkdirSync(plan.root);
      createdDirs.push(plan.root);
    }
    for (const dir of plan.dirs) {
      mkdirSync(dir); // not recursive: EEXIST if something appeared since the plan
      createdDirs.push(dir);
    }
    const realRoot = realpathSync(plan.root);
    for (const { target, data, existing } of plan.writes) {
      const realParent = realpathSync(dirname(target));
      if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
        throw new Error(`path escapes the workspace through a symbolic link: ${relative(plan.root, target)}`);
      }
      if (existing) {
        backups.push([target, readFileSync(target)]);
        writeNoFollow(target, data, fsConstants.O_TRUNC);
      } else {
        writeNoFollow(target, data, fsConstants.O_CREAT | fsConstants.O_EXCL);
        createdFiles.push(target);
      }
    }
  } catch (error) {
    for (const [target, original] of backups.reverse()) {
      try {
        writeNoFollow(target, original, fsConstants.O_TRUNC);
      } catch (restoreError) {
        log.error(`Import rollback: could not restore ${target}: ${(restoreError as Error).message}`);
      }
    }
    for (const target of createdFiles) rmSync(target, { force: true });
    for (const dir of createdDirs.reverse()) {
      try {
        rmdirSync(dir);
      } catch (rmError) {
        log.error(`Import rollback: could not remove ${dir}: ${(rmError as Error).message}`);
      }
    }
    throw error;
  }
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
agentExportImportRouter.post("/import", withUploadErrors(upload.single("file"), { tooLarge: "Zip too large; the limit is 50MB" }), async (req: Request, res: Response): Promise<void> => {
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

  // ── Zip bomb protection ────────────────────────────────────────
  const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024; // 100MB
  const MAX_COMPRESSION_RATIO = 100; // 100:1
  const MAX_ENTRY_COUNT = 1000;

  const fileEntries = entries.filter((e: AdmZip.IZipEntry) => !e.isDirectory);

  if (fileEntries.length > MAX_ENTRY_COUNT) {
    res.status(400).json({ error: `Zip contains too many entries (${fileEntries.length}, max ${MAX_ENTRY_COUNT})` });
    return;
  }

  let totalDecompressedSize = 0;
  for (const entry of fileEntries) {
    const uncompressedSize = entry.header.size;
    const compressedSize = entry.header.compressedSize;
    totalDecompressedSize += uncompressedSize;

    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      log.warn(`Import rejected — suspicious compression ratio for ${entry.entryName}: ${uncompressedSize}/${compressedSize}`);
      res.status(400).json({ error: "Zip file rejected: suspicious compression ratio detected" });
      return;
    }
  }

  if (totalDecompressedSize > MAX_DECOMPRESSED_SIZE) {
    log.warn(`Import rejected — total decompressed size ${totalDecompressedSize} exceeds limit ${MAX_DECOMPRESSED_SIZE}`);
    res.status(400).json({ error: `Zip decompressed size exceeds the ${MAX_DECOMPRESSED_SIZE / (1024 * 1024)}MB limit` });
    return;
  }

  const entryNames = fileEntries.map((e: AdmZip.IZipEntry) => e.entryName);

  // getEntry() resolves a duplicate name to a different entry than iteration
  // does (GHSA-p634-w6r4-rjp2), so one archive could carry two agent.json.
  const duplicate = entryNames.find((name, i) => entryNames.indexOf(name) !== i);
  if (duplicate) {
    res.status(400).json({ error: `Zip contains duplicate entry: ${duplicate}` });
    return;
  }

  for (const entry of entries) {
    const reason = rejectEntryReason(entry);
    if (reason) {
      log.warn(`Import rejected — ${entry.entryName}: ${reason}`);
      res.status(400).json({ error: `Zip entry ${entry.entryName} rejected: ${reason}` });
      return;
    }
  }

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

  // 3. Read every entry before anything is written, so a corrupt archive
  // can't leave a half-imported agent behind.
  const contents = new Map<string, Buffer>();
  for (const entry of fileEntries) {
    try {
      contents.set(entry.entryName, readEntryData(entry));
    } catch (error) {
      log.warn(`Import rejected — could not read ${entry.entryName}: ${(error as Error).message}`);
      res.status(400).json({ error: `Could not read ${entry.entryName} from zip` });
      return;
    }
  }

  // 4. Parse and validate agent.json
  let agentConfig: AgentConfig;
  try {
    agentConfig = JSON.parse(contents.get("agent.json")!.toString("utf8")) as AgentConfig;
  } catch {
    res.status(400).json({ error: "agent.json is not valid JSON" });
    return;
  }

  if (!agentConfig.name || !agentConfig.alias || !agentConfig.description) {
    res.status(400).json({ error: "agent.json must contain name, alias, and description fields" });
    return;
  }

  // 5. Validate alias format
  if (!isValidAlias(agentConfig.alias)) {
    res.status(400).json({
      error: "Alias must be 2-64 characters: lowercase letters, numbers, hyphens, underscores. Must start with a letter or number.",
    });
    return;
  }

  // 6. Check if agent already exists
  if (agentExists(agentConfig.alias)) {
    res.status(409).json({ error: `An agent with alias "${agentConfig.alias}" already exists` });
    return;
  }

  const alias = agentConfig.alias;

  // ── Write workspace files ─────────────────────────────────
  // Before createAgent, and all or nothing: every target is validated before
  // the first write, and a write that still fails is rolled back.
  const workspaceFiles = [...contents]
    .filter(([name]) => name.startsWith("workspace/"))
    .map(([name, data]): [string, Buffer] => [name.slice("workspace/".length), data]);

  let plan: WorkspacePlan;
  try {
    plan = planWorkspaceWrites(getAgentWorkspacePath(alias), workspaceFiles);
  } catch (error) {
    log.warn(`Import rejected — ${alias}: ${(error as Error).message}`);
    res.status(400).json({ error: `Import refused: ${(error as Error).message}` });
    return;
  }
  try {
    applyWorkspacePlan(plan);
  } catch (error) {
    log.error(`Import failed — ${alias}: ${(error as Error).message}; workspace rolled back`);
    res.status(500).json({ error: `Could not write workspace files (${(error as Error).message}); nothing was changed` });
    return;
  }
  const workspacePath = ensureAgentWorkspaceDir(alias);

  // ── Write agent data ──────────────────────────────────────
  // Set createdAt to now
  agentConfig.createdAt = Date.now();
  createAgent(agentConfig);

  const dataDir = getAgentDataDir(alias);

  // Write cron-jobs.json if present
  const cronBytes = contents.get("cron-jobs.json");
  if (cronBytes) {
    try {
      const cronData = JSON.parse(cronBytes.toString("utf8"));
      await dropUnsupportedActionEfforts(alias, "cron-jobs.json", cronData);
      writeFileSync(join(dataDir, "cron-jobs.json"), JSON.stringify(cronData, null, 2));
    } catch {
      log.warn(`Import: invalid cron-jobs.json for ${alias}, skipping`);
    }
  }

  // Write triggers.json if present
  const triggersBytes = contents.get("triggers.json");
  if (triggersBytes) {
    try {
      const triggersData = JSON.parse(triggersBytes.toString("utf8"));
      await dropUnsupportedActionEfforts(alias, "triggers.json", triggersData);
      writeFileSync(join(dataDir, "triggers.json"), JSON.stringify(triggersData, null, 2));
    } catch {
      log.warn(`Import: invalid triggers.json for ${alias}, skipping`);
    }
  }

  // Ensure default cron jobs exist (heartbeat, consolidation)
  ensureDefaultCronJobs(alias);

  // Schedule active cron jobs (both imported and defaults)
  const allJobs = listCronJobs(alias);
  for (const job of allJobs) {
    if (job.status === "active") {
      scheduleJob(alias, job);
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
