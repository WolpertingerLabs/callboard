/**
 * Unit tests for skill wiring — exercises the real OR library loaders against an
 * on-disk plugin fixture so the discovery + namespacing + listing path is tested
 * end-to-end (not mocked).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins, type LoadedPlugin } from "@wolpertingerlabs/openrouter-agent-harness";
import { buildSkillSupport } from "./skillAdapter.js";

let tmpRoot: string;
let cwd: string;
let pluginDir: string;
let loaded: LoadedPlugin[];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "or-skill-"));
  // A project cwd with a .git marker so the skill loader's project-scope walk
  // stops here and doesn't climb into the real repo.
  cwd = join(tmpRoot, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });

  // A plugin contributing one skill: skills/greet/SKILL.md.
  pluginDir = join(tmpRoot, "myplugin");
  const skillDir = join(pluginDir, "skills", "greet");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: greet",
      "description: Greet someone by name",
      "---",
      "Say hello to $ARGUMENTS from the greet skill.",
      "",
    ].join("\n"),
  );

  loaded = await loadPlugins({ pluginDirs: [pluginDir] });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildSkillSupport", () => {
  it("loads the plugin and discovers its skill", () => {
    expect(loaded).toHaveLength(1);
    expect(loaded[0].manifest.name).toBe("myplugin");
    expect(loaded[0].skillRoots.length).toBeGreaterThan(0);
  });

  it("appends a `skill` tool and a listing naming the namespaced plugin skill", async () => {
    const support = await buildSkillSupport(loaded, { sessionId: "s1", cwd });
    expect(support).not.toBeNull();
    // Plugin skills are namespaced <pluginName>:<skillName>.
    expect(support!.listing).toContain("myplugin:greet");
    // The appended tool is the OR `skill` tool.
    expect((support!.tool as { function?: { name?: string } }).function?.name).toBe("skill");
  });

  it("renders the skill body via the shared loader (arguments substituted)", async () => {
    const support = await buildSkillSupport(loaded, { sessionId: "s1", cwd });
    const body = await support!.loader.render("myplugin:greet", {
      arguments: ["Ada"],
      sessionId: "s1",
      projectDir: cwd,
      cwd,
    });
    expect(body).toContain("Say hello to Ada from the greet skill.");
  });

  it("namespaces only plugin skills; the listing entry uses <plugin>:<skill>", async () => {
    const support = await buildSkillSupport(loaded, { sessionId: "s1", cwd });
    // The listing is parsed back into visibleNames the tool description echoes;
    // confirm the namespaced name round-trips through buildSkillListing.
    expect(support!.listing).toMatch(/`myplugin:greet`/);
  });
});
