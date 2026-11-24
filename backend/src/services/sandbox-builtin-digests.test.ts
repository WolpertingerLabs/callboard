/**
 * The pinned built-in digests are exactly the shipped recipes': if a recipe in
 * packages/computer-use/docker/profiles changes, this fails until the map is
 * regenerated (`node scripts/builtin-profile-digests.mjs`) and committed. The
 * build runs the same check (`--check`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseProfileRecipe, profileRecipeDigest } from "@wolpertingerlabs/computer-use";
import { BUILTIN_PROFILE_DIGESTS } from "./sandbox-builtin-digests.generated.js";
import { builtinProfilesDir, isTrustedBuiltin, loadBuiltinProfiles } from "./sandbox-profiles.js";

describe("BUILTIN_PROFILE_DIGESTS", () => {
  it("pins every shipped recipe, and nothing else", () => {
    const dir = builtinProfilesDir();
    const shipped = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const recipe = parseProfileRecipe(readFileSync(join(dir, f), "utf8"));
          return [recipe.name, profileRecipeDigest(recipe)];
        }),
    );
    expect({ ...BUILTIN_PROFILE_DIGESTS }).toEqual(shipped);
    expect(Object.isFrozen(BUILTIN_PROFILE_DIGESTS)).toBe(true);
  });
  it("so every shipped built-in loads as trusted", () => {
    const { entries, errors } = loadBuiltinProfiles();
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.recipe.name, isTrustedBuiltin(e)])).toEqual(Object.keys(BUILTIN_PROFILE_DIGESTS).map((name) => [name, true]));
  });
});
