/**
 * `"var(--danger)22"` looks like "--danger at 0x22 alpha" — the hex-suffix
 * trick that works on a literal `#dc3545` — but appended to a `var()` it is
 * just invalid CSS, so the browser drops the whole declaration and the element
 * renders with no background at all. A tinted variant of a token is its own
 * variable (`--danger-bg`, `--warning-bg`, …) or a `color-mix()`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = __dirname;
const VAR_WITH_HEX_SUFFIX = /var\(--[\w-]+(?:,[^)]*)?\)[0-9a-fA-F]{2}\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("CSS variables", () => {
  it("are never followed by a hex alpha suffix", () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => (VAR_WITH_HEX_SUFFIX.test(line) ? `${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null),
    );
    expect(offenders).toEqual([]);
  });
});
