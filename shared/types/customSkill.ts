/**
 * Custom skill created in Callboard settings, stored as a Claude-convention
 * skill directory at ~/.callboard/custom-skills/skills/<name>/SKILL.md inside
 * a synthetic "callboard" plugin so every plugin-aware chat path loads it
 * through its existing plugin-skill machinery.
 */
export interface CustomSkill {
  /** Skill name — kebab-case slug, doubles as the directory name. Invoked as `callboard:<name>`. */
  name: string;
  /** One-line description shown to the model when deciding whether to use the skill. */
  description: string;
  /** Markdown body of SKILL.md (without the frontmatter block). */
  content: string;
  /** ISO timestamp of last modification (from file mtime). */
  updatedAt: string;
}

export interface CustomSkillListItem {
  name: string;
  description: string;
  updatedAt: string;
}
