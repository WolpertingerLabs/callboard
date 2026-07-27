/**
 * Tests for process-tree termination.
 *
 * The load-bearing case is the third one: a parent that spawns a child, where
 * `child.kill()` would reap only the parent and leave the grandchild running
 * forever, reparented to init. That is the exact leak an agent CLI produces
 * (launcher → runtime → tool process), and the reason this utility exists.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // `trap '' TERM` makes the shell immune to SIGTERM; only SIGKILL ends it.
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 120"], DETACHED_SPAWN_OPTIONS);
    await new Promise((resolve) => child.once("spawn", resolve));

    await killProcessTree(child, 200);
    await expect.poll(() => alive(child.pid!), { timeout: 5000 }).toBe(false);
  }, 15_000);
});
