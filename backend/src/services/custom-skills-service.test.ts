/**
 * Unit tests for the custom-skills service — CRUD over the synthetic
 * "callboard" plugin directory, frontmatter round-trip, and (end-to-end, not
 * mocked) discoverability of the resulting directory through the OR harness's
 * plugin loader, which is exactly how the OpenRouter chat path consumes it.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is resolved from this env var when utils/paths.js first loads, so
// it must be set before the service module is imported (hence dynamic import).
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-skills-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { customSkillsService, slugifySkillName, CUSTOM_SKILLS_PLUGIN_NAME } = await import("./custom-skills-service.js");

const PLUGIN_DIR = join(tmpRoot, "custom-skills");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(PLUGIN_DIR, { recursive: true, force: true });
});

describe("slugifySkillName", () => {
  it("kebab-cases display names", () => {
    expect(slugifySkillName("Release Notes Writer")).toBe("release-notes-writer");
    expect(slugifySkillName("  PDF -> Text!  ")).toBe("pdf-text");
    expect(slugifySkillName("already-kebab")).toBe("already-kebab");
  });

  it("rejects names with no usable characters", () => {
    expect(() => slugifySkillName("!!!")).toThrow(/no usable characters/);
    expect(() => slugifySkillName("")).toThrow(/no usable characters/);
  });
});

describe("CRUD", () => {
  it("creates a skill with plugin manifest and standard SKILL.md layout", () => {
    const skill = customSkillsService.createSkill({
      name: "Release Notes",
      description: "Draft release notes from recent commits",
      content: "# Release notes\n\nLook at git log and summarize.",
    });
    expect(skill.name).toBe("release-notes");
    expect(skill.description).toBe("Draft release notes from recent commits");

    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe(CUSTOM_SKILLS_PLUGIN_NAME);

    const raw = readFileSync(join(PLUGIN_DIR, "skills", "release-notes", "SKILL.md"), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain('description: "Draft release notes from recent commits"');
  });

  it("round-trips description and content through the frontmatter", () => {
    const description = 'Tricky: contains "quotes", colons: yes, and --- dashes';
    const content = "Body with\n\n---\n\nhorizontal rule and `code`.";
    customSkillsService.createSkill({ name: "tricky", description, content });

    const skill = customSkillsService.getSkill("tricky");
    expect(skill).not.toBeNull();
    expect(skill!.description).toBe(description);
    expect(skill!.content).toBe(content);
  });

  it("rejects duplicate names", () => {
    customSkillsService.createSkill({ name: "dup", description: "d", content: "c" });
    expect(() => customSkillsService.createSkill({ name: "dup", description: "d", content: "c" })).toThrow(/already exists/);
  });

  it("updates fields partially and supports renames", () => {
    customSkillsService.createSkill({ name: "old-name", description: "before", content: "body" });

    const updated = customSkillsService.updateSkill("old-name", { description: "after" });
    expect(updated.description).toBe("after");
    expect(updated.content).toBe("body");

    const renamed = customSkillsService.updateSkill("old-name", { name: "new-name" });
    expect(renamed.name).toBe("new-name");
    expect(customSkillsService.getSkill("old-name")).toBeNull();
    expect(customSkillsService.getSkill("new-name")!.content).toBe("body");
  });

  it("deletes skills and reports missing ones", () => {
    customSkillsService.createSkill({ name: "gone", description: "d", content: "c" });
    customSkillsService.deleteSkill("gone");
    expect(existsSync(join(PLUGIN_DIR, "skills", "gone"))).toBe(false);
    expect(() => customSkillsService.deleteSkill("gone")).toThrow(/not found/);
  });

  it("lists skills sorted by name", () => {
    customSkillsService.createSkill({ name: "bbb", description: "2", content: "c" });
    customSkillsService.createSkill({ name: "aaa", description: "1", content: "c" });
    expect(customSkillsService.listSkills().map((s) => s.name)).toEqual(["aaa", "bbb"]);
  });
});

describe("session integration surface", () => {
  it("returns no plugin dir when empty, the plugin dir once a skill exists", () => {
    expect(customSkillsService.getPluginDir()).toBeNull();
    customSkillsService.createSkill({ name: "one", description: "d", content: "c" });
    expect(customSkillsService.getPluginDir()).toBe(PLUGIN_DIR);
  });

  it("exposes callboard:<name> slash commands", () => {
    customSkillsService.createSkill({ name: "my-skill", description: "d", content: "c" });
    expect(customSkillsService.listSlashCommands()).toEqual(["callboard:my-skill"]);
  });

  it("is discoverable by the OR harness plugin loader exactly as chats consume it", async () => {
    customSkillsService.createSkill({
      name: "greet",
      description: "Greet someone by name",
      content: "Say hello to $ARGUMENTS.",
    });
    const { loadPlugins } = await import("@wolpertingerlabs/openrouter-agent-harness");
    const loaded = await loadPlugins({ pluginDirs: [customSkillsService.getPluginDir()!] });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].manifest.name).toBe(CUSTOM_SKILLS_PLUGIN_NAME);
    expect(loaded[0].skillRoots.length).toBeGreaterThan(0);
  });
});
