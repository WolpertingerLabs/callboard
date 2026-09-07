import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ComputerUseError } from "../contracts.js";

export interface NativeInputLock {
  readonly path: string;
  /** True when a lock left by a process that no longer exists was taken over. */
  readonly reclaimed: boolean;
  /** Delete the lock. Call only once every held input has been released. */
  release(): Promise<void>;
  /** Keep the lock and record why: input state is uncertain and needs an operator. */
  quarantine(reason: string): Promise<void>;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but owned by someone else. Treat as live; never steal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function inspect(path: string): Promise<{ reclaimable: boolean; reason: string }> {
  const quarantined = await readFile(join(path, "quarantined"), "utf8").catch(() => undefined);
  if (quarantined !== undefined)
    return { reclaimable: false, reason: `quarantined (${quarantined.trim() || "input state uncertain"}); inspect the desktop, then remove the lock` };
  const pid = Number.parseInt((await readFile(join(path, "pid"), "utf8").catch(() => "")).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { reclaimable: false, reason: "no holder recorded; remove the lock after confirming no input is held" };
  if (alive(pid)) return { reclaimable: false, reason: `held by live process ${pid}` };
  return { reclaimable: true, reason: `left by exited process ${pid}` };
}

/**
 * Cross-process lock for one shared input device: a directory recording the
 * holder's PID, created atomically.
 *
 * A lock whose recorded holder no longer exists cannot be protecting a live
 * lease, so it is reclaimed (a crashed daemon must not need an operator to
 * delete a hashed path before native control works again). A lock the holder
 * deliberately left behind — quarantined because its input release failed —
 * is never reclaimed: the desktop may still have a key or button held, and
 * only an operator can check that. Either way the error names the path.
 * Nothing here guesses that taking input away from a *live* holder is safe.
 */
export async function acquireNativeInputLock(path: string): Promise<NativeInputLock> {
  let reclaimed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ComputerUseError("lease_conflict", `Native input lock unavailable: ${path}`);
      const holder = await inspect(path);
      if (!holder.reclaimable || attempt > 0) throw new ComputerUseError("lease_conflict", `Native input locked: ${holder.reason}. Lock: ${path}`);
      // Move the stale directory aside atomically so two reclaimers cannot both
      // believe they own a lock one of them recreated; the loser's rename fails.
      const aside = `${path}.stale-${randomUUID()}`;
      await rename(path, aside).catch(() => {});
      await rm(aside, { recursive: true, force: true }).catch(() => {});
      reclaimed = true;
      continue;
    }
    try {
      await writeFile(join(path, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      throw new ComputerUseError("lease_conflict", `Native input lock unavailable: ${path}`);
    }
    break;
  }
  return {
    path,
    reclaimed,
    release: () => rm(path, { recursive: true, force: true }),
    quarantine: (reason) => writeFile(join(path, "quarantined"), `${reason} (pid ${process.pid})\n`, { mode: 0o600 }),
  };
}
