/**
 * Keep-for-recovery on the manager's keep contract, against the real manager
 * with an in-memory Docker and outbox: a failed copy pauses the container and
 * returns `{ keep: true }` (session end, shutdown, orphan); `session.json`
 * is the one record; `maxKept` and `keepHours`; adopting a paused leftover;
 * the deleted-chat policy; Retry export, Discard and the sweep, all through
 * `release()`; another instance answering means removal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseError } from "@wolpertingerlabs/computer-use";
import { SandboxContainerManager } from "./sandbox-containers.js";
import { SandboxDeliveries, type OutboxSource } from "./sandbox-deliverables.js";
import { SandboxRecovery } from "./sandbox-recovery.js";
import { resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { fakeDocker, fakeRemote } from "./__fixtures__/sandbox-docker.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** One outbox shared by every container (the fake remote's drivers all read it). */
function fakeOutbox() {
  const files = new Map<string, Buffer | "writing">();
  let failGet = false;
  const source: OutboxSource = {
    listOutbox: async () =>
      [...files].map(([name, data]) => ({ name, size: data === "writing" ? 1 : data.length, sha256: data === "writing" ? null : sha(data), mtimeMs: 0 })),
    downloadOutboxFile: async (name) => {
      const data = files.get(name);
      if (failGet) throw new ComputerUseError("driver_error", "connection reset");
      if (!data || data === "writing") throw new ComputerUseError("not_found");
      return { name, size: data.length, sha256: sha(data), data };
    },
  };
  return {
    source,
    set: (name: string, value: string | "writing") => files.set(name, value === "writing" ? value : Buffer.from(value)),
    failDownloads: (on: boolean) => (failGet = on),
  };
}

async function setup(
  options: {
    settings?: Partial<ResolvedSandboxSettings>;
    dataDir?: string;
    docker?: ReturnType<typeof fakeDocker>;
    remote?: ReturnType<typeof fakeRemote>;
    outbox?: ReturnType<typeof fakeOutbox>;
    chats?: Set<string>;
  } = {},
) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "cb-recovery-")));
  dirs.push(dataDir);
  const docker = options.docker ?? fakeDocker();
  const remote = options.remote ?? fakeRemote();
  const outbox = options.outbox ?? fakeOutbox();
  const settings: ResolvedSandboxSettings = { ...resolveSandboxSettings({}), ...options.settings };
  const chats = options.chats ?? new Set(["chat-k", "chat-o", "chat-s", "chat-2"]);
  const deliveries = new SandboxDeliveries({ dataDir, pollMs: { min: 10, max: 40 }, settleMs: 30, settleIntervalMs: 10 });
  // eslint-disable-next-line prefer-const
  let recovery: SandboxRecovery;
  const manager = new SandboxContainerManager({
    docker: docker.run,
    dataDir,
    settings: () => settings,
    createRemoteDriver: (o) => Object.assign(remote.factory(o), outbox.source),
    helloIntervalMs: 5,
    preflightCacheMs: 0,
    drainTimeoutMs: 2_000,
    chatContext: () => ({ folder: "/work/repo" }),
    adoptPaused: (sandbox) => recovery.adoptPaused(sandbox),
  });
  recovery = new SandboxRecovery({ manager, deliveries, docker: docker.run, settings: () => settings, chatExists: (id) => chats.has(id), copyBudgetMs: 1_000 });
  manager.drainBeforeDestroy = recovery.drainHook;
  const commands = () => docker.state.calls.map((args) => args.slice(0, 2).join(" "));
  const readMeta = async (sessionId: string) => JSON.parse(await readFile(join(manager.sessionsDir, sessionId, "session.json"), "utf8"));
  const start = async (chatId = "chat-k") => {
    const box = await manager.start({ sessionId: randomUUID(), chatId, signal: new AbortController().signal });
    manager.ready(box.sessionId);
    return box;
  };
  return { dataDir, docker, remote, outbox, settings, chats, deliveries, manager, recovery, commands, readMeta, start };
}

/** A session whose final copy fails (a file still being written), ended normally. */
async function keptOne(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  ctx.outbox.set("done.txt", "ok");
  ctx.outbox.set("draft.md", "writing");
  const box = await ctx.start();
  await ctx.manager.destroy(box.sessionId);
  return { ...ctx, box };
}

describe("the drain hook and the manager's keep", () => {
  it("a copy that succeeds: the files are on the host, and the container is removed", async () => {
    const ctx = await setup();
    ctx.outbox.set("chart.png", "PNG");
    const box = await ctx.start();
    await ctx.manager.destroy(box.sessionId);
    expect(ctx.docker.state.containers.has(box.name)).toBe(false);
    const [s] = await ctx.deliveries.forChat("chat-k", {});
    expect(s.state).toBe("complete");
    expect(readFileSync(s.files[0].path, "utf8")).toBe("PNG");
  });

  it("an incomplete copy pauses the container (never docker stop: its outbox is tmpfs) and returns { keep: true }; session.json is the one record", async () => {
    const { manager, docker, box, commands, readMeta, recovery } = await keptOne();
    expect(docker.state.containers.get(box.name)?.paused).toBe(true);
    expect(commands()).toContain(`pause ${box.name}`);
    expect(commands().some((c) => c.startsWith("stop") || c.startsWith("rm"))).toBe(false);
    expect(manager.containerState(box.sessionId)).toEqual({ phase: "kept" });
    const meta = await readMeta(box.sessionId);
    expect(meta).toMatchObject({ keptAt: expect.any(Number), keptCause: "session-end" });
    expect(statSync(join(manager.sessionsDir, box.sessionId, "session.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(manager.sessionsDir, box.sessionId, "token"))).toBe(true);
    // The view: retention from keptAt and Settings, the reason from the deliveries manifest.
    const [view] = await recovery.keptFor("chat-k");
    expect(view).toEqual({ sessionId: box.sessionId, keptAt: meta.keptAt, expiresAt: meta.keptAt + 24 * 3_600_000, reason: "1 file still being written" });
    expect(await recovery.keptFor("chat-other")).toEqual([]);
    expect(await manager.hasLeftovers()).toBe(false);
  });

  it("a copy that overruns its budget still keeps: the hook stops the copy before the manager's bound, so it can pause and return", async () => {
    const ctx = await setup();
    let release!: () => void;
    ctx.outbox.source.listOutbox = (signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        release = () => resolve([]);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const box = await ctx.start();
    await ctx.manager.destroy(box.sessionId);
    expect(release).toBeTypeOf("function");
    expect(ctx.docker.state.containers.get(box.name)?.paused).toBe(true);
    expect((await ctx.recovery.keptFor("chat-k"))[0].reason).toBe("the final copy timed out");
  });

  it("removes the container if it cannot be paused, and records the loss: nothing runs unsupervised", async () => {
    const docker = fakeDocker();
    docker.state.pauseFailure = "cgroup freezer unavailable";
    const { box, recovery, deliveries } = await keptOne({ docker });
    expect(docker.state.containers.has(box.name)).toBe(false);
    expect(await recovery.keptFor("chat-k")).toEqual([]);
    expect((await deliveries.forChat("chat-k", {}))[0]).toMatchObject({ state: "incomplete", lost: "gone" });
  });

  it("keeps at most maxKept at once, separately from maxConcurrent; past it the container is removed and reported not-kept", async () => {
    const ctx = await keptOne({ settings: { maxKept: 1, maxConcurrent: 1 } });
    // A kept sandbox holds no running slot: a new one still starts under maxConcurrent 1.
    const second = await ctx.start("chat-2");
    await ctx.manager.destroy(second.sessionId);
    expect(ctx.docker.state.containers.get(ctx.box.name)?.paused).toBe(true);
    expect(ctx.docker.state.containers.has(second.name)).toBe(false);
    expect((await ctx.deliveries.forChat("chat-2", {}))[0]).toMatchObject({ lost: "not-kept" });
    // Two failing at once cannot both take the last slot.
    const race = await setup({ settings: { maxKept: 1 } });
    race.outbox.set("x", "writing");
    const [a, b] = [await race.start(), await race.start("chat-2")];
    await Promise.all([race.manager.destroy(a.sessionId), race.manager.destroy(b.sessionId)]);
    expect((await race.manager.keptSandboxes()).length).toBe(1);
    // maxKept 0: never keep.
    const never = await keptOne({ settings: { maxKept: 0 } });
    expect(never.docker.state.containers.size).toBe(0);
  });

  it("an orphan whose copy fails after a crash is paused and kept, and no later pass drains or removes it", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const outbox = fakeOutbox();
    const first = await setup({ docker, remote, outbox });
    outbox.set("draft.md", "writing");
    const box = await first.start("chat-o");
    // The daemon dies; the next one's reaper finds the orphan.
    const second = await setup({ docker, remote, outbox, dataDir: first.dataDir });
    expect(await second.manager.reap()).toEqual([]);
    expect(docker.state.containers.get(box.name)?.paused).toBe(true);
    expect(await second.readMeta(box.sessionId)).toMatchObject({ keptCause: "orphan" });
    const lists = docker.state.calls.length;
    expect(await second.manager.reap()).toEqual([]);
    expect(docker.state.calls.slice(lists).filter((args) => args[0] === "rm")).toEqual([]);
    expect(await second.recovery.keptFor("chat-o")).toHaveLength(1);
  });

  it("a shutdown whose copy fails keeps the container, and the next start sees it kept, not an orphan", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const outbox = fakeOutbox();
    const first = await setup({ docker, remote, outbox });
    outbox.set("draft.md", "writing");
    const box = await first.start("chat-s");
    first.manager.beginShutdown();
    await first.manager.dispose();
    expect(await first.readMeta(box.sessionId)).toMatchObject({ keptCause: "shutdown" });
    const next = await setup({ docker, remote, outbox, dataDir: first.dataDir });
    expect(await next.manager.reap()).toEqual([]);
    expect(docker.state.containers.get(box.name)?.paused).toBe(true);
    expect(await next.recovery.keptFor("chat-s")).toHaveLength(1);
  });

  it("adopts a paused leftover (a daemon killed between our pause and the manager's record) if its chat exists and there is room", async () => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const first = await setup({ docker, remote });
    const mine = await first.start("chat-o");
    const deleted = await first.start("gone-chat");
    for (const box of [mine, deleted]) docker.state.containers.get(box.name)!.paused = true;
    const next = await setup({ docker, remote, dataDir: first.dataDir });
    expect(await next.manager.reap()).toHaveLength(1);
    expect(docker.state.containers.get(mine.name)?.paused).toBe(true);
    expect(docker.state.containers.has(deleted.name)).toBe(false);
    expect(await next.readMeta(mine.sessionId)).toMatchObject({ keptCause: "orphan" });
  });
});

describe("the deleted-chat policy", () => {
  it.each(["session-end", "orphan"] as const)("%s: a deleted chat's outbox is never copied; the container is removed, not kept", async (cause) => {
    const docker = fakeDocker();
    const remote = fakeRemote();
    const outbox = fakeOutbox();
    outbox.set("secret.txt", "x");
    const first = await setup({ docker, remote, outbox, chats: new Set() });
    const box = await first.start("chat-k");
    if (cause === "session-end") await first.manager.destroy(box.sessionId);
    else expect(await (await setup({ docker, remote, outbox, chats: new Set(), dataDir: first.dataDir })).manager.reap()).toHaveLength(1);
    expect(docker.state.containers.size).toBe(0);
    expect(await first.deliveries.forChat("chat-k", {})).toEqual([]);
  });

  it("deleting a chat discards its kept sandboxes (through release)", async () => {
    const { recovery, docker, box, manager } = await keptOne();
    expect(await recovery.discardForChat("chat-k")).toBe(1);
    expect(docker.state.containers.has(box.name)).toBe(false);
    expect(existsSync(join(manager.sessionsDir, box.sessionId))).toBe(false);
  });
});

describe("Retry export, Discard and the sweep", () => {
  it("Retry export: unpause, reconnect (endpoint from Docker, instance proved), copy, release", async () => {
    const { recovery, docker, box, outbox, deliveries, commands, manager } = await keptOne();
    outbox.set("draft.md", "# final");
    expect(await recovery.retry("chat-k", box.sessionId)).toEqual({ outcome: "removed" });
    expect(commands()).toContain(`unpause ${box.name}`);
    expect(docker.state.containers.has(box.name)).toBe(false);
    expect(existsSync(join(manager.sessionsDir, box.sessionId))).toBe(false);
    const [s] = await deliveries.forChat("chat-k", {});
    expect(s.state).toBe("complete");
    expect(s.files.map((f) => f.name).sort()).toEqual(["done.txt", "draft.md"]);
  });

  it("a retry that fails again pauses it again, still kept, its retention not extended", async () => {
    const { recovery, docker, box } = await keptOne();
    const [before] = await recovery.keptFor("chat-k");
    expect(await recovery.retry("chat-k", box.sessionId)).toEqual({ outcome: "kept", reason: "1 file still being written" });
    expect(docker.state.containers.get(box.name)?.paused).toBe(true);
    expect((await recovery.keptFor("chat-k"))[0].expiresAt).toBe(before.expiresAt);
  });

  it("another instance answering on retry (the container restarted) removes it and reports the loss", async () => {
    const { recovery, docker, box, remote, deliveries } = await keptOne();
    remote.instances.set([...remote.instances.keys()][0], randomUUID());
    expect(await recovery.retry("chat-k", box.sessionId)).toMatchObject({ outcome: "gone" });
    expect(docker.state.containers.has(box.name)).toBe(false);
    expect((await deliveries.forChat("chat-k", {}))[0]).toMatchObject({ lost: "gone" });
  });

  it("Discard releases it now; retry and discard are scoped to the owning chat and refused while one runs", async () => {
    const { recovery, docker, box, outbox } = await keptOne();
    await expect(recovery.discard("chat-other", box.sessionId)).rejects.toMatchObject({ code: "not_found" });
    await expect(recovery.retry("chat-other", box.sessionId)).rejects.toMatchObject({ code: "not_found" });
    // A retry in flight: busy, and left alone by the sweep.
    let release!: () => void;
    const list = outbox.source.listOutbox;
    outbox.source.listOutbox = async (signal) => {
      await new Promise<void>((resolve) => (release = resolve));
      return list(signal);
    };
    outbox.set("draft.md", "done");
    const retrying = recovery.retry("chat-k", box.sessionId);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await recovery.keptFor("chat-k"))[0].retrying).toBe(true);
    await expect(recovery.discard("chat-k", box.sessionId)).rejects.toMatchObject({ code: "lease_conflict" });
    await recovery.sweep(Date.now() + 100 * 3_600_000);
    expect(docker.state.containers.has(box.name)).toBe(true);
    release();
    expect(await retrying).toEqual({ outcome: "removed" });

    const other = await keptOne();
    await other.recovery.discard("chat-k", other.box.sessionId);
    expect(other.docker.state.containers.has(other.box.name)).toBe(false);
    expect((await other.deliveries.forChat("chat-k", {}))[0]).toMatchObject({ lost: "discarded" });
  });

  it("the sweep releases a kept sandbox past keepHours (retention from Settings), one whose container vanished, and re-pauses one found running", async () => {
    const expired = await keptOne({ settings: { keepHours: 2 } });
    await expired.recovery.sweep(Date.now() + 1 * 3_600_000);
    expect(expired.docker.state.containers.has(expired.box.name)).toBe(true);
    await expired.recovery.sweep(Date.now() + 2 * 3_600_000 + 1_000);
    expect(expired.docker.state.containers.has(expired.box.name)).toBe(false);
    expect((await expired.deliveries.forChat("chat-k", {}))[0]).toMatchObject({ lost: "expired" });

    const vanished = await keptOne();
    vanished.docker.state.containers.delete(vanished.box.name);
    await vanished.recovery.sweep();
    expect(await vanished.manager.keptSandboxes()).toEqual([]);
    expect((await vanished.deliveries.forChat("chat-k", {}))[0]).toMatchObject({ lost: "gone" });

    const running = await keptOne();
    running.docker.state.containers.get(running.box.name)!.paused = false;
    await running.recovery.sweep();
    expect(running.docker.state.containers.get(running.box.name)?.paused).toBe(true);
  });
});
