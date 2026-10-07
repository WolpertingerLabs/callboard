import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import dotenv from "dotenv";
import { DEV_BUILD_ID } from "../shared/types/build";
import { computeBuildId, emitBuildId } from "./build-id";

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
      // The SPA and `/api` share this origin (the proxy below), so nothing
      // needs CORS. Vite's default reflects any localhost origin, i.e. any
      // other port on this machine — the same hole the backend closed.
      cors: false,
      proxy: {
        "/api": `http://localhost:${devPortServer}`,
      },
    },
  };
});
