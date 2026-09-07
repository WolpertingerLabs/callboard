/**
 * `color-scheme` is the one theme token the CSS variables cannot carry.
 *
 * Every colour in this app comes from a custom property, and none of them
 * reach the chrome the browser paints itself: a bare `<button>`'s fill, a
 * scrollbar, a `<select>`'s dropdown popup and arrow, checkbox and radio
 * glyphs, spin buttons, date pickers, the keyboard focus ring. That surface is
 * drawn from the user agent's own palette, and `color-scheme` is the only
 * property that picks which one. Undeclared, it resolves to `normal` — light —
 * regardless of what `--bg` says, so the dark theme was painting light-mode
 * widgets throughout.
 *
 * The bug that found this: ComputerUsePanel's collapsed heading is a
 * `<button>` with no `background`, so it fell through to the UA's `buttonface`
 * and drew a full-width light band across the dark chat view, directly above
 * the composer. Both halves are needed and neither substitutes for the other —
 * under `color-scheme: dark`, `buttonface` is still a visible mid-grey — so
 * the heading's own background is guarded separately, in
 * `components/ComputerUsePanel.test.tsx`.
 *
 * These assert the *resolved* cascade rather than the stylesheet's text. Both
 * `:root` and `[data-theme="light"]` have specificity (0,1,0), so light mode
 * wins only by coming later, and a second `:root` appended anywhere below —
 * the ordinary way to add a section to a stylesheet — silently takes over the
 * whole dark theme. Reading `getComputedStyle` is what makes that visible;
 * matching rule bodies out of the file is what hides it. See
 * `testing/cssCascade.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conditionalRules, injectCss, readCss, setTheme } from "./testing/cssCascade";

let sheet: CSSStyleSheet;
let remove: () => void;

beforeAll(() => {
  ({ sheet, remove } = injectCss(readCss("index.css")));
});

afterAll(() => {
  remove();
  setTheme(null);
});

const colorScheme = () => getComputedStyle(document.documentElement).colorScheme;

describe("native widget color-scheme", () => {
  it("resolves to dark under the dark theme", () => {
    setTheme("dark");
    expect(colorScheme()).toBe("dark");
  });

  it("resolves to light under the light theme", () => {
    setTheme("light");
    expect(colorScheme()).toBe("light");
  });

  it("resolves to dark before a theme has been chosen", () => {
    // index.html sets data-theme before first paint and falls back to "dark" if
    // localStorage throws, so this is the state of the very first frame.
    setTheme(null);
    expect(colorScheme()).toBe("dark");
  });

  it("declares color-scheme nowhere the resolved cascade cannot see it", () => {
    // jsdom applies no @media rule at any viewport, so a color-scheme hidden
    // inside one would leave the three tests above passing while the theme
    // broke on exactly the phone viewport this was reported from. Nothing
    // declares it conditionally today; if that changes, this should fail rather
    // than quietly stop covering it.
    const conditional = conditionalRules(sheet).filter((rule) => rule.properties.includes("color-scheme"));
    expect(conditional).toEqual([]);
  });
});
