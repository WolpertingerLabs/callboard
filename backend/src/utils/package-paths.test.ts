import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Tests that path resolution logic used throughout the app resolves to
 * real files/directories. These paths must work both during local dev
 * (running from the monorepo root) and after global npm install (running
 * from the installed package directory).
 *
 * Each test mirrors the exact relative path computation from the actual
 * source file it validates:
 *
 *   index.ts        lives at backend/src/       → "../.." = monorepo root
 *   claude-compiler lives at backend/src/services/ → "..", "..", "src", "scaffold"
 *   swagger spec    lives at backend/swagger.json
 *
 * This test lives at backend/src/utils/ — one level deeper than index.ts —
 * so we compute the monorepo root as "../../.." from here.
 */
const __dirname_here = dirname(fileURLToPath(import.meta.url));

// From backend/src/utils/ → go up 3 levels → monorepo root
const pkgRoot = resolve(__dirname_here, "../../..");

describe("package path resolution", () => {
  describe("__pkgRoot (index.ts resolves monorepo root via '../..')", () => {
    it("resolves to a directory containing package.json", () => {
      expect(existsSync(join(pkgRoot, "package.json"))).toBe(true);
    });

    it("finds frontend/dist after build", () => {
      // This is the path backend/src/index.ts uses to serve the React SPA
      const frontendDist = join(pkgRoot, "frontend/dist");
      expect(existsSync(frontendDist)).toBe(true);
      expect(existsSync(join(frontendDist, "index.html"))).toBe(true);
    });
  });

  describe("SCAFFOLD_DIR (claude-compiler.ts resolves scaffold via __dirname)", () => {
    // claude-compiler.ts lives at backend/src/services/ and computes:
    //   join(__dirname, "..", "..", "src", "scaffold")
    // From backend/src/services/ → ".." = backend/src/ → ".." = backend/ → "src/scaffold"
    // Which is: backend/src/scaffold
    //
    // We replicate from our location (backend/src/utils/):
    const servicesDir = resolve(__dirname_here, ".."); // backend/src/
    const scaffoldDir = join(servicesDir, "..", "src", "scaffold"); // backend/src/scaffold

    it("resolves to the scaffold directory", () => {
      expect(existsSync(scaffoldDir)).toBe(true);
    });

    it.each(["CLAUDE.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"])("contains scaffold file: %s", (filename) => {
      expect(existsSync(join(scaffoldDir, filename))).toBe(true);
    });
  });

  describe("swagger.json (index.ts resolves spec via __dir)", () => {
    // index.ts line 107: join(__dir, "../swagger.json") where __dir = backend/dist/ (or src/)
    // From this test at backend/src/utils/ → ".." = backend/src/ → "../swagger.json" = backend/swagger.json
    const backendSrcDir = resolve(__dirname_here, "..");
    const swaggerPath = join(backendSrcDir, "../swagger.json");

    it("resolves to the swagger spec", () => {
      expect(existsSync(swaggerPath)).toBe(true);
    });
  });

  describe("bin/callboard.js", () => {
    it("exists at the package root", () => {
      expect(existsSync(join(pkgRoot, "bin/callboard.js"))).toBe(true);
    });
  });
});
