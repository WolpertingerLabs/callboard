/**
 * Contrast measurement for themes — built-in and stored alike.
 *
 * Why this is not `contrast(fg, bg)`:
 *
 * Almost every pairing that has ever failed in this palette puts a colour on a
 * *translucent tint*, not on an opaque fill. `--warning-bg` is
 * `rgba(133, 77, 14, 0.1)`; `--chatlist-badge-triggered-bg` is
 * `color-mix(in srgb, var(--status-triggered) 15%, transparent)`. What the eye
 * actually sees is that tint composited over whatever opaque surface is behind
 * it, and that surface differs by context: sidebar rows sit on `--bg-sidebar`,
 * modals on `--bg`, panels and hover rows on `--surface`. Measuring the tint's
 * own rgba, or assuming a single backdrop, gives numbers that are wrong in both
 * directions. So every pairing here names its backdrop explicitly, and the tint
 * is flattened onto it before the ratio is taken. This mirrors how #293
 * measured the built-in palette; PAIRING_TRIPWIRE in the tests pins the numbers.
 *
 * Themes are evaluated the same way the browser evaluates them: the theme's own
 * variables layered over BUILTIN_PALETTE (inline styles on <html> beat both
 * `:root` and `[data-theme="light"]`, but a variable the theme does not define
 * still cascades from the stylesheet). Resolution follows `var()` and
 * `color-mix()` chains, which is what lets a theme that only defines
 * `--status-triggered` still move `--chatlist-badge-triggered-bg` with it.
 */

import { BUILTIN_PALETTE } from "./theme-contrast-palette.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";
import type { CustomTheme, ThemeContrastReport, ThemeContrastFailure } from "shared/types/index.js";

export type ThemeMode = "dark" | "light";

export interface Rgba {
  /** 0-255 */
  r: number;
  /** 0-255 */
  g: number;
  /** 0-255 */
  b: number;
  /** 0-1 */
  a: number;
}

// ─── Colour parsing ─────────────────────────────────────────────────

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

/**
 * Memoisation for the three pure string→value parses below.
 *
 * Correction is a search, and a search re-reads the same strings relentlessly:
 * one candidate lightness for one variable re-resolves every pairing that
 * variable touches, and every one of those walks `var()` chains that bottom out
 * in the same handful of palette literals. Parsing is a pure function of the
 * string, so the second read of `rgba(99, 102, 241, 0.1)` cannot differ from the
 * first — caching it changes what the work costs, never what it says.
 *
 * The cap exists because the search *generates* strings: up to 201 candidate
 * colours per variable per round. Clearing wholesale on overflow rather than
 * evicting by age keeps the caches a pure accelerator — the answer at any point
 * is the answer the uncached parse would give, whatever is or is not resident.
 */
const PARSE_CACHE_LIMIT = 1 << 14;

function cached<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (cache.size >= PARSE_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

const COLOR_CACHE = new Map<string, Rgba | null>();

/**
 * Parse a literal CSS colour. Returns null for anything unrecognised.
 *
 * The result is copied out of the cache rather than shared, because an `Rgba` is
 * a plain mutable object and this is an exported function: handing two callers
 * the same one would make a caller that writes to it corrupt every later read.
 */
export function parseCssColor(raw: string): Rgba | null {
  const hit = cached(COLOR_CACHE, raw, () => parseLiteralColor(raw));
  return hit === null ? null : { ...hit };
}

function parseLiteralColor(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase();
  if (value in NAMED) return { ...NAMED[value] };

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const h = hex[1];
    const dup = (c: string) => parseInt(c + c, 16);
    if (h.length === 3) return { r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: 1 };
    if (h.length === 4) return { r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: dup(h[3]) / 255 };
    if (h.length === 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    if (h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }

  // rgb()/rgba(), comma or space separated, alpha as number or percentage.
  const fn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (fn) {
    const parts = fn[1]
      .replace(/\//g, " ")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const chan = (s: string) => (s.endsWith("%") ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    const r = chan(parts[0]);
    const g = chan(parts[1]);
    const b = chan(parts[2]);
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
  }

  // hsl()/hsla(). Not a shape this stylesheet uses, but valid CSS and the
  // notation a model reaches for when asked to vary one colour's lightness — and
  // an unparseable value is not a soft failure here: every pairing touching it
  // becomes unmeasurable, which correction cannot fix, which means rejection.
  // Refusing to read a legal colour is a rejection the author cannot act on.
  const hslFn = /^hsla?\(([^)]*)\)$/.exec(value);
  if (hslFn) {
    const parts = hslFn[1]
      .replace(/\//g, " ")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    // Hue is an angle: bare number = degrees, and the three other CSS units are
    // accepted because a model that writes `turn` means it.
    const hueUnit = /^(-?\d*\.?\d+)(deg|grad|rad|turn)?$/.exec(parts[0]);
    if (!hueUnit) return null;
    const hueScale = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 } as const;
    const h = parseFloat(hueUnit[1]) * (hueUnit[2] ? hueScale[hueUnit[2] as keyof typeof hueScale] : 1);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([h, s, l, a].some((n) => !Number.isFinite(n))) return null;
    return { ...hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)), a: clamp(a, 0, 1) };
  }

  return null;
}

/** CSS Color 4's hsl→rgb, hue in degrees, s and l as 0-1. */
function hslToRgb(hue: number, s: number, l: number): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Split a comma-separated argument list, respecting nested parentheses. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const MAX_RESOLVE_DEPTH = 16;

/**
 * What an expression *is*, decided once per distinct string.
 *
 * The shape of `color-mix(in srgb, var(--x) 15%, transparent)` — that it is a
 * mix, of those two arguments, at that weight — depends only on the characters,
 * never on the variable map resolved against. Both walkers below ran the same
 * three regexes and the same `splitArgs` on every visit, on every candidate of
 * every scan; deciding it once and reading the answer back is the same walk with
 * the lexing lifted out of the loop.
 */
type ParsedExpr =
  | { kind: "var"; name: string; fallback: string | undefined }
  | { kind: "mix"; args: Array<{ colorExpr: string; weight: number | null }> }
  | { kind: "color" };

const EXPR_CACHE = new Map<string, ParsedExpr>();

function parseExpr(value: string): ParsedExpr {
  return cached(EXPR_CACHE, value, () => {
    const varRef = /^var\(\s*--([a-z0-9-]+)\s*(?:,([\s\S]*))?\)$/i.exec(value);
    if (varRef) return { kind: "var", name: varRef[1], fallback: varRef[2] };

    const mix = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/i.exec(value);
    if (mix) {
      return {
        kind: "mix",
        args: splitArgs(mix[1]).map((arg) => {
          const pct = /\s(\d+(?:\.\d+)?)%$/.exec(arg);
          return { colorExpr: pct ? arg.slice(0, pct.index).trim() : arg, weight: pct ? parseFloat(pct[1]) / 100 : null };
        }),
      };
    }

    return { kind: "color" };
  });
}

/**
 * Resolve a CSS value expression to an Rgba, following `var()` and
 * `color-mix()` through the supplied variable map. Returns null if any link in
 * the chain is missing, cyclic, or not a colour this parser understands —
 * never a silent fallback, because an unmeasurable pairing must be reported as
 * unmeasurable rather than counted as passing.
 */
export function resolveColor(expr: string, vars: Record<string, string>, depth = 0): Rgba | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const value = expr.trim();
  const shape = parseExpr(value);

  if (shape.kind === "var") {
    const name = shape.name;
    if (name in vars) return resolveColor(vars[name], vars, depth + 1);
    if (shape.fallback !== undefined) return resolveColor(shape.fallback, vars, depth + 1);
    return null;
  }

  if (shape.kind === "mix") {
    if (shape.args.length !== 2) return null;
    const parsed = shape.args.map((arg) => ({ color: resolveColor(arg.colorExpr, vars, depth + 1), weight: arg.weight }));
    if (parsed.some((p) => p.color === null)) return null;
    let [w0, w1] = [parsed[0].weight, parsed[1].weight];
    if (w0 === null && w1 === null) [w0, w1] = [0.5, 0.5];
    else if (w0 === null) w0 = 1 - (w1 as number);
    else if (w1 === null) w1 = 1 - w0;
    const total = (w0 as number) + (w1 as number);
    if (total <= 0) return null;
    const p0 = (w0 as number) / total;
    const p1 = (w1 as number) / total;
    const c0 = parsed[0].color as Rgba;
    const c1 = parsed[1].color as Rgba;
    // Non-premultiplied srgb mixing, matching the CSS Color 5 definition for
    // the only shape this stylesheet uses (a colour mixed with `transparent`).
    const a = c0.a * p0 + c1.a * p1;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const chan = (k: "r" | "g" | "b") => (c0[k] * c0.a * p0 + c1[k] * c1.a * p1) / a;
    return { r: chan("r"), g: chan("g"), b: chan("b"), a };
  }

  return parseCssColor(value);
}

/**
 * Follow a failed resolution to the token that actually failed.
 *
 * `resolveColor` returns null for the whole expression, which makes for a
 * diagnostic nobody can act on: told that `var(--warning)` is unreadable, a
 * caller still does not know that `--warning` is the string `goldenrod`, and
 * cannot tell that from a `--warning` that is simply absent. This walks the same
 * chain and hands back the last thing it could not parse.
 */
function unresolvableToken(expr: string, vars: Record<string, string>, depth = 0): string {
  const value = expr.trim();
  if (depth > MAX_RESOLVE_DEPTH) return value;
  const shape = parseExpr(value);

  if (shape.kind === "var") {
    const name = shape.name;
    if (name in vars) return unresolvableToken(vars[name], vars, depth + 1);
    if (shape.fallback !== undefined) return unresolvableToken(shape.fallback, vars, depth + 1);
    return value; // the variable is not defined anywhere — the reference is the fault
  }

  if (shape.kind === "mix") {
    for (const { colorExpr } of shape.args) {
      if (resolveColor(colorExpr, vars, depth + 1) === null) return unresolvableToken(colorExpr, vars, depth + 1);
    }
    return value;
  }

  return value;
}

/** "var(--warning) → goldenrod", or just the expression when it is its own fault. */
function describeUnresolvable(expr: string, vars: Record<string, string>): string {
  const token = unresolvableToken(expr, vars);
  return token === expr.trim() ? token : `${expr.trim()} → ${token}`;
}

// ─── Compositing & WCAG ratio ───────────────────────────────────────

/** Flatten a possibly-translucent colour onto an opaque backdrop. */
export function composite(fg: Rgba, backdrop: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + backdrop.r * (1 - a),
    g: fg.g * a + backdrop.g * (1 - a),
    b: fg.b * a + backdrop.b * (1 - a),
    a: 1,
  };
}

export function relativeLuminance(c: Rgba): number {
  const lin = (n: number) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.1 contrast ratio. Both colours must already be opaque. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ─── OKLCh, for hue-preserving correction ───────────────────────────

/**
 * Correction moves lightness in OKLCh, not HSL.
 *
 * HSL's "saturation" is a ratio, so a pale cream (#f5e6d0) reads as *highly*
 * saturated; darkening it at constant S turns it into a strong brown rather
 * than the warm grey it perceptually is. OKLCh's chroma is absolute, so a pale
 * colour stays pale as it darkens, which is what "preserve the hue so the theme
 * still looks like what was asked for" actually means. The cost is that L and C
 * can leave the sRGB gamut, so `oklchToRgba` walks chroma down until the result
 * is representable — the standard chroma-reduction gamut map.
 */
export interface Oklch {
  /** Perceptual lightness, 0-1. */
  l: number;
  /** Chroma, ~0-0.4. */
  c: number;
  /** Hue, degrees. */
  h: number;
  a: number;
}

const srgbToLinear = (n: number) => {
  const s = n / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (n: number) => (n <= 0.0031308 ? n * 12.92 : 1.055 * Math.pow(n, 1 / 2.4) - 0.055) * 255;

export function rgbaToOklch(color: Rgba): Oklch {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(A, B);
  let hue = (Math.atan2(B, A) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { l: L, c: chroma, h: hue, a: color.a };
}

function oklabToRgbRaw(L: number, A: number, B: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklchToRgba({ l, c, h, a }: Oklch): Rgba {
  const rad = (h * Math.PI) / 180;
  const inGamut = (chroma: number): [number, number, number] | null => {
    const rgb = oklabToRgbRaw(l, chroma * Math.cos(rad), chroma * Math.sin(rad));
    return rgb.every((n) => n >= -1e-4 && n <= 1 + 1e-4) ? rgb : null;
  };
  let rgb = inGamut(c);
  if (!rgb) {
    // Binary search the largest representable chroma at this lightness.
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    rgb = oklabToRgbRaw(l, lo * Math.cos(rad), lo * Math.sin(rad));
  }
  return {
    r: clamp(linearToSrgb(clamp(rgb[0], 0, 1)), 0, 255),
    g: clamp(linearToSrgb(clamp(rgb[1], 0, 1)), 0, 255),
    b: clamp(linearToSrgb(clamp(rgb[2], 0, 1)), 0, 255),
    a,
  };
}

/**
 * The CSS a candidate lightness produces, for a fixed hue, chroma and alpha.
 *
 * The scans below ask for the same colour over and over: the seed search runs
 * the greedy pass up to 27 times from the same starting palette, so round one of
 * every seed re-derives the identical grid for the identical variable. Each
 * derivation is a gamut map, and for a saturated hue at an extreme lightness
 * that is a 24-step chroma binary search — the single most expensive thing in a
 * scan, and the top line of its profile. Keyed on the four numbers that decide
 * the answer, because that is exactly what it is a function of.
 */
const CANDIDATE_CACHE = new Map<string, string>();

function candidateCss(shape: Oklch, l: number): string {
  return cached(CANDIDATE_CACHE, `${shape.c}|${shape.h}|${shape.a}|${l}`, () => toCss(oklchToRgba({ ...shape, l })));
}

function toCss(c: Rgba): string {
  const h = (n: number) =>
    Math.round(clamp(n, 0, 255))
      .toString(16)
      .padStart(2, "0");
  if (c.a >= 1) return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return `rgba(${Math.round(clamp(c.r, 0, 255))}, ${Math.round(clamp(c.g, 0, 255))}, ${Math.round(clamp(c.b, 0, 255))}, ${Number(c.a.toFixed(3))})`;
}

// ─── The pairing table ──────────────────────────────────────────────

export interface Pairing {
  /** Stable id, safe to store in a report. */
  id: string;
  /** Where in the UI this is actually painted. */
  where: string;
  /** Foreground expression (usually `var(--x)`). */
  fg: string;
  /** Background expression — frequently a translucent tint. */
  bg: string;
  /** The opaque surface behind `bg`. */
  backdrop: string;
  /**
   * "text" → 4.5:1 (WCAG AA body text).
   * "nonText" → 3:1 (AA non-text contrast: status dots, toggle knobs).
   */
  kind: "text" | "nonText";
}

const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

export function minimumRatio(kind: Pairing["kind"]): number {
  return kind === "text" ? TEXT_MIN : NON_TEXT_MIN;
}

const v = (name: string) => `var(--${name})`;

/**
 * Every pairing this codebase actually paints, with the surface each one sits
 * on. Grouped by failure mode rather than by component, because the fix for a
 * family is the same wherever it appears.
 */
export const PAIRINGS: Pairing[] = [
  // ── Body text on opaque surfaces ──
  { id: "text-on-bg", where: "body text, main window", fg: v("text"), bg: v("bg"), backdrop: v("bg"), kind: "text" },
  { id: "text-on-surface", where: "body text, panels", fg: v("text"), bg: v("surface"), backdrop: v("surface"), kind: "text" },
  { id: "text-on-sidebar", where: "body text, sidebar", fg: v("text"), bg: v("bg-sidebar"), backdrop: v("bg-sidebar"), kind: "text" },
  { id: "text-on-popout", where: "body text, new-chat popout", fg: v("text"), bg: v("bg-popout"), backdrop: v("bg-popout"), kind: "text" },
  { id: "text-on-bg-secondary", where: "body text, secondary panels", fg: v("text"), bg: v("bg-secondary"), backdrop: v("bg-secondary"), kind: "text" },
  { id: "text-on-user-bg", where: "user message bubble", fg: v("text"), bg: v("user-bg"), backdrop: v("bg"), kind: "text" },
  { id: "text-on-assistant-bg", where: "assistant message bubble", fg: v("text"), bg: v("assistant-bg"), backdrop: v("bg"), kind: "text" },
  { id: "text-on-code-bg", where: "code blocks", fg: v("text"), bg: v("code-bg"), backdrop: v("bg"), kind: "text" },
  { id: "muted-on-bg", where: "secondary text, main window", fg: v("text-muted"), bg: v("bg"), backdrop: v("bg"), kind: "text" },
  { id: "muted-on-surface", where: "secondary text, panels", fg: v("text-muted"), bg: v("surface"), backdrop: v("surface"), kind: "text" },
  { id: "muted-on-sidebar", where: "chat list subtitles, timestamps", fg: v("text-muted"), bg: v("bg-sidebar"), backdrop: v("bg-sidebar"), kind: "text" },
  {
    id: "muted-on-bg-secondary",
    where: "secondary text, secondary panels",
    fg: v("text-muted"),
    bg: v("bg-secondary"),
    backdrop: v("bg-secondary"),
    kind: "text",
  },
  { id: "secondary-on-bg", where: "--text-secondary, main window", fg: v("text-secondary"), bg: v("bg"), backdrop: v("bg"), kind: "text" },
  { id: "secondary-on-surface", where: "--text-secondary, panels", fg: v("text-secondary"), bg: v("surface"), backdrop: v("surface"), kind: "text" },

  // ── Colour on a tint of itself: the family #293 fixed ──
  { id: "warning-on-warning-bg-surface", where: "McpToolsPanel 'external' badge", fg: v("warning"), bg: v("warning-bg"), backdrop: v("surface"), kind: "text" },
  {
    id: "warning-on-warning-bg-sidebar",
    where: "FolderListItem warning strip",
    fg: v("warning"),
    bg: v("warning-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  { id: "warning-on-warning-bg-bg", where: "CodeLoginModal warning box", fg: v("warning"), bg: v("warning-bg"), backdrop: v("bg"), kind: "text" },
  { id: "danger-on-danger-bg-surface", where: "JobRunPanel error box", fg: v("danger"), bg: v("danger-bg"), backdrop: v("surface"), kind: "text" },
  { id: "danger-on-danger-bg-bg", where: "DraftModal / MessageBubble error box", fg: v("danger"), bg: v("danger-bg"), backdrop: v("bg"), kind: "text" },
  { id: "error-on-danger-bg-bg", where: "--error text in an error box", fg: v("error"), bg: v("danger-bg"), backdrop: v("bg"), kind: "text" },
  { id: "success-on-success-bg-surface", where: "McpToolsPanel 'agent' badge", fg: v("success"), bg: v("success-bg"), backdrop: v("surface"), kind: "text" },
  // fg is --accent-text, not --accent, because that is what these two paint —
  // and, since #297's successor, what *every* accent-coloured `color:` in the
  // app paints. The brand accent as ink was already short of AA before it moved
  // (4.25:1 on --surface, 3.89:1 on the light one, before any tint), and moving
  // the fill under white's 0.183 luminance ceiling took it further down: 3.16:1
  // on --bg-popout now. A fill dark enough for white ink cannot also be ink.
  // Measuring --accent here would be measuring a value no component paints.
  {
    id: "accent-on-accent-bg-surface",
    where: "McpToolsPanel 'platform' badge",
    fg: v("accent-text"),
    bg: v("accent-bg"),
    backdrop: v("surface"),
    kind: "text",
  },
  { id: "accent-on-accent-bg-bg", where: "PromptInput drop-images overlay", fg: v("accent-text"), bg: v("accent-bg"), backdrop: v("bg"), kind: "text" },
  { id: "badge-info-on-info-bg", where: "McpToolsPanel 'proxy' badge", fg: v("badge-info"), bg: v("info-bg"), backdrop: v("surface"), kind: "text" },
  { id: "badge-info-on-badge-info-bg", where: "MessageBubble info chip", fg: v("badge-info"), bg: v("badge-info-bg"), backdrop: v("surface"), kind: "text" },
  {
    id: "badge-env-on-badge-env-bg",
    where: "PluginsSettings stdio badge",
    fg: v("badge-env-text"),
    bg: v("badge-env-bg"),
    backdrop: v("surface"),
    kind: "text",
  },
  { id: "badge-sse-on-badge-sse-bg", where: "PluginsSettings sse badge", fg: v("badge-sse-text"), bg: v("badge-sse-bg"), backdrop: v("surface"), kind: "text" },

  // ── Diff view ──
  { id: "diff-added-on-added-bg", where: "GitDiffView added line", fg: v("diff-added-text"), bg: v("diff-added-bg"), backdrop: v("surface"), kind: "text" },
  {
    id: "diff-added-on-added-line-bg",
    where: "GitDiffView added line body",
    fg: v("diff-added-text"),
    bg: v("diff-added-line-bg"),
    backdrop: v("surface"),
    kind: "text",
  },
  {
    id: "diff-removed-on-removed-bg",
    where: "GitDiffView removed line",
    fg: v("diff-removed-text"),
    bg: v("diff-removed-bg"),
    backdrop: v("surface"),
    kind: "text",
  },
  {
    id: "diff-removed-on-removed-line-bg",
    where: "GitDiffView removed line body",
    fg: v("diff-removed-text"),
    bg: v("diff-removed-line-bg"),
    backdrop: v("surface"),
    kind: "text",
  },

  // ── Chat-list derived layer: tints mixed from the theme's own primitives ──
  {
    id: "chatlist-summon",
    where: "ChatListItem summon badge",
    fg: v("chatlist-summon-text"),
    bg: v("chatlist-summon-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-summon-urgent",
    where: "ChatListItem urgent summon badge",
    fg: v("chatlist-summon-urgent-text"),
    bg: v("chatlist-summon-urgent-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-badge-triggered",
    where: "ChatListItem/FolderListItem triggered badge",
    fg: v("chatlist-badge-triggered-text"),
    bg: v("chatlist-badge-triggered-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-badge-agent",
    where: "FolderListItem agent badge",
    fg: v("chatlist-badge-agent-text"),
    bg: v("chatlist-badge-agent-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-badge-status",
    where: "FolderListItem status badge",
    fg: v("chatlist-badge-status-text"),
    bg: v("chatlist-badge-status-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-title-active",
    where: "active chat row title",
    fg: v("chatlist-item-title-text"),
    bg: v("chatlist-item-active-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-path-active",
    where: "active chat row path",
    fg: v("chatlist-item-path-text"),
    bg: v("chatlist-item-active-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "chatlist-path-hover",
    where: "hovered chat row path",
    fg: v("chatlist-item-path-text"),
    bg: v("chatlist-item-hover-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },

  // ── Text on solid fills ──
  { id: "on-accent", where: "primary buttons, active nav", fg: v("text-on-accent"), bg: v("accent"), backdrop: v("bg"), kind: "text" },
  { id: "on-accent-hover", where: "primary buttons, hovered", fg: v("text-on-accent"), bg: v("accent-hover"), backdrop: v("bg"), kind: "text" },
  // bg is --danger-solid for the same reason: --danger has to stay light enough
  // to read as *ink* on --danger-bg over a dark surface, which is exactly what
  // put white-on-it at 3.35:1. Every destructive button now paints the fill
  // token; `--danger-solid` derives from `--danger`, so a theme still drives it.
  { id: "on-danger", where: "confirm-delete button", fg: v("text-on-danger"), bg: v("danger-solid"), backdrop: v("bg"), kind: "text" },
  {
    id: "provider-badge-openrouter",
    where: "OpenRouter provider badge",
    fg: v("badge-provider-text"),
    bg: v("badge-provider-openrouter-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "provider-badge-codex",
    where: "Codex provider badge",
    fg: v("badge-provider-text"),
    bg: v("badge-provider-codex-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "provider-badge-acp",
    where: "ACP provider badge",
    fg: v("badge-provider-text"),
    bg: v("badge-provider-acp-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "provider-badge-cline",
    where: "Cline provider badge",
    fg: v("badge-provider-text"),
    bg: v("badge-provider-cline-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "provider-badge-pi",
    where: "pi provider badge",
    fg: v("badge-provider-text"),
    bg: v("badge-provider-pi-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  {
    id: "session-badge-cli",
    where: "CLI session badge",
    fg: v("chatlist-badge-session-text"),
    bg: v("chatlist-badge-session-cli-bg"),
    backdrop: v("bg-sidebar"),
    kind: "text",
  },
  { id: "worktree-badge", where: "FolderListItem worktree badge", fg: v("text-on-accent"), bg: v("badge-worktree"), backdrop: v("bg-sidebar"), kind: "text" },
  { id: "builtin-on-user-bg", where: "slash-command user message", fg: v("builtin-text"), bg: v("builtin-user-bg"), backdrop: v("bg"), kind: "text" },
  {
    id: "builtin-on-assistant-bg",
    where: "slash-command assistant message",
    fg: v("builtin-text"),
    bg: v("builtin-assistant-bg"),
    backdrop: v("bg"),
    kind: "text",
  },

  // ── Non-text indicators (3:1) ──
  { id: "status-green-dot", where: "FolderListItem running dot", fg: v("status-green"), bg: v("bg-sidebar"), backdrop: v("bg-sidebar"), kind: "nonText" },
  { id: "status-active-dot", where: "ChatTreeIndicator ongoing dot", fg: v("status-active"), bg: v("bg-sidebar"), backdrop: v("bg-sidebar"), kind: "nonText" },
  { id: "warning-waiting-dot", where: "FolderListItem waiting dot", fg: v("warning"), bg: v("bg-sidebar"), backdrop: v("bg-sidebar"), kind: "nonText" },
  { id: "toggle-knob-on-accent", where: "toggle switch knob, on", fg: v("toggle-knob"), bg: v("accent"), backdrop: v("surface"), kind: "nonText" },
];

// ─── Measurement ────────────────────────────────────────────────────

export interface PairingMeasurement {
  pairing: Pairing;
  /** null when some link in the chain could not be resolved. */
  ratio: number | null;
  required: number;
  passes: boolean;
  /** Set when ratio is null: which expression failed to resolve. */
  unmeasurable?: string;
}

/** The variable map a browser would see: theme values layered over the stylesheet. */
export function effectiveVars(themeVars: Record<string, string> | undefined, mode: ThemeMode): Record<string, string> {
  return { ...BUILTIN_PALETTE[mode], ...(themeVars ?? {}) };
}

export function measurePairing(pairing: Pairing, vars: Record<string, string>): PairingMeasurement {
  const required = minimumRatio(pairing.kind);
  const backdrop = resolveColor(pairing.backdrop, vars);
  const bg = resolveColor(pairing.bg, vars);
  const fg = resolveColor(pairing.fg, vars);

  const missing = !backdrop ? pairing.backdrop : !bg ? pairing.bg : !fg ? pairing.fg : null;
  if (missing || !backdrop || !bg || !fg) {
    return { pairing, ratio: null, required, passes: false, unmeasurable: missing ? describeUnresolvable(missing, vars) : undefined };
  }

  // The backdrop is the bottom of the stack and must be opaque; if the theme
  // made it translucent, flatten it onto itself-over-white rather than guess.
  const solidBackdrop = backdrop.a >= 1 ? backdrop : composite(backdrop, { r: 255, g: 255, b: 255, a: 1 });
  const painted = composite(bg, solidBackdrop);
  const inked = composite(fg, painted);
  const ratio = contrastRatio(inked, painted);
  return { pairing, ratio, required, passes: ratio >= required };
}

export function measureMode(themeVars: Record<string, string> | undefined, mode: ThemeMode): PairingMeasurement[] {
  const vars = effectiveVars(themeVars, mode);
  return PAIRINGS.map((p) => measurePairing(p, vars));
}

function toFailure(mode: ThemeMode, m: PairingMeasurement): ThemeContrastFailure {
  return {
    mode,
    id: m.pairing.id,
    where: m.pairing.where,
    fg: m.pairing.fg,
    bg: m.pairing.bg,
    backdrop: m.pairing.backdrop,
    required: m.required,
    ratio: m.ratio === null ? null : Number(m.ratio.toFixed(2)),
    ...(m.unmeasurable ? { unmeasurable: m.unmeasurable } : {}),
  };
}

/**
 * Audit a theme's variables against every pairing, in both modes.
 *
 * Reports; never modifies. Stored themes are user data — see
 * `correctThemeContrast` for the generation-time path, which is the only place
 * values are allowed to move.
 *
 * Two independent kinds of wrong come back from here, and the second is the one
 * with no ratio attached: see `undefinedVariables` on the report.
 */
export function auditThemeVars(dark: Record<string, string>, light: Record<string, string>): ThemeContrastReport {
  const failures: ThemeContrastFailure[] = [];
  let checked = 0;
  for (const [mode, vars] of [
    ["dark", dark],
    ["light", light],
  ] as Array<[ThemeMode, Record<string, string>]>) {
    for (const m of measureMode(vars, mode)) {
      checked++;
      if (!m.passes) failures.push(toFailure(mode, m));
    }
  }
  failures.sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0));
  return {
    checked,
    failures,
    undefinedVariables: {
      dark: THEME_VARIABLE_NAMES.filter((name) => !(name in dark)),
      light: THEME_VARIABLE_NAMES.filter((name) => !(name in light)),
    },
  };
}

export function auditTheme(theme: Pick<CustomTheme, "dark" | "light">): ThemeContrastReport {
  return auditThemeVars(theme.dark, theme.light);
}

// ─── Correction (generation time only) ──────────────────────────────

/**
 * How long correction may hold the thread before it hands it back.
 *
 * The search below is bounded but not small: the seed pass runs the greedy
 * correction up to 27 times per mode, and each of those scans a 201-step
 * lightness grid for every candidate lever of every round. On the built-in
 * palette that is around 80ms of solid arithmetic; on a theme whose colours put
 * three contrast carriers in the way it is seconds. Callboard's daemon is one
 * thread, and that thread is also every open SSE stream and every pending
 * request, so a synchronous search of that size is not slow — it is a stall in
 * the whole application for as long as it runs.
 *
 * So the search yields. `setImmediate` puts the continuation in the check phase,
 * behind whatever I/O the loop has waiting, which is exactly the ordering wanted
 * here: pending socket writes and incoming requests go first, and correction
 * resumes with what is left.
 *
 * **This changes when the work happens, never what it computes.** The sequence
 * of candidates, measurements and comparisons is identical either way — nothing
 * in this module reads a clock, and nothing outside it can reach the search's
 * state to change it mid-run. Two concurrent corrections interleave at breath
 * points and neither can see the other, because every value each one touches is
 * local to its own call. The caches above are shared, but a cache of a pure
 * function has no state to race on: whoever fills an entry, it holds the same
 * answer.
 *
 * 8ms is a frame at 120Hz, and comfortably under the interval at which a stalled
 * stream becomes visible as a stutter rather than as latency.
 */
const MAX_UNINTERRUPTED_MS = 8;

/**
 * How often the innermost loop consults the clock, as a power-of-two mask.
 *
 * A candidate costs single-digit microseconds, so checking every one would spend
 * a meaningful fraction of the search on `performance.now()`. Every 32nd bounds
 * the overshoot past a breath at roughly a tenth of a millisecond, which is
 * nothing next to the 8ms it is measuring.
 */
const BREATH_CHECK_MASK = 31;

let lastBreath = 0;

function breathDue(): boolean {
  return performance.now() - lastBreath >= MAX_UNINTERRUPTED_MS;
}

/**
 * Yield to the event loop.
 *
 * The clock is module-scoped rather than per-run deliberately: the property
 * worth holding is "this module does not hold the thread for more than
 * MAX_UNINTERRUPTED_MS at a stretch", and that is a property of the thread, not
 * of any one correction. Two corrections running at once should breathe twice as
 * often between them, not twice as rarely.
 */
async function breathe(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  lastBreath = performance.now();
}

/**
 * The opaque surfaces a theme is *made of*. "A warm cream theme" is --bg;
 * moving it to rescue a badge answers a different request than the one asked.
 *
 * The list is longer than the window chrome, because "surface" is about what a
 * value *is*, not where it sits in the stylesheet. `--user-bg`, `--assistant-bg`
 * and `--code-bg` are the message bubbles — the largest painted areas in the
 * app and, for a theme described in a sentence, the thing being described. They
 * are opaque fills, so `isAnchor`'s alpha test says nothing about them and the
 * corrector was free to slide all three to the same grey to rescue the body text
 * on top; naming them here is what stops that. The two `--builtin-*` bubble
 * fills are the same surface wearing a slash-command's colour.
 */
export const SURFACE_VARS = new Set([
  "bg",
  "bg-sidebar",
  "bg-popout",
  "surface",
  "bg-secondary",
  "user-bg",
  "assistant-bg",
  "code-bg",
  "builtin-user-bg",
  "builtin-assistant-bg",
]);

/**
 * Variables correction is not allowed to move.
 *
 * Two kinds, and the second is decided by measurement rather than by name:
 *
 * - the surfaces above, and
 * - any variable that resolves to a *translucent* colour. Those are washes
 *   whose whole job is to be barely there; darkening a wash to rescue the text
 *   on it is exactly the muddy result to avoid. The colour a wash is mixed
 *   from is still fair game — `dependencies()` walks through `color-mix()`, so
 *   correcting `--status-triggered` moves the triggered badge's tint with it,
 *   which is the asymptote case `correctVariable` is built to detect.
 *
 * Deciding on alpha rather than on a `-bg` suffix matters: `--badge-provider-codex-bg`
 * is an opaque fill despite its name, and `--accent-light` is a wash despite not
 * having one.
 */
export function isAnchor(name: string, vars: Record<string, string>): boolean {
  if (SURFACE_VARS.has(name)) return true;
  const resolved = resolveColor(vars[name] ?? "", vars);
  if (!resolved) return true; // unparseable (shadows, gradients) — not ours to move
  return resolved.a < 1;
}

/**
 * Every `var()` an expression names, in source order — the whole expression, not
 * just its head, so a `color-mix()`'s arguments and a `var()`'s fallback both
 * count. Cached for the same reason the shapes above are: `pairingsTouching`
 * re-scans all three slots of all 57 pairings for every lever of every round.
 */
const VAR_REFS_CACHE = new Map<string, string[]>();

function varReferences(expr: string): string[] {
  return cached(VAR_REFS_CACHE, expr, () => [...expr.matchAll(/var\(\s*--([a-z0-9-]+)/gi)].map((m) => m[1]));
}

/** Which theme variables a pairing's outcome depends on. */
function dependencies(expr: string, vars: Record<string, string>, seen = new Set<string>(), depth = 0): Set<string> {
  if (depth > MAX_RESOLVE_DEPTH) return seen;
  for (const name of varReferences(expr)) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name in vars) dependencies(vars[name], vars, seen, depth + 1);
  }
  return seen;
}

export interface Correction {
  mode: ThemeMode;
  variable: string;
  from: string;
  to: string;
  /** Pairings that this move brought up to AA. */
  fixed: string[];
}

export interface CorrectionOutcome {
  dark: Record<string, string>;
  light: Record<string, string>;
  corrections: Correction[];
  /** Pairings still failing after correction — nothing legal fixes them. */
  unsatisfiable: ThemeContrastFailure[];
}

/**
 * Lightness grid. 0.005 in OKLCh is well under a just-noticeable difference, so
 * the nearest passing step is, for practical purposes, the nearest passing value.
 */
const L_STEPS = 201;

/**
 * The lightness grid in nearest-first order: ascending distance from `target`,
 * ties broken toward the lower index, stopping at `budget`.
 *
 * Both scans below want *the nearest lightness at which every pairing passes*,
 * and both used to find it by walking 0→200 and keeping the closest candidate
 * seen so far. That is the same answer this yields — the minimum of
 * (distance, index) over the passing candidates, either way — but reached in a
 * different number of trials. Ascending index walks *toward* the origin, so
 * every step of the way is a new closest and nothing is ever skipped; roughly
 * half the grid is evaluated before the answer is even in view. Nearest-first
 * lets the scan return at the first candidate that passes, because by then no
 * nearer one exists to find.
 *
 * It matters because a trial is not cheap: a gamut-mapped OKLCh→sRGB conversion
 * (a 24-step chroma binary search whenever the candidate leaves sRGB, which for
 * a saturated hue at an extreme lightness is most of the grid) and then a full
 * measurement of every pairing the variable touches. On a theme whose colours
 * are a step or two off, this is ~3 trials where it was ~150.
 *
 * Distance is monotonic along each side, so a side that runs past `budget` is
 * finished rather than merely skipped — which is also what makes a tightly
 * budgeted variable cheap instead of a full-grid scan of `continue`s.
 */
function* nearestLightnessFirst(target: number, budget: number): Generator<{ l: number; distance: number }> {
  const last = L_STEPS - 1;
  // The largest index at or below `target`, and the smallest above it. `origin.l`
  // is not guaranteed to sit inside [0, 1] — OKLCh lightness for a clipped white
  // can land a hair outside — so both are clamped into the grid.
  let lo = Math.min(last, Math.floor(target * last));
  if (lo < -1) lo = -1;
  let hi = lo + 1;
  while (lo >= 0 || hi <= last) {
    const dLo = lo >= 0 ? Math.abs(lo / last - target) : Infinity;
    const dHi = hi <= last ? Math.abs(hi / last - target) : Infinity;
    // A tie goes to `lo`, which is always the lower index — the same candidate
    // the ascending scan's `distance >= best.distance` test used to keep.
    const takeLo = dLo <= dHi;
    const index = takeLo ? lo : hi;
    const distance = takeLo ? dLo : dHi;
    if (takeLo) lo--;
    else hi++;
    if (distance > budget) {
      if (takeLo) lo = -1;
      else hi = last + 1;
      continue;
    }
    yield { l: index / last, distance };
  }
}

/**
 * How far correction may drag an identity colour, in OKLCh lightness.
 *
 * This is where "clamp until it clears AA" stops and "reject" begins. Without a
 * budget the search will happily answer a 1.75:1 knob-on-track by turning a
 * cream knob dark — technically AA, and not the theme anyone asked for.
 *
 * The number is calibrated rather than chosen: it is the largest move #293 made
 * by hand on this palette. Those moves, in OKLCh lightness, were --text-muted
 * 0.069, --danger 0.131, --status-green 0.195, --warning 0.204, and
 * --status-triggered 0.295 (amber-500 to amber-800, two full ramp steps, taken
 * deliberately to keep the badge's own hue instead of collapsing it onto
 * --warning). A budget under 0.30 would refuse the very correction the palette's
 * maintainers judged acceptable, so 0.30 it is — and anything wanting more than
 * a human was willing to do by hand is a theme to regenerate, not to clamp.
 */
const MAX_LIGHTNESS_DELTA = 0.3;

/**
 * Tokens exempt from the budget, because legibility *is* their definition.
 *
 * `--text-on-accent` has no aesthetic content: it exists to be readable on
 * whatever `--accent` turned out to be, and flipping it from white to near-black
 * when the accent came back pale is the correct answer, not a violation of
 * intent. An identity colour has the opposite property, which is why the budget
 * exists at all.
 *
 * `--toggle-knob` is the same kind of token wearing a different name: the puck
 * on a switch, whose only job is to be distinguishable from the track behind it.
 * A pale theme with a pale accent leaves it invisible, and the fix is a darker
 * knob, not a rejected theme.
 */
const CONTRAST_CARRIERS = new Set(["text-on-accent", "text-on-danger", "toggle-knob"]);

/**
 * Move one variable's lightness — hue and saturation held — to the nearest
 * value at which every pairing it participates in clears its threshold.
 *
 * Searching an interval rather than stepping toward the target is what makes
 * this terminate: a variable can appear on both sides of a pairing (a colour on
 * a `color-mix()` tint of itself moves its own backdrop as it moves), so
 * "darken until it passes" can chase an asymptote forever. Enumerating the grid
 * either finds a value satisfying all of them at once or proves none exists.
 */
async function correctVariable(
  name: string,
  vars: Record<string, string>,
  relevant: Pairing[],
): Promise<{ value: string; fixed: string[]; distance: number } | null> {
  // Only a literal colour is a lever. A variable holding `var(--x)` or a
  // `color-mix()` is an alias by design; replacing it with a flat value would
  // sever the cascade it exists to carry — correct its source instead.
  const literal = parseCssColor(vars[name] ?? "");
  if (!literal) return null;
  const origin = rgbaToOklch(literal);
  const budget = CONTRAST_CARRIERS.has(name) ? 1 : MAX_LIGHTNESS_DELTA;

  const failingBefore = relevant.filter((p) => !measurePairing(p, vars).passes).map((p) => p.id);
  if (failingBefore.length === 0) return null;

  let scanned = 0;
  for (const { l, distance } of nearestLightnessFirst(origin.l, budget)) {
    if ((scanned++ & BREATH_CHECK_MASK) === 0 && breathDue()) await breathe();
    const candidate = candidateCss(origin, l);
    const trial = { ...vars, [name]: candidate };
    // Every pairing this variable touches, not just the failing ones: a move
    // that rescues a badge by breaking body text is not a correction.
    if (!relevant.every((p) => measurePairing(p, trial).passes)) continue;
    return { value: candidate, fixed: failingBefore, distance };
  }
  return null;
}

/** Every pairing whose outcome depends on `name`, from any of its three slots. */
function pairingsTouching(name: string, vars: Record<string, string>): Pairing[] {
  return PAIRINGS.filter((p) => {
    const deps = new Set([...dependencies(p.fg, vars), ...dependencies(p.bg, vars), ...dependencies(p.backdrop, vars)]);
    return deps.has(name);
  });
}

interface ModeOutcome {
  vars: Record<string, string>;
  corrections: Correction[];
  unsatisfiable: ThemeContrastFailure[];
}

async function correctMode(themeVars: Record<string, string>, mode: ThemeMode, seed: Record<string, string> = {}): Promise<ModeOutcome> {
  const corrections: Correction[] = [];
  let vars = { ...effectiveVars(themeVars, mode), ...seed };
  const owned = new Set(Object.keys(themeVars));

  // One variable can carry several failing pairings, and correcting it can
  // resolve all of them; re-measure after each move rather than assuming.
  for (let round = 0; round < 24; round++) {
    if (breathDue()) await breathe();
    const failures = PAIRINGS.map((p) => measurePairing(p, vars)).filter((m) => !m.passes);
    if (failures.length === 0) break;

    // Candidate levers: theme-owned, non-anchor variables the failing pairings
    // depend on, from either side. A badge whose fill is wrong is as fixable by
    // moving the fill as by moving the text on it, and which of the two moves
    // less is not knowable in advance — so cost both and take the cheaper.
    const tally = new Map<string, number>();
    for (const f of failures) {
      if (f.ratio === null) continue; // unmeasurable — no value can fix a missing link
      for (const dep of [...dependencies(f.pairing.fg, vars), ...dependencies(f.pairing.bg, vars)]) {
        if (!owned.has(dep) || isAnchor(dep, vars)) continue;
        tally.set(dep, (tally.get(dep) ?? 0) + 1);
      }
    }
    if (tally.size === 0) break;

    let choice: { lever: string; value: string; fixed: string[]; distance: number } | null = null;
    for (const lever of tally.keys()) {
      const result = await correctVariable(lever, vars, pairingsTouching(lever, vars));
      if (!result) continue;
      const better = !choice || result.fixed.length > choice.fixed.length || (result.fixed.length === choice.fixed.length && result.distance < choice.distance);
      if (better) choice = { lever, ...result };
    }
    if (!choice) break;

    corrections.push({ mode, variable: choice.lever, from: vars[choice.lever], to: choice.value, fixed: choice.fixed });
    vars = { ...vars, [choice.lever]: choice.value };
  }

  const unsatisfiable = PAIRINGS.map((p) => measurePairing(p, vars))
    .filter((m) => !m.passes)
    .map((m) => toFailure(mode, m));

  // Hand back only the theme's own keys — a variable the theme never defined
  // must keep cascading from the stylesheet.
  const out: Record<string, string> = {};
  for (const key of owned) out[key] = vars[key];

  // Report against what the theme actually said, not against the seed or an
  // intermediate step: a variable moved twice is one correction, and a seeded
  // variable that stayed put is none. This is also what makes `corrections` a
  // sound tie-breaker between seeds — it counts values that really changed.
  const attributed = new Map<string, string[]>();
  for (const c of corrections) attributed.set(c.variable, [...(attributed.get(c.variable) ?? []), ...c.fixed]);
  const net: Correction[] = [];
  for (const key of owned) {
    if (out[key] === themeVars[key]) continue;
    net.push({ mode, variable: key, from: themeVars[key], to: out[key], fixed: [...new Set(attributed.get(key) ?? [])] });
  }
  return { vars: out, corrections: net, unsatisfiable };
}

/**
 * Which contrast carriers are worth reseeding, given what the greedy pass could
 * not resolve.
 *
 * **A carrier blocks by passing.** That is the whole subtlety, and reading
 * "blocking" as "failing" is the bug this function exists to not have.
 * `correctVariable` will only move a lever to a value where *every* pairing that
 * lever touches passes — so a carrier that shares a pairing with a stuck lever
 * constrains that lever's entire search while being perfectly healthy itself,
 * and therefore never appears among the unsatisfiable at all.
 *
 * Reproduced, dark mode: an `--accent` of `#36967a` needs to lighten to clear
 * `accent-on-accent-bg-surface` and `chatlist-badge-agent`, and a near-white
 * `--toggle-knob` reads 3.12:1 on it — passing, with room to spare by the only
 * test that looks at it. Lighten the accent by any amount and the knob drops
 * under 3:1, so no candidate survives the all-pairings rule and `--accent` does
 * not move at all. Seeding the knob dark costs `--accent` 0.017 of lightness and
 * clears both. The joint answer existed and was nearly free.
 *
 * So the relation is traced forwards, not looked up: from the stuck pairings, to
 * the levers that could fix them, to every pairing constraining those levers. A
 * carrier appearing anywhere in that closure is a candidate.
 */
function blockingCarriers(themeVars: Record<string, string>, vars: Record<string, string>, unsatisfiable: ThemeContrastFailure[]): string[] {
  const byId = new Map(PAIRINGS.map((p) => [p.id, p]));
  const constraining = new Set(unsatisfiable.map((f) => f.id));
  for (const f of unsatisfiable) {
    if (f.ratio === null) continue; // unmeasurable — no lever fixes a missing link
    const pairing = byId.get(f.id);
    if (!pairing) continue;
    for (const dep of [...dependencies(pairing.fg, vars), ...dependencies(pairing.bg, vars)]) {
      if (!(dep in themeVars) || isAnchor(dep, vars)) continue;
      for (const constrained of pairingsTouching(dep, vars)) constraining.add(constrained.id);
    }
  }
  return [...CONTRAST_CARRIERS].filter(
    (name) => name in themeVars && parseCssColor(themeVars[name]) !== null && pairingsTouching(name, vars).some((p) => constraining.has(p.id)),
  );
}

/**
 * Pull a seeded carrier back toward the value the theme actually asked for.
 *
 * A seed is deliberately extreme — near-black or near-white — because its job is
 * to break a deadlock, not to be the answer. Once the greedy pass has settled
 * everything else around that choice, the extreme is usually far more than was
 * needed: the knob above only has to reach 3:1, and leaving it at L=0.02 when
 * the theme asked for white is a correction nobody requested. Moving it back to
 * the nearest value that still keeps every pairing it touches passing costs one
 * grid scan and gives the theme back as much of its own knob as contrast allows.
 */
async function relaxCarrier(name: string, vars: Record<string, string>, original: string): Promise<string> {
  const current = parseCssColor(vars[name] ?? "");
  const target = parseCssColor(original);
  if (!current || !target) return vars[name];
  const shape = rgbaToOklch(current);
  const wanted = rgbaToOklch(target).l;
  const relevant = pairingsTouching(name, vars);
  // The value the theme wrote, verbatim, when it turns out to work — so a
  // carrier that only had to be seeded to unstick something else is handed back
  // untouched rather than as a round-trip of itself.
  if (relevant.every((p) => measurePairing(p, { ...vars, [name]: original }).passes)) return original;
  let scanned = 0;
  for (const { l } of nearestLightnessFirst(wanted, Infinity)) {
    if ((scanned++ & BREATH_CHECK_MASK) === 0 && breathDue()) await breathe();
    const candidate = candidateCss(shape, l);
    if (!relevant.every((p) => measurePairing(p, { ...vars, [name]: candidate }).passes)) continue;
    return candidate;
  }
  return vars[name];
}

/**
 * Run `correctMode` from several starting points and keep the best result.
 *
 * One variable at a time is the wrong shape for two situations, and neither is
 * rare. `--text-on-accent` is painted on five unrelated fills — `--accent`,
 * `--accent-hover`, `--badge-worktree`, `--badge-provider-codex-bg` and (through
 * `--chatlist-badge-session-text`) `--status-active`. Whether it should be
 * near-white or near-black is a single decision binding all five, and the fills
 * have to move to agree with it. Correcting greedily, the search sees only that
 * flipping the text breaks a badge, and that fixing the badge breaks the text.
 * The second is `blockingCarriers`' case: a carrier that is fine on its own
 * numbers and pins a lever that is not.
 *
 * Rather than a general joint search, seed the carriers at each polarity and let
 * the ordinary greedy pass settle the fills around that choice, then relax the
 * seed back toward what the theme asked for. The carriers are effectively binary
 * in practice, so a handful of runs covers the space, and the outcome with the
 * fewest unresolved pairings wins.
 *
 * It is not a complete joint search and does not claim to be. What it guarantees
 * is the *direction* of the error: an outcome is only ever accepted over `plain`
 * when it resolves strictly more, so seeding never makes a theme worse, only
 * sometimes not better. Measured on a 40-theme synthetic corpus against the
 * relation this replaced: 33 rejections fell to 20, 13 themes were rescued
 * outright, and nothing regressed. What survives is dominated by pale identity
 * colours that cannot reach AA on a tint of themselves inside
 * MAX_LIGHTNESS_DELTA — a theme to regenerate, not a search that gave up.
 */
async function correctModeFromBestSeed(themeVars: Record<string, string>, mode: ThemeMode): Promise<ModeOutcome> {
  const plain = await correctMode(themeVars, mode);
  if (plain.unsatisfiable.length === 0) return plain;

  const startVars = effectiveVars(themeVars, mode);
  const carriers = blockingCarriers(themeVars, startVars, plain.unsatisfiable);
  if (carriers.length === 0) return plain;

  // Every combination of polarities across the implicated carriers, minus the
  // empty one — that is `plain`, already run.
  let seeds: Array<Record<string, string>> = [{}];
  for (const name of carriers) {
    const origin = rgbaToOklch(parseCssColor(themeVars[name]) as Rgba);
    const polarities = [toCss(oklchToRgba({ ...origin, l: 0.02 })), toCss(oklchToRgba({ ...origin, l: 0.99 }))];
    seeds = seeds.flatMap((seed) => [seed, ...polarities.map((value) => ({ ...seed, [name]: value }))]);
  }

  let best: ModeOutcome = plain;
  let seeded: string[] = [];
  for (const seed of seeds) {
    if (Object.keys(seed).length === 0) continue;
    const outcome = await correctMode(themeVars, mode, seed);
    const better =
      outcome.unsatisfiable.length < best.unsatisfiable.length ||
      (outcome.unsatisfiable.length === best.unsatisfiable.length && outcome.corrections.length < best.corrections.length);
    if (better) {
      best = outcome;
      seeded = Object.keys(seed);
    }
    if (best.unsatisfiable.length === 0) break;
  }
  return seeded.length === 0 ? best : relaxSeeds(best, themeVars, mode, seeded);
}

/** Re-derive a settled outcome with each seeded carrier pulled back toward the theme's own value. */
async function relaxSeeds(outcome: ModeOutcome, themeVars: Record<string, string>, mode: ThemeMode, seeded: string[]): Promise<ModeOutcome> {
  let vars = { ...effectiveVars(themeVars, mode), ...outcome.vars };
  for (const name of seeded) {
    if (outcome.vars[name] === undefined || outcome.vars[name] === themeVars[name]) continue;
    vars = { ...vars, [name]: await relaxCarrier(name, vars, themeVars[name]) };
  }
  const relaxed: Record<string, string> = {};
  for (const key of Object.keys(outcome.vars)) relaxed[key] = vars[key];
  const corrections = outcome.corrections.filter((c) => relaxed[c.variable] !== themeVars[c.variable]).map((c) => ({ ...c, to: relaxed[c.variable] }));
  const unsatisfiable = PAIRINGS.map((p) => measurePairing(p, vars))
    .filter((m) => !m.passes)
    .map((m) => toFailure(mode, m));
  // Relaxation only ever moves within values that keep every touched pairing
  // passing, so this cannot regress — but it is measured rather than asserted,
  // because "cannot" is exactly the claim a corrector should not be trusted on.
  return unsatisfiable.length > outcome.unsatisfiable.length ? outcome : { vars: relaxed, corrections, unsatisfiable };
}

/**
 * Bring a not-yet-stored theme up to AA by moving foreground lightness only.
 *
 * A generated theme has not been saved and is not user data, so correcting it
 * here is cheap and reversible in a way that rewriting a stored theme is not.
 * When the grid search proves no lightness works, the pairing is returned in
 * `unsatisfiable` — the caller rejects rather than shipping something muddy.
 */
export async function correctThemeContrast(dark: Record<string, string>, light: Record<string, string>): Promise<CorrectionOutcome> {
  const d = await correctModeFromBestSeed(dark, "dark");
  const l = await correctModeFromBestSeed(light, "light");
  return {
    dark: d.vars,
    light: l.vars,
    corrections: [...d.corrections, ...l.corrections],
    unsatisfiable: [...d.unsatisfiable, ...l.unsatisfiable],
  };
}
