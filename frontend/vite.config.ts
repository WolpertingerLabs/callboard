import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import dotenv from "dotenv";
import { DEV_BUILD_ID, BUILD_ID_FILENAME } from "../shared/types/build";

/**
 * The one place a build id is minted. See `shared/types/build.ts` for what the
 * id is for and why it is composed this way rather than from the version alone.
 *
 * Runs at config time, so the same string can be `define`d into the bundle and
 * emitted beside it — that pairing is the whole mechanism, and it is why this
 * cannot be a hash of the output: the id has to exist before the code that
 * contains it does.
 */
function computeBuildId(pkgRoot: string): string {
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
function emitBuildId(buildId: string): Plugin {
  return {
    name: "callboard-build-id",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: BUILD_ID_FILENAME, source: JSON.stringify({ buildId }, null, 2) + "\n" });
    },
  };
}

export default defineConfig(({ command }) => {
  const pkgRoot = path.resolve(__dirname, "..");

  // Load .env: prefer project-root .env (dev overrides), fall back to ~/.callboard/.env
  const projectEnvPath = path.resolve(__dirname, "..", ".env");
  const configEnvPath = process.env.CALLBOARD_DATA_DIR ? path.join(process.env.CALLBOARD_DATA_DIR, ".env") : path.join(homedir(), ".callboard", ".env");

  let envFile: Record<string, string> = {};
  try {
    if (existsSync(projectEnvPath)) {
      envFile = dotenv.parse(readFileSync(projectEnvPath));
    } else if (existsSync(configEnvPath)) {
      envFile = dotenv.parse(readFileSync(configEnvPath));
    }
  } catch {
    // .env file is optional
  }

  const devPortUI = parseInt(envFile.DEV_PORT_UI) || 3000;
  const devPortServer = parseInt(envFile.DEV_PORT_SERVER) || 3002;

  // `vite serve` recompiles per keystroke and reloads the tab itself, so a dev
  // bundle declares that it has no identity rather than inventing one.
  const buildId = command === "build" ? computeBuildId(pkgRoot) : DEV_BUILD_ID;

  return {
    plugins: [react(), ...(command === "build" ? [emitBuildId(buildId)] : [])],
    root: ".",
    define: {
      __CALLBOARD_BUILD_ID__: JSON.stringify(buildId),
    },
    resolve: {
      alias: {
        "shared": path.resolve(__dirname, "..", "shared"),
      },
    },
    server: {
      port: devPortUI,
      allowedHosts: true,
      proxy: {
        "/api": `http://localhost:${devPortServer}`,
      },
    },
  };
});
