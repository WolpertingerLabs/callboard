import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import dotenv from "dotenv";

export default defineConfig(() => {
  // Load .env: prefer project-root .env (dev overrides), fall back to ~/.callboard/.env
  const projectEnvPath = path.resolve(__dirname, "..", ".env");
  const configEnvPath = path.join(homedir(), ".callboard", ".env");

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

  return {
    plugins: [react()],
    root: ".",
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
