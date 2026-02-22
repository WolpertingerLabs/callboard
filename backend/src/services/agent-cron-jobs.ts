import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { CronJob } from "shared";

const log = createLogger("agent-cron-jobs");

const AGENTS_DIR = join(DATA_DIR, "agents");

function cronJobsPath(alias: string): string {
  return join(AGENTS_DIR, alias, "cron-jobs.json");
}

function ensureAgentDir(alias: string): void {
  const dir = join(AGENTS_DIR, alias);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJobs(alias: string): CronJob[] {
  const path = cronJobsPath(alias);
  if (!existsSync(path)) return [];
  try {
    const data = readFileSync(path, "utf8");
    return JSON.parse(data) as CronJob[];
  } catch {
    return [];
  }
}

function writeJobs(alias: string, jobs: CronJob[]): void {
  ensureAgentDir(alias);
  writeFileSync(cronJobsPath(alias), JSON.stringify(jobs, null, 2));
}

export function listCronJobs(alias: string): CronJob[] {
  return readJobs(alias);
}

export function getCronJob(alias: string, jobId: string): CronJob | undefined {
  const jobs = readJobs(alias);
  return jobs.find((j) => j.id === jobId);
}

export function createCronJob(alias: string, job: Omit<CronJob, "id">): CronJob {
  const jobs = readJobs(alias);
  const newJob: CronJob = {
    ...job,
    id: randomUUID(),
  };
  jobs.push(newJob);
  writeJobs(alias, jobs);
  return newJob;
}

export function updateCronJob(alias: string, jobId: string, updates: Partial<CronJob>): CronJob | undefined {
  const jobs = readJobs(alias);
  const index = jobs.findIndex((j) => j.id === jobId);
  if (index === -1) return undefined;

  // Don't allow changing the id
  const { id: _id, ...safeUpdates } = updates;
  jobs[index] = { ...jobs[index], ...safeUpdates };
  writeJobs(alias, jobs);
  return jobs[index];
}

export function deleteCronJob(alias: string, jobId: string): boolean {
  const jobs = readJobs(alias);
  const index = jobs.findIndex((j) => j.id === jobId);
  if (index === -1) return false;

  jobs.splice(index, 1);
  writeJobs(alias, jobs);
  return true;
}

// ── Default Cron Jobs ──────────────────────────────────

const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists in your workspace. Follow any instructions in it. " + "If nothing needs attention, reply HEARTBEAT_OK.";

const CONSOLIDATION_PROMPT = [
  "# Daily Memory Consolidation",
  "",
  "This is your scheduled nightly memory consolidation task.",
  "",
  "## Step 1: Review Recent Journals",
  "",
  "Read all daily journal files in `memory/` from the past 14 days.",
  "Focus on entries you haven't already consolidated into MEMORY.md.",
  "",
  "## Step 2: Update MEMORY.md",
  "",
  "Read MEMORY.md first (to avoid overwriting recent changes).",
  "Then distill significant insights, decisions, lessons learned, and important context from recent journals into MEMORY.md.",
  "",
  "Guidelines:",
  "- Add new entries under appropriate headings (create headings as needed)",
  "- Remove or update outdated information that is no longer relevant",
  "- Keep it curated — MEMORY.md is your long-term memory, not a dump of everything",
  "- Include dates for time-sensitive context",
  "- Preserve the existing structure and tone",
  "",
  "## Step 3: Update Other Files (If Relevant)",
  "",
  "Review recent journals for information that belongs in other workspace files:",
  "- SOUL.md — your personality, self-knowledge, preferences",
  "- USER.md — what you've learned about your human",
  "- TOOLS.md — tool usage patterns, configurations, tips",
  "- Or create a new file if the information doesn't fit existing files.",
  "",
  "Only update these if there is genuinely new, relevant information. Read each file first before updating.",
  "",
  "## Step 4: Log Summary",
  "",
  "After completing all steps, append a brief note to today's journal in `memory/`:",
  "- How many journals you reviewed",
  "- Key insights consolidated (if any)",
  "",
  "Keep the consolidation note to 2-3 lines. If there was nothing significant to consolidate, just note that.",
].join("\n");

const DEFAULT_CRON_JOBS: Array<Omit<CronJob, "id">> = [
  {
    name: "Heartbeat",
    schedule: "*/30 * * * *",
    type: "recurring",
    status: "active",
    description: "Periodic check-in: reads HEARTBEAT.md and acts on any instructions.",
    action: {
      type: "start_session",
      prompt: HEARTBEAT_PROMPT,
    },
    isDefault: true,
  },
  {
    name: "Memory Consolidation",
    schedule: "0 3 * * *",
    type: "recurring",
    status: "active",
    description: "Nightly review of journal entries. Distills insights into MEMORY.md and updates SOUL.md, USER.md, TOOLS.md as needed.",
    action: {
      type: "start_session",
      prompt: CONSOLIDATION_PROMPT,
    },
    isDefault: true,
  },
];

/**
 * Ensure all default cron jobs exist for the given agent.
 * Checks by the `isDefault` flag and name to avoid duplicates.
 * Returns the list of newly created jobs (empty if all already exist).
 */
export function ensureDefaultCronJobs(alias: string): CronJob[] {
  const existingJobs = readJobs(alias);
  const created: CronJob[] = [];

  for (const defaultJob of DEFAULT_CRON_JOBS) {
    const exists = existingJobs.some((j) => j.isDefault === true && j.name === defaultJob.name);

    if (!exists) {
      const newJob = createCronJob(alias, defaultJob);
      log.info(`Created default cron job "${defaultJob.name}" for agent ${alias}`);
      created.push(newJob);
    }
  }

  return created;
}
