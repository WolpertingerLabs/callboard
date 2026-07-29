/**
 * The inline-style layer a custom theme is applied through.
 *
 * A custom theme is written as inline custom properties on <html>, which beat
 * both `:root` and `[data-theme="light"]`. That is the mechanism, and it is also
 * the hazard: whatever the previous mode wrote stays winning until something
 * removes it. Nothing in the pipeline requires the two modes to define the same
 * keys — the generator checks five, and the theme-surface filter runs over each
 * mode on its own — so asymmetry is a normal shape, not a corrupt one.
 *
 * The consequence is what makes this worth a test of its own: the contrast
 * engine measures light mode as `{...BUILTIN.light, ...theme.light}`. A key
 * leaking across from `dark` is a colour it never looked at, so a theme it
 * audited as clean could still paint sub-AA in the browser.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./api", () => ({
  checkClaudeStatus: vi.fn(),
  getTheme: vi.fn(),
}));

import { applyCustomThemeVars } from "./App";

const ASYMMETRIC = {
  name: "Asymmetric",
  // --warning and --danger exist only in dark; --accent exists in both.
  dark: { accent: "#7c6aef", warning: "#e3b341", danger: "#f85149" },
  light: { accent: "#5b4bd6" },
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const inline = (name: string) => document.documentElement.style.getPropertyValue(`--${name}`);

describe("applyCustomThemeVars", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("removes the other mode's keys when they are not redefined", () => {
    applyCustomThemeVars(ASYMMETRIC, "dark");
    expect(inline("warning")).toBe("#e3b341");
    expect(inline("danger")).toBe("#f85149");

    applyCustomThemeVars(ASYMMETRIC, "light");

    // Without the clear, these stay inline and outrank [data-theme="light"] —
    // the dark palette's amber painted on a light theme's surfaces.
    expect(inline("warning")).toBe("");
    expect(inline("danger")).toBe("");
  });

  it("still writes the keys the target mode does define", () => {
    applyCustomThemeVars(ASYMMETRIC, "dark");
    applyCustomThemeVars(ASYMMETRIC, "light");
    expect(inline("accent")).toBe("#5b4bd6");
  });

  it("switches back without losing the keys only the first mode has", () => {
    applyCustomThemeVars(ASYMMETRIC, "dark");
    applyCustomThemeVars(ASYMMETRIC, "light");
    applyCustomThemeVars(ASYMMETRIC, "dark");
    expect(inline("warning")).toBe("#e3b341");
    expect(inline("accent")).toBe("#7c6aef");
  });

  it("leaves a symmetric theme's keys alone in both directions", () => {
    // Golden Hour happens to be symmetric, which is exactly why this bug did not
    // show up on the only stored theme anyone had.
    const symmetric = { ...ASYMMETRIC, light: { accent: "#5b4bd6", warning: "#8a5a00", danger: "#b32d24" } };
    applyCustomThemeVars(symmetric, "dark");
    applyCustomThemeVars(symmetric, "light");
    expect(inline("warning")).toBe("#8a5a00");
    expect(inline("danger")).toBe("#b32d24");
  });
});
