import { DEV_BUILD_ID, UNKNOWN_BUILD_ID } from "shared/types/build.js";

/**
 * Injected by `define` in `frontend/vite.config.ts` — the id of the build this
 * bundle came out of. Declared, not imported, because it does not exist as a
 * value anywhere: Vite substitutes the literal at compile time.
 */
declare const __CALLBOARD_BUILD_ID__: string | undefined;

/**
 * This bundle's own build identity.
 *
 * `DEV_BUILD_ID` when the define is absent, which covers two cases that want
 * the same answer: the Vite dev server (which sets it to that sentinel itself)
 * and vitest (which loads these modules without the config's `define` at all).
 * Both are "no identity", and no identity means no prompt.
 */
export const MY_BUILD_ID: string = typeof __CALLBOARD_BUILD_ID__ === "string" ? __CALLBOARD_BUILD_ID__ : DEV_BUILD_ID;

export interface BuildWatchState {
  /**
   * The daemon build id this page load first saw. `undefined` until a poll
   * reports one — and deliberately *not* seeded from `MY_BUILD_ID`; see below.
   */
  baseline?: string;
  /** The daemon build id we are offering a reload for, if any. */
  staleBuildId?: string;
}

export const INITIAL_BUILD_WATCH: BuildWatchState = {};

/**
 * Fold one poll's `build` field into the watch state.
 *
 * **The rule is drift, not disagreement.** The prompt fires when the daemon's
 * build id *changes underneath a live page*, never when it merely differs from
 * the id this bundle was compiled with. That distinction is the whole design,
 * and it is not squeamishness — comparing against `MY_BUILD_ID` has a real
 * false positive with the daemon's cached read (`backend/src/services/
 * build-identity.ts`): build the frontend without restarting the daemon, reload
 * a tab, and the tab holds a bundle *newer* than the id the daemon reports.
 * Told to reload, the user would reload into the same mismatch, forever. Drift
 * cannot produce that, because whatever the daemon says on the first poll is
 * accepted as the truth of this page load rather than judged against anything.
 *
 * Which is also why **the first observation never fires**: there is nothing yet
 * to have drifted from. It seeds `baseline` and returns quietly.
 *
 * `MY_BUILD_ID` still earns its place, on rule 4 — a daemon reporting *our* id
 * is positive proof this tab is current, so it clears a prompt that is already
 * up. That is what a rollback looks like, and a stale-tab warning that outlives
 * the staleness is its own kind of wrong.
 *
 * @param serverBuild the response's `build` field, or `undefined` when the
 *   daemon omitted it — which means "you already have this one", not "changed".
 * @param myBuild this bundle's id; a parameter rather than a closed-over
 *   constant so tests can state both halves of the pair explicitly.
 */
export function observeServerBuild(state: BuildWatchState, serverBuild: string | undefined, myBuild: string = MY_BUILD_ID): BuildWatchState {
  // 1. Nothing reported: the daemon is echoing agreement, or it predates this
  //    field entirely. Either way it carries no news.
  if (serverBuild === undefined) return state;

  // 2. A dev bundle is recompiled per keystroke and reloaded by HMR. It has no
  //    identity to be stale against, and prompting a developer to reload a tab
  //    that is already current is how a prompt gets trained out of usefulness.
  if (myBuild === DEV_BUILD_ID) return state;

  // 3. A daemon with no built frontend cannot identify itself. Do not let the
  //    sentinel become a baseline, or the first real id after it would read as
  //    drift and fire.
  if (serverBuild === UNKNOWN_BUILD_ID) return state;

  // 4. We provably match the daemon. Adopt it and clear any standing prompt.
  if (serverBuild === myBuild) {
    return state.baseline === serverBuild && state.staleBuildId === undefined ? state : { baseline: serverBuild };
  }

  // 5. First observation of this page load. Seed, say nothing.
  if (state.baseline === undefined) return { baseline: serverBuild };

  // 6. The daemon moved. Re-baseline as well as prompt, so that a *further*
  //    move produces a new `staleBuildId` and re-prompts past a dismissal of
  //    the previous one.
  if (serverBuild !== state.baseline) return { baseline: serverBuild, staleBuildId: serverBuild };

  // 7. Unchanged from the baseline we are holding.
  return state;
}

/**
 * Whether to draw the prompt: something drifted, and it is not the exact build
 * the user already waved off. Dismissal is keyed by the id rather than being a
 * boolean precisely so that the *next* upgrade gets a hearing.
 */
export function shouldPromptReload(state: BuildWatchState, dismissedBuildId: string | null): boolean {
  return state.staleBuildId !== undefined && state.staleBuildId !== dismissedBuildId;
}
