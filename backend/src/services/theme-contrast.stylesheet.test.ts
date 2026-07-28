/**
 * Ties two hand-maintained lists back to `frontend/src/index.css`:
 *
 * - BUILTIN_PALETTE, the fallback layer every theme measurement resolves against
 * - THEME_VARIABLE_NAMES, the set a generated theme is asked to provide
 *
 * Both are copies of something the stylesheet already knows, and both have
 * already drifted once — THEME_VARIABLE_NAMES is how `--status-green` and
 * `--info-bg` ended up as arbitrary exceptions. A copy without a test is a
 * comment; these are the tests that make them claims.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { BUILTIN_PALETTE } from "./theme-contrast-palette.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";

const INDEX_CSS = join(dirname(fileURLToPath(import.meta.url)), "../../../frontend/src/index.css");

/**
 * Parse one rule's custom-property declarations.
 *
 * Comments are stripped *first*, and that is not incidental tidiness. #293's
 * audit tool read declarations straight out of the raw text, so the moment a
 * comment explained why `--warning` had moved, the prose parsed as a second
 * declaration of it and shadowed the real value — eight rows went blank and
 * were nearly published as fact. Stripping first is the whole fix.
 */
function declarations(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = clean.indexOf(selector);
  if (at < 0) throw new Error(`selector ${selector} not found in index.css`);
  const open = clean.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (; end < clean.length; end++) {
    if (clean[end] === "{") depth++;
    else if (clean[end] === "}" && --depth === 0) break;
  }
  const out: Record<string, string> = {};
  for (const m of clean.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1].slice(2)] = m[2].trim().replace(/\s+/g, " ");
  }
  return out;
}

const css = readFileSync(INDEX_CSS, "utf8");
const DARK = declarations(css, ":root");
const LIGHT = declarations(css, '[data-theme="light"]');

/** Typography and geometry: theme-adjacent, but not part of the palette. */
const NON_VISUAL = ["font-mono", "radius", "safe-bottom"];
/** A value that defers to another variable rather than choosing anything itself. */
const isDerived = (value: string) => /var\(|color-mix\(/.test(value);

describe("the comment-stripping parser", () => {
  it("ignores a declaration that only appears inside a comment", () => {
    const trap = `:root {\n  --warning: #d29922;\n  /* --warning: #000000; explains why the real one moved */\n  --text: #fff;\n}`;
    expect(declarations(trap, ":root")).toEqual({ warning: "#d29922", text: "#fff" });
  });

  it("reads the real stylesheet, not an empty object", () => {
    // The failure mode above is silent: a broken parser returns fewer keys, and
    // every comparison below then trivially passes on nothing.
    expect(Object.keys(DARK).length).toBeGreaterThan(100);
    // Light overrides every variable :root defines except the three that are
    // neither colour nor mode-dependent.
    expect(Object.keys(DARK).filter((k) => !(k in LIGHT))).toEqual(["font-mono", "radius", "safe-bottom"]);
    expect(Object.keys(LIGHT).filter((k) => !(k in DARK))).toEqual([]);
  });
});

describe("BUILTIN_PALETTE", () => {
  for (const [mode, block] of [
    ["dark", DARK],
    ["light", LIGHT],
  ] as const) {
    it(`holds every visual ${mode} variable, verbatim`, () => {
      const expected = Object.fromEntries(Object.entries(block).filter(([name]) => !NON_VISUAL.includes(name)));
      expect(BUILTIN_PALETTE[mode]).toEqual(expected);
    });
  }

  it("keeps derived entries as expressions — flattening them would break the cascade a theme rides", () => {
    expect(BUILTIN_PALETTE.dark["chatlist-badge-triggered-bg"]).toContain("var(--status-triggered)");
    expect(BUILTIN_PALETTE.light["chatlist-item-active-bg"]).toBe("var(--accent-light)");
  });
});

describe("THEME_VARIABLE_NAMES", () => {
  /**
   * The rule, stated once: a theme may define exactly the variables index.css
   * defines with a literal value, minus the ones with no colour to choose and
   * the non-visual tokens.
   */
  const COLOURLESS = ["chatlist-header-bg", "chatlist-item-bg"]; // literal `transparent`

  const expected = Object.keys(DARK).filter(
    (name) => !isDerived(DARK[name]) && !isDerived(LIGHT[name]) && DARK[name] !== "transparent" && !NON_VISUAL.includes(name),
  );

  it("is exactly the stylesheet's literal-valued visual tokens", () => {
    expect([...THEME_VARIABLE_NAMES].sort()).toEqual([...expected].sort());
  });

  it("names the five that had drifted out of it", () => {
    // The asymmetry this branch closes: a stored theme used to override
    // --status-triggered while inheriting --status-green and --info-bg.
    for (const name of ["bg-sidebar", "bg-popout", "info-bg", "status-green", "badge-provider-codex-bg"]) {
      expect(THEME_VARIABLE_NAMES, name).toContain(name);
    }
  });

  it("excludes the derived layer, so a theme's primitives still reach it", () => {
    for (const name of ["chatlist-badge-triggered-bg", "chatlist-summon-bg", "board-tile-bg", "badge-provider-text", "chatlist-item-active-bg"]) {
      expect(THEME_VARIABLE_NAMES, name).not.toContain(name);
    }
  });

  it("excludes the tokens with nothing to choose, and says which they are", () => {
    for (const name of [...COLOURLESS, ...NON_VISUAL]) {
      expect(THEME_VARIABLE_NAMES, name).not.toContain(name);
    }
    // COLOURLESS is a claim about the stylesheet, not a wish — check it holds.
    for (const name of COLOURLESS) expect(DARK[name]).toBe("transparent");
  });

  it("has no duplicates", () => {
    expect(new Set(THEME_VARIABLE_NAMES).size).toBe(THEME_VARIABLE_NAMES.length);
  });
});
