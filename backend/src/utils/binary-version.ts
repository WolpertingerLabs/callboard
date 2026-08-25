/**
 * `<binary> --version`, at most once per path per {@link BINARY_VERSION_TTL_MS}.
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
 * ## Cached per path, stale-while-revalidate
 *
 * Keyed by path rather than by engine, so that pointing an override somewhere
 * new and pressing Recheck cannot be answered from the old binary's cache entry.
 *
 * It was cached for the whole **process lifetime**, and that was wrong in one
 * specific and increasingly common way: Claude Code upgrades itself *in place*.
 * A new version at the same path is a new answer under an unchanged key, so a
 * daemon left running for a week showed Settings → About a version number that
 * had been false for six days. Recheck does drop this cache — but Recheck is a
 * button on Settings → Engines, and the row it repairs is on Settings → About,
 * so the page that was lying offered no way to stop it.
 *
 * So an entry past {@link BINARY_VERSION_TTL_MS} is still *served*, and a
 * re-probe is started behind it for whoever asks next. That ordering is the
 * whole design: `/api/system-info` is polled, and the reason this cache exists
 * at all is that it must never pay ~108ms of `execFile` inside a request. A
 * plain TTL would reintroduce exactly that, once per TTL, on whichever unlucky
 * request crossed the line.
 *
 * The cost is bounded by demand rather than by the clock — no caller, no
 * revalidation — so an idle daemon spawns nothing and a settings page left open
 * spawns one child per TTL per path, off the request path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How long an answer is trusted before the next reader triggers a re-probe.
 *
 * One minute. The number is a trade between how long About may disagree with
 * the CLI and how often a background child process is acceptable, and both ends
 * are forgiving here: a version string is not a safety-critical fact, and the
 * thing being replaced was a **synchronous** spawn on *every* request. At a
 * minute, a user who upgrades and wonders why the number is old is right within
 * one page reload, while a settings page polling every few seconds costs one
 * spawn per minute instead of one per poll — the same probe, roughly two orders
 * of magnitude less often, and never in front of a response.
 *
 * Exported so tests pin the behaviour to this constant rather than to a literal
 * that could drift away from it.
 */
export const BINARY_VERSION_TTL_MS = 60_000;

interface CachedVersion {
  /** First line of `<path> --version`, or `undefined` when the spawn produced nothing. */
  line: string | undefined;
  /** When the probe that produced {@link line} settled, for the TTL above. */
  probedAt: number;
}

const binaryVersionCache = new Map<string, CachedVersion>();

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
  const cached = binaryVersionCache.get(execPath);
  if (cached) {
    // An entry, even one holding `undefined`, is a real answer: a binary that
    // ran and printed nothing usable must not be re-spawned on every read, and
    // it gets the same TTL as a successful one so a broken install that gets
    // repaired converges too.
    if (Date.now() - cached.probedAt >= BINARY_VERSION_TTL_MS) {
      // Fire-and-forget. `startProbe` cannot reject — the spawn's own failures
      // are caught below — but the `.catch` is kept because an unhandled
      // rejection here would be a process-level event raised by a *background*
      // refresh nobody is waiting on, which is the worst place to discover one.
      void startProbe(execPath).catch(() => {});
    }
    return cached.line;
  }
  // Nothing cached: this caller waits, because there is no stale answer to
  // serve it. After a reset that is every caller once, by design — Recheck is
  // an explicit press, not a poll.
  return startProbe(execPath);
}

/** Spawn (or join) the probe for `execPath` and write its answer into the cache. */
function startProbe(execPath: string): Promise<string | undefined> {
  const inFlight = binaryVersionProbes.get(execPath);
  // Joining rather than starting a second child is what keeps a revalidation
  // from multiplying: every reader that arrives while one is running is already
  // being served the stale value, and they all share this one spawn.
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
    //
    // A *revalidation* is subject to the identical hazard — it is simply a probe
    // whose caller walked away — which is why the guard lives here, on the one
    // path both kinds of probe go through, rather than at either call site.
    if (generation === cacheGeneration) {
      // Within one generation there can only ever be this probe for this path —
      // a second is short-circuited by the `binaryVersionProbes` lookup above,
      // and the only thing that clears the map also bumps the generation. So a
      // matching generation is proof the entry is ours.
      binaryVersionCache.set(execPath, { line, probedAt: Date.now() });
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
 * user who upgrades their CLI is told about it *now* rather than within
 * {@link BINARY_VERSION_TTL_MS}. The TTL is what makes the answer eventually
 * right on its own; this is what makes the button immediate.
 *
 * Bumping {@link cacheGeneration} is the half that actually works; see the probe
 * above for what clearing the maps alone cannot do.
 */
export function resetBinaryVersionCache(): void {
  cacheGeneration++;
  binaryVersionCache.clear();
  binaryVersionProbes.clear();
}
