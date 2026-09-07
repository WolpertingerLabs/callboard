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

async function pidIn(file: string): Promise<number | undefined> {
  const pid = Number.parseInt((await readFile(file, "utf8").catch(() => "")).trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function inspect(path: string): Promise<{ reclaimable: boolean; reason: string; pid?: number }> {
  const quarantined = await readFile(join(path, "quarantined"), "utf8").catch(() => undefined);
  if (quarantined !== undefined)
    return { reclaimable: false, reason: `quarantined (${quarantined.trim() || "input state uncertain"}); inspect the desktop, then remove the lock` };
  const pid = await pidIn(join(path, "pid"));
  if (pid === undefined) return { reclaimable: false, reason: "no holder recorded; remove the lock after confirming no input is held" };
  if (alive(pid)) return { reclaimable: false, reason: `held by live process ${pid}`, pid };
  return { reclaimable: true, reason: `left by exited process ${pid}`, pid };
}

/**
 * Take a dead holder's claim file out of the lock directory, atomically, and
 * prove it is the claim that was inspected. Exported for its own tests.
 *
 * The claim is the `pid` file, not the directory. Between inspecting a stale
 * lock and acting on it, another reclaimer may already have replaced the dead
 * claim with its own live one; moving the directory aside at that point would
 * hand two processes the same input. Renaming the claim file instead, then
 * reading the moved file, makes the check exact: if it does not carry the dead
 * PID it belongs to a live holder and goes straight back. A third process
 * cannot slip in during that window either — with no `pid` file present,
 * `inspect` reports "no holder recorded" and it fails closed.
 */
export async function reclaimDeadClaim(path: string, deadPid: number): Promise<void> {
  const claim = join(path, "pid");
  const taken = join(path, `pid.dead-${randomUUID()}`);
  const concurrent = () => new ComputerUseError("lease_conflict", `Native input locked: reclaimed concurrently by another process. Lock: ${path}`);
  try {
    await rename(claim, taken);
  } catch {
    throw concurrent();
  }
  if ((await pidIn(taken)) !== deadPid) {
    await rename(taken, claim).catch(() => {});
    throw concurrent();
  }
  await rm(taken, { force: true }).catch(() => {});
}

/**
 * Cross-process lock for one shared input device: a directory created
 * atomically, holding a `pid` claim file that records the holder.
 *
 * A lock whose recorded holder no longer exists cannot be protecting a live
 * lease, so it is reclaimed (a crashed daemon must not need an operator to
 * delete a hashed path before native control works again). A lock the holder
 * deliberately left behind — quarantined because its input release failed —
 * is never reclaimed: the desktop may still have a key or button held, and
 * only an operator can check that. Either way the error names the path.
 * Nothing here guesses that taking input away from a *live* holder is safe;
 * see {@link reclaimDeadClaim} for how concurrent reclaimers are kept honest.
 */
export async function acquireNativeInputLock(path: string): Promise<NativeInputLock> {
  let reclaimed = false;
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ComputerUseError("lease_conflict", `Native input lock unavailable: ${path}`);
    const holder = await inspect(path);
    if (!holder.reclaimable || holder.pid === undefined) throw new ComputerUseError("lease_conflict", `Native input locked: ${holder.reason}. Lock: ${path}`);
    await reclaimDeadClaim(path, holder.pid);
    reclaimed = true;
  }
  try {
    await writeFile(join(path, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    // Only remove a directory this call created; on the reclaim path it may be someone else's now.
    if (created) await rm(path, { recursive: true, force: true }).catch(() => {});
    throw new ComputerUseError("lease_conflict", `Native input lock unavailable: ${path}`);
  }
  return {
    path,
    reclaimed,
    release: () => rm(path, { recursive: true, force: true }),
    quarantine: (reason) => writeFile(join(path, "quarantined"), `${reason} (pid ${process.pid})\n`, { mode: 0o600 }),
  };
}
