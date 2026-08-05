/**
 * Callboard's custom skills reach a pi session; the opened repository's do not.
 *
 * Two halves of one property, and neither is worth much alone. The feature is
 * that a skill the user authored in callboard settings is visible to a pi chat.
 * The reason the feature is safe is that turning it on did **not** turn on
 * project-local skill discovery — `.pi/skills/` in the opened repo is
 * trust-gated content for the same reason `.pi/extensions/` is, and the
 * tempting one-line version of this feature (`noSkills: false`) would admit it.
 *
 * Built the same way as `projectTrust.test.ts`, for the same reasons: a real
 * `createAgentSessionServices` rather than assertions about an options bag, a
 * scratch repo per case, and a **control** that proves the negative assertion
 * has teeth. `optionsAdapter.test.ts` covers the option *shape*; only this file
 * notices if pi keeps every option name and changes what they do.
 *
 * The skills themselves come from the real `customSkillsService` — pointed at a
 * scratch `CALLBOARD_DATA_DIR` — so what is exercised is the actual path from
 * "user saves a skill in settings" to "pi lists it", not a hand-built directory
 * that happens to look like one.
 *
 * No model, no network, no credentials.
 *
 * @see plans/pi-spike-findings.md (§2 — trust-gated project resources)
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-skills-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { createAgentSessionServices, SettingsManager, DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
const { buildPiServicesOptions, resolveCallboardSkillPaths } = await import("./optionsAdapter.js");
const { buildPermissionExtension } = await import("./permissionAdapter.js");
const { customSkillsService } = await import("../../../services/custom-skills-service.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const agentDir = join(tmpRoot, "pi-agent");

/**
 * A scratch repo carrying a project-local skill.
 *
 * Per-case directories, as in `projectTrust.test.ts`. The reason differs and is
 * worth stating: skills are read with `readFileSync`, not evaluated through
 * jiti, so there is no module cache to defeat here. What there *is* is pi's
 * per-path trust store under `agentDir` — a decision recorded for one repo path
 * would otherwise carry into the next case, and the control deliberately trusts
 * a path.
 */
function scratchRepo(label: string): { cwd: string; skillName: string } {
  const cwd = join(tmpRoot, `repo-${label}`);
  const skillName = `project-skill-${label}`;
  mkdirSync(join(cwd, ".pi", "skills", skillName), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "skills", skillName, "SKILL.md"),
    `---\nname: "${skillName}"\ndescription: "A skill supplied by the opened repository"\n---\n\nProject-local skill body.\n`,
  );
  return { cwd, skillName };
}

/** Build the session services this adapter would build for a real chat. */
async function servicesFor(cwd: string) {
  return createAgentSessionServices(
    buildPiServicesOptions({
      cwd,
      extension: buildPermissionExtension({ signal: new AbortController().signal }),
      agentDir,
    }),
  );
}

const CUSTOM_SKILL = {
  name: "callboard-probe-skill",
  description: "A custom skill authored in callboard settings",
  content: "When asked for the probe word, answer with exactly: PERSIMMON.",
};

/**
 * Deliberately its own block, and deliberately first: it is the only case that
 * needs the scratch data dir to still be empty. The suite below creates the
 * skill in its own `beforeAll`, so the ordering is a stated dependency rather
 * than a lucky one.
 */
describe("a callboard install with no custom skills", () => {
  it("adds no skill paths to pi's resource surface", () => {
    // pi records a diagnostic for a named path that does not exist, so the key
    // must be absent rather than an empty array.
    expect(customSkillsService.listSkills()).toEqual([]);
    expect(resolveCallboardSkillPaths()).toEqual([]);
    const options = buildPiServicesOptions({ cwd: join(tmpRoot, "repo-none"), extension: () => {}, agentDir });
    expect(options.resourceLoaderOptions).not.toHaveProperty("additionalSkillPaths");
  });
});

describe("callboard custom skills in a pi session", () => {
  beforeAll(() => {
    customSkillsService.createSkill(CUSTOM_SKILL);
  });

  it("makes a skill authored in settings available to the session", async () => {
    const repo = scratchRepo("available");

    const services = await servicesFor(repo.cwd);
    const skills = services.resourceLoader.getSkills();

    expect(skills.skills.map((s) => s.name)).toContain(CUSTOM_SKILL.name);
    const loaded = skills.skills.find((s) => s.name === CUSTOM_SKILL.name)!;
    expect(loaded.description).toBe(CUSTOM_SKILL.description);
    // The path pi will hand the model to `read`, so it has to be the real file.
    expect(existsSync(loaded.filePath)).toBe(true);
    expect(loaded.filePath.startsWith(tmpRoot)).toBe(true);
    // A skill pi drops for a bad frontmatter would still show up as a
    // diagnostic rather than a failure, so assert the clean load too.
    expect(skills.diagnostics).toEqual([]);
  });

  /**
   * The safety half. `noSkills: true` is still set — custom skills ride in on
   * `additionalSkillPaths`, which the loader keeps on both sides of that flag —
   * so the repository's own skills must remain invisible.
   */
  it("does not load a project-local skill from the opened repo", async () => {
    const repo = scratchRepo("denied");

    const services = await servicesFor(repo.cwd);
    const names = services.resourceLoader.getSkills().skills.map((s) => s.name);

    expect(names).not.toContain(repo.skillName);
    // ...while callboard's own is present in the very same session, which is
    // what makes this a discrimination rather than "skills are just off".
    expect(names).toContain(CUSTOM_SKILL.name);
  });

  /**
   * The control, and the reason the assertion above means anything.
   *
   * Without it, "does not contain the project skill" passes just as happily if
   * the fixture never wrote a valid skill, if pi's discovery moved off
   * `.pi/skills/`, or if pi stopped loading project skills for some unrelated
   * reason. This asserts the **permissive** configuration genuinely loads the
   * very same file, so a green suite above is a green suite about trust.
   */
  it("CONTROL: a trusting loader on the same repo DOES load it", async () => {
    const repo = scratchRepo("control");
    const loader = new DefaultResourceLoader({
      cwd: repo.cwd,
      agentDir,
      settingsManager: SettingsManager.create(repo.cwd, agentDir, { projectTrusted: true }),
    });
    await loader.reload({ resolveProjectTrust: async () => true });

    expect(loader.getSkills().skills.map((s) => s.name)).toContain(repo.skillName);
  });

  /**
   * The two mitigations, measured one at a time.
   *
   * Written first as "dropping `noSkills` re-admits the repo's skill" — which
   * **failed**, and the failure is the interesting part. Project-local skills
   * are gated by *trust* as well as by the flag, and either alone is sufficient:
   * only trusting the project *and* leaving discovery on exposes the file. So
   * `noSkills` is genuine defence in depth here rather than the sole lock, which
   * is the same relationship `noExtensions` has to `resolveProjectTrust`.
   *
   * Pinning all four cells means a pi upgrade that quietly makes either
   * mitigation a no-op fails here, instead of leaving the other one silently
   * carrying the property alone.
   */
  it.each([
    ["trusted, discovery on — the one vulnerable configuration", true, false, true],
    ["trusted, but noSkills held", true, true, false],
    ["untrusted, though noSkills dropped", false, false, false],
    ["neither — what this adapter ships", false, true, false],
  ])("CONTROL: %s", async (label, projectTrusted, noSkills, expectLoaded) => {
    const repo = scratchRepo(`matrix-${projectTrusted}-${noSkills}`);
    // A per-case agentDir as well as a per-case repo: the trust store is keyed
    // by path *within* an agent dir, and this case deliberately trusts one.
    const caseAgentDir = join(tmpRoot, `pi-agent-${projectTrusted}-${noSkills}`);
    const loader = new DefaultResourceLoader({
      cwd: repo.cwd,
      agentDir: caseAgentDir,
      settingsManager: SettingsManager.create(repo.cwd, caseAgentDir, { projectTrusted }),
      noSkills,
    });
    await loader.reload({ resolveProjectTrust: async () => projectTrusted });

    expect(loader.getSkills().skills.map((s) => s.name).includes(repo.skillName)).toBe(expectLoaded);
  });
});
