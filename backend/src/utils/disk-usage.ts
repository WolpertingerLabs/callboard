/**
 * How much disk a directory occupies.
 *
 * Exists for one reason: worktrees are the biggest thing Callboard leaks, and
 * "43 directories" is not a number anyone acts on — "40 GB" is. Adoption
 * discovery reports it per candidate so the human deciding what to adopt can
 * start with the expensive ones.
 *
 * `du -sk` rather than a recursive walk in Node: `-s` and `-k` are both POSIX,
 * it counts blocks actually allocated rather than apparent size, and a
 * `node_modules` that would take a JS walk tens of seconds takes it a fraction
 * of that. It is still slow enough to need a timeout and a budget, which is why
 * a measurement can legitimately come back absent — a missing number is never
 * fatal here, it is just a column a caller cannot sort on.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import type { WorktreeDiskUsage } from "shared/types/index.js";

/** Per-directory ceiling. A cold `node_modules` on a slow disk is seconds. */
export const DISK_USAGE_TIMEOUT_MS = 15000;

/**
 * Size of `directory` in bytes, or an explanation of why there is no number.
 *
 * Never throws. `du` exits non-zero when it cannot read a subdirectory but
 * still prints a total for what it could read, so a partial answer is used and
 * labelled rather than discarded.
 */
export function directoryDiskUsage(directory: string, timeoutMs: number = DISK_USAGE_TIMEOUT_MS): WorktreeDiskUsage {
  if (!directory || !existsSync(directory)) {
    return { error: `Directory does not exist: ${directory}` };
  }
  const parse = (out: string): number | undefined => {
    const kb = Number.parseInt(String(out).trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined;
  };
  try {
    const bytes = parse(execFileSync("du", ["-sk", directory], { encoding: "utf8", stdio: "pipe", timeout: timeoutMs }));
    return bytes === undefined ? { error: "du produced no parseable total" } : { bytes };
  } catch (err: any) {
    const partial = typeof err?.stdout === "string" ? parse(err.stdout) : undefined;
    const message = (err?.killed ? `timed out after ${timeoutMs}ms` : err?.message) || String(err);
    return partial === undefined ? { error: `du failed: ${message}` } : { bytes: partial, error: `du reported errors (${message}); total is partial` };
  }
}
