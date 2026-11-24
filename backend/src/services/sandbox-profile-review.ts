/**
 * What a human reads before a profile that is not built in gets built: the
 * proposal card's review, and Settings' Build/Rebuild review. One function,
 * so the two can never show different things for the same recipe.
 */
import type { ProfileRecipe } from "@wolpertingerlabs/computer-use";
import type { SandboxProfileProposalCardInput } from "shared/types/index.js";
import { effectiveProfileLimits, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";

export function recipeReview(recipe: ProfileRecipe, settings: ResolvedSandboxSettings): SandboxProfileProposalCardInput["review"] {
  const { clamped, ...limits } = effectiveProfileLimits(recipe, settings);
  return {
    description: recipe.description,
    setup: recipe.setup,
    setupLines: recipe.setup ? recipe.setup.replace(/\n$/, "").split("\n").length : 0,
    downloads: recipe.downloads.map((d) => ({ host: new URL(d.url).hostname, url: d.url, sha256: d.sha256, dest: d.dest, unpack: d.unpack })),
    hosts: [...new Set(recipe.downloads.map((d) => new URL(d.url).hostname))],
    packages: recipe.packages,
    gl: recipe.gl,
    architectures: recipe.architectures,
    requested: recipe.limits,
    limits,
    ...(clamped ? { clamped } : {}),
    caps: settings.profileCaps,
    path: recipe.path,
    env: recipe.env,
  };
}
