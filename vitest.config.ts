import { defineConfig } from "vitest/config";

// Two projects: backend/shared tests run in Node; frontend tests run in jsdom.
// The frontend project forces NODE_ENV=development so React loads its dev build
// (the shell may export NODE_ENV=production, under which @testing-library's
// act() support is unavailable). JSX is transformed by esbuild via the
// frontend tsconfig's "jsx": "react-jsx".
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          exclude: ["**/node_modules/**", "**/dist/**", "frontend/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "frontend",
          environment: "jsdom",
          env: { NODE_ENV: "development" },
          include: ["frontend/**/*.{test,spec}.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
    ],
  },
});
