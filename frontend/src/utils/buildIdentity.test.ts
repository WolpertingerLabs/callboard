/**
 * The rules that decide whether a tab gets told it is out of date.
 *
 * Every one of these is a claim about a false positive or a false negative, and
 * the two are not symmetric. A missed prompt costs the user a confusing crash
 * they can still reload their way out of (#367 says so on the fallback). A
 * spurious prompt costs the prompt its credibility, permanently — after the
 * second wrong one nobody reads the third. So the bias throughout is: say
 * nothing unless the daemon demonstrably moved under a live page.
 *
 * `myBuild` is passed explicitly rather than left to `MY_BUILD_ID`, which under
 * vitest is always the dev sentinel (no Vite `define`). A test that relied on
 * the constant would be asserting against "dev" and would pass no matter what
 * the production path did.
 */
import { describe, expect, it } from "vitest";
import { DEV_BUILD_ID, UNKNOWN_BUILD_ID } from "shared/types/build.js";
import { observeServerBuild, shouldPromptReload, INITIAL_BUILD_WATCH, type BuildWatchState } from "./buildIdentity";

const V1 = "1.0.0-alpha.49+gaaaaaaaaaaaa";
const V2 = "1.0.0-alpha.50+gbbbbbbbbbbbb";
const V3 = "1.0.0-alpha.51+gcccccccccccc";

/** Replay a sequence of poll `build` values from a fresh page load. */
function replay(builds: (string | undefined)[], myBuild = V1): BuildWatchState {
  return builds.reduce<BuildWatchState>((state, build) => observeServerBuild(state, build, myBuild), INITIAL_BUILD_WATCH);
}

describe("the first observation", () => {
  it("does not fire, even when the daemon's id is not ours", () => {
    // This is the load-bearing one. The daemon caches its id at startup, so a
    // frontend rebuilt without a daemon restart makes a *fresh* tab look stale.
    // Judging the first poll would tell that user to reload into the identical
    // mismatch, and they would keep doing it.
    const state = replay([V2], V1);
    expect(state.staleBuildId).toBeUndefined();
    expect(shouldPromptReload(state, null)).toBe(false);
  });

  it("adopts what it heard as the baseline", () => {
    expect(replay([V2], V1).baseline).toBe(V2);
  });

  it("stays quiet however long the daemon holds still", () => {
    const state = replay([V2, V2, V2, V2, V2], V1);
    expect(shouldPromptReload(state, null)).toBe(false);
  });
});

describe("drift", () => {
  it("fires when the daemon moves under a live page", () => {
    const state = replay([V1, V2], V1);
    expect(state.staleBuildId).toBe(V2);
    expect(shouldPromptReload(state, null)).toBe(true);
  });

  it("fires on a move between two builds that are both foreign to us", () => {
    // The bundle's own id never enters this comparison. A tab that loaded
    // against a daemon it did not match still notices the daemon moving again.
    const state = replay([V2, V3], V1);
    expect(shouldPromptReload(state, null)).toBe(true);
  });

  it("treats an omitted field as agreement, not as change", () => {
    // The daemon omits `build` when the client echoed the id it already holds.
    // Reading that silence as a change would fire on literally every poll.
    const state = replay([V1, undefined, undefined, undefined], V1);
    expect(shouldPromptReload(state, null)).toBe(false);
    expect(state.baseline).toBe(V1);
  });

  it("returns the identical state object when nothing happened", () => {
    // Identity, not just equality: the provider only writes React state when
    // the object changes, so a new object per second would be a re-render per
    // second across the whole app.
    const seeded = observeServerBuild(INITIAL_BUILD_WATCH, V1, V1);
    expect(observeServerBuild(seeded, undefined, V1)).toBe(seeded);
    expect(observeServerBuild(seeded, V1, V1)).toBe(seeded);
  });
});

describe("the sentinels", () => {
  it("never fires from a dev bundle", () => {
    // `vite serve` recompiles per keystroke and reloads the tab itself. Every
    // dev-server restart would otherwise be an upgrade notice.
    const state = replay([V1, V2, V3], DEV_BUILD_ID);
    expect(shouldPromptReload(state, null)).toBe(false);
    expect(state.baseline).toBeUndefined();
  });

  it("never lets an unbuilt daemon become a baseline", () => {
    // If "unknown" were adopted, the first real id after it would read as drift
    // — a source checkout that gets built mid-session would prompt for nothing.
    const state = replay([UNKNOWN_BUILD_ID, UNKNOWN_BUILD_ID, V2], V1);
    expect(shouldPromptReload(state, null)).toBe(false);
    expect(state.baseline).toBe(V2);
  });

  it("ignores an unknown arriving after a real baseline", () => {
    const state = replay([V1, UNKNOWN_BUILD_ID], V1);
    expect(shouldPromptReload(state, null)).toBe(false);
    expect(state.baseline).toBe(V1);
  });
});

describe("matching the daemon exactly", () => {
  it("clears a prompt when the daemon comes back to our build", () => {
    // A rollback. The tab is current again, and a warning that outlives the
    // condition it describes is its own bug.
    const drifted = replay([V1, V2], V1);
    expect(shouldPromptReload(drifted, null)).toBe(true);

    const rolledBack = observeServerBuild(drifted, V1, V1);
    expect(rolledBack.staleBuildId).toBeUndefined();
    expect(shouldPromptReload(rolledBack, null)).toBe(false);
  });

  it("never fires while the daemon reports our own id", () => {
    expect(shouldPromptReload(replay([V1, V1, V1], V1), null)).toBe(false);
  });
});

describe("dismissal", () => {
  it("holds for the build it was clicked for", () => {
    const state = replay([V1, V2], V1);
    expect(shouldPromptReload(state, V2)).toBe(false);
  });

  it("lifts when the daemon moves again", () => {
    // "Not now" is an answer about one upgrade, not a permanent opt-out.
    const state = replay([V1, V2, V3], V1);
    expect(state.staleBuildId).toBe(V3);
    expect(shouldPromptReload(state, V2)).toBe(true);
  });

  it("is irrelevant while nothing has drifted", () => {
    expect(shouldPromptReload(INITIAL_BUILD_WATCH, V2)).toBe(false);
  });
});
