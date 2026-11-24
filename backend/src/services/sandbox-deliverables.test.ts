/**
 * The outbox sync against an in-memory outbox: keying, layout and
 * permissions, path safety, version names on change, the limits, the final
 * copy's success and failure, endpoint mode's baseline (and that it never
 * removes anything), and chat scoping of listings and of `/api/files/serve`.
 * The managed chain (keep for recovery) is sandbox-recovery.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ComputerUseError, type Driver } from "@wolpertingerlabs/computer-use";
import {
  DeliveryIncompleteError,
  SandboxDeliveries,
  chatSegment,
  deliverablePathForChat,
  deliverablesRoot,
  ownerKey,
  versionName,
  type DeliveryContext,
  type OutboxSource,
} from "./sandbox-deliverables.js";
import { withOutboxSync } from "./computer-use.js";
import { fakeDocker } from "./__fixtures__/sandbox-docker.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "cb-deliverables-"));
  dirs.push(dir);
  return dir;
}
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** An outbox: name → bytes, or `"writing"` (listed with sha256 null). */
function fakeOutbox(initial: Record<string, string | Buffer | "writing"> = {}) {
  const files = new Map<string, Buffer | "writing">(Object.entries(initial).map(([k, v]) => [k, v === "writing" ? v : Buffer.from(v)]));
  const calls = { list: 0, get: [] as string[] };
  let listFailure: Error | undefined;
  let getFailure: ((name: string) => Error | undefined) | undefined;
  let lie: ((name: string, data: Buffer) => Buffer) | undefined;
  const source: OutboxSource = {
    async listOutbox() {
      calls.list++;
      if (listFailure) throw listFailure;
      return [...files].map(([name, data]) => ({
        name,
        size: data === "writing" ? 10 : data.length,
        sha256: data === "writing" ? null : sha(data),
        mtimeMs: Date.now(),
      }));
    },
    async downloadOutboxFile(name, _signal, options) {
      calls.get.push(name);
      const failure = getFailure?.(name);
      if (failure) throw failure;
      const data = files.get(name);
      if (!data || data === "writing") throw new ComputerUseError("not_found");
      if (options?.expectedSha256 && options.expectedSha256 !== sha(data)) throw new ComputerUseError("stale_frame", "changed");
      const sent = lie ? lie(name, data) : data;
      return { name, size: sent.length, sha256: sha(sent), data: sent };
    },
  };
  return {
    source,
    files,
    calls,
    set: (name: string, value: string | Buffer | "writing") => files.set(name, value === "writing" ? value : Buffer.from(value)),
    failList: (error?: Error) => (listFailure = error),
    failGet: (fn?: (name: string) => Error | undefined) => (getFailure = fn),
    lie: (fn?: (name: string, data: Buffer) => Buffer) => (lie = fn),
  };
}

async function setup(options: { limits?: ConstructorParameters<typeof SandboxDeliveries>[0]["limits"]; settleMs?: number; quotaBytes?: number } = {}) {
  const dataDir = await tempDir();
  const deliveries = new SandboxDeliveries({
    dataDir,
    limits: options.limits,
    ...(options.quotaBytes !== undefined ? { quotaBytes: () => options.quotaBytes! } : {}),
    pollMs: { min: 10, max: 40 },
    settleMs: options.settleMs ?? 200,
    settleIntervalMs: 10,
  });
  return { dataDir, deliveries };
}
const context = (source: OutboxSource, extra: Partial<DeliveryContext> = {}): DeliveryContext => ({
  sessionId: randomUUID(),
  chatId: "chat-a",
  folder: "/work/repo",
  mode: "managed",
  source,
  ...extra,
});
const mode = (path: string) => statSync(path).mode & 0o777;

describe("keying and layout", () => {
  it("keys on the workspace when there is one, else the folder, always hashed, never a raw id or path", () => {
    const ws = ownerKey({ workspaceId: "ws/../../etc", folder: "/work/repo" });
    const folder = ownerKey({ folder: "/work/repo" });
    expect(ws).toMatch(/^w-[0-9a-f]{32}$/);
    expect(folder).toMatch(/^f-[0-9a-f]{32}$/);
    // Two workspaces on one folder are two owners; the folder alone is a third.
    expect(ownerKey({ workspaceId: "ws-2", folder: "/work/repo" })).not.toBe(ws);
    expect(ownerKey({ workspaceId: "ws/../../etc" })).toBe(ws);
    expect(ownerKey({ folder: "/work/repo/" })).toBe(folder);
    expect(ownerKey({ folder: "relative/path" })).toBe("none");
    expect(ownerKey({})).toBe("none");
    // A chat id that is not a plain id is hashed too.
    expect(chatSegment("chat-a")).toBe("chat-a");
    expect(chatSegment("../x")).toMatch(/^c-[0-9a-f]{32}$/);
    expect(chatSegment(chatSegment("../x"))).not.toBe(chatSegment("../x"));
  });

  it("writes <root>/<owner key>/<chat>/<session>/files/<name>, every directory 0700 and every file 0600", async () => {
    const { dataDir, deliveries } = await setup();
    const outbox = fakeOutbox({ "report.pdf": "%PDF-1.7 fake" });
    const ctx = context(outbox.source, { workspaceId: "ws-1" });
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    const root = deliverablesRoot(dataDir);
    const expected = join(root, ownerKey({ workspaceId: "ws-1" }), "chat-a", ctx.sessionId, "files", "report.pdf");
    expect(report.files.map((f) => f.path)).toEqual([expected]);
    expect(readFileSync(expected, "utf8")).toBe("%PDF-1.7 fake");
    expect(mode(expected)).toBe(0o600);
    expect(mode(join(root, ownerKey({ workspaceId: "ws-1" }), "chat-a", ctx.sessionId, "manifest.json"))).toBe(0o600);
    for (let dir = join(expected, ".."); dir.length >= root.length; dir = join(dir, "..")) expect(mode(dir)).toBe(0o700);
    expect(report.files[0]).toMatchObject({
      name: "report.pdf",
      storedName: "report.pdf",
      size: 13,
      sha256: sha("%PDF-1.7 fake"),
      mediaType: "pdf",
      mimeType: "application/pdf",
    });
    // No temp files left behind.
    expect(readdirSync(join(expected, "..")).filter((n) => n.startsWith("."))).toEqual([]);
  });
});

describe("live sync", () => {
  it("copies finished files while the session runs, skips files still being written, and backs off when idle", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox({ "a.txt": "one", "b.bin": "writing" });
    const ctx = context(outbox.source);
    await deliveries.start(ctx);
    await vi.waitFor(async () => expect((await deliveries.forChat("chat-a", ctx))[0]?.files.map((f) => f.name)).toEqual(["a.txt"]));
    expect(outbox.calls.get).toEqual(["a.txt"]);
    outbox.set("b.bin", "two");
    await vi.waitFor(async () => expect((await deliveries.forChat("chat-a", ctx))[0]?.files.map((f) => f.name)).toEqual(["a.txt", "b.bin"]));
    const [session] = await deliveries.forChat("chat-a", ctx);
    expect(session.state).toBe("live");
    // Nothing new: each file was fetched once.
    const lists = outbox.calls.list;
    await new Promise((r) => setTimeout(r, 150));
    expect(outbox.calls.get).toEqual(["a.txt", "b.bin"]);
    expect(outbox.calls.list - lists).toBeLessThanOrEqual(6);
    await deliveries.drain(ctx, AbortSignal.timeout(5_000));
  });

  it("a file that changes after delivery is stored again as name (2).ext; the delivered one is never overwritten", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox({ "report.pdf": "v1", "archive.tar.gz": "a1", README: "r1" });
    const ctx = context(outbox.source);
    await deliveries.start(ctx);
    await vi.waitFor(async () => expect((await deliveries.forChat("chat-a", ctx))[0]?.files).toHaveLength(3));
    outbox.set("report.pdf", "v2");
    outbox.set("archive.tar.gz", "a2");
    outbox.set("README", "r2");
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    const stored = Object.fromEntries(report.files.map((f) => [f.storedName, readFileSync(f.path, "utf8")]));
    expect(stored).toEqual({
      "report.pdf": "v1",
      "archive.tar.gz": "a1",
      README: "r1",
      "report (2).pdf": "v2",
      "archive (2).tar.gz": "a2",
      "README (2)": "r2",
    });
    expect(versionName("x.y.z", 3)).toBe("x (3).y.z");
  });

  it("never overwrites a file already at the target name, and never follows a symlink there", async () => {
    const { dataDir, deliveries } = await setup();
    const outbox = fakeOutbox({ "notes.txt": "from the sandbox" });
    const ctx = context(outbox.source);
    const files = join(deliverablesRoot(dataDir), ownerKey(ctx), "chat-a", ctx.sessionId, "files");
    await mkdir(files, { recursive: true, mode: 0o700 });
    const victim = join(await tempDir(), "victim.txt");
    await writeFile(victim, "precious");
    await symlink(victim, join(files, "notes.txt"));
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    expect(report.files[0].storedName).toBe("notes (2).txt");
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(lstatSync(join(files, "notes.txt")).isSymbolicLink()).toBe(true);
    expect(readFileSync(report.files[0].path, "utf8")).toBe("from the sandbox");
  });

  it("refuses to write through a symlinked directory", async () => {
    const { dataDir, deliveries } = await setup();
    const outbox = fakeOutbox({ "x.txt": "data" });
    const ctx = context(outbox.source);
    const elsewhere = await tempDir();
    await mkdir(join(deliverablesRoot(dataDir), ownerKey(ctx)), { recursive: true });
    await symlink(elsewhere, join(deliverablesRoot(dataDir), ownerKey(ctx), "chat-a"));
    await expect(deliveries.drain(ctx, AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(DeliveryIncompleteError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("ignores names that are not plain outbox names, and bytes that do not match their digest", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox({ "../escape.txt": "x", "a/b": "x", ".hidden.part": "x", "ok.txt": "fine", "liar.txt": "truth" });
    outbox.lie((name, data) => (name === "liar.txt" ? Buffer.from("tampered") : data));
    const ctx = context(outbox.source);
    await expect(deliveries.drain(ctx, AbortSignal.timeout(5_000))).rejects.toThrow(/1 file could not be copied/);
    const [session] = await deliveries.forChat("chat-a", ctx);
    expect(session.files.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(outbox.calls.get).toEqual(["ok.txt", "liar.txt"]);
  });
});

describe("limits", () => {
  it("a refusal keeps the reason it was first refused for (session-total does not flip to file-count as the count fills)", async () => {
    const { deliveries } = await setup({ limits: { sessionBytes: 10, sessionFiles: 2 } });
    const outbox = fakeOutbox({ "a.txt": "1234567890", "big.txt": "12" });
    const ctx = context(outbox.source);
    await deliveries.start(ctx);
    await vi.waitFor(async () =>
      expect((await deliveries.forChat("chat-a", ctx))[0]?.refused).toEqual([{ name: "big.txt", size: 2, reason: "session-total" }]),
    );
    outbox.set("b.txt", "x".repeat(0)); // fills the count to 2
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    expect(report.files.map((f) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
    expect(report.refused).toEqual([{ name: "big.txt", size: 2, reason: "session-total" }]);
  });

  it("the quota checks what actually arrived: a host listing every size as 1 byte cannot overrun it (review round 2)", async () => {
    const { deliveries } = await setup({ quotaBytes: 50 });
    const data = Buffer.alloc(100, 1);
    const liar: OutboxSource = {
      listOutbox: async () => [{ name: "big.bin", size: 1, sha256: sha(data), mtimeMs: 0 }],
      downloadOutboxFile: async (name) => ({ name, size: data.length, sha256: sha(data), data }),
    };
    const report = await deliveries.drain(context(liar), AbortSignal.timeout(5_000));
    expect(report.files).toEqual([]);
    expect(report.refused).toEqual([{ name: "big.bin", size: 100, reason: "storage-full" }]);
    expect(await deliveries.usageBytes()).toBe(0);
    // Its reservation was released: a file that fits still goes through.
    const fits = await deliveries.drain(context(fakeOutbox({ "ok.txt": "x".repeat(40) }).source), AbortSignal.timeout(5_000));
    expect(fits.files.map((f) => f.name)).toEqual(["ok.txt"]);
  });

  it("concurrent sessions reserve before downloading, so together they cannot overrun the quota (review round 2)", async () => {
    const { deliveries } = await setup({ quotaBytes: 100 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = (fill: number): OutboxSource => {
      const data = Buffer.alloc(60, fill);
      return {
        listOutbox: async () => [{ name: `f${fill}.bin`, size: 60, sha256: sha(data), mtimeMs: 0 }],
        downloadOutboxFile: async (name) => {
          await gate;
          return { name, size: data.length, sha256: sha(data), data };
        },
      };
    };
    const runs = [1, 2, 3].map((n) => deliveries.drain(context(gated(n), { chatId: `chat-${n}` }), AbortSignal.timeout(5_000)));
    await new Promise((r) => setTimeout(r, 30));
    release();
    const reports = await Promise.all(runs);
    expect(reports.flatMap((r) => r.files)).toHaveLength(1);
    expect(reports.flatMap((r) => r.refused).map((r) => r.reason)).toEqual(["storage-full", "storage-full"]);
    expect(await deliveries.usageBytes()).toBe(60);
  });

  it("a failed download releases its reservation", async () => {
    const { deliveries } = await setup({ quotaBytes: 60 });
    const broken = fakeOutbox({ "a.bin": "x".repeat(60) });
    broken.failGet(() => new ComputerUseError("driver_error", "reset"));
    await expect(deliveries.drain(context(broken.source), AbortSignal.timeout(5_000))).rejects.toThrow(/reset/);
    const report = await deliveries.drain(context(fakeOutbox({ "b.bin": "y".repeat(60) }).source), AbortSignal.timeout(5_000));
    expect(report.files.map((f) => f.name)).toEqual(["b.bin"]);
  });

  it("a global quota across every chat refuses new files (storage-full) and never deletes delivered ones", async () => {
    const { deliveries } = await setup({ quotaBytes: 10 });
    const first = await deliveries.drain(context(fakeOutbox({ "a.txt": "12345678" }).source, { chatId: "chat-1" }), AbortSignal.timeout(5_000));
    const second = await deliveries.drain(context(fakeOutbox({ "b.txt": "12345" }).source, { chatId: "chat-2" }), AbortSignal.timeout(5_000));
    expect(second.refused).toEqual([{ name: "b.txt", size: 5, reason: "storage-full" }]);
    expect(existsSync(first.files[0].path)).toBe(true);
    expect(await deliveries.usageBytes()).toBe(8);
    // Deleting a chat frees its space.
    await deliveries.deleteForChat("chat-1");
    const third = await deliveries.drain(context(fakeOutbox({ "c.txt": "12345" }).source, { chatId: "chat-3" }), AbortSignal.timeout(5_000));
    expect(third.files.map((f) => f.name)).toEqual(["c.txt"]);
  });

  it("refuses, and reports, a file over the per-file limit, past the per-session total, or past the file count", async () => {
    const { deliveries } = await setup({ limits: { fileBytes: 10, sessionBytes: 12, sessionFiles: 3 } });
    const outbox = fakeOutbox({ "big.iso": "x".repeat(11), "a.txt": "12345", "b.txt": "1234567", "c.txt": "1" });
    const ctx = context(outbox.source);
    // Refusals are reported, not retried, and do not keep the container.
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    expect(report.state).toBe("complete");
    expect(report.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(report.refused).toEqual([
      { name: "big.iso", size: 11, reason: "too-large" },
      { name: "c.txt", size: 1, reason: "session-total" },
    ]);
    expect(outbox.calls.get).not.toContain("big.iso");

    const counted = await setup({ limits: { sessionFiles: 2 } });
    const many = fakeOutbox({ "1.txt": "a", "2.txt": "b", "3.txt": "c" });
    const r2 = await counted.deliveries.drain(context(many.source), AbortSignal.timeout(5_000));
    expect(r2.refused).toEqual([{ name: "3.txt", size: 1, reason: "file-count" }]);
  });

  it("a too-large file listed with no digest is refused, not waited for", async () => {
    const { deliveries } = await setup({ limits: { fileBytes: 5 } });
    const outbox = fakeOutbox({ "huge.bin": "writing" }); // listed as 10 bytes, sha256 null
    const report = await deliveries.drain(context(outbox.source), AbortSignal.timeout(5_000));
    expect(report.state).toBe("complete");
    expect(report.refused).toEqual([{ name: "huge.bin", size: 10, reason: "too-large" }]);
  });
});

describe("the final copy", () => {
  it("waits a short settle window for files still being written, then verifies every one by digest", async () => {
    const { deliveries } = await setup({ settleMs: 2_000 });
    const outbox = fakeOutbox({ "late.txt": "writing" });
    const ctx = context(outbox.source);
    setTimeout(() => outbox.set("late.txt", "done"), 60);
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    expect(report.state).toBe("complete");
    expect(report.files.map((f) => [f.name, f.sha256])).toEqual([["late.txt", sha("done")]]);
  });

  it("fails, and records why, when a file is still being written after the settle window", async () => {
    const { deliveries } = await setup({ settleMs: 50 });
    const outbox = fakeOutbox({ "done.txt": "ok", "forever.log": "writing" });
    const ctx = context(outbox.source);
    await expect(deliveries.drain(ctx, AbortSignal.timeout(5_000))).rejects.toThrow("1 file still being written");
    const [session] = await deliveries.forChat("chat-a", ctx);
    expect(session).toMatchObject({ state: "incomplete", problem: "1 file still being written" });
    expect(session.files.map((f) => f.name)).toEqual(["done.txt"]);
  });

  it("fails when a download fails or the outbox cannot be listed, and a retry resumes from what was delivered", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox({ "a.txt": "1", "b.txt": "2" });
    outbox.failGet((name) => (name === "b.txt" ? new ComputerUseError("driver_error", "connection reset") : undefined));
    const ctx = context(outbox.source);
    await expect(deliveries.drain(ctx, AbortSignal.timeout(5_000))).rejects.toThrow(/could not be copied \(connection reset\)/);
    outbox.failList(new ComputerUseError("driver_error", "refused"));
    await expect(deliveries.drain(ctx, AbortSignal.timeout(5_000))).rejects.toThrow(/could not be read/);
    outbox.failList();
    outbox.failGet();
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    expect(report.state).toBe("complete");
    expect(report.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(outbox.calls.get.filter((n) => n === "a.txt")).toHaveLength(1);
  });

  it("a session that never used its outbox leaves nothing on disk", async () => {
    const { dataDir, deliveries } = await setup();
    expect((await deliveries.drain(context(fakeOutbox().source), AbortSignal.timeout(5_000))).state).toBe("complete");
    expect(existsSync(deliverablesRoot(dataDir))).toBe(false);
  });

  it("a host with no outbox at all has nothing to lose: complete, not kept", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox();
    outbox.failList(new ComputerUseError("unsupported", "no outbox"));
    expect((await deliveries.drain(context(outbox.source), AbortSignal.timeout(5_000))).state).toBe("complete");
  });

  it("whenEnded waits for the final copy of a live session (what cu_stop reports)", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox({ "r.txt": "x" });
    const ctx = context(outbox.source);
    await deliveries.start(ctx);
    const waiting = deliveries.whenEnded(ctx.sessionId, 5_000);
    setTimeout(() => void deliveries.drain(ctx, AbortSignal.timeout(5_000)), 30);
    expect(await waiting).toMatchObject({ state: "complete", files: [expect.objectContaining({ name: "r.txt" })] });
    expect(await deliveries.whenEnded(randomUUID(), 10)).toBeUndefined();
  });
});

describe("endpoint mode", () => {
  it("delivers only what is new or changed since the session opened (the outbox is shared)", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox({ "old.txt": "earlier session", "edited.txt": "before", "half.bin": "writing" });
    const ctx = context(outbox.source, { mode: "endpoint" });
    await deliveries.start(ctx);
    outbox.set("new.txt", "mine");
    outbox.set("edited.txt", "after");
    const report = await deliveries.drain(ctx, AbortSignal.timeout(5_000));
    expect(report.state).toBe("complete");
    expect(report.files.map((f) => f.name).sort()).toEqual(["edited.txt", "new.txt"]);
  });

  it("withOutboxSync syncs a session and copies once more on close, and never removes, pauses or keeps anything", async () => {
    const { deliveries } = await setup();
    const outbox = fakeOutbox();
    const docker = fakeDocker();
    let closed = 0;
    const endpoint = {
      kind: "native-desktop",
      lockDomain: "remote-desktop:test",
      endpoint: "127.0.0.1:7801",
      identity: async () => ({ instanceId: "i" }),
      probe: async () => ({ available: true, kind: "native-desktop", capabilities: [] }),
      open: async () => ({
        observe: async () => ({ data: "", mimeType: "image/png", width: 1, height: 1, capturedAt: 0 }),
        act: async () => {},
        releaseInput: async () => {},
        close: async () => {
          closed++;
        },
      }),
      ...outbox.source,
    } as unknown as Driver;
    const wrapped = withOutboxSync(endpoint, deliveries, (chatId) => (chatId === "chat-e" ? { workspaceId: "ws-e" } : undefined));
    expect((wrapped as unknown as { endpoint: string }).endpoint).toBe("127.0.0.1:7801");
    const sessionId = randomUUID();
    const session = await wrapped.open({ sessionId, ownerId: "chat-e", signal: new AbortController().signal } as never);
    outbox.set("result.csv", "a,b\n1,2\n");
    await session.close();
    expect(closed).toBe(1);
    const [s] = await deliveries.forChat("chat-e", { workspaceId: "ws-e" });
    expect(s).toMatchObject({ sessionId, mode: "endpoint", state: "complete", files: [expect.objectContaining({ name: "result.csv" })] });
    expect(docker.state.calls).toEqual([]);
    // A driver with no outbox is returned as it is.
    const plain = { kind: "native-desktop", probe: endpoint.probe, open: endpoint.open } as Driver;
    expect(withOutboxSync(plain, deliveries, () => undefined)).toBe(plain);
  });

  it("a failed final copy on an endpoint is recorded, and still nothing is removed", async () => {
    const { deliveries } = await setup({ settleMs: 20 });
    const outbox = fakeOutbox();
    const endpoint = {
      kind: "native-desktop",
      endpoint: "x",
      identity: async () => ({ instanceId: "i" }),
      probe: async () => ({ available: true, kind: "native-desktop", capabilities: [] }),
      open: async () => ({ observe: async () => ({}), act: async () => {}, releaseInput: async () => {}, close: async () => {} }),
      ...outbox.source,
    } as unknown as Driver;
    const wrapped = withOutboxSync(endpoint, deliveries, () => ({ folder: "/w" }));
    const session = await wrapped.open({ sessionId: randomUUID(), ownerId: "chat-f", signal: new AbortController().signal } as never);
    outbox.set("stuck.log", "writing");
    await session.close();
    const [s] = await deliveries.forChat("chat-f", { folder: "/w" });
    expect(s).toMatchObject({ mode: "endpoint", state: "incomplete", problem: "1 file still being written" });
  });
});

describe("chat scoping", () => {
  it("a chat lists only its own sessions, under its own owner key or another one it was keyed under before", async () => {
    const { deliveries } = await setup();
    const a = fakeOutbox({ "a.txt": "a" });
    const b = fakeOutbox({ "b.txt": "b" });
    await deliveries.drain(context(a.source, { chatId: "chat-a", folder: "/work/repo" }), AbortSignal.timeout(5_000));
    await deliveries.drain(context(b.source, { chatId: "chat-b", folder: "/work/repo" }), AbortSignal.timeout(5_000));
    expect((await deliveries.forChat("chat-a", { folder: "/work/repo" })).flatMap((s) => s.files.map((f) => f.name))).toEqual(["a.txt"]);
    expect((await deliveries.forChat("chat-b", { folder: "/work/repo" })).flatMap((s) => s.files.map((f) => f.name))).toEqual(["b.txt"]);
    // chat-a later gained a workspace record: its earlier, folder-keyed deliveries still list.
    expect((await deliveries.forChat("chat-a", { workspaceId: "ws-new" })).flatMap((s) => s.files.map((f) => f.name))).toEqual(["a.txt"]);
    expect(await deliveries.forChat("chat-c", { folder: "/work/repo" })).toEqual([]);
  });

  it("deliverablePathForChat: a delivered file is served to its own chat only; other paths under the root never", async () => {
    const { dataDir, deliveries } = await setup();
    const a = await deliveries.drain(context(fakeOutbox({ "a.txt": "a" }).source, { chatId: "chat-a", workspaceId: "ws-1" }), AbortSignal.timeout(5_000));
    const path = a.files[0].path;
    expect(deliverablePathForChat(dataDir, path, "chat-a")).toBe("allowed");
    expect(deliverablePathForChat(dataDir, path, "chat-b")).toBe("refused");
    expect(deliverablePathForChat(dataDir, path, undefined)).toBe("refused");
    expect(deliverablePathForChat(dataDir, join(path, "..", "..", "manifest.json"), "chat-a")).toBe("refused");
    expect(deliverablePathForChat(dataDir, deliverablesRoot(dataDir), "chat-a")).toBe("refused");
    expect(deliverablePathForChat(dataDir, join(path, "..", ".incoming-x"), "chat-a")).toBe("refused");
    expect(deliverablePathForChat(dataDir, "/etc/hostname", undefined)).toBe("outside");
    expect(deliverablePathForChat(dataDir, join(dataDir, "elsewhere.txt"), undefined)).toBe("outside");
    expect(deliverablePathForChat(dataDir, `${deliverablesRoot(dataDir)}-sibling${sep}x`, undefined)).toBe("outside");
  });
});

describe("deleting a chat while a copy is in flight (review round 1)", () => {
  /** An outbox whose one download waits for `release()`, as a 40 MB file over a slow link does. */
  function slowOutbox(size = 40 * 1024 * 1024) {
    const data = Buffer.alloc(size, 7);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markStarted!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    const source: OutboxSource = {
      listOutbox: async () => [{ name: "big.bin", size: data.length, sha256: sha(data), mtimeMs: 0 }],
      downloadOutboxFile: async (name) => {
        markStarted();
        await gate;
        return { name, size: data.length, sha256: sha(data), data };
      },
    };
    return { source, started, release: () => release() };
  }

  it("deleteForChat waits for the pass, and nothing of the chat is (re)created — 20 runs, live sync and final copy alike", async () => {
    for (let run = 0; run < 20; run++) {
      const { dataDir, deliveries } = await setup();
      const slow = slowOutbox();
      const ctx = context(slow.source, { chatId: `doomed-${run}` });
      const copying = run % 2 ? deliveries.drain(ctx, AbortSignal.timeout(10_000)).catch(() => {}) : deliveries.start(ctx);
      await slow.started;
      // The reviewer's window: the download has finished and passed the
      // deleted-chat check, and the 40 MB file is being written, when the
      // chat is deleted.
      slow.release();
      await new Promise((r) => setImmediate(r));
      await deliveries.deleteForChat(ctx.chatId);
      await copying;
      await new Promise((r) => setTimeout(r, 20));
      const chatDir = join(deliverablesRoot(dataDir), ownerKey(ctx), chatSegment(ctx.chatId));
      expect(existsSync(chatDir), `run ${run}`).toBe(false);
      expect(await deliveries.forChat(ctx.chatId, ctx)).toEqual([]);
      // And nothing writes there later either.
      await deliveries.markLost(ctx, "gone");
      expect(existsSync(chatDir)).toBe(false);
    }
  }, 60_000);

  it("a later deleteFiles (the batched flush) waits for the deleted chat's in-flight pass", async () => {
    const { dataDir, deliveries } = await setup();
    const slow = slowOutbox();
    const ctx = context(slow.source, { chatId: "flushed" });
    void deliveries.start(ctx);
    await slow.started;
    slow.release();
    await new Promise((r) => setImmediate(r));
    void deliveries.deleteForChat(ctx.chatId, { keepFiles: true });
    await deliveries.deleteFiles(ctx.chatId);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(deliverablesRoot(dataDir), ownerKey(ctx), chatSegment(ctx.chatId)))).toBe(false);
  });

  it("keepFiles: the chat stops being written, its files stay (a surviving chat still shows them)", async () => {
    const { deliveries } = await setup();
    const report = await deliveries.drain(context(fakeOutbox({ "keep.txt": "k" }).source, { chatId: "orig" }), AbortSignal.timeout(5_000));
    await deliveries.deleteForChat("orig", { keepFiles: true });
    expect(existsSync(report.files[0].path)).toBe(true);
    const late = await deliveries.drain(context(fakeOutbox({ "new.txt": "n" }).source, { chatId: "orig" }), AbortSignal.timeout(5_000));
    expect(late.files).toEqual([]);
  });
});
