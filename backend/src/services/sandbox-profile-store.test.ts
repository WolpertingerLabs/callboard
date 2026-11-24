/**
 * The agent-built profile store: paths only from validated keys, private and
 * atomic files, a symlinked directory refused, versions re-validated on read,
 * and promotion keeping the recipe digest and the provenance.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProfileRecipe } from "@wolpertingerlabs/computer-use";
import { ProfileStore, currentRecipe } from "./sandbox-profile-store.js";
import { defaultSources, listProfiles, resolveProfileId } from "./sandbox-profiles.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-store-"));
  dirs.push(dir);
  return join(dir, "profiles");
};
const SCOPE = "w0123456789ab" as const;
const recipe = (over: Record<string, unknown> = {}) =>
  validateProfileRecipe({ schema: 1, name: "eyes", description: "xeyes", packages: ["x11-apps"], ...over });
const add = (store: ProfileStore, over: Record<string, unknown> = {}, scope: `w${string}` | "global" = SCOPE) =>
  store.addVersion({ scope, recipe: recipe(over), chatId: "chat-a", maxProfiles: 5, maxVersions: 10 });

describe("ProfileStore", () => {
  it("refuses any scope or name outside the grammar before touching a path", () => {
    const store = new ProfileStore(fresh());
    for (const [scope, name] of [
      ["../x", "eyes"],
      ["global/..", "eyes"],
      [SCOPE, "../eyes"],
      [SCOPE, "a/b"],
      [SCOPE, "base"],
    ])
      expect(() => store.read(scope as never, name)).toThrow(/Invalid profile/);
  });

  it("writes 0600 files in 0700 directories, atomically (no temp file left)", () => {
    const root = fresh();
    const store = new ProfileStore(root);
    add(store);
    add(store, { description: "v2" });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, SCOPE)).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, SCOPE, "eyes.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, SCOPE))).toEqual(["eyes.json"]);
    expect(store.read(SCOPE, "eyes")!.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("refuses a store directory that is a symlink", () => {
    const root = fresh();
    const elsewhere = mkdtempSync(join(tmpdir(), "cb-elsewhere-"));
    dirs.push(elsewhere);
    mkdirSync(root, { recursive: true });
    symlinkSync(elsewhere, join(root, SCOPE));
    expect(() => add(new ProfileStore(root))).toThrow(/not a plain directory/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("only an approved version is in force, and only it becomes a registry entry", () => {
    const store = new ProfileStore(fresh());
    const { version } = add(store);
    expect(currentRecipe(store.read(SCOPE, "eyes")!)).toBeUndefined();
    expect(listProfiles({}, defaultSources(store)).some((e) => e.recipe.name === "eyes")).toBe(false);
    store.approve(SCOPE, "eyes", version.version, version.digest, "req-1");
    expect(resolveProfileId(`${SCOPE}/eyes`, defaultSources(store))).toMatchObject({ source: "agent", version: 1, digest: version.digest });
    expect(() => store.approve(SCOPE, "eyes", 1, "0".repeat(64), "req-2")).toThrow(expect.objectContaining({ code: "changed" }));
  });

  it("promotes to global under the same digest, keeping versions and provenance, and refuses a second global of that name", () => {
    const store = new ProfileStore(fresh());
    const { version } = add(store);
    store.approve(SCOPE, "eyes", 1, version.digest, "req-1");
    const promoted = store.promote(SCOPE, "eyes", 1234);
    expect(promoted).toMatchObject({ scope: "global", current: 1, createdBy: "chat-a", promoted: { at: 1234, fromScope: SCOPE, fromVersion: 1 } });
    expect(store.read(SCOPE, "eyes")).toBeUndefined();
    expect(resolveProfileId("global/eyes", defaultSources(store))).toMatchObject({ digest: version.digest, image: expect.stringMatching(/:eyes$/) });
    const again = add(store);
    store.approve(SCOPE, "eyes", again.version.version, again.version.digest, "req-3");
    expect(() => store.promote(SCOPE, "eyes")).toThrow(/exists already/);
  });

  it("refuses to promote a profile with no approved version", () => {
    const store = new ProfileStore(fresh());
    add(store);
    expect(() => store.promote(SCOPE, "eyes")).toThrow(/no approved version/);
  });
});
