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
 * Four things jsdom genuinely does not do. Each is measured, not assumed, and
 * each is worked around here rather than hand-waved in a comment:
 *
 * - **No `var()` substitution.** For the shorthand `background: var(--surface)`,
 *   `backgroundColor` reads back `"rgba(0, 0, 0, 0)"` — indistinguishable from
 *   an explicit `transparent` — while the `background` shorthand reads back the
 *   literal `"var(--surface)"`. For the longhand `background-color:
 *   var(--surface)` it is the other way round: `backgroundColor` itself holds
 *   the literal. Neither spelling yields a colour, so a test that cares what a
 *   var-backed property paints must read the declaration via `declarationsFor`
 *   and resolve the custom property itself, which does work:
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
 *   `getComputedStyle`.
 * - **No `!important`.** jsdom parses the flag — `getPropertyPriority` returns
 *   `"important"` — but resolves the cascade on specificity and source order
 *   alone, discarding importance. That fails in the dangerous direction: an
 *   `!important` a later or more specific *normal* declaration would beat is
 *   read back as if it were not there, so the guard goes green while the
 *   browser paints the override. `index.css` already carries a global
 *   `button { }` reset, which is exactly where someone reaches to force a
 *   background, and `!important` is the reflex when a reset appears not to
 *   take.
 *
 * The last two are the same hazard — a declaration the CSSOM holds but
 * `getComputedStyle` will not honour — so `declarationsJsdomIgnores` reports
 * both, and a test can fail loudly on the blind spot instead of silently
 * ceasing to cover it.
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

/**
 * Append the given sources to the document as one `<style>` element.
 *
 * The `sheet` is checked rather than asserted: jsdom refuses a stylesheet it
 * cannot parse — `@layer` and CSS nesting both do it, and both are legal CSS a
 * real browser handles — and leaves `el.sheet` null. Left as `el.sheet!` that
 * surfaces later as a `TypeError` from whichever helper touches it first,
 * which is a bisect rather than a message.
 */
export function injectCss(...sources: string[]): { sheet: CSSStyleSheet; remove: () => void } {
  const el = document.createElement("style");
  el.textContent = sources.join("\n");
  document.head.appendChild(el);
  const sheet = el.sheet;
  if (!sheet) {
    el.remove();
    throw new Error("jsdom parsed no stylesheet from the injected CSS. Its parser rejects the whole file on syntax it does not know — @layer and CSS nesting are the usual causes.");
  }
  return { sheet, remove: () => el.remove() };
}

/** Set — or with `null`, clear — the `data-theme` attribute the palette keys on. */
export function setTheme(mode: "dark" | "light" | null): void {
  if (mode === null) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

export interface Declaration {
  /** The `@media`/`@supports` conditions this rule sits under; "" at top level. */
  condition: string;
  selectorText: string;
  /** Property name as authored, so a shorthand stays `background`. */
  property: string;
  value: string;
  important: boolean;
}

/**
 * Every declaration in the sheet, in source order, at any nesting depth.
 *
 * Keyframes are skipped: their children are `CSSKeyframeRule`s keyed by
 * percentage rather than selectors, and they are not part of any element's
 * cascade.
 */
function allDeclarations(sheet: CSSStyleSheet): Declaration[] {
  const out: Declaration[] = [];

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
      if (typeof selectorText !== "string") continue;

      // Index access rather than `.item(i)`: the CSSStyleDeclaration jsdom
      // hangs off a rule inside an at-rule is array-like but has no `item`,
      // and calling it throws.
      const style = rule.style as unknown as CSSStyleDeclaration & { length: number } & Record<number, string>;
      for (let i = 0; i < style.length; i++) {
        const property = style[i];
        out.push({
          condition,
          selectorText,
          property,
          value: style.getPropertyValue(property),
          important: style.getPropertyPriority(property) === "important",
        });
      }
    }
  };

  walk(sheet.cssRules, "");
  return out;
}

/**
 * Does `element` match this rule's selector?
 *
 * Wrapped only so a selector jsdom's engine cannot parse names itself in the
 * failure. Nothing in `index.css` throws today, `:has()` included.
 */
export function matchesSelector(element: Element, selectorText: string): boolean {
  try {
    return element.matches(selectorText);
  } catch (cause) {
    throw new Error(`jsdom could not evaluate the selector \`${selectorText}\``, { cause });
  }
}

/**
 * Declarations of `propertyPrefix` that apply to `element`, in source order.
 *
 * For reading what a property was *authored* as when `getComputedStyle` will
 * not resolve it — a `var()` reference, most often. Callers should assert on
 * the number of hits rather than blindly taking the last: this reports the
 * cascade's inputs, not its winner, and does not model specificity.
 */
export function declarationsFor(sheet: CSSStyleSheet, element: Element, propertyPrefix: string): Declaration[] {
  return allDeclarations(sheet).filter((d) => d.property.startsWith(propertyPrefix) && matchesSelector(element, d.selectorText));
}

/**
 * Declarations the CSSOM holds but `getComputedStyle` will not honour here:
 * anything under an `@media`/`@supports` condition, and anything flagged
 * `!important`.
 *
 * Both are invisible to the resolved-cascade assertions, and both fail in the
 * direction that goes green while the browser breaks. An `!important` jsdom
 * would have honoured anyway is still reported — its outcome was reached by
 * the wrong rule, and the caller filtering by element and property is what
 * keeps that from being noise.
 */
export function declarationsJsdomIgnores(sheet: CSSStyleSheet): Declaration[] {
  return allDeclarations(sheet).filter((d) => d.condition !== "" || d.important);
}
