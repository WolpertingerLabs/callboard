/**
 * Before the human is asked to start a Sandbox desktop profile: is there one
 * by that name for this chat, can a session start from it now, and what will
 * it get? Kept apart from sandbox-desktop.ts (which wires the globals) so the
 * rule is testable on its own.
 */
import { SANDBOX_PROFILE_BUILD_COMMAND, type ComputerUseSandboxProfile, type SandboxDesktopMode } from "shared/types/index.js";
import { effectiveProfileLimits, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import type { DockerRunner } from "./sandbox-image.js";
import { currentBase, inspectProfileImage, profileVariant, type ProfileEntry, type ProfileImageInfo } from "./sandbox-profiles.js";

/** A profile as a session will run it: summary, clamped limits, and the variant that binds a consent to this exact recipe. */
export type ConsentProfile = ComputerUseSandboxProfile & { limits: NonNullable<ComputerUseSandboxProfile["limits"]>; variant: string };

export interface ProfileConsentDeps {
  mode: SandboxDesktopMode;
  docker: DockerRunner;
  /** The base image tag, to judge whether the profile was built on it. */
  baseImage: string;
  settings: ResolvedSandboxSettings;
  resolve: (name: string) => ProfileEntry | undefined;
  names: () => string[];
}

const fail = (code: "invalid_request" | "unsupported", message: string) => Object.assign(new Error(message), { code });

/**
 * The named profile, if a session can start from it now: managed mode, and
 * its image built and not refused (an out-of-date one still starts). Throws
 * an Error with a `code` and words for the agent otherwise. Recipe text never
 * reaches these messages: only the validated name.
 */
export async function profileForConsent(name: string, deps: ProfileConsentDeps): Promise<ConsentProfile> {
  if (deps.mode !== "managed")
    throw fail(
      "unsupported",
      "Sandbox profiles need managed mode (Callboard starts the container). This Callboard's Sandbox desktop is not in managed mode; request it without a profile.",
    );
  const entry = deps.resolve(name);
  if (!entry)
    throw fail(
      "invalid_request",
      `There is no sandbox profile named ${JSON.stringify(name)}. Available: ${deps.names().join(", ") || "none"} (or omit profile for the base desktop).`,
    );
  const image: ProfileImageInfo = await inspectProfileImage(deps.docker, entry, await currentBase(deps.docker, deps.baseImage)).catch(() => ({
    state: "missing",
  }));
  if (image.state === "missing")
    throw fail(
      "unsupported",
      `Sandbox profile ${entry.recipe.name} is not built on this Callboard. Ask the human to build it (Settings → Sandbox desktop → Profiles, or \`${SANDBOX_PROFILE_BUILD_COMMAND} ${entry.recipe.name}\` on the service host); building is theirs to start, never yours.`,
    );
  if (image.state === "insecure" || image.state === "incompatible")
    throw fail(
      "unsupported",
      `Sandbox profile ${entry.recipe.name}'s image must be rebuilt before it can start. Ask the human to rebuild it (Settings → Sandbox desktop → Profiles).`,
    );
  const { clamped: _clamped, ...limits } = effectiveProfileLimits(entry.recipe, deps.settings);
  return { name: entry.recipe.name, description: entry.recipe.description, gl: entry.recipe.gl, limits, variant: profileVariant(entry) };
}
