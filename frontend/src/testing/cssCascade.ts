/**
 * Load the app's real stylesheets into jsdom and read the cascade back out.
 *
 * The reason a CSS bug looks untestable here is narrower than it first appears.
 * jsdom *does* implement the cascade — selector specificity, source order,
 * attribute selectors like `[data-theme="light"]`, custom properties. What it
 * does not do is run Vite's CSS pipeline: vitest ignores `import "./index.css"`
 * entirely, so nothing reaches the document and `getComputedStyle` has nothing
 * to resolve. Inject the file's text as a `<style>` element and the value you
 * read back is the one the cascade actually produces.
 *
 * That distinction is load-bearing. Asserting on the stylesheet *text* instead
 * — regexing out a rule body — reproduces a bug this repo has already fixed
 * once on the backend side (`theme-contrast.stylesheet.test.ts` documents it):
 * a first-match parser drops a second `:root` block, which is the ordinary way
 * to extend a stylesheet, so the guard goes green while the app is broken.
 *
 * Three things jsdom genuinely does not do. Callers must work around them
 * rather than quietly assume them away:
 *
 * - **No `var()` substitution.** `background: var(--surface)` leaves
 *   `backgroundColor` empty and reads back from the shorthand as the literal
 *   `var(--surface)`. The custom properties themselves resolve fine, via
 *   `getComputedStyle(el).getPropertyValue("--surface")`.
 * - **No system-colour resolution.** jsdom's own UA stylesheet *does* carry
 *   Chrome's `button { background-color: buttonface }`, so the fall-through
 *   this codebase's bare buttons suffer is reproducible as-is. What jsdom does
 *   not do is resolve the `buttonface` keyword to a colour — a real browser
 *   picks one from `color-scheme` (light grey under `light`, mid grey under
 *   `dark`), jsdom hands back the keyword. Either way it is not transparent,
 *   which is the only distinction a test needs.
 * - **No `@media` evaluation, at any viewport.** Media rules are parsed into
 *   the CSSOM but never applied; `window.resizeTo` is a no-op and there is no
 *   `matchMedia`. A rule that only breaks on a phone is therefore invisible to
 *   `getComputedStyle`. `conditionalRules` exists so a test can fail loudly on
 *   that blind spot instead of silently ceasing to cover it.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// `frontend/src`, this file's parent's parent.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read a stylesheet from disk, by path relative to `frontend/src`.
 *
 * Deliberately not `new URL("./x.css", import.meta.url)`: Vite rewrites that
 * two-argument form into an asset reference and hands back an http URL, which
 * `readFileSync` rejects with `TypeError: The URL must be of scheme file`.
 * (`import.meta.url` on its own is a normal file URL.)
 */
export function readCss(relativeToSrc: string): string {
  return readFileSync(join(SRC, relativeToSrc), "utf8");
}

/**
 * What a `<button>` with no author `background` resolves to — the fill this
 * codebase's bare buttons fall through to. Supplied by jsdom's own UA
 * stylesheet, not by anything here, so a test that depends on it should assert
 * it is live rather than assume a future jsdom still ships it.
 */
export const UA_BUTTON_FILL = "buttonface";

/** Fully transparent, as `getComputedStyle` reports it. */
export const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** Append the given sources to the document as one `<style>` element. */
export function injectCss(...sources: string[]): { sheet: CSSStyleSheet; remove: () => void } {
  const el = document.createElement("style");
  el.textContent = sources.join("\n");
  document.head.appendChild(el);
  return { sheet: el.sheet!, remove: () => el.remove() };
}

/** Set — or with `null`, clear — the `data-theme` attribute the palette keys on. */
export function setTheme(mode: "dark" | "light" | null): void {
  if (mode === null) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

export interface ConditionalRule {
  /** The `@media`/`@supports` conditions this rule sits under, outermost first. */
  condition: string;
  selectorText: string;
  /** Longhand property names the rule declares, as jsdom expanded them. */
  properties: string[];
}

/**
 * Every style rule nested inside a conditional at-rule, with its condition.
 *
 * These are exactly the declarations `getComputedStyle` will not see, so a test
 * that cares about a property can assert that nothing redeclares it out of
 * reach. Keyframes are skipped: their children are `CSSKeyframeRule`s keyed by
 * percentage, not selectors, and they are not part of any element's cascade.
 */
export function conditionalRules(sheet: CSSStyleSheet): ConditionalRule[] {
  const out: ConditionalRule[] = [];

  const walk = (rules: CSSRuleList, condition: string) => {
    for (const rule of Array.from(rules) as (CSSRule & Record<string, unknown>)[]) {
      if (rule.constructor.name === "CSSKeyframesRule") continue;

      const nested = rule.cssRules as CSSRuleList | undefined;
      if (nested) {
        const own = (rule.conditionText as string | undefined) ?? ((rule.media as MediaList | undefined)?.mediaText || "");
        walk(nested, [condition, own].filter(Boolean).join(" and "));
        continue;
      }

      const selectorText = rule.selectorText as string | undefined;
      if (!condition || typeof selectorText !== "string") continue;

      // Index access rather than `.item(i)`: the CSSStyleDeclaration jsdom
      // hangs off a rule inside an at-rule is array-like but has no `item`,
      // and calling it throws. Names come back as authored, so a shorthand
      // stays `background` rather than expanding to `background-color`.
      const style = rule.style as unknown as { length: number } & Record<number, string>;
      const properties: string[] = [];
      for (let i = 0; i < style.length; i++) properties.push(style[i]);
      out.push({ condition, selectorText, properties });
    }
  };

  walk(sheet.cssRules, "");
  return out;
}
