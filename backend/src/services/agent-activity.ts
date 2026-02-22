import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "../utils/paths.js";
import type { ActivityEntry } from "shared";

const AGENTS_DIR = join(DATA_DIR, "agents");

function activityPath(alias: string): string {
  return join(AGENTS_DIR, alias, "activity.jsonl");
}

function ensureAgentDir(alias: string): void {
  const dir = join(AGENTS_DIR, alias);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function appendActivity(
  alias: string,
  entry: Omit<ActivityEntry, "id" | "timestamp">,
): ActivityEntry {
  ensureAgentDir(alias);
  const full: ActivityEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: Date.now(),
  };
  appendFileSync(activityPath(alias), JSON.stringify(full) + "\n");
  return full;
}

export interface GetActivityOptions {
  type?: ActivityEntry["type"];
  limit?: number;
  offset?: number;
}

export function getActivity(alias: string, opts: GetActivityOptions = {}): ActivityEntry[] {
  const path = activityPath(alias);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];

  const lines = raw.split("\n");
  let entries: ActivityEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ActivityEntry);
    } catch {
      // Skip malformed lines
    }
  }

  // Filter by type if specified
  if (opts.type) {
    entries = entries.filter((e) => e.type === opts.type);
  }

  // Sort newest first
  entries.sort((a, b) => b.timestamp - a.timestamp);

  // Apply pagination
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return entries.slice(offset, offset + limit);
}
