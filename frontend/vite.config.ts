import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";
import dotenv from "dotenv";

export default defineConfig(() => {
  // Load .env from project root (one level up from frontend/)
  // Use dotenv.parse to read the file directly, so .env values take priority
  // over any inherited process.env values
  const envPath = path.resolve(__dirname, "..", ".env");
  let envFile: Record<string, string> = {};
  try {
    envFile = dotenv.parse(readFileSync(envPath));
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
