import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "../utils/paths.js";
import type { Trigger } from "shared";

const AGENTS_DIR = join(DATA_DIR, "agents");

function triggersPath(alias: string): string {
  return join(AGENTS_DIR, alias, "triggers.json");
}

function ensureAgentDir(alias: string): void {
  const dir = join(AGENTS_DIR, alias);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readTriggers(alias: string): Trigger[] {
  const path = triggersPath(alias);
  if (!existsSync(path)) return [];
  try {
    const data = readFileSync(path, "utf8");
    return JSON.parse(data) as Trigger[];
  } catch {
    return [];
  }
}

function writeTriggers(alias: string, triggers: Trigger[]): void {
  ensureAgentDir(alias);
  writeFileSync(triggersPath(alias), JSON.stringify(triggers, null, 2));
}

export function listTriggers(alias: string): Trigger[] {
  return readTriggers(alias);
}

export function getTrigger(alias: string, triggerId: string): Trigger | undefined {
  const triggers = readTriggers(alias);
  return triggers.find((t) => t.id === triggerId);
}

export function createTrigger(alias: string, trigger: Omit<Trigger, "id">): Trigger {
  const triggers = readTriggers(alias);
  const newTrigger: Trigger = {
    ...trigger,
    id: randomUUID(),
  };
  triggers.push(newTrigger);
  writeTriggers(alias, triggers);
  return newTrigger;
}

export function updateTrigger(alias: string, triggerId: string, updates: Partial<Trigger>): Trigger | undefined {
  const triggers = readTriggers(alias);
  const index = triggers.findIndex((t) => t.id === triggerId);
  if (index === -1) return undefined;

  // Don't allow changing the id
  const { id: _id, ...safeUpdates } = updates;
  triggers[index] = { ...triggers[index], ...safeUpdates };
  writeTriggers(alias, triggers);
  return triggers[index];
}

export function deleteTrigger(alias: string, triggerId: string): boolean {
  const triggers = readTriggers(alias);
  const index = triggers.findIndex((t) => t.id === triggerId);
  if (index === -1) return false;

  triggers.splice(index, 1);
  writeTriggers(alias, triggers);
  return true;
}
