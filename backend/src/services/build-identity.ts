import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { UNKNOWN_BUILD_ID, BUILD_ID_FILENAME, type BuildIdFile } from "shared";

const __pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The directory `index.ts` serves the frontend from, and the one the id lives beside. */
const FRONTEND_DIST = path.join(__pkgRoot, "frontend", "dist");

/**
 * Read a build id out of a built frontend directory.
 *
 * Returns {@link UNKNOWN_BUILD_ID} for every way this can fail — no file, bad
 * JSON, no `buildId` key, empty string. There is no error case worth
 * distinguishing: all of them mean the daemon cannot say which build it is, and
 * a client that hears that stays quiet rather than guessing.
 */
export function readBuildIdFrom(distDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(distDir, BUILD_ID_FILENAME), "utf-8")) as BuildIdFile;
    return typeof parsed.buildId === "string" && parsed.buildId.length > 0 ? parsed.buildId : UNKNOWN_BUILD_ID;
  } catch {
    return UNKNOWN_BUILD_ID;
  }
}

let cached: string | undefined;

/**
 * The build identity of the frontend this daemon serves.
 *
 * Read once, at first call, from the `build-id.json` that `vite build` emits
 * into `frontend/dist` — the same directory `index.ts` serves static files
 * from, so this is literally the identity of the bundle a tab downloads.
 *
 * **Read once on purpose.** The poll this feeds runs once a second per open
 * tab; a `readFileSync` — or even a `stat` — on that path is not something to
 * do per request. The cost of caching is one scenario: rebuild the frontend
 * without restarting the daemon, hard-reload a tab, and the tab now holds a
 * *newer* bundle than the id the daemon reports. That mismatch points the wrong
 * way — the tab is fresh, not stale — and it is exactly why the client compares
 * the daemon's id against itself over time rather than against its own
 * compile-time id. See `frontend/src/utils/buildIdentity.ts`.
 *
 * {@link UNKNOWN_BUILD_ID} when there is nothing to read, which is the normal
 * state of a source checkout that has never been built.
 */
export function getServerBuildId(): string {
  if (cached === undefined) cached = readBuildIdFrom(FRONTEND_DIST);
  return cached;
}

/** Test seam: drops the memo so a following call re-reads the tree. */
export function resetServerBuildIdCache(): void {
  cached = undefined;
}
