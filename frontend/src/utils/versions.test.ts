/**
 * The comparison that decides whether Callboard offers to update itself.
 *
 * It moved out of `AboutSettings.tsx` so the update banner could use the same
 * one, and these cases are the reason it is worth a suite rather than a
 * `>`: this project publishes pre-release versions (`1.0.0-alpha.52`), and both
 * rules that matter about them are ones a string compare gets backwards.
 */
import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion } from "./versions";

describe("compareVersions", () => {
  it("orders release versions numerically, not lexically", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats a missing segment as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("ranks a release above its own pre-releases", () => {
    expect(compareVersions("1.0.0", "1.0.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0")).toBeLessThan(0);
  });

  it("orders numeric pre-release segments numerically", () => {
    // The one this project hits on every release: alpha.52 comes after alpha.9,
    // and a string compare says the opposite.
    expect(compareVersions("1.0.0-alpha.52", "1.0.0-alpha.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.9", "1.0.0-alpha.10")).toBeLessThan(0);
  });

  it("orders mixed pre-release tags with numbers before strings", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });
});

describe("isNewerVersion", () => {
  it("is false for equal versions, and for either side missing", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "")).toBe(false);
  });

  it("answers the question the banner asks", () => {
    expect(isNewerVersion("1.0.0-alpha.52", "1.0.0-alpha.53")).toBe(true);
    expect(isNewerVersion("1.0.0-alpha.53", "1.0.0-alpha.52")).toBe(false);
    // A published release supersedes the pre-release line it came from.
    expect(isNewerVersion("1.0.0-alpha.52", "1.0.0")).toBe(true);
  });
});
