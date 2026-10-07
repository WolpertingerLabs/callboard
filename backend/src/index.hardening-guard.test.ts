/**
 * Source guards for what `http-hardening.wire.test.ts` cannot see. That suite
 * assembles its own app from `applyHttpHardening` and the real routers, so it
 * would stay green if `index.ts` re-added `cors()` or mounted something ahead
 * of the hardening middleware. These two checks pin the daemon's own wiring:
 *
 * - nothing under backend/src imports the `cors` package (a reflective
 *   `cors({ origin: true, credentials: true })` let any other port on this host
 *   read every authenticated response — see utils/security-headers.ts);
 * - `applyHttpHardening(app)` is the first thing done to the app in index.ts,
 *   so every response, including the auth routes' and early refusals, gets the
 *   headers.
 *
 * Comments are stripped first, so prose about CORS doesn't count.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Drop block and line comments. `://` (URLs in strings) is not a comment. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("no CORS", () => {
  it("nothing under backend/src imports the cors package", () => {
    const importsCors = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']cors["']/m;
    const offenders = sourceFiles(SRC)
      .filter((file) => importsCors.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe("index.ts", () => {
  const index = stripComments(readFileSync(join(SRC, "index.ts"), "utf8"));

  it("applies the hardening before anything else is mounted on the app", () => {
    const created = index.indexOf("const app = express()");
    const hardened = index.indexOf("applyHttpHardening(app)");
    expect(created).toBeGreaterThan(-1);
    expect(hardened).toBeGreaterThan(created);
    // Anything that registers middleware or a route, or changes app settings.
    const between = index.slice(created + "const app = express()".length, hardened);
    expect(between).not.toMatch(/\bapp\s*\.\s*(use|get|post|put|patch|delete|all|options|head|route|set|enable|disable|engine|param)\s*\(/);
  });
});
