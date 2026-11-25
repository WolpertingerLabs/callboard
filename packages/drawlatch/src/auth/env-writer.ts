import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

import { getConfigDir, getEnvFilePath } from '../shared/config.js';

/** Ensure the daemon's config dir and .env file exist before reading/writing. */
function ensureEnvFile(): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const envFile = getEnvFilePath();
  if (!existsSync(envFile)) {
    writeFileSync(envFile, '', { mode: 0o600 });
  }
}

/**
 * Read the current .env file, update or add the specified key/value pairs,
 * and write back with mode 0o600. Keys in `keysToRemove` are deleted entirely.
 */
export function updateEnvFile(updates: Record<string, string>, keysToRemove: string[] = []): void {
  ensureEnvFile();
  const envFile = getEnvFilePath();

  const content = readFileSync(envFile, 'utf-8');
  const lines = content.split('\n');
  const updatedKeys = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    const shouldRemove = keysToRemove.some((key) => {
      return trimmed.startsWith(`${key}=`) || trimmed === `${key}=`;
    });
    if (shouldRemove) continue;

    let replaced = false;
    for (const [key, value] of Object.entries(updates)) {
      if (trimmed.startsWith(`${key}=`) || trimmed === `${key}=`) {
        result.push(`${key}=${value}`);
        updatedKeys.add(key);
        replaced = true;
        break;
      }
    }
    if (!replaced) result.push(line);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      let insertIdx = result.length;
      while (insertIdx > 0 && result[insertIdx - 1].trim() === '') {
        insertIdx--;
      }
      result.splice(insertIdx, 0, `${key}=${value}`);
    }
  }

  writeFileSync(envFile, result.join('\n'), { mode: 0o600 });
}
