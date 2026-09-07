import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireNativeInputLock } from "../dist/drivers/native-lock.js";

const error = (code, pattern) => (e) => e.code === code && (!pattern || pattern.test(e.message));
async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), "computer-use-lock-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A PID that certainly no longer exists: a child that has already exited. */
function exitedPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid));
  });
}

test("acquire records the holder PID and release removes the directory", async (t) => {
  const lock = await acquireNativeInputLock(join(await root(t), "domain"));
  assert.equal(lock.reclaimed, false);
  assert.equal((await readFile(join(lock.path, "pid"), "utf8")).trim(), String(process.pid));
  await assert.rejects(acquireNativeInputLock(lock.path), error("lease_conflict", new RegExp(`live process ${process.pid}[\\s\\S]*${lock.path}`)));
  await lock.release();
  await assert.rejects(stat(lock.path), { code: "ENOENT" });
});

test("a lock left by an exited process is reclaimed instead of orphaned forever", async (t) => {
  const path = join(await root(t), "domain");
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "pid"), `${await exitedPid()}\n`);
  const lock = await acquireNativeInputLock(path);
  assert.equal(lock.reclaimed, true);
  assert.equal((await readFile(join(path, "pid"), "utf8")).trim(), String(process.pid));
  await lock.release();
});

test("a quarantined lock and a lock without a recorded holder fail closed and name the path", async (t) => {
  const dir = await root(t);
  const quarantined = await acquireNativeInputLock(join(dir, "quarantined"));
  await quarantined.quarantine("input release failed at close");
  // Even though this process is the holder and alive, quarantine wins; and a dead holder does not unquarantine.
  await writeFile(join(quarantined.path, "pid"), `${await exitedPid()}\n`);
  await assert.rejects(acquireNativeInputLock(quarantined.path), error("lease_conflict", /quarantined \(input release failed at close[\s\S]*quarantined$/));
  const unknown = join(dir, "unknown");
  await mkdir(unknown, { mode: 0o700 });
  await assert.rejects(acquireNativeInputLock(unknown), error("lease_conflict", /no holder recorded[\s\S]*unknown$/));
});

test("two reclaimers of one stale lock cannot both hold it", async (t) => {
  const path = join(await root(t), "domain");
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "pid"), `${await exitedPid()}\n`);
  const results = await Promise.allSettled([acquireNativeInputLock(path), acquireNativeInputLock(path)]);
  const held = results.filter((r) => r.status === "fulfilled");
  assert.equal(held.length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "lease_conflict");
  await held[0].value.release();
});
