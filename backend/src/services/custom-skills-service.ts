/**
 * Custom skills — user-created skills managed in Callboard settings.
 *
 * Storage is a single Claude-convention plugin directory:
 *
 *   ~/.callboard/custom-skills/
 *   ├── .claude-plugin/plugin.json        ← synthetic "callboard" plugin manifest
 *   └── skills/<name>/SKILL.md            ← standard skill frontmatter + body
 *
 * Both chat paths consume this with their existing plugin-skill machinery:
 * claude.ts#buildPluginOptions appends the directory as a `{ type:"local" }`
 * plugin descriptor, which the Claude SDK loads natively and the OpenRouter
 * adapter picks up via extractPluginDirs → loadPlugins. Skills are therefore
 * invoked as `callboard:<name>` on both providers, and the namespace
 * guarantees we never shadow framework, user, or project skills.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { CustomSkill, CustomSkillListItem } from "shared/types/index.js";

const log = createLogger("custom-skills");

const PLUGIN_DIR = join(DATA_DIR, "custom-skills");
const SKILLS_DIR = join(PLUGIN_DIR, "skills");
const MANIFEST_DIR = join(PLUGIN_DIR, ".claude-plugin");
const MANIFEST_FILE = join(MANIFEST_DIR, "plugin.json");

/** Plugin name — skills surface as `callboard:<name>` in both chat paths. */
export const CUSTOM_SKILLS_PLUGIN_NAME = "callboard";

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const CONTENT_MAX = 64 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Kebab-case a display name into a skill/directory name. Throws if nothing usable remains. */
export function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/g, "");
  if (!slug || !NAME_RE.test(slug)) {
    throw new Error(`Skill name "${name}" contains no usable characters (a-z, 0-9)`);
  }
  return slug;
}

function validateDescription(description: string): string {
  const desc = description.replace(/\s+/g, " ").trim();
  if (!desc) throw new Error("Skill description is required");
  if (desc.length > DESCRIPTION_MAX) {
    throw new Error(`Skill description must be ${DESCRIPTION_MAX} characters or fewer`);
  }
  return desc;
}

function validateContent(content: string): string {
  const body = content.trim();
  if (!body) throw new Error("Skill content is required");
  if (body.length > CONTENT_MAX) {
    throw new Error(`Skill content must be ${CONTENT_MAX} characters or fewer`);
  }
  return body;
}

function skillDir(name: string): string {
  return join(SKILLS_DIR, name);
}

function skillFile(name: string): string {
  return join(skillDir(name), "SKILL.md");
}

/**
 * Write the plugin manifest (and parent dirs) if missing or unreadable, so
 * the directory is always a loadable Claude plugin once a skill exists.
 */
function ensurePluginManifest(): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
  mkdirSync(MANIFEST_DIR, { recursive: true });
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
    if (manifest && manifest.name === CUSTOM_SKILLS_PLUGIN_NAME) return;
  } catch {
    // missing or corrupt — rewrite below
  }
  writeFileSync(
    MANIFEST_FILE,
    JSON.stringify(
      {
        name: CUSTOM_SKILLS_PLUGIN_NAME,
        version: "1.0.0",
        description: "Custom skills created in Callboard settings",
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Serialize frontmatter + body into SKILL.md. Name and description are
 * emitted as JSON strings — valid YAML double-quoted scalars — so arbitrary
 * description text can't break the frontmatter block.
 */
function serializeSkill(name: string, description: string, content: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n`;
}

/** Parse SKILL.md into { description, content }. Tolerates missing frontmatter. */
function parseSkillFile(raw: string): { description: string; content: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { description: "", content: raw.trim() };
  let description = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!kv || kv[1] !== "description") continue;
    const value = kv[2].trim();
    if (value.startsWith('"')) {
      try {
        description = JSON.parse(value);
      } catch {
        description = value.replace(/^"|"$/g, "");
      }
    } else {
      description = value;
    }
  }
  return { description, content: raw.slice(m[0].length).trim() };
}

class CustomSkillsService {
  listSkills(): CustomSkillListItem[] {
    if (!existsSync(SKILLS_DIR)) return [];
    try {
      return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(skillFile(entry.name)))
        .map((entry) => {
          try {
            const file = skillFile(entry.name);
            const { description } = parseSkillFile(readFileSync(file, "utf8"));
            return {
              name: entry.name,
              description,
              updatedAt: statSync(file).mtime.toISOString(),
            };
          } catch {
            return null;
          }
        })
        .filter((s): s is CustomSkillListItem => s !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      log.error(`Failed to list custom skills: ${err.message}`);
      return [];
    }
  }

  getSkill(name: string): CustomSkill | null {
    if (!NAME_RE.test(name)) return null;
    const file = skillFile(name);
    try {
      if (!existsSync(file)) return null;
      const { description, content } = parseSkillFile(readFileSync(file, "utf8"));
      return { name, description, content, updatedAt: statSync(file).mtime.toISOString() };
    } catch (err: any) {
      log.error(`Failed to read custom skill "${name}": ${err.message}`);
      return null;
    }
  }

  createSkill(input: { name: string; description: string; content: string }): CustomSkill {
    const name = slugifySkillName(input.name);
    const description = validateDescription(input.description);
    const content = validateContent(input.content);
    if (existsSync(skillFile(name))) {
      throw new Error(`Skill "${name}" already exists`);
    }
    ensurePluginManifest();
    mkdirSync(skillDir(name), { recursive: true });
    writeFileSync(skillFile(name), serializeSkill(name, description, content), "utf8");
    log.info(`Created custom skill "${name}"`);
    return this.getSkill(name)!;
  }

  updateSkill(name: string, updates: { name?: string; description?: string; content?: string }): CustomSkill {
    const existing = this.getSkill(name);
    if (!existing) throw new Error(`Skill "${name}" not found`);

    const newName = updates.name !== undefined ? slugifySkillName(updates.name) : name;
    const description = validateDescription(updates.description ?? existing.description);
    const content = validateContent(updates.content ?? existing.content);

    if (newName !== name) {
      if (existsSync(skillDir(newName))) {
        throw new Error(`Skill "${newName}" already exists`);
      }
      renameSync(skillDir(name), skillDir(newName));
    }
    ensurePluginManifest();
    writeFileSync(skillFile(newName), serializeSkill(newName, description, content), "utf8");
    log.info(`Updated custom skill "${newName}"${newName !== name ? ` (renamed from "${name}")` : ""}`);
    return this.getSkill(newName)!;
  }

  deleteSkill(name: string): void {
    if (!NAME_RE.test(name) || !existsSync(skillDir(name))) {
      throw new Error(`Skill "${name}" not found`);
    }
    rmSync(skillDir(name), { recursive: true, force: true });
    log.info(`Deleted custom skill "${name}"`);
  }

  /**
   * Plugin directory to inject into chat sessions, or null when no skills
   * exist (so empty installs add nothing to the plugin surface).
   */
  getPluginDir(): string | null {
    if (this.listSkills().length === 0) return null;
    try {
      ensurePluginManifest();
    } catch (err: any) {
      log.error(`Failed to ensure custom-skills plugin manifest: ${err.message}`);
      return null;
    }
    return PLUGIN_DIR;
  }

  /** `callboard:<name>` invocation strings for slash-command listings. */
  listSlashCommands(): string[] {
    return this.listSkills().map((s) => `${CUSTOM_SKILLS_PLUGIN_NAME}:${s.name}`);
  }
}

export const customSkillsService = new CustomSkillsService();
