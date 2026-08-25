/**
 * `<binary> --version`, once per path, for the whole daemon.
 *
 * Lived in `services/engine-status.ts` until the Claude resolver needed the same
 * probe for a different purpose — see {@link binaryVersion}'s callers below —
 * and `claude-binary.ts` cannot import `engine-status.ts` without a cycle
 * (engine-status imports the resolver). Same shape as
 * `utils/package-version.ts`, which moved down here for the same reason.
 *
 * ## Two answers, one spawn
 *
 * Callers want one of two things out of the same stdout, so the cache holds the
 * **raw first line** and each accessor derives from it:
 *
 * - {@link binaryVersion} — the first **dotted numeric** token, for anything
 *   that compares versions (`isNewerVersion`, the Codex drift check).
 * - {@link binaryVersionLine} — the banner as printed, for anything that merely
 *   *displays* it (`/api/system-info`'s `claudeCliVersion`, which the About page
 *   renders verbatim and where `"2.0.1 (Claude Code)"` is the useful string).
 *
 * Deriving both from one cached line rather than giving the second consumer its
 * own map is the point: two caches would mean two spawns of the same binary on a
 * daemon whose whole reason for caching this is that spawning is the expensive
 * part.
 *
 * A banner with no dotted token yields `undefined` **from `binaryVersion`**, and
 * it must: an earlier cut fell back to the whole first line, which meant a
 * wrapper printing `my custom codex build` became the engine's `version` — a
 * permanent amber drift row asserting resume was unsafe, and an
 * `isNewerVersion(…)` comparison over `NaN` that reported an update was
 * available. Every consumer of *that* accessor compares the value numerically or
 * against a version constant, so a string that is not a version is not an answer
 * to give them. A consumer that only prints it is not bound by that, which is
 * exactly the distinction the two accessors draw.
 *
 * Async, with `killSignal: "SIGKILL"`: `execFileSync`'s `timeout` does not bound
 * wall-clock (Node sends SIGTERM at the deadline and then waits indefinitely),
 * and a sync stall on a single-threaded server stalls every open SSE stream too.
 *
 * Cached per path for the process lifetime. Keyed by path rather than by engine
 * so that pointing an override somewhere new and pressing Recheck cannot be
 * answered from the old binary's cache entry.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** First line of `<path> --version`, or `undefined` when the spawn produced nothing. */
const binaryVersionCache = new Map<string, string | undefined>();

/** In-flight probes, so two callers asking about one path share a spawn. */
const binaryVersionProbes = new Map<string, Promise<string | undefined>>();

/**
 * Incremented by every reset, so an async probe can tell whether the world it
 * started in still exists before writing to it. See {@link resetBinaryVersionCache}.
 */
let cacheGeneration = 0;

/**
 * The `--version` banner as the binary printed it — first line, trimmed.
 *
 * `undefined` means the spawn produced no usable output at all (absent binary,
 * wrong arch, killed at the deadline), not "printed something unparseable".
 */
export async function binaryVersionLine(execPath: string): Promise<string | undefined> {
  // `has` rather than a truthiness check on `get`: a binary that ran and printed
  // nothing usable caches as `undefined`, and re-spawning it on every assembly
  // because the answer was "no version" is how a settings page starts costing a
  // process per render.
  if (binaryVersionCache.has(execPath)) return binaryVersionCache.get(execPath);
  const inFlight = binaryVersionProbes.get(execPath);
  if (inFlight) return inFlight;

  const generation = cacheGeneration;
  const probe = (async (): Promise<string | undefined> => {
    let line: string | undefined;
    try {
      const { stdout } = await execFileAsync(execPath, ["--version"], {
        timeout: 5_000,
        killSignal: "SIGKILL",
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      line = stdout.trim().split("\n")[0]?.trim() || undefined;
    } catch {
      // Present but unrunnable (wrong arch, permissions, killed at the
      // deadline) — no version to report.
      line = undefined;
    }
    // A probe started before a reset must not write its answer afterwards, and
    // must not delete the *replacement* probe's map entry. Clearing the maps
    // cannot cancel a promise already in flight, and the ordering that loses is
    // the likely one: a slow probe is the usual reason someone pressed Recheck,
    // so the stale answer tends to settle last and would win for the rest of the
    // process's life. Same guard, and the same reasoning, as `acpProviderVersion`
    // in `agents/adapters/acp/availability.ts`.
    if (generation === cacheGeneration) {
      // Within one generation there can only ever be this probe for this path —
      // a second is short-circuited by the `binaryVersionProbes` lookup above,
      // and the only thing that clears the map also bumps the generation. So a
      // matching generation is proof the entry is ours.
      binaryVersionCache.set(execPath, line);
      binaryVersionProbes.delete(execPath);
    }
    return line;
  })();

  binaryVersionProbes.set(execPath, probe);
  return probe;
}

/** The first dotted numeric token of the banner — the comparable version, or nothing. */
export async function binaryVersion(execPath: string): Promise<string | undefined> {
  const line = await binaryVersionLine(execPath);
  // `MAJOR.MINOR[.PATCH][-prerelease]`, anywhere on the line. No fallback to the
  // raw banner — see the module doc.
  return line ? (/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(line)?.[0] ?? undefined) : undefined;
}

/**
 * Forget every cached `--version` answer, so a re-probe actually re-spawns.
 *
 * Reached from `POST /api/engines/refresh` — via `resetEngineProbeCaches()` in
 * `services/engine-status.ts`, which calls `resetEngineStatusCache()` — so a
 * user who upgrades their CLI is told about it without restarting the daemon.
 * Bumping {@link cacheGeneration} is the half that actually works; see the
 * probe above for what clearing the maps alone cannot do.
 */
export function resetBinaryVersionCache(): void {
  cacheGeneration++;
  binaryVersionCache.clear();
  binaryVersionProbes.clear();
}
