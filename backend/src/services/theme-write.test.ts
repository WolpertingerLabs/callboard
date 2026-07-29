/**
 * The gate every theme write goes through.
 *
 * `generateThemeCSS` used to be the only guarded one of four, which is close to
 * the opposite of useful: `update_theme` sat beside it in the same tool list,
 * merged whatever it was handed straight onto disk, and was the natural recovery
 * path when the guarded one refused. These tests are about the gate itself; the
 * ones proving each write actually calls it live next to those writes.
 */
import { describe, expect, it } from "vitest";
import { prepareThemeWrite, describeFailures } from "./theme-write.js";
import { BUILTIN_PALETTE } from "./theme-contrast-palette.js";
import { measureMode } from "./theme-contrast.js";

/** A theme in the shape the generator is asked for, with overrides applied. */
function complete(dark: Record<string, string> = {}, light: Record<string, string> = {}) {
  return { dark: { ...BUILTIN_PALETTE.dark, ...dark }, light: { ...BUILTIN_PALETTE.light, ...light } };
}

describe("prepareThemeWrite — filtering", () => {
  it("drops a derived variable rather than letting a write pin it flat", () => {
    // `--chatlist-badge-triggered-bg` is a color-mix of `--status-triggered`. A
    // theme that set it to a literal would sever the cascade it exists to carry
    // — the same thing `keep()` prevents on the generate path, and exactly what
    // an agent asked to "make the triggered badge more orange" would write.
    const out = prepareThemeWrite({
      dark: { ...complete().dark, "chatlist-badge-triggered-bg": "#ff00ff" },
      light: complete().light,
    });
    expect(out.dropped).toContain("chatlist-badge-triggered-bg");
    expect(out.dark).not.toHaveProperty("chatlist-badge-triggered-bg");
  });

  it("drops a name that is not a theme variable at all", () => {
    const out = prepareThemeWrite({ dark: { ...complete().dark, "not-a-variable": "#123456" }, light: complete().light });
    expect(out.dropped).toContain("not-a-variable");
  });

  it("filters the incoming write, not the theme it is merged into", () => {
    // Deleting a user's stored values because they were merged past on the way
    // to a different edit is a write nobody asked for.
    const existing = { dark: { ...complete().dark, "legacy-key": "#123456" }, light: complete().light };
    const out = prepareThemeWrite({ dark: { warning: "#e3b341" }, existing });
    expect(out.dark["legacy-key"]).toBe("#123456");
    expect(out.dropped).toEqual([]);
  });
});

describe("prepareThemeWrite — correction and refusal", () => {
  it("corrects a sub-AA value arriving through an update, not just through generation", () => {
    // The item-1 scenario end to end: an agent asked to warm up the triggered
    // badge writes amber-500, which measures 1.71:1 as text on a tint of itself.
    const existing = complete();
    const out = prepareThemeWrite({ light: { "status-triggered": "#f59e0b" }, existing });

    expect(out.unsatisfiable).toEqual([]);
    expect(out.light["status-triggered"]).not.toBe("#f59e0b");
    const measured = measureMode(out.light, "light").find((m) => m.pairing.id === "chatlist-badge-triggered");
    expect(measured!.ratio).toBeGreaterThanOrEqual(4.5);
    expect(out.corrections.some((c) => c.variable === "status-triggered" && c.mode === "light")).toBe(true);
  });

  it("reports what no lightness move fixes, so the caller can refuse", () => {
    // The ink is aliased to --bg rather than left at #ffffff: --bg is a surface
    // the corrector will not move, which is what leaves the pairing with no
    // lever at all. Against a literal white ink this is now *satisfiable* —
    // darkening --text-on-accent rescues it, an answer that only became legal
    // once the built-in fills all carried a dark ink at AA themselves.
    const existing = complete();
    const out = prepareThemeWrite({ light: { "accent-hover": "#fdfdfd", "text-on-accent": "var(--bg)" }, existing });
    expect(out.unsatisfiable.some((f) => f.id === "on-accent-hover" && f.mode === "light")).toBe(true);
    // And says enough for a caller to fix the right colour.
    expect(describeFailures(out.unsatisfiable)).toContain("var(--accent-hover)");
    expect(describeFailures(out.unsatisfiable)).toContain("needs 4.5:1");
  });

  it("hands back a clean audit alongside the values it would store", () => {
    const out = prepareThemeWrite(complete());
    expect(out.contrast.failures).toEqual([]);
    expect(out.contrast.checked).toBeGreaterThan(0);
  });
});

describe("prepareThemeWrite — what a write is accountable for", () => {
  /**
   * The rule: introduces nothing, worsens nothing. Not "the whole app reaches
   * AA".
   *
   * The palette pass took the stylesheet's own failures from 24 of 104 to 4, and
   * the four left are `on-accent` and `on-accent-hover` in both modes: white on
   * `--accent`, which no ink and no tint reaches, only a different brand colour.
   * That is a smaller reason than the one this rule was written for, but it is
   * the same reason. A write that says `{ warning: ... }` still inherits them,
   * still cannot name them without authoring `--accent` too, and refusing it for
   * a pairing it neither touched nor can reach is a rejection the author cannot
   * act on. So the rule stays as it is until the accent question is answered.
   */
  it("accepts a partial write that leaves the stylesheet's own failures where they were", () => {
    const out = prepareThemeWrite({ light: { warning: "#8a5a00" } });
    expect(out.unsatisfiable).toEqual([]);
    // And is not pretending they passed: the audit still carries every one.
    expect(out.contrast.failures.some((f) => f.id === "on-accent")).toBe(true);
  });

  it("refuses a write that makes an already-failing pairing worse", () => {
    // --accent-hover is the theme's to choose, and light-mode `on-accent-hover`
    // starts at 3.08:1. Driving it below that is the write's doing.
    const out = prepareThemeWrite({ light: { "accent-hover": "#fdfdfd", "text-on-accent": "#ffffff" } });
    const hover = out.unsatisfiable.find((f) => f.id === "on-accent-hover" && f.mode === "light");
    expect(hover).toBeDefined();
    expect(hover!.ratio).toBeLessThan(3.08);
  });

  it("refuses a write that breaks a pairing the stylesheet passes", () => {
    // `text-on-bg` is 14.63:1 on the built-in light palette. Nothing about the
    // baseline rule lets a write take it to 1.0.
    const out = prepareThemeWrite({ light: { text: "#fffef8", bg: "#fffef8" } });
    expect(out.unsatisfiable.some((f) => f.id === "text-on-bg" && f.mode === "light")).toBe(true);
  });

  it("treats an unreadable value as the write's problem regardless of the baseline", () => {
    const out = prepareThemeWrite({ light: { warning: "goldenrod" } });
    expect(out.unsatisfiable.some((f) => f.unmeasurable?.includes("goldenrod"))).toBe(true);
  });
});

describe("prepareThemeWrite — the allowBelowAA opt-out", () => {
  const authored = { light: { "accent-hover": "#fdfdfd", "text-on-accent": "var(--bg)" }, existing: complete() };

  it("stores a human-authored value exactly as written", () => {
    // The distinction is authorship. A person editing their own theme file
    // through an API they had to name a flag to reach is exercising ownership
    // over their own data; quietly moving the value answers a question nobody
    // asked. So the opt-out skips correction, not only the refusal.
    const out = prepareThemeWrite({ ...authored, allowBelowAA: true });
    expect(out.light["accent-hover"]).toBe("#fdfdfd");
    expect(out.corrections).toEqual([]);
    expect(out.unsatisfiable).toEqual([]);
  });

  it("still reports what it stored, so the caller can warn", () => {
    const out = prepareThemeWrite({ ...authored, allowBelowAA: true });
    expect(out.contrast.failures.some((f) => f.id === "on-accent-hover" && f.mode === "light")).toBe(true);
  });

  it("still filters — a severed cascade is not a matter of taste", () => {
    const out = prepareThemeWrite({ dark: { "chatlist-badge-triggered-bg": "#ff00ff" }, existing: complete(), allowBelowAA: true });
    expect(out.dropped).toContain("chatlist-badge-triggered-bg");
    // The flat value never lands; the existing color-mix keeps carrying the
    // theme's own --status-triggered through to the badge, which is the point.
    expect(out.dark["chatlist-badge-triggered-bg"]).toContain("var(--status-triggered)");
  });

  it("refuses the same write without the flag", () => {
    const out = prepareThemeWrite(authored);
    expect(out.unsatisfiable.length).toBeGreaterThan(0);
  });
});
