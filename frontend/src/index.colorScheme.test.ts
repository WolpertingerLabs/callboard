/**
 * `color-scheme` is the one theme token the CSS variables cannot carry.
 *
 * Every colour in this app comes from a custom property, and none of them
 * reach the chrome the browser paints itself: a bare `<button>`'s fill, a
 * scrollbar, a `<select>`'s dropdown popup and arrow, checkbox and radio
 * glyphs, spin buttons, date pickers, autofill highlighting. That surface is
 * drawn from the user agent's own palette, and `color-scheme` is the only
 * property that picks which one. Undeclared, it resolves to `normal` — light —
 * regardless of what `--bg` says, so the dark theme was painting light-mode
 * widgets throughout.
 *
 * The bug that found this: ComputerUsePanel's collapsed heading is a
 * `<button>` with no `background`, so it fell through to Chrome's `buttonface`
 * (#efefef) and drew a full-width light band across the dark chat view,
 * directly above the composer, with near-white --text on it. That component
 * now sets its own background — but a rule that only fixed the one button
 * would leave every other native widget still light, which is why the pair
 * below exists as well.
 *
 * These assert against the stylesheet rather than a rendered node because
 * jsdom implements no cascade and no user-agent stylesheet: `getComputedStyle`
 * on `<html>` returns the empty string for `color-scheme` whether or not the
 * declaration is there, so a DOM-based test would pass on the broken code.
 * `index.html` sets `data-theme` before first paint, so exactly one of these
 * two blocks is live from the very first frame.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// Not `new URL("./index.css", import.meta.url)`: Vite rewrites that pattern
// into an asset reference, and the http URL it hands back is not something fs
// can open.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[2] ?? "";
}

const colorScheme = (selector: string) => /(^|;)\s*color-scheme\s*:\s*([a-z ]+?)\s*(;|$)/.exec(block(selector))?.[2];

describe("native widget color-scheme", () => {
  it("declares dark on the :root default", () => {
    expect(colorScheme(":root")).toBe("dark");
  });

  it("declares light on the light-theme override", () => {
    expect(colorScheme('[data-theme="light"]')).toBe("light");
  });

  it("keeps the two in the same order the rest of the palette uses", () => {
    // [data-theme="light"] has the same specificity as :root, so it only wins
    // by coming later. If the blocks were ever reordered, light mode would get
    // dark native chrome and nothing in the variables would hint at why.
    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf('[data-theme="light"] {'));
  });
});
