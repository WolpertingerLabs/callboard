/**
 * Build identity — how a browser tab and the daemon under it tell each other
 * which build they are.
 *
 * Callboard is installed globally and restarted in place (`npm i -g` then
 * `callboard restart`). An open tab keeps its JavaScript indefinitely: it
 * reconnects SSE and carries on, so a bundle from before the upgrade goes on
 * talking to a daemon from after it. `stream.ts` opens with exactly this
 * premise, and #364 is what it looks like when a tab loses that bet — a REST
 * field it read unconditionally was gone, and the tab took a `TypeError`
 * through the whole root. #367 contained that to one region. Neither one
 * *tells* the user, before the crash, that reloading is the fix.
 *
 * A build id is the missing signal. It travels on `GET /api/sessions/poll`,
 * which the frontend already hits every second.
 *
 * ## What the id is
 *
 * `<package version>+g<git sha>` for a build off a clean tree, with a
 * timestamp suffix when the tree is dirty and a timestamp alone when there is
 * no git at all. Composed in `frontend/vite.config.ts`, which is the only
 * place that knows it: the value is `define`d into the bundle *and* emitted
 * beside it as `frontend/dist/build-id.json`, so one `vite build` stamps both
 * halves of the pair with the same token and the daemon can read the identity
 * of the very bundle it serves.
 *
 * The version alone would not do. Callboard ships alpha builds by the dozen
 * under one version string, and a rebuild from source never moves it — the
 * upgrade this is meant to catch would be invisible. A build timestamp alone
 * has the opposite fault: it moves on *every* rebuild, so re-running
 * `npm run build` on an unchanged tree would prompt every open tab to reload
 * for nothing. The git sha is the identity of the source that produced the
 * bundle, which is the thing actually being asked about, and the dirty-tree
 * timestamp covers the one case a sha cannot distinguish — two builds of the
 * same commit with different uncommitted edits.
 *
 * ## The two sentinels
 *
 * Both mean "do not draw a conclusion from this", and they exist because the
 * expensive failure here is a false positive: a prompt telling a developer to
 * reload a tab that is already current teaches them to ignore the prompt.
 *
 * - {@link DEV_BUILD_ID} is what the *bundle* reports when it came from
 *   `vite serve`. There is no meaningful build identity for a module graph
 *   being recompiled per keystroke, and a dev tab is reloaded by HMR anyway.
 * - {@link UNKNOWN_BUILD_ID} is what the *daemon* reports when there is no
 *   `build-id.json` to read — a source checkout that has never been built.
 *
 * A client that sees either one on either side stays quiet.
 */

/** The bundle came from the Vite dev server; it has no build identity. */
export const DEV_BUILD_ID = "dev";

/** The daemon found no `build-id.json` beside the frontend it serves. */
export const UNKNOWN_BUILD_ID = "unknown";

/** Emitted into `frontend/dist` by the Vite build; read by the daemon at startup. */
export const BUILD_ID_FILENAME = "build-id.json";

/** The contents of {@link BUILD_ID_FILENAME}. */
export interface BuildIdFile {
  buildId: string;
}
