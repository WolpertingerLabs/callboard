/**
 * Guards `vitest.setup.node.ts` — the floor that keeps incidental test writes
 * out of the developer's real `~/.callboard`.
 *
 * This file deliberately sets no `CALLBOARD_DATA_DIR` of its own, so what it
 * observes is whatever the setup file left in place. If the `setupFiles` entry
 * is dropped from `vitest.config.ts`, this is what says so — otherwise the
 * regression is silent until a stray session appears in someone's sidebar.
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR } from "./paths.js";

describe("test data-dir sandbox", () => {
  it("points CALLBOARD_DATA_DIR somewhere other than the real ~/.callboard", () => {
    const dataDir = process.env.CALLBOARD_DATA_DIR?.trim();
    expect(dataDir).toBeTruthy();
    expect(resolve(dataDir!)).not.toBe(join(homedir(), ".callboard"));
  });

  it("is the dir that paths.ts resolved at import time", () => {
    // The check above is only worth anything if the override was in place
    // *before* the module graph loaded — DATA_DIR is a const, not a getter.
    expect(DATA_DIR).toBe(process.env.CALLBOARD_DATA_DIR);
  });
});
