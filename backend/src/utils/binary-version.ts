/**
 * `<binary> --version`, once per path, for the whole daemon.
 *
 * Lived in `services/engine-status.ts` until the Claude resolver needed the same
 * probe for a different purpose — see {@link binaryVersion}'s two callers below
 * — and `claude-binary.ts` cannot import `engine-status.ts` without a cycle
 * (engine-status imports the resolver). Same shape as
 * `utils/package-version.ts`, which moved down here for the same reason.
 *
 * The CLIs print `"2.0.1 (Claude Code)"` and `"codex-cli 0.146.0"`, so the
 * answer is the first **dotted numeric** token on the first line.
 *
 * A banner with no such token yields `undefined`, and it must: an earlier cut
 * fell back to the whole first line, which meant a wrapper printing `my custom
 * codex build` became the engine's `version` — a permanent amber drift row
 * asserting resume was unsafe, and an `isNewerVersion(…)` comparison over `NaN`
 * that reported an update was available. Every consumer compares this value
 * numerically or against a version constant, so a string that is not a version
 * is not an answer to give them.
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

const binaryVersionCache = new Map<string, string | undefined>();

/** In-flight probes, so two callers asking about one path share a spawn. */
const binaryVersionProbes = new Map<string, Promise<string | undefined>>();

export async function binaryVersion(execPath: string): Promise<string | undefined> {
  // `has` rather than a truthiness check on `get`: a binary that ran and printed
  // nothing usable caches as `undefined`, and re-spawning it on every assembly
  // because the answer was "no version" is how a settings page starts costing a
  // process per render.
  if (binaryVersionCache.has(execPath)) return binaryVersionCache.get(execPath);
  const inFlight = binaryVersionProbes.get(execPath);
  if (inFlight) return inFlight;

  const probe = (async (): Promise<string | undefined> => {
    let version: string | undefined;
    try {
      const { stdout } = await execFileAsync(execPath, ["--version"], {
        timeout: 5_000,
        killSignal: "SIGKILL",
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      const firstLine = stdout.trim().split("\n")[0]?.trim() ?? "";
      // `MAJOR.MINOR[.PATCH][-prerelease]`, anywhere on the line. No fallback to
      // the raw banner — see the module doc.
      version = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(firstLine)?.[0];
    } catch {
      // Present but unrunnable (wrong arch, permissions, killed at the
      // deadline) — no version to report.
      version = undefined;
    }
    binaryVersionCache.set(execPath, version);
    binaryVersionProbes.delete(execPath);
    return version;
  })();

  binaryVersionProbes.set(execPath, probe);
  return probe;
}

/** Forget every cached `--version` answer, so a re-probe actually re-spawns. */
export function resetBinaryVersionCache(): void {
  binaryVersionCache.clear();
  binaryVersionProbes.clear();
}
