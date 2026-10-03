/**
 * Read/write the set of active plugin IDs from localStorage.
 *
 * Shared between SlashCommandsModal and Chat.tsx to keep plugin
 * activation state consistent.
 */

import { readStorageItem, writeStorageItem } from "./localStorage";

const STORAGE_KEY = "activePlugins";

/**
 * Load active plugin IDs from localStorage.
 */
export function getActivePlugins(): Set<string> {
  const active = readStorageItem(STORAGE_KEY);
  try {
    return new Set(active ? JSON.parse(active) : []);
  } catch {
    return new Set();
  }
}

/**
 * Persist active plugin IDs to localStorage.
 */
export function setActivePlugins(activeIds: Set<string>): void {
  writeStorageItem(STORAGE_KEY, JSON.stringify(Array.from(activeIds)));
}
