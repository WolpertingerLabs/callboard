/**
 * The §2 finding, reproduced against **real pi** rather than asserted about
 * options.
 *
 * `permissionAdapter.test.ts` checks the *shape* of the options callboard
 * builds. This file checks the thing that actually matters: that pi, driven with
 * those options, does not execute a repository's `.pi/extensions/*.ts`. The two
 * are not redundant — a pi upgrade could keep every option name and change what
 * they do, and only this file would notice.
 *
 * The instrument is a project-local extension whose **module top level** writes a
 * marker file. That code runs at load time, before the first model call and
 * before any `tool_call` handler exists, so the marker's presence is proof that
 * untrusted repository code executed in the backend process.
 *
 * No model, no network, no credentials: `createAgentSessionServices` resolves
 * trust and loads extensions without any of them, in ~12 ms.
 *
 * @see plans/pi-spike-findings.md (§2)
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-trust-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { createAgentSessionServices, SettingsManager, DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
const { buildPiServicesOptions } = await import("./optionsAdapter.js");
const { buildPermissionExtension } = await import("./permissionAdapter.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A scratch repo containing a hostile project-local extension.
 *
 * Each call gets its own directory. That is deliberate: jiti's module cache is
 * process-wide and keyed by path, so reusing one repo across the denial and the
 * control would let the first run's cached module mask the second. The spike hit
 * exactly this and mistook it for a security property.
 */
function scratchRepo(label: string): { cwd: string; marker: string; markerWasWritten: () => boolean } {
  const cwd = join(tmpRoot, `repo-${label}`);
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  const marker = join(tmpRoot, `MARKER-${label}`);
  writeFileSync(
    join(cwd, ".pi", "extensions", "hostile.ts"),
    [
      `import { writeFileSync } from "node:fs";`,
      // Module top level — runs on load, before any tool gate exists.
      `writeFileSync(${JSON.stringify(marker)}, "project-local extension executed");`,
      `export default function (pi: any) {}`,
    ].join("\n"),
  );
  return { cwd, marker, markerWasWritten: () => existsSync(marker) };
}

const agentDir = join(tmpRoot, "pi-agent");

describe("a pi session built by this adapter does not execute repository code", () => {
  it("does not load a project-local extension from the opened repo", async () => {
    const repo = scratchRepo("denied");
    const services = await createAgentSessionServices({
      ...buildPiServicesOptions({ cwd: repo.cwd, extension: buildPermissionExtension({ signal: new AbortController().signal }), agentDir }),
    });

    expect(repo.markerWasWritten()).toBe(false);
    const loaded = services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    expect(loaded).not.toContain(join(repo.cwd, ".pi", "extensions", "hostile.ts"));
  });

  it("still installs callboard's own gate", async () => {
    const repo = scratchRepo("gate");
    const services = await createAgentSessionServices({
      ...buildPiServicesOptions({ cwd: repo.cwd, extension: buildPermissionExtension({ signal: new AbortController().signal }), agentDir }),
    });

    // `noExtensions` must not take the gate down with the project's code.
    const loaded = services.resourceLoader.getExtensions().extensions;
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.path).toContain("inline");
    expect(loaded[0]?.handlers.has("tool_call")).toBe(true);
  });

  /**
   * The control. Without it, the two cases above pass just as happily if the
   * marker mechanism is broken, or if pi stopped loading project extensions
   * entirely for some unrelated reason.
   *
   * This asserts the **vulnerable** configuration is genuinely vulnerable: a
   * trusting loader on the same shape of repo does execute the file. If this
   * ever starts passing with `markerWasWritten() === false`, the tests above
   * have stopped proving anything and this one says so.
   */
  it("CONTROL: a trusting loader on the same repo DOES execute it", async () => {
    const repo = scratchRepo("control");
    const loader = new DefaultResourceLoader({
      cwd: repo.cwd,
      agentDir,
      settingsManager: SettingsManager.create(repo.cwd, agentDir, { projectTrusted: true }),
    });
    await loader.reload({ resolveProjectTrust: async () => true });

    expect(repo.markerWasWritten()).toBe(true);
  });
});

/**
 * A source-level guard, deliberately crude.
 *
 * The behavioural tests above prove the options callboard builds today are safe.
 * They cannot prove that *tomorrow's* `PiAgentQuery` still uses them: swapping
 * `createAgentSessionServices` + `createAgentSessionFromServices` for the
 * one-line `createAgentSession()` is a tempting simplification that compiles,
 * passes every other test in this directory, and silently re-opens §2.
 *
 * So the import itself is the thing asserted. `createAgentSession` is pi's
 * convenience entry point and this adapter has no legitimate use for it.
 */
describe("the adapter never reaches for pi's convenience entry point", () => {
  const adapterDir = dirname(fileURLToPath(import.meta.url));

  const sourceFiles = readdirSync(adapterDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => [f, readFileSync(join(adapterDir, f), "utf8")] as const);

  it("has source files to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  it.each(sourceFiles)("%s does not import createAgentSession", (_name, source) => {
    // Strip block comments: the header docs discuss `createAgentSession()` at
    // length, and explaining why it is forbidden must not trip the check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // `createAgentSessionServices` / `...FromServices` are the sanctioned pair;
    // the negative lookahead lets them through and catches only the bare symbol.
    expect(code).not.toMatch(/\bcreateAgentSession(?!Services|FromServices)\b/);
  });
});
