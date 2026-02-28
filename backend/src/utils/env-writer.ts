import { readFileSync, writeFileSync } from "fs";
import { ENV_FILE, ensureDataDir, ensureEnvFile } from "./paths.js";

/**
 * Read the current .env file contents, update or add the specified
 * key-value pairs, and write the file back with mode 0o600.
 *
 * If a key already exists in the file, its line is replaced in-place.
 * If the key does not exist, a new line is appended before any
 * trailing blank lines.
 *
 * Keys listed in `keysToRemove` will have their lines deleted entirely
 * (used to remove the plaintext AUTH_PASSWORD after migration).
 */
export function updateEnvFile(updates: Record<string, string>, keysToRemove: string[] = []): void {
  ensureDataDir();
  ensureEnvFile();

  const content = readFileSync(ENV_FILE, "utf-8");
  const lines = content.split("\n");
  const updatedKeys = new Set<string>();

  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this line should be removed
    const shouldRemove = keysToRemove.some((key) => {
      return trimmed.startsWith(`${key}=`) || trimmed === `${key}=`;
    });
    if (shouldRemove) continue;

    // Check if this line should be updated
    let replaced = false;
    for (const [key, value] of Object.entries(updates)) {
      if (trimmed.startsWith(`${key}=`) || trimmed === `${key}=`) {
        result.push(`${key}=${value}`);
        updatedKeys.add(key);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      result.push(line);
    }
  }

  // Append any keys that were not found as existing lines
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      // Insert before trailing empty lines
      let insertIdx = result.length;
      while (insertIdx > 0 && result[insertIdx - 1].trim() === "") {
        insertIdx--;
      }
      result.splice(insertIdx, 0, `${key}=${value}`);
    }
  }

  writeFileSync(ENV_FILE, result.join("\n"), { mode: 0o600 });
}
