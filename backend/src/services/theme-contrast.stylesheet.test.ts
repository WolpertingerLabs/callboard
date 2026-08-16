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
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { BUILTIN_PALETTE } from "./theme-contrast-palette.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";
import { composite, contrastRatio, effectiveVars, resolveColor } from "./theme-contrast.js";

const INDEX_CSS = join(dirname(fileURLToPath(import.meta.url)), "../../../frontend/src/index.css");

/**
 * Walk a stylesheet's rules, yielding each `prelude { body }` pair.
 *
 * Nested rules are only descended into for at-rules, and the depth is reported,
 * because the difference matters to the caller: a declaration inside `@media`
 * applies conditionally, and a parser that flattened it would report a value the
 * browser might never use.
 */
function* rules(css: string, depth = 0): Generator<{ prelude: string; body: string; depth: number }> {
  let i = 0;
  let start = 0;
  while (i < css.length) {
    if (css[i] !== "{") {
      i++;
      continue;
    }
    let open = 0;
    let end = i;
    for (; end < css.length; end++) {
      if (css[end] === "{") open++;
      else if (css[end] === "}" && --open === 0) break;
    }
    const prelude = css.slice(start, i).replace(/\s+/g, " ").trim();
    const body = css.slice(i + 1, end);
    yield { prelude, body, depth };
    if (prelude.startsWith("@")) yield* rules(body, depth + 1);
    i = end + 1;
    start = i;
  }
}

/**
 * Parse one selector's custom-property declarations.
 *
 * Three things here are corrections, and all three are the same class of bug as
 * the one this file exists to catch — a parser that silently sees less than the
 * stylesheet says, so a variable drifts out of the audit without anything going
 * red:
 *
 * - **Comments are stripped first.** #293's audit tool read declarations
 *   straight out of the raw text, so the moment a comment explained why
 *   `--warning` had moved, the prose parsed as a second declaration of it and
 *   shadowed the real value. Eight rows went blank and were nearly published.
 * - **A declaration needs no trailing semicolon.** Legal CSS omits it on the
 *   last one in a block, and the old `[^;]+;` required it — so a variable added
 *   at the end of `:root` was invisible to both the palette and the names test.
 *   There is no stylelint and no prettier in `prepublishOnly` to add it for you.
 * - **Every matching rule is merged, in document order.** `indexOf(selector)`
 *   found the first block and stopped, so a second `:root` — the ordinary way to
 *   add a section to a stylesheet — was dropped entirely. Matching is on the
 *   normalised prelude rather than a substring, so `[data-theme="light"] .row`
 *   is no longer mistaken for the light palette block.
 *
 * The one blind spot left is deliberate and loud: a matching selector nested
 * inside an at-rule throws rather than being merged or ignored, since neither
 * would be true. `:root` in `@media print` is not the palette, and silently
 * treating it as such — or silently not — is how this class of bug starts.
 */
function declarations(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const wanted = selector.replace(/\s+/g, " ").trim();
  const out: Record<string, string> = {};
  let found = false;

  for (const rule of rules(clean)) {
    if (rule.prelude !== wanted) continue;
    if (rule.depth > 0) throw new Error(`selector ${selector} appears inside an at-rule, where its declarations apply conditionally`);
    found = true;
    // Split on ";" rather than requiring one: the last declaration in a block
    // legally has none.
    for (const decl of rule.body.split(";")) {
      const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i.exec(decl);
      if (m) out[m[1].slice(2)] = m[2].replace(/\s+/g, " ");
    }
  }

  if (!found) throw new Error(`selector ${selector} not found in index.css`);
  return out;
}

const css = readFileSync(INDEX_CSS, "utf8");
const DARK = declarations(css, ":root");
const LIGHT = declarations(css, '[data-theme="light"]');

/**
 * Typography, geometry and one opacity: theme-adjacent, but not part of the
 * palette. The shared property is that none of them names a colour, so there is
 * nothing for a theme author to pick and nothing for the pairing table to
 * measure — `--chatlist-item-dimmed-opacity` is a scalar the browser multiplies
 * a whole row by, not a foreground or a background.
 */
const NON_VISUAL = ["font-mono", "radius", "safe-bottom", "chatlist-item-dimmed-opacity"];
/** A value that defers to another variable rather than choosing anything itself. */
const isDerived = (value: string) => /var\(|color-mix\(/.test(value);

describe("the stylesheet parser", () => {
  it("ignores a declaration that only appears inside a comment", () => {
    const trap = `:root {\n  --warning: #d29922;\n  /* --warning: #000000; explains why the real one moved */\n  --text: #fff;\n}`;
    expect(declarations(trap, ":root")).toEqual({ warning: "#d29922", text: "#fff" });
  });

  it("sees the last declaration in a block even without a trailing semicolon", () => {
    // Legal CSS, and the exact shape of "someone added a variable at the end".
    // The old parser required the `;` and silently dropped it — which is this
    // whole file's failure mode, a check that quietly stops checking.
    expect(declarations(`:root {\n  --bg: #0d1117;\n  --accent: #7c6aef\n}`, ":root")).toEqual({ bg: "#0d1117", accent: "#7c6aef" });
  });

  it("merges a second block of the same selector, later winning", () => {
    // Splitting a stylesheet into sections is ordinary; `indexOf` found the
    // first `:root` and stopped, so an entire section could go unaudited.
    const two = `:root {\n  --bg: #0d1117;\n  --accent: #111111;\n}\n.x { color: red; }\n:root {\n  --accent: #7c6aef;\n  --text: #fff;\n}`;
    expect(declarations(two, ":root")).toEqual({ bg: "#0d1117", accent: "#7c6aef", text: "#fff" });
  });

  it("matches the whole selector, not a prefix of one", () => {
    // `[data-theme="light"] .chat-row` is a different rule, and reading its
    // declarations as the light palette's would be worse than reading none.
    const compound = `[data-theme="light"] .chat-row {\n  --text: #ff0000;\n}\n[data-theme="light"] {\n  --text: #1f2328;\n}`;
    expect(declarations(compound, '[data-theme="light"]')).toEqual({ text: "#1f2328" });
  });

  it("refuses a match nested inside an at-rule rather than guessing at the cascade", () => {
    // Merging it would claim a conditional value always applies; skipping it
    // silently would hide a real palette override. Neither is honest.
    const nested = `@media print {\n  :root {\n    --bg: #ffffff;\n  }\n}`;
    expect(() => declarations(nested, ":root")).toThrow(/at-rule/);
  });

  it("throws when the selector is absent, instead of returning an empty palette", () => {
    expect(() => declarations(`.x { color: red; }`, ":root")).toThrow(/not found/);
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

/**
 * `--chatlist-item-dimmed-opacity` is the one palette-adjacent token the pairing
 * table structurally cannot measure: it is a scalar the browser multiplies a
 * whole row by, not a foreground on a background. So it gets its own
 * measurement, taken the same way — composite, then ratio — rather than a
 * judgement about what looks faded.
 *
 * What is pinned is the row *title* (`--chatlist-item-title-text`), the body
 * text of a chat row. The row's secondary text is deliberately not pinned here:
 * `--text-muted` on `--bg-sidebar` is 5.75:1 dark / 5.63:1 light before any
 * fade, so AA caps *any* opacity dim at 0.85 / 0.90 — not a visible dim. That
 * is a property of fading with opacity, and the honest place to record it is
 * here, next to the number it constrains, rather than in a commit message.
 */
describe("the dimmed chat row", () => {
  const DIMMED_TITLE_RATIOS: Record<"dark" | "light", number> = { dark: 5.31, light: 5.2 };

  for (const mode of ["dark", "light"] as const) {
    it(`keeps a faded row's title above AA in ${mode}`, () => {
      const opacity = Number((mode === "dark" ? DARK : LIGHT)["chatlist-item-dimmed-opacity"]);
      expect(Number.isFinite(opacity), "opacity parses as a number").toBe(true);

      const vars = effectiveVars(undefined, mode);
      const backdrop = resolveColor("var(--bg-sidebar)", vars)!;
      // The row paints no background of its own (--chatlist-item-bg is
      // transparent), so `opacity` composites the title straight onto the
      // sidebar at that alpha.
      const title = composite(resolveColor("var(--chatlist-item-title-text)", vars)!, backdrop);
      const ratio = contrastRatio(composite({ ...title, a: opacity }, backdrop), backdrop);

      expect(ratio).toBeGreaterThanOrEqual(4.5);
      // Pinned so a change to --text, --bg-sidebar or the opacity itself has to
      // restate the measurement rather than drift past it.
      expect(Number(ratio.toFixed(2))).toBe(DIMMED_TITLE_RATIOS[mode]);
    });
  }

  it("is measuring the fade, not reporting the undimmed row", () => {
    // At opacity 1 this same computation is 14.97:1 / 12.92:1 — a test that had
    // quietly stopped applying the alpha would still pass the AA assertion
    // above, and only this one would notice.
    for (const mode of ["dark", "light"] as const) {
      const vars = effectiveVars(undefined, mode);
      const backdrop = resolveColor("var(--bg-sidebar)", vars)!;
      const title = composite(resolveColor("var(--chatlist-item-title-text)", vars)!, backdrop);
      expect(contrastRatio(title, backdrop)).toBeGreaterThan(DIMMED_TITLE_RATIOS[mode] * 2);
    }
  });
});

/**
 * `background: var(--accent)`, `color: var(--accent-text)`.
 *
 * The pairing table cannot catch a violation of this. It measures named
 * pairings, and a component that writes `color: "var(--accent)"` inline invents
 * a pairing nobody listed — which is how ~95 sites sat between 3.79:1 and
 * 4.65:1 through two contrast passes without a single number going red.
 *
 * They are not a style preference. `--accent` is the fill white is painted on,
 * so AA caps its luminance at 0.183, and a colour that dark reads 3.16:1 as ink
 * on `--bg-popout`. The two roles pull in opposite directions and one token
 * cannot serve both — `--accent-text` is the other half, derived from `--accent`
 * so a theme still drives it.
 *
 * Scoped to `color:` on purpose. Fills, borders and dots keep naming `--accent`
 * and should: `background: var(--accent)` is the correct half of the rule.
 */
describe("the accent fill/ink split", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../frontend/src");
  /** `color: "var(--accent)"` but not `backgroundColor:`/`borderTopColor:`/… */
  const INK = /(?<![A-Za-z])color:\s*(["'`]?)var\(--accent\)\1/g;

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(tsx?|css)$/.test(e.name) ? [full] : [];
    });
  }

  it("leaves no component painting the brand fill as text", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          INK.lastIndex = 0;
          if (INK.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("still finds the sites it is meant to find", () => {
    // A regex that matches nothing passes the test above for free.
    const probe = (line: string) => {
      INK.lastIndex = 0;
      return INK.test(line);
    };
    expect(probe(`style={{ color: "var(--accent)" }}`)).toBe(true);
    expect(probe(`  color: var(--accent);`)).toBe(true);
    expect(probe(`{ color: 'var(--accent)', flexShrink: 0 }`)).toBe(true);
    // The half of the rule that stays.
    expect(probe(`background: "var(--accent)"`)).toBe(false);
    expect(probe(`borderTopColor: "var(--accent)"`)).toBe(false);
    expect(probe(`backgroundColor: "var(--accent)"`)).toBe(false);
    expect(probe(`color: "var(--accent-text)"`)).toBe(false);
  });
});
