/**
 * Saving a settings file kept as a symlink with a **relative** target, with the
 * data dir itself reached through a symlink.
 *
 * The kernel resolves a relative link target from the link's *real* directory.
 * Resolving it as text against the path callboard was given (or against the
 * cwd) picks a different file once a directory on the way is a link: the save
 * reports success, writes elsewhere, and every later read comes back `absent`.
 *
 * Needs its own data dir, so it cannot share the worker's: `DATA_DIR` is
 * captured when `utils/paths.ts` is first imported, which is why the env var is
 * set before the dynamic import below.
 *
 * Layout (root = a scratch dir; the data dir is `root/outer/alias`):
 *
 *   root/outer/alias → root/deep
 *   root/deep/agent-settings.json → ../store/agent-settings.json
 *
 * The kernel resolves that from `root/deep`, giving `root/store/…`. Read as text
 * from `root/outer/alias`, it gives `root/outer/store/…`, the decoy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSettings } from "shared";

const root = mkdtempSync(join(tmpdir(), "cb-settings-rel-"));
const outer = join(root, "outer");
const deep = join(root, "deep");
const alias = join(outer, "alias");
mkdirSync(outer);
mkdirSync(deep);
symlinkSync(deep, alias);
process.env.CALLBOARD_DATA_DIR = alias;

const { readAgentSettings, updateAgentSettings } = await import("./agent-settings.js");

const SETTINGS = join(alias, "agent-settings.json");
const kernelTarget = (dir: string) => join(root, dir, "agent-settings.json");
const decoyTarget = (dir: string) => join(outer, dir, "agent-settings.json");
const read = (path: string): AgentSettings => JSON.parse(readFileSync(path, "utf-8"));

beforeEach(() => {
  // Both the real and the decoy parents exist, so a wrong resolve succeeds
  // quietly instead of failing loudly. That is the dangerous case.
  for (const dir of ["store", "mid", "final"]) {
    mkdirSync(join(root, dir), { recursive: true });
    mkdirSync(join(outer, dir), { recursive: true });
  }
});

afterEach(() => {
  rmSync(SETTINGS, { force: true });
  for (const dir of ["store", "mid", "final"]) {
    rmSync(join(root, dir), { recursive: true, force: true });
    rmSync(join(outer, dir), { recursive: true, force: true });
  }
});

describe("a settings file linked with a relative target, under a symlinked data dir", () => {
  it("first save through a dangling `../` link creates the file the link points at", () => {
    symlinkSync("../store/agent-settings.json", SETTINGS);

    updateAgentSettings({ codexModel: "first" });

    expect(lstatSync(SETTINGS).isSymbolicLink()).toBe(true);
    expect(read(kernelTarget("store")).codexModel).toBe("first");
    expect(existsSync(decoyTarget("store"))).toBe(false);
    const after = readAgentSettings();
    expect(after.state).toBe("ok");
    expect(after.settings.codexModel).toBe("first");
  });

  it("a later save through the same link updates that file", () => {
    symlinkSync("../store/agent-settings.json", SETTINGS);
    updateAgentSettings({ codexModel: "first" });

    updateAgentSettings({ codexModel: "second" });

    expect(lstatSync(SETTINGS).isSymbolicLink()).toBe(true);
    expect(read(kernelTarget("store")).codexModel).toBe("second");
    expect(existsSync(decoyTarget("store"))).toBe(false);
  });

  it("a dangling chain keeps its middle link and creates the final target", () => {
    // agent-settings.json → ../mid/link → ../final/agent-settings.json (missing)
    symlinkSync("../final/agent-settings.json", join(root, "mid", "link"));
    symlinkSync("../mid/link", SETTINGS);

    updateAgentSettings({ codexModel: "chained" });

    expect(lstatSync(SETTINGS).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, "mid", "link")).isSymbolicLink()).toBe(true);
    expect(read(kernelTarget("final")).codexModel).toBe("chained");
    expect(readAgentSettings().settings.codexModel).toBe("chained");
  });
});
