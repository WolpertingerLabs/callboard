import path from "path";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import type { Plugin } from "vite";
import { BUILD_ID_FILENAME } from "../shared/types/build";

/**
 * Minting the build id, and the plugin that publishes it.
 *
 * Lives beside `vite.config.ts` rather than inside it so that it can be tested.
 * A config file is imported for its side effect of configuring a build; the one
 * property this whole feature rests on — *a clean tree rebuilds to the same id*
 * — is a property of these functions, and it needs a guard rather than a
 * promise. See `build-id.test.ts`, and `shared/types/build.ts` for what the id
 * is for.
 */

/**
 * The id for this build.
 *
 * Runs at config time, so the same string can be `define`d into the bundle and
 * emitted beside it — that pairing is the whole mechanism, and it is why this
 * cannot be a hash of the output: the id has to exist before the code that
 * contains it does.
 */
export function computeBuildId(pkgRoot: string): string {
  let version = "0.0.0";
  try {
    version = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf-8")).version || version;
  } catch {
    // A version we cannot read is not worth failing a build over; the git half
    // below is the part that actually distinguishes two builds.
  }

  const git = (args: string[]): string => execFileSync("git", args, { cwd: pkgRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  try {
    const sha = git(["rev-parse", "--short=12", "HEAD"]);
    // A dirty tree is a build the sha cannot describe: two of them off the same
    // commit are genuinely different bundles, so they get genuinely different
    // ids. A clean tree stays reproducible on purpose — rebuilding an unchanged
    // checkout must not tell every open tab to reload.
    const dirty = git(["status", "--porcelain"]).length > 0;
    return dirty ? `${version}+g${sha}.d${Date.now().toString(36)}` : `${version}+g${sha}`;
  } catch {
    // No git: an unpacked tarball being rebuilt, or a source download. Fall back
    // to the build clock, which over-reports change rather than under-reporting
    // it — the safe direction for a prompt the user can dismiss.
    return `${version}+t${Date.now().toString(36)}`;
  }
}

/** Writes the build id into `frontend/dist`, where the daemon reads it at startup. */
export function emitBuildId(buildId: string): Plugin {
  return {
    name: "callboard-build-id",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: BUILD_ID_FILENAME, source: JSON.stringify({ buildId }, null, 2) + "\n" });
    },
  };
}
