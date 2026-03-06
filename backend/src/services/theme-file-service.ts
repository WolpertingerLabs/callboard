import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { CustomTheme, ThemeListItem } from "shared/types/index.js";

const log = createLogger("theme-file-service");
const THEMES_DIR = join(DATA_DIR, "themes");

function ensureThemesDir(): void {
  if (!existsSync(THEMES_DIR)) {
    mkdirSync(THEMES_DIR, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
}

function themePath(name: string): string {
  return join(THEMES_DIR, `${sanitizeFilename(name)}.json`);
}

class ThemeFileService {
  listThemes(): ThemeListItem[] {
    ensureThemesDir();
    try {
      const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".json"));
      return files
        .map((f) => {
          try {
            const content = readFileSync(join(THEMES_DIR, f), "utf8");
            const theme: CustomTheme = JSON.parse(content);
            return {
              name: theme.name,
              createdAt: theme.createdAt,
              updatedAt: theme.updatedAt,
            };
          } catch {
            return null;
          }
        })
        .filter((t): t is ThemeListItem => t !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      log.error(`Failed to list themes: ${err.message}`);
      return [];
    }
  }

  getTheme(name: string): CustomTheme | null {
    const filepath = themePath(name);
    try {
      if (!existsSync(filepath)) return null;
      const content = readFileSync(filepath, "utf8");
      return JSON.parse(content);
    } catch (err: any) {
      log.error(`Failed to read theme "${name}": ${err.message}`);
      return null;
    }
  }

  createTheme(theme: CustomTheme): void {
    ensureThemesDir();
    const filepath = themePath(theme.name);
    if (existsSync(filepath)) {
      throw new Error(`Theme "${theme.name}" already exists`);
    }
    writeFileSync(filepath, JSON.stringify(theme, null, 2), "utf8");
    log.info(`Created theme "${theme.name}"`);
  }

  updateTheme(name: string, theme: CustomTheme): void {
    ensureThemesDir();
    const filepath = themePath(name);
    if (!existsSync(filepath)) {
      throw new Error(`Theme "${name}" not found`);
    }
    // If name changed, delete old file
    if (name !== theme.name) {
      unlinkSync(filepath);
    }
    const newPath = themePath(theme.name);
    writeFileSync(newPath, JSON.stringify(theme, null, 2), "utf8");
    log.info(`Updated theme "${theme.name}"`);
  }

  deleteTheme(name: string): void {
    const filepath = themePath(name);
    if (!existsSync(filepath)) {
      throw new Error(`Theme "${name}" not found`);
    }
    unlinkSync(filepath);
    log.info(`Deleted theme "${name}"`);
  }
}

export const themeFileService = new ThemeFileService();
