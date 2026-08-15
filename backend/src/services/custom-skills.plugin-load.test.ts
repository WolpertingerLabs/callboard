/**
 * The Claude side of custom skills: that the synthetic "callboard" plugin
 * directory is a thing a **real plugin loader** will accept, and that
 * `buildPluginOptions` actually hands it to one.
 *
 * ## Why this file exists
 *
 * The equivalent assertion used to ride on the OpenRouter harness's
 * `loadPlugins`, which the OR removal deleted along with the harness. What that
 * test was really worth was the word *real*: `custom-skills-service.test.ts`
 * checks that we write the files we meant to write, which is a tautology — it
 * would pass just as happily if the layout Claude requires had changed
 * underneath us. Nothing about the manifest key names, the `skills/<name>/`
 * nesting, or the frontmatter is Callboard's to decide; a loader we do not own
 * decides all of it. So the load has to be performed by that loader.
 *
 * ## What each block does and does not prove
 *
 * 1. **Directory contract** — structural assertions, no loader. Cheap, and the
 *    one that names the specific shape so a break reads as "the manifest lost
 *    its name field" rather than "the SDK didn't list our skill". It proves
 *    nothing on its own: it is our belief about the format, restated.
 *
 * 2. **`buildPluginOptions` includes the descriptor** — the wiring. Proves the
 *    directory reaches `options.plugins`; proves nothing about whether the
 *    thing at the end of that path is loadable.
 *
 * 3. **Real SDK load** — spawns the actual Claude Code CLI with exactly the
 *    descriptor `buildPluginOptions` produced, and reads the `init` message,
 *    which reports the plugins the CLI loaded and the skills it will offer the
 *    model. This is the block that carries the property: a manifest Claude
 *    rejects, or a skills layout it does not recognise, shows up here as an
 *    absent entry.
 *
 *    **It is a loadability test, not an end-to-end test.** It stops at `init`,
 *    before any inference: it asserts the skill was *discovered and offered*,
 *    not that a model ever chose to run it or that running it did anything. The
 *    session is aborted at `init` and the credentials are deliberately bogus, so
 *    it makes no API call and costs nothing — which is also precisely why it
 *    cannot say anything about invocation. Invocation was verified by hand
 *    against a live model (a skill whose body carried a token absent from the
 *    prompt; the model called `Skill{skill:"callboard:<name>"}` and echoed the
 *    token back); that check needs credentials and real tokens, so it does not
 *    live in CI.
 *
 * The CLI binary comes from the `@anthropic-ai/claude-agent-sdk` platform
 * package — a normal dependency, already installed — so this needs no network,
 * no credentials, and no globally-installed `claude`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is frozen when utils/paths.js first loads, so the override has to
// precede the imports below — hence the dynamic form.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-plugin-load-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { customSkillsService, CUSTOM_SKILLS_PLUGIN_NAME } = await import("./custom-skills-service.js");
const { buildPluginOptions } = await import("./claude.js");
const { query } = await import("@anthropic-ai/claude-agent-sdk");

const PLUGIN_DIR = join(tmpRoot, "custom-skills");
/** A scratch cwd for the CLI, so it cannot pick up this repo's own skills. */
const WORK_DIR = join(tmpRoot, "cwd");

const SKILL = {
  name: "plugin-load-probe",
  description: "Probe skill used to prove the callboard plugin directory loads",
  content: "# Probe\n\nThis body exists only so the skill has one.",
};

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
  customSkillsService.createSkill(SKILL);
});

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("the directory contract a Claude plugin loader imposes", () => {
  it("puts the manifest at .claude-plugin/plugin.json with a name", () => {
    const manifestPath = join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // `name` is the namespace half of `callboard:<skill>`; without it the
    // loader has nothing to qualify the skill with.
    expect(manifest.name).toBe(CUSTOM_SKILLS_PLUGIN_NAME);
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
  });

  it("nests each skill as skills/<name>/SKILL.md and nothing else", () => {
    const skillsRoot = join(PLUGIN_DIR, "skills");
    expect(statSync(skillsRoot).isDirectory()).toBe(true);

    const entries = readdirSync(skillsRoot, { withFileTypes: true });
    // Loose files directly under skills/ are not skills to Claude, and are
    // actively harmful to pi (see getSkillsDir's doc-comment) — the root holds
    // skill directories only.
    expect(entries.every((e) => e.isDirectory())).toBe(true);
    expect(entries.map((e) => e.name)).toContain(SKILL.name);

    for (const entry of entries) {
      expect(existsSync(join(skillsRoot, entry.name, "SKILL.md"))).toBe(true);
    }
  });

  it("opens SKILL.md with frontmatter carrying name and description", () => {
    const raw = readFileSync(join(PLUGIN_DIR, "skills", SKILL.name, "SKILL.md"), "utf8");

    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
    expect(match, "SKILL.md must open with a --- delimited frontmatter block").not.toBeNull();

    const frontmatter = match![1];
    // Emitted as JSON strings, i.e. valid YAML double-quoted scalars, so a
    // description containing `:` or `#` cannot break the block.
    expect(frontmatter).toContain(`name: ${JSON.stringify(SKILL.name)}`);
    expect(frontmatter).toContain(`description: ${JSON.stringify(SKILL.description)}`);
    // The declared name must match the directory, or the loader and our
    // `callboard:<name>` slash-command listing disagree about what to call it.
    expect(JSON.parse(/name:\s*(".*")/.exec(frontmatter)![1])).toBe(SKILL.name);
    // A skill with frontmatter and no body is a skill with nothing to say.
    expect(raw.slice(match![0].length).trim().length).toBeGreaterThan(0);
  });
});

describe("buildPluginOptions", () => {
  it("includes the custom-skills directory as a local plugin descriptor", () => {
    const descriptors = buildPluginOptions(WORK_DIR);
    expect(descriptors).toContainEqual({
      type: "local",
      path: PLUGIN_DIR,
      name: CUSTOM_SKILLS_PLUGIN_NAME,
    });
  });

  it("omits it when the install has no custom skills", () => {
    customSkillsService.deleteSkill(SKILL.name);
    try {
      expect(customSkillsService.getPluginDir()).toBeNull();
      expect(buildPluginOptions(WORK_DIR).some((p) => p.name === CUSTOM_SKILLS_PLUGIN_NAME)).toBe(false);
    } finally {
      customSkillsService.createSkill(SKILL);
    }
  });
});

describe("the real Claude Code SDK loader", () => {
  /**
   * Reads only the `init` message and aborts. No inference happens, so this
   * proves discovery — the CLI parsed the manifest, walked `skills/`, accepted
   * the frontmatter, and will offer the model `callboard:<name>` — and stops
   * exactly short of proving the model can use it. See the file header.
   */
  it("loads the plugin and offers the skill as callboard:<name>", async () => {
    // The very descriptor array a real chat session would pass.
    const plugins = buildPluginOptions(WORK_DIR);
    expect(plugins.some((p) => p.name === CUSTOM_SKILLS_PLUGIN_NAME)).toBe(true);

    // Refuse to inherit working credentials. Aborting at init already means no
    // request is sent; deleting these makes "costs nothing" structural rather
    // than a matter of winning a race. CLAUDECODE goes too — the CLI refuses to
    // start inside another Claude Code session, which is how this suite is
    // usually run locally.
    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-invalid-plugin-load-test" };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.CLAUDECODE;

    const abortController = new AbortController();
    const session = query({
      prompt: "unused — the session is aborted at init",
      options: {
        cwd: WORK_DIR,
        abortController,
        plugins,
        // No user/project/local settings: the plugin descriptor becomes the
        // only route by which a `callboard:` skill could appear at all.
        settingSources: [],
        env,
        stderr: () => {},
      },
    });

    let init: Extract<SDKMessage, { type: "system"; subtype: "init" }> | null = null;
    try {
      for await (const message of session) {
        if (message.type === "system" && message.subtype === "init") {
          init = message;
          break;
        }
      }
    } finally {
      abortController.abort();
    }

    expect(init, "the CLI produced no init message").not.toBeNull();
    // The loader's own account of what it loaded, by name and by path.
    expect(init!.plugins).toContainEqual(expect.objectContaining({ name: CUSTOM_SKILLS_PLUGIN_NAME, path: PLUGIN_DIR }));
    // ...and, the part that a well-formed-but-unreadable directory would fail:
    // the skill inside it is one the model will be offered.
    expect(init!.skills).toContain(`${CUSTOM_SKILLS_PLUGIN_NAME}:${SKILL.name}`);
    expect(init!.slash_commands).toContain(`${CUSTOM_SKILLS_PLUGIN_NAME}:${SKILL.name}`);
  }, 60_000);
});
