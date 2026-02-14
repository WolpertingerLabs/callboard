import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  // Load .env from project root (one level up from frontend/)
  const env = loadEnv(mode, path.resolve(__dirname, ".."), "");

  const devPortUI = parseInt(env.DEV_PORT_UI) || 3000;
  const devPortServer = parseInt(env.DEV_PORT_SERVER) || 3002;

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
