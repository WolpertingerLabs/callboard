/**
 * Build records: one queue, in order; a base build and a profile build each
 * keep their own record and log; asking twice returns the build already
 * waiting; records and logs survive a restart (an unfinished build reads back
 * as interrupted); logs are capped; old records are pruned.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxBuilds, type BuildTarget } from "./sandbox-builds.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-builds-"));
  dirs.push(dir);
  return dir;
};
const profile = (name: string): BuildTarget => ({ kind: "profile", id: `global/${name}`, scope: "global", name });

/** A runner whose builds finish only when told to. */
function controllable() {
  const started: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; out: (s: string) => void }>();
  const key = (t: BuildTarget) => (t.kind === "base" ? "base" : t.id);
  return {
    started,
    run: (target: BuildTarget, onOutput: (chunk: string) => void) =>
      new Promise<void>((resolve, reject) => {
        started.push(key(target));
        pending.set(key(target), { resolve, reject, out: onOutput });
      }),
    finish: (k: string, error?: Error) => {
      const p = pending.get(k)!;
      pending.delete(k);
      if (error) p.reject(error);
      else p.resolve();
    },
    output: (k: string, chunk: string) => pending.get(k)!.out(chunk),
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sandbox build records", () => {
  it("run one at a time in the order asked; a base build never clobbers a profile build; a repeated ask returns the waiting build", async () => {
    const runner = controllable();
    const builds = new SandboxBuilds({ dir: freshDir(), run: runner.run });
    const blender = builds.enqueue(profile("blender"));
    const base = builds.enqueue({ kind: "base" });
    expect(builds.enqueue(profile("blender")).id).toBe(blender.id);
    expect(builds.enqueue({ kind: "base" }).id).toBe(base.id);
    await tick();
    expect(runner.started).toEqual(["global/blender"]);
    expect([builds.get(blender.id)!.phase, builds.get(base.id)!.phase]).toEqual(["running", "queued"]);
    runner.output("global/blender", "blender output\n");
    runner.finish("global/blender");
    await tick();
    await tick();
    expect(runner.started).toEqual(["global/blender", "base"]);
    runner.output("base", "base output\n");
    runner.finish("base", new Error("docker build exited with 1\ntail of the log"));
    await builds.idle();
    expect(builds.get(blender.id)).toMatchObject({ phase: "succeeded", kind: "profile", profile: "global/blender", scope: "global", name: "blender" });
    expect(builds.get(base.id)).toMatchObject({ phase: "failed", kind: "base", error: "docker build exited with 1" });
    expect(builds.log(blender.id)).toBe("blender output\n");
    expect(builds.log(base.id)).toContain("base output\n");
    expect(builds.log(base.id)).toContain("tail of the log");
    expect(builds.list().map((r) => r.id)).toEqual([base.id, blender.id]);
    // A finished target can be built again: a new record.
    expect(builds.enqueue(profile("blender")).id).not.toBe(blender.id);
  });

  it("persist across a restart; what was queued or running reads back as interrupted, with its log", async () => {
    const dir = freshDir();
    const runner = controllable();
    const first = new SandboxBuilds({ dir, run: runner.run });
    const running = first.enqueue(profile("test"));
    const queued = first.enqueue({ kind: "base" });
    await tick();
    runner.output("global/test", "half a build\n");
    first.dispose();
    const second = new SandboxBuilds({ dir, run: controllable().run });
    expect(second.get(running.id)).toMatchObject({ phase: "interrupted", error: "Callboard stopped before this build finished" });
    expect(second.get(queued.id)!.phase).toBe("interrupted");
    expect(second.log(running.id)).toBe("half a build\n");
    expect(second.get("../../etc/passwd")).toBeUndefined();
    expect(second.log("not-an-id")).toBeUndefined();
  });

  it("cap each log (keeping its end) and prune the oldest finished records with their logs", async () => {
    const dir = freshDir();
    const runner = controllable();
    const builds = new SandboxBuilds({ dir, run: runner.run, logLimit: 1000, keep: 3 });
    const big = builds.enqueue(profile("big"));
    await tick();
    for (let i = 0; i < 40; i++) runner.output("global/big", `line ${String(i).padStart(3, "0")} ${"x".repeat(40)}\n`);
    runner.finish("global/big");
    await builds.idle();
    const log = builds.log(big.id)!;
    expect(log.length).toBeLessThanOrEqual(1000);
    expect(log).toMatch(/^\[… earlier output dropped/);
    expect(log).toContain("line 039");
    expect(log).not.toContain("line 000");
    for (const name of ["a", "b", "c"]) {
      builds.enqueue(profile(name));
      await tick();
      runner.finish(`global/${name}`);
      await builds.idle();
    }
    expect(builds.list()).toHaveLength(3);
    expect(builds.get(big.id)).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.startsWith(big.id))).toEqual([]);
  });
});
