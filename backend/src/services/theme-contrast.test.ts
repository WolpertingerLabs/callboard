import { describe, it, expect } from "vitest";
import {
  PAIRINGS,
  measureMode,
  measurePairing,
  parseCssColor,
  resolveColor,
  contrastRatio,
  composite,
  correctThemeContrast,
  auditThemeVars,
  effectiveVars,
  isAnchor,
  rgbaToOklch,
  oklchToRgba,
  minimumRatio,
} from "./theme-contrast.js";
import { BUILTIN_PALETTE } from "./theme-contrast-palette.js";

/**
 * Every pairing's ratio on the built-in palette, in both modes.
 *
 * This is a tripwire on the *measurement*, not on the palette. #293's audit tool
 * scraped prose out of CSS block comments as real declarations, so a comment
 * that mentioned a variable by name silently shadowed it and blanked eight rows.
 * That was caught only because rows with no business changing went blank —
 * which is to say, the healthy numbers are the ones that detected the bug.
 *
 * So all 104 are pinned, passing and failing alike. Regenerating them to make a
 * test go green is only correct when index.css itself moved. If the stylesheet
 * did not change and a number here did, the measurement is broken, not the pin.
 */
const BUILTIN_RATIOS: Record<"dark" | "light", Record<string, number>> = {
  dark: {
    "text-on-bg": 16.02,
    "text-on-surface": 14.64,
    "text-on-sidebar": 14.97,
    "text-on-popout": 13.06,
    "text-on-bg-secondary": 13.7,
    "text-on-user-bg": 13.36,
    "text-on-assistant-bg": 14.64,
    "text-on-code-bg": 16.02,
    "muted-on-bg": 6.15,
    "muted-on-surface": 5.62,
    "muted-on-sidebar": 5.75,
    "muted-on-bg-secondary": 5.26,
    "secondary-on-bg": 6.15,
    "secondary-on-surface": 5.62,
    "warning-on-warning-bg-surface": 5.37,
    "warning-on-warning-bg-sidebar": 5.52,
    "warning-on-warning-bg-bg": 6.01,
    "danger-on-danger-bg-surface": 4.65,
    "danger-on-danger-bg-bg": 5.14,
    "error-on-danger-bg-bg": 5.14,
    "success-on-success-bg-surface": 5.84,
    "accent-on-accent-bg-surface": 5.49,
    "accent-on-accent-bg-bg": 6.07,
    "badge-info-on-info-bg": 5.84,
    "badge-info-on-badge-info-bg": 5.32,
    "badge-env-on-badge-env-bg": 5.64,
    "badge-sse-on-badge-sse-bg": 9.15,
    "diff-added-on-added-bg": 5.59,
    "diff-added-on-added-line-bg": 6.01,
    "diff-removed-on-removed-bg": 5.79,
    "diff-removed-on-removed-line-bg": 6.18,
    "chatlist-summon": 5.83,
    "chatlist-summon-urgent": 4.65,
    "chatlist-badge-triggered": 6.34,
    "chatlist-badge-agent": 5.37,
    "chatlist-badge-status": 4.62,
    "chatlist-title-active": 13.55,
    "chatlist-path-active": 5.2,
    "chatlist-path-hover": 5.62,
    "on-accent": 4.89,
    "on-accent-hover": 4.52,
    "on-danger": 5.52,
    "provider-badge-openrouter": 5.7,
    "provider-badge-codex": 5.48,
    "provider-badge-acp": 6.7,
    "session-badge-cli": 5.47,
    "worktree-badge": 5.7,
    "builtin-on-user-bg": 10.33,
    "builtin-on-assistant-bg": 10.3,
    "status-green-dot": 7.76,
    "status-active-dot": 6.97,
    "warning-waiting-dot": 7.01,
    "toggle-knob-on-accent": 4.89,
  },
  light: {
    "text-on-bg": 14.63,
    "text-on-surface": 13.98,
    "text-on-sidebar": 12.92,
    "text-on-popout": 14.49,
    "text-on-bg-secondary": 13.24,
    "text-on-user-bg": 11.87,
    "text-on-assistant-bg": 13.98,
    "text-on-code-bg": 13.35,
    "muted-on-bg": 6.38,
    "muted-on-surface": 6.09,
    "muted-on-sidebar": 5.63,
    "muted-on-bg-secondary": 5.77,
    "secondary-on-bg": 6.38,
    "secondary-on-surface": 6.09,
    "warning-on-warning-bg-surface": 5.65,
    "warning-on-warning-bg-sidebar": 5.24,
    "warning-on-warning-bg-bg": 5.9,
    "danger-on-danger-bg-surface": 5.41,
    "danger-on-danger-bg-bg": 5.66,
    "error-on-danger-bg-bg": 4.68,
    "success-on-success-bg-surface": 6.26,
    "accent-on-accent-bg-surface": 5.94,
    "accent-on-accent-bg-bg": 6.21,
    "badge-info-on-info-bg": 5.75,
    "badge-info-on-badge-info-bg": 5.59,
    "badge-env-on-badge-env-bg": 6.13,
    "badge-sse-on-badge-sse-bg": 5.5,
    "diff-added-on-added-bg": 6,
    "diff-added-on-added-line-bg": 6.26,
    "diff-removed-on-removed-bg": 5.37,
    "diff-removed-on-removed-line-bg": 5.63,
    "chatlist-summon": 5.09,
    "chatlist-summon-urgent": 4.69,
    "chatlist-badge-triggered": 4.99,
    "chatlist-badge-agent": 5.05,
    "chatlist-badge-status": 4.6,
    "chatlist-title-active": 11.72,
    "chatlist-path-active": 5.11,
    "chatlist-path-hover": 6.09,
    "on-accent": 4.89,
    "on-accent-hover": 4.52,
    "on-danger": 6.47,
    "provider-badge-openrouter": 5.7,
    "provider-badge-codex": 5.48,
    "provider-badge-acp": 6.7,
    "session-badge-cli": 5.48,
    "worktree-badge": 5.7,
    "builtin-on-user-bg": 7.15,
    "builtin-on-assistant-bg": 8.01,
    "status-green-dot": 4.43,
    "status-active-dot": 4.84,
    "warning-waiting-dot": 6.05,
    "toggle-knob-on-accent": 4.89,
  },
};

describe("colour parsing", () => {
  it("parses the value shapes this stylesheet and its themes actually use", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#7c6aef")).toEqual({ r: 124, g: 106, b: 239, a: 1 });
    expect(parseCssColor("rgba(210, 153, 34, 0.15)")).toEqual({ r: 210, g: 153, b: 34, a: 0.15 });
    // Golden Hour writes rgba() without spaces after the commas.
    expect(parseCssColor("rgba(240,160,48,0.1)")).toEqual({ r: 240, g: 160, b: 48, a: 0.1 });
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("#7c6aef80")?.a).toBeCloseTo(0.502, 2);
  });

  it("returns null rather than a plausible-looking guess", () => {
    // A shadow is not a colour, and a pairing that lands on one must report
    // itself unmeasurable — silently reading it as black would pass any test.
    expect(parseCssColor("0 4px 12px rgba(0, 0, 0, 0.15)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    // A named colour outside the three the stylesheet uses stays unreadable on
    // purpose: guessing at the CSS colour keyword table is a lot of surface for
    // a value a theme has no reason to write.
    expect(parseCssColor("goldenrod")).toBeNull();
  });

  it("reads hsl(), because refusing legal CSS is a rejection the author cannot act on", () => {
    // Not a shape index.css uses — but a shape a model reaches for, and an
    // unparseable value is not a soft failure: every pairing touching it becomes
    // unmeasurable, which correction cannot fix, which means the theme is
    // refused for a reason that is entirely this parser's.
    // Channels stay in floating point, as they do for a percentage rgb() — the
    // compositing below never wanted integers.
    const near = (value: string, expected: { r: number; g: number; b: number }) => {
      const c = parseCssColor(value);
      expect(c, value).not.toBeNull();
      expect(c!.r, `${value} r`).toBeCloseTo(expected.r, 6);
      expect(c!.g, `${value} g`).toBeCloseTo(expected.g, 6);
      expect(c!.b, `${value} b`).toBeCloseTo(expected.b, 6);
    };
    near("hsl(220 50% 40%)", { r: 51, g: 85, b: 153 });
    near("hsl(220, 50%, 40%)", { r: 51, g: 85, b: 153 });
    near("hsl(0 0% 100%)", { r: 255, g: 255, b: 255 });
    expect(parseCssColor("hsla(220, 50%, 40%, 0.5)")?.a).toBeCloseTo(0.5, 4);
    expect(parseCssColor("hsl(220 50% 40% / 25%)")?.a).toBeCloseTo(0.25, 4);
    // Hue is an angle, and the units are not decoration.
    near("hsl(0.5turn 50% 40%)", parseCssColor("hsl(180 50% 40%)")!);
    near("hsl(-140 50% 40%)", { r: 51, g: 85, b: 153 });
    expect(parseCssColor("hsl(220 50%)")).toBeNull();
  });
});

describe("unmeasurable diagnostics", () => {
  it("names the literal that could not be read, not just the reference to it", () => {
    // "var(--warning) is not a colour" leaves the caller unable to tell an
    // unparseable value from an undefined variable — different repairs.
    const vars = { ...effectiveVars(undefined, "light"), warning: "goldenrod" };
    const m = measurePairing(PAIRINGS.find((p) => p.id === "warning-on-warning-bg-bg")!, vars);
    expect(m.ratio).toBeNull();
    expect(m.unmeasurable).toBe("var(--warning) → goldenrod");
  });

  it("blames the reference itself when the variable is simply absent", () => {
    const m = measurePairing(
      { id: "t", where: "t", fg: "var(--nope)", bg: "var(--bg)", backdrop: "var(--bg)", kind: "text" },
      effectiveVars(undefined, "dark"),
    );
    expect(m.unmeasurable).toBe("var(--nope)");
  });
});

describe("variable resolution", () => {
  const vars = {
    accent: "#7c6aef",
    alias: "var(--accent)",
    tint: "color-mix(in srgb, var(--accent) 15%, transparent)",
    loop: "var(--loop)",
    "with-fallback": "var(--nope, #112233)",
  };

  it("follows var() chains", () => {
    expect(resolveColor("var(--alias)", vars)).toEqual({ r: 124, g: 106, b: 239, a: 1 });
  });

  it("resolves color-mix against transparent to a translucent colour", () => {
    const mixed = resolveColor("var(--tint)", vars);
    expect(mixed?.a).toBeCloseTo(0.15, 4);
    expect(mixed?.r).toBeCloseTo(124, 4);
  });

  it("uses a var() fallback when the variable is absent", () => {
    expect(resolveColor("var(--with-fallback)", vars)).toEqual({ r: 17, g: 34, b: 51, a: 1 });
  });

  it("gives up on cycles and on missing variables instead of hanging", () => {
    expect(resolveColor("var(--loop)", vars)).toBeNull();
    expect(resolveColor("var(--absent)", vars)).toBeNull();
  });
});

describe("compositing", () => {
  it("flattens a tint onto the surface behind it", () => {
    const painted = composite({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
    expect(painted).toEqual({ r: 127.5, g: 0, b: 0, a: 1 });
  });

  it("is why the backdrop has to be named — the same tint measures differently on each", () => {
    const vars = effectiveVars(undefined, "light");
    const onSidebar = measurePairing({ id: "t", where: "t", fg: "var(--warning)", bg: "var(--warning-bg)", backdrop: "var(--bg-sidebar)", kind: "text" }, vars);
    const onBg = measurePairing({ id: "t", where: "t", fg: "var(--warning)", bg: "var(--warning-bg)", backdrop: "var(--bg)", kind: "text" }, vars);
    expect(onSidebar.ratio).not.toBeCloseTo(onBg.ratio as number, 2);
  });

  it("agrees with the reference ratio for black on white", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 5);
  });
});

describe("built-in palette tripwire", () => {
  it("has a pinned ratio for every pairing in both modes", () => {
    const ids = PAIRINGS.map((p) => p.id).sort();
    expect(Object.keys(BUILTIN_RATIOS.dark).sort()).toEqual(ids);
    expect(Object.keys(BUILTIN_RATIOS.light).sort()).toEqual(ids);
  });

  it("uses unique pairing ids", () => {
    expect(new Set(PAIRINGS.map((p) => p.id)).size).toBe(PAIRINGS.length);
  });

  for (const mode of ["dark", "light"] as const) {
    it(`measures the built-in ${mode} palette exactly as recorded`, () => {
      const measured = Object.fromEntries(measureMode(undefined, mode).map((m) => [m.pairing.id, m.ratio === null ? null : Number(m.ratio.toFixed(2))]));
      expect(measured).toEqual(BUILTIN_RATIOS[mode]);
    });

    it(`resolves every ${mode} pairing — an unmeasurable one means a variable went missing`, () => {
      const unmeasurable = measureMode(undefined, mode).filter((m) => m.ratio === null);
      expect(unmeasurable.map((m) => `${m.pairing.id}: ${m.unmeasurable}`)).toEqual([]);
    });
  }

  it("closed the two ceilings #293 published as fixed while they were still below AA", () => {
    const light = Object.fromEntries(measureMode(undefined, "light").map((m) => [m.pairing.id, m.ratio as number]));
    // #293 reported "--accent on --accent-bg (3.70:1 light)" and "--badge-info
    // chip on --badge-info-bg is 4.31:1 in light" among its fixes. Both numbers
    // are below 4.5 on their face. The first needed a token split (--accent-text)
    // because the brand accent as ink cannot reach AA at any tint opacity; the
    // second only needed blue-700.
    expect(light["accent-on-accent-bg-bg"]).toBeGreaterThanOrEqual(4.5);
    expect(light["badge-info-on-badge-info-bg"]).toBeGreaterThanOrEqual(4.5);
    // "amber-800 clears at 4.99:1" — the worst pairing in the palette, and the
    // one #293 got right. Untouched here, so it is still pinned exactly.
    expect(light["chatlist-badge-triggered"]).toBeCloseTo(4.99, 2);
  });

  /**
   * Nothing is left, and this assertion is the reason the refusal rule in
   * `theme-write.ts` could stop being conditional.
   *
   * The last two were `on-accent` and `on-accent-hover`, and no ink rescued
   * them: white was 4.07:1 on `#7c6aef` and black, at 5.17:1 on the base but
   * 6.82:1 on the hover, would have inverted a button's ink against its own
   * hover state. `--text-on-accent` could not move either, being the ink on
   * `--badge-provider-codex-bg` too. The only lever was the brand colour, so
   * the brand colour is what moved — `#7c6aef` → `#705ce0`, OKLCh lightness
   * only, hue and chroma held, which puts the fill under the 0.183 luminance
   * ceiling white needs. `--accent-hover` sits *at* that ceiling by
   * construction, which is why its 4.52 has no headroom and why the hover step
   * is smaller than it used to be: there is nowhere lighter to go.
   *
   * If this test ever fails, do not widen it. A pairing below AA in the
   * built-in palette is now also a pairing every partial theme write is
   * refused for — see `isCausedByWrite`.
   */
  it("leaves nothing below AA, in either mode", () => {
    for (const mode of ["dark", "light"] as const) {
      const failing = measureMode(undefined, mode)
        .filter((m) => !m.passes)
        .map((m) => `${m.pairing.id}=${m.ratio}`);
      expect(failing, mode).toEqual([]);
    }
  });

  /**
   * The palette has one ink for the accent and one fill, and they are not
   * interchangeable in either direction.
   *
   * `--accent` is now dark enough to carry white, which is exactly what makes
   * it too dark to *be* text on a dark surface: 3.16:1 on `--bg-popout`. Every
   * `color:` that used to name it names `--accent-text` instead, and this is
   * the assertion that says the replacement is worth having — on all five
   * surfaces, in both modes, not just on the two the pairing table samples.
   */
  it("keeps --accent-text above AA on every surface it can land on, in both modes", () => {
    const surfaces = ["bg", "surface", "bg-sidebar", "bg-secondary", "bg-popout"];
    for (const mode of ["dark", "light"] as const) {
      const vars = effectiveVars(undefined, mode);
      const ink = resolveColor("var(--accent-text)", vars)!;
      for (const surface of surfaces) {
        const ratio = contrastRatio(ink, resolveColor(`var(--${surface})`, vars)!);
        expect(ratio, `${mode} --accent-text on --${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("holds every light-mode pairing #293 moved above AA", () => {
    const light = Object.fromEntries(measureMode(undefined, "light").map((m) => [m.pairing.id, m.ratio as number]));
    for (const id of [
      "warning-on-warning-bg-surface",
      "warning-on-warning-bg-sidebar",
      "warning-on-warning-bg-bg",
      "danger-on-danger-bg-surface",
      "danger-on-danger-bg-bg",
      "chatlist-summon",
      "chatlist-summon-urgent",
      "chatlist-badge-triggered",
      "muted-on-sidebar",
    ]) {
      expect(light[id], id).toBeGreaterThanOrEqual(4.5);
    }
    // --status-green, defined by #293, clears the 3:1 a status dot needs.
    expect(light["status-green-dot"]).toBeGreaterThanOrEqual(3);
  });
});

describe("OKLCh lightness moves", () => {
  it("round-trips a colour", () => {
    const original = { r: 124, g: 106, b: 239, a: 1 };
    const back = oklchToRgba(rgbaToOklch(original));
    expect(back.r).toBeCloseTo(original.r, 1);
    expect(back.g).toBeCloseTo(original.g, 1);
    expect(back.b).toBeCloseTo(original.b, 1);
  });

  it("keeps a pale colour pale as it darkens — the reason this is not HSL", () => {
    // #f5e6d0 is a cream. HSL calls it 65% saturated, so darkening it at
    // constant S produces a strong brown; OKLCh's chroma is absolute, so the
    // dark version stays the warm near-grey a human would call it.
    const cream = rgbaToOklch({ r: 245, g: 230, b: 208, a: 1 });
    const darkened = rgbaToOklch(oklchToRgba({ ...cream, l: 0.4 }));
    expect(darkened.c).toBeLessThan(0.06);
  });

  it("gamut-maps rather than clipping a channel and shifting the hue", () => {
    const vivid = { l: 0.95, c: 0.35, h: 250, a: 1 };
    const mapped = rgbaToOklch(oklchToRgba(vivid));
    expect(mapped.h).toBeCloseTo(250, 0);
    expect(mapped.c).toBeLessThan(0.35);
  });
});

describe("anchors", () => {
  const vars = effectiveVars(undefined, "light");

  it("treats the surfaces and every translucent wash as untouchable", () => {
    expect(isAnchor("bg", vars)).toBe(true);
    expect(isAnchor("bg-sidebar", vars)).toBe(true);
    expect(isAnchor("warning-bg", vars)).toBe(true);
    expect(isAnchor("accent-light", vars)).toBe(true);
  });

  it("counts the message bubbles as surfaces, because that is what they are", () => {
    // These are opaque fills, so the alpha test says nothing about them, and the
    // corrector was free to slide all three to the same grey to rescue the body
    // text on top — the largest painted areas in the app, and for a theme
    // described in a sentence, the thing being described.
    for (const name of ["user-bg", "assistant-bg", "code-bg", "builtin-user-bg", "builtin-assistant-bg"]) {
      expect(isAnchor(name, vars), name).toBe(true);
    }
  });

  it("decides on alpha, not on the name", () => {
    // Opaque despite the -bg suffix: a fill, and therefore movable.
    expect(isAnchor("badge-provider-codex-bg", vars)).toBe(false);
    expect(isAnchor("accent", vars)).toBe(false);
    // Unparseable (a shadow) — not ours to move either.
    expect(isAnchor("shadow-md", vars)).toBe(true);
  });
});

describe("generation-time correction", () => {
  /** A theme in the shape the generator is asked for: every listed name present. */
  function completeTheme(overrides: { dark?: Record<string, string>; light?: Record<string, string> } = {}) {
    return {
      dark: { ...BUILTIN_PALETTE.dark, ...(overrides.dark ?? {}) },
      light: { ...BUILTIN_PALETTE.light, ...(overrides.light ?? {}) },
    };
  }

  it("finds no work at all on the built-in palette", async () => {
    // The palette used to arrive here with two failing pairings and leave with
    // them intact. Now the corrector is handed a clean theme and must recognise
    // it as clean — a correction on this input would mean the stylesheet and
    // the measurement disagree about what AA is.
    const seed = completeTheme();
    const outcome = await correctThemeContrast(seed.dark, seed.light);
    expect(outcome.corrections).toEqual([]);
    expect(outcome.unsatisfiable).toEqual([]);
  });

  it("reaches a fixed point — correcting its own output changes nothing", async () => {
    // Not a stylistic nicety: a corrector that keeps finding work on its own
    // output is one whose "fixed" claims are not stable, and the retry loop in
    // generateThemeCSS would be deciding on numbers that move underneath it.
    // The seed has to be a theme that genuinely needs work: the built-in
    // palette no longer does, so using it here would assert nothing.
    const seed = completeTheme({ light: { "status-triggered": "#f59e0b" }, dark: { accent: "#17604a", "toggle-knob": "#a8a8a8" } });
    const once = await correctThemeContrast(seed.dark, seed.light);
    expect(once.corrections.length).toBeGreaterThan(0);
    const twice = await correctThemeContrast(once.dark, once.light);
    expect(twice.corrections).toEqual([]);
    // Whatever it could not reach on the first pass it still cannot reach, and
    // it does not thrash trying.
    expect(twice.unsatisfiable.map((f) => `${f.mode}:${f.id}`)).toEqual(once.unsatisfiable.map((f) => `${f.mode}:${f.id}`));
  });

  it("raises a sub-AA foreground to AA, keeping its hue", async () => {
    // amber-500 as text on a tint of itself: 1.71:1, the worst pairing #293 met.
    const theme = completeTheme({ light: { "status-triggered": "#f59e0b" } });
    const before = auditThemeVars(theme.dark, theme.light);
    expect(before.failures.some((f) => f.id === "chatlist-badge-triggered" && f.mode === "light")).toBe(true);

    const after = await correctThemeContrast(theme.dark, theme.light);
    const moved = after.corrections.find((c) => c.variable === "status-triggered" && c.mode === "light");
    expect(moved).toBeDefined();

    const fromHue = rgbaToOklch(parseCssColor("#f59e0b")!).h;
    const toHue = rgbaToOklch(parseCssColor(moved!.to)!).h;
    expect(toHue).toBeCloseTo(fromHue, 0);

    const measured = measureMode(after.light, "light").find((m) => m.pairing.id === "chatlist-badge-triggered");
    expect(measured!.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("never returns a corrected theme that still fails a pairing it claims to have fixed", async () => {
    const theme = completeTheme({ light: { "status-triggered": "#f59e0b", warning: "#ca8a04", danger: "#ef4444" } });
    const after = await correctThemeContrast(theme.dark, theme.light);
    const report = auditThemeVars(after.dark, after.light);
    const stillFailing = new Set(report.failures.map((f) => `${f.mode}:${f.id}`));
    const claimed = after.corrections.flatMap((c) => c.fixed.map((id) => `${c.mode}:${id}`));
    for (const id of claimed) expect(stillFailing.has(id), id).toBe(false);
  });

  it("reports what it could not fix instead of dragging a colour somewhere muddy", async () => {
    // A near-white hover fill. --accent-hover is an identity colour, so the fill
    // does not move; the ink is aliased to --bg, and --bg is a surface the
    // corrector must not touch, so the ink does not move either. Both levers
    // gone, the pairing is reported rather than approximated.
    //
    // The ink is pinned deliberately. Left as a literal #ffffff this is no longer
    // unsatisfiable — darkening --text-on-accent rescues it, and since the
    // built-in palette's fills now all carry a dark ink at AA, that answer is
    // available where before it broke `provider-badge-codex`. Correction getting
    // *better* is not something to hide behind a fixture that no longer bites.
    const theme = completeTheme({ light: { "accent-hover": "#fdfdfd", "text-on-accent": "var(--bg)" } });
    const after = await correctThemeContrast(theme.dark, theme.light);
    const hoverFail = after.unsatisfiable.find((f) => f.id === "on-accent-hover" && f.mode === "light");
    expect(hoverFail).toBeDefined();
    // And it did not silently blacken the identity colour to get there.
    expect(after.corrections.find((c) => c.variable === "accent-hover" && c.mode === "light")).toBeUndefined();
  });

  it("only ever hands back keys the theme already owned", async () => {
    const dark = { ...BUILTIN_PALETTE.dark };
    const light = { warning: "#ca8a04" };
    const after = await correctThemeContrast(dark, light);
    expect(Object.keys(after.light)).toEqual(["warning"]);
  });

  it("does not flatten an alias into a literal", async () => {
    // A theme that aliases one variable to another keeps the alias: correcting
    // it would sever the cascade the alias exists to carry.
    const theme = completeTheme({ light: { warning: "var(--danger)", danger: "#ef4444" } });
    const after = await correctThemeContrast(theme.dark, theme.light);
    expect(after.light.warning).toBe("var(--danger)");
  });

  it("leaves the message-bubble surfaces where the theme put them", async () => {
    // Reproduced before SURFACE_VARS grew: mid-grey bubbles under a near-white
    // --text, which cannot lighten further, so the cheapest move the corrector
    // could find was to drag all three fills #8a8a8a → #6a6a6a — collapsing the
    // user bubble, the assistant bubble and the code block onto one colour. They
    // are opaque, so isAnchor's alpha test said nothing about them, and they are
    // the largest painted areas in the app.
    const theme = completeTheme({
      dark: { "user-bg": "#8a8a8a", "assistant-bg": "#8a8a8a", "code-bg": "#8a8a8a" },
    });
    const after = await correctThemeContrast(theme.dark, theme.light);
    expect(after.dark["user-bg"]).toBe("#8a8a8a");
    expect(after.dark["assistant-bg"]).toBe("#8a8a8a");
    expect(after.dark["code-bg"]).toBe("#8a8a8a");
    expect(after.corrections.some((c) => ["user-bg", "assistant-bg", "code-bg"].includes(c.variable))).toBe(false);
    // Held as a surface, the pairing is correctly reported as one nothing legal
    // fixes rather than silently repainted.
    expect(after.unsatisfiable.some((f) => f.id === "text-on-user-bg" && f.mode === "dark")).toBe(true);
  });

  it("reseeds a carrier that blocks by passing, not only one that is itself failing", async () => {
    // The H2 case, reproduced. --accent must lighten to clear
    // `accent-on-accent-bg-surface` (4.06:1) and `chatlist-badge-agent` (4.05:1);
    // a mid-grey --toggle-knob reads 3.14:1 on it, which *passes*. Lighten the
    // accent at all and the knob drops under 3:1, so correctVariable's
    // all-pairings rule admits no candidate and --accent never moves. The knob
    // never appears among the failures, so a filter looking for carriers in
    // `stuck` never considers it.
    //
    // The seed has moved twice with the palette, because it is calibrated
    // against --accent-text's mix: at 80%-toward-white the deadlock needed
    // #2a7059/#bdbdbd, and at 70% that accent no longer fails the ink pairings
    // at all. Darker accent, darker knob, same geometry — and the knob still
    // reads the 3.14:1 the case is named for.
    const SEED_ACCENT = "#17604a";
    const theme = completeTheme({ dark: { accent: SEED_ACCENT, "toggle-knob": "#a8a8a8" } });

    const before = measureMode(theme.dark, "dark");
    expect(before.find((m) => m.pairing.id === "toggle-knob-on-accent")!.passes).toBe(true);
    expect(before.find((m) => m.pairing.id === "accent-on-accent-bg-surface")!.passes).toBe(false);

    const after = await correctThemeContrast(theme.dark, theme.light);
    expect(after.unsatisfiable.filter((f) => f.mode === "dark")).toEqual([]);
    // The knob is what was reseeded — that is the behaviour under test, and
    // asserting it here is what stops this from passing for the wrong reason.
    expect(after.corrections.some((c) => c.mode === "dark" && c.variable === "toggle-knob")).toBe(true);

    // --accent moved, which is the whole point: it could not before. Measured
    // against the seed, not against a value the seed used to have.
    const accentMove = Math.abs(rgbaToOklch(parseCssColor(after.dark.accent)!).l - rgbaToOklch(parseCssColor(SEED_ACCENT)!).l);
    expect(accentMove).toBeGreaterThan(0);
    expect(accentMove).toBeLessThan(0.1);
  });

  it("relaxes a seeded carrier back toward the value the theme asked for", async () => {
    // A seed is deliberately extreme because its job is to break a deadlock, not
    // to be the answer. Handing back a near-black knob when the theme asked for
    // a light one is a correction nobody requested — the knob only has to
    // reach 3:1. Same fixture as the test above, which is the one that actually
    // seeds it; on the old pair nothing deadlocked, so nothing was seeded and
    // this asserted only that an untouched value came back untouched.
    const theme = completeTheme({ dark: { accent: "#2a7059", "toggle-knob": "#bdbdbd" } });
    const after = await correctThemeContrast(theme.dark, theme.light);

    const knob = rgbaToOklch(parseCssColor(after.dark["toggle-knob"])!);
    expect(knob.l).toBeGreaterThanOrEqual(rgbaToOklch(parseCssColor("#bdbdbd")!).l);
    const measured = measureMode(after.dark, "dark").find((m) => m.pairing.id === "toggle-knob-on-accent");
    expect(measured!.ratio).toBeGreaterThanOrEqual(3);
  });

  it("never accepts a seeded outcome that resolves less than the plain one", async () => {
    // The search is not a complete joint solver and does not claim to be. What
    // it guarantees is the direction of the error: seeding can fail to help, and
    // must never hurt.
    const theme = completeTheme({ light: { "accent-hover": "#fdfdfd", "text-on-accent": "#ffffff", "toggle-knob": "#f4f4f4" } });
    const after = await correctThemeContrast(theme.dark, theme.light);
    const report = auditThemeVars(after.dark, after.light);
    // Everything it claims to have fixed really is fixed...
    const stillFailing = new Set(report.failures.map((f) => `${f.mode}:${f.id}`));
    for (const c of after.corrections) for (const id of c.fixed) expect(stillFailing.has(`${c.mode}:${id}`), id).toBe(false);
    // ...and what it gave up on, it reported.
    for (const f of report.failures)
      expect(
        after.unsatisfiable.some((u) => u.id === f.id && u.mode === f.mode),
        `${f.mode}:${f.id}`,
      ).toBe(true);
  });

  it("terminates on a self-referential tint rather than chasing the asymptote", async () => {
    // --chatlist-summon-bg is a color-mix of --warning itself, so darkening
    // --warning darkens its own backdrop. There is a value that works, but the
    // point is that the search returns at all.
    const theme = completeTheme({ light: { warning: "#fde68a" } });
    const started = Date.now();
    const after = await correctThemeContrast(theme.dark, theme.light);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(after).toBeDefined();
  });

  it("hands the event loop back while it searches", async () => {
    // The daemon is one thread, and that thread is also every open SSE stream.
    // A search that never yields is a stall in the whole application for as long
    // as it runs — which is the reason this function is async at all, so it is
    // worth asserting rather than assuming.
    //
    // The fixture is chosen for its *cost*, not for what it says about colour:
    // pale identity colours in both modes, which is the shape that makes the
    // seed pass run the greedy correction from every carrier polarity. It has to
    // outlast the yield interval by a wide margin for the assertion to mean
    // anything, and the built-in palette no longer does — it corrects in under a
    // millisecond now that it arrives here clean. So the run's length is asserted
    // too: if this fixture ever stops being expensive, the failure should say
    // "re-pick the fixture" rather than quietly stop testing anything.
    const pale = {
      warning: "#fde68a",
      "status-triggered": "#f59e0b",
      "accent-hover": "#fdfdfd",
      "text-on-accent": "#ffffff",
      "toggle-knob": "#f4f4f4",
      danger: "#fca5a5",
      success: "#bbf7d0",
      "badge-info": "#bfdbfe",
    };
    const theme = completeTheme({ dark: pale, light: pale });

    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    const started = performance.now();
    try {
      await correctThemeContrast(theme.dark, theme.light);
    } finally {
      clearInterval(heartbeat);
    }
    expect(performance.now() - started).toBeGreaterThan(20);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("audit", () => {
  it("measures both modes and sorts the worst first", () => {
    const report = auditThemeVars({}, {});
    expect(report.checked).toBe(PAIRINGS.length * 2);
    const ratios = report.failures.map((f) => f.ratio ?? 0);
    expect([...ratios].sort((a, b) => a - b)).toEqual(ratios);
  });

  it("reports a theme's own failures, not the stylesheet's, where the two differ", () => {
    const clean = auditThemeVars({}, {});
    const worse = auditThemeVars({}, { "status-triggered": "#f59e0b" });
    expect(worse.failures.length).toBeGreaterThan(clean.failures.length);
  });

  it("carries the threshold each pairing was judged against", () => {
    expect(minimumRatio("text")).toBe(4.5);
    expect(minimumRatio("nonText")).toBe(3);
    const report = auditThemeVars({}, {});
    for (const f of report.failures) expect([3, 4.5]).toContain(f.required);
  });
});
