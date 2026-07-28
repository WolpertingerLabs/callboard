/**
 * Tests for process-tree termination.
 *
 * The load-bearing case is the third one: a parent that spawns a child, where
 * `child.kill()` would reap only the parent and leave the grandchild running
 * forever, reparented to init. That is the exact leak an agent CLI produces
 * (launcher → runtime → tool process), and the reason this utility exists.
 */
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { DETACHED_SPAWN_OPTIONS, killProcessTree } from "./tree-kill.js";

const RUN = process.platform !== "win32";

/** True while `pid` still exists (signal 0 probes without delivering). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid that currently belongs to no process, for the "already gone" path. */
function findFreePid(): number {
  for (let pid = 4_194_300; pid > 1000; pid--) {
    if (!alive(pid)) return pid;
  }
  throw new Error("no free pid found");
}

describe.runIf(RUN)("killProcessTree", () => {
  it("is a no-op for a missing or already-exited child", async () => {
    await expect(killProcessTree(null)).resolves.toBeUndefined();
    await expect(killProcessTree(undefined)).resolves.toBeUndefined();

    const child = spawn("true", [], DETACHED_SPAWN_OPTIONS);
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(killProcessTree(child)).resolves.toBeUndefined();
  });

  it("terminates a simple long-running child", async () => {
    const child = spawn("sleep", ["120"], DETACHED_SPAWN_OPTIONS);
    await new Promise((resolve) => child.once("spawn", resolve));
    expect(alive(child.pid!)).toBe(true);

    await killProcessTree(child);
    await expect.poll(() => alive(child.pid!), { timeout: 5000 }).toBe(false);
  });

  it("terminates GRANDCHILDREN, which a plain child.kill() would leak", async () => {
    // A shell that spawns `sleep` and then waits — the shape of an agent CLI
    // launcher. Killing only the shell would orphan the sleep.
    const child = spawn("sh", ["-c", "sleep 120 & echo $!; wait"], { ...DETACHED_SPAWN_OPTIONS, stdio: ["ignore", "pipe", "ignore"] });
    const grandchildPid = await new Promise<number>((resolve) => {
      child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    expect(Number.isFinite(grandchildPid)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);

    await killProcessTree(child);

    await expect.poll(() => alive(child.pid!), { timeout: 5000 }).toBe(false);
    // The point of the whole utility.
    await expect.poll(() => alive(grandchildPid), { timeout: 5000 }).toBe(false);
  });

  it("RESOLVES when the process group cannot be signalled at all", async () => {
    // The early-exit path, and the one the suite never exercised: a child whose
    // exitCode/signalCode are still null (so the guard above lets it through)
    // but whose pid is gone, so both process.kill attempts throw ESRCH. That is
    // an ordinary race — the child exited moments ago and Node has not delivered
    // `exit` yet — and it also covers EPERM.
    //
    // This rejected with `ReferenceError: Cannot access 'timer' before
    // initialization`, which is why it is asserted as a resolution rather than
    // "does not hang": AcpAgentClient.close() awaits this, so the rejection
    // skipped `this.child = null`, skipped AcpAgentQuery.closeToolServers() —
    // leaking an MCP server, its socket and its temp dir — and replaced the
    // turn's real outcome with a ReferenceError.
    const child = { pid: findFreePid(), exitCode: null, signalCode: null, once: () => child } as unknown as ChildProcess;
    await expect(killProcessTree(child)).resolves.toBeUndefined();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // `trap '' TERM` makes the shell immune to SIGTERM; only SIGKILL ends it.
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 120"], DETACHED_SPAWN_OPTIONS);
    await new Promise((resolve) => child.once("spawn", resolve));

    await killProcessTree(child, 200);
    await expect.poll(() => alive(child.pid!), { timeout: 5000 }).toBe(false);
  }, 15_000);
});
