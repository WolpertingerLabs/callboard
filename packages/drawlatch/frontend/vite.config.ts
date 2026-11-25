import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: ".",
  resolve: {
    alias: {
      "drawlatch-admin-types": path.resolve(
        __dirname,
        "..",
        "src",
        "remote",
        "admin-types.ts",
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:9999",
    },
  },
});
