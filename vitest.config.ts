import { defineConfig } from "vitest/config";

// Two projects: backend/shared tests run in Node; frontend tests run in jsdom.
// The frontend project forces NODE_ENV=development so React loads its dev build
// (the shell may export NODE_ENV=production, under which @testing-library's
// act() support is unavailable). JSX is transformed by esbuild via the
// frontend tsconfig's "jsx": "react-jsx".
export default defineConfig({
  test: {
    // Coverage is reported but NEVER gates the build — no `thresholds` are set
    // intentionally. This is a first step toward good practice; the numbers are
    // surfaced in CI but a low number must not fail the job.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Only measure first-party source in the three workspaces.
      include: [
        "shared/src/**/*.{ts,tsx}",
        "backend/src/**/*.{ts,tsx}",
        "frontend/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        // Tests and fixtures
        "**/*.{test,spec}.{ts,tsx}",
        "**/__tests__/**",
        "**/__mocks__/**",
        // Config / build tooling
        "**/*.config.{ts,js,mjs,cjs}",
        "scripts/**",
        "backend/src/scaffold/**",
        "backend/src/swagger.ts",
        // Type-only declarations
        "**/*.d.ts",
        "**/types/**",
      ],
    },
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
