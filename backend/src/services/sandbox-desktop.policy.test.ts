/**
 * The Sandbox desktop wiring: the drain hook is installed through
 * `startSandboxReaper({ drainBeforeDestroy })`; deleting a chat deletes its
 * deliverables and stops its syncs; `keepHours` and `maxKept` are bounded.
 * The keep policy itself is sandbox-recovery.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "cb-sandbox-policy-"));
process.env.CALLBOARD_DATA_DIR = DATA;
const { getSandboxDeliveries, deleteSandboxChatData, sandboxDrainHook, startSandboxReaper, getSandboxManager, shutdownSandboxDesktop } =
  await import("./sandbox-desktop.js");
const { normalizeSandboxSettings, resolveSandboxSettings } = await import("./sandbox-desktop-settings.js");
const { SANDBOX_DESKTOP_BOUNDS } = await import("shared/types/index.js");
afterAll(() => rmSync(DATA, { recursive: true, force: true }));

const data = Buffer.from("the deliverable");
const sha = createHash("sha256").update(data).digest("hex");
const outbox = () => {
  const calls: string[] = [];
  return {
    calls,
    driver: {
      listOutbox: async () => (calls.push("list"), [{ name: "out.txt", size: data.length, sha256: sha, mtimeMs: 0 }]),
      downloadOutboxFile: async () => (calls.push("get"), { name: "out.txt", size: data.length, sha256: sha, data }),
    } as never,
  };
};

describe("hook registration", () => {
  it("startSandboxReaper({ drainBeforeDestroy }) installs the managed hook before its first pass", async () => {
    startSandboxReaper({ intervalMs: 3_600_000, drainBeforeDestroy: sandboxDrainHook, afterPass: async () => {} });
    expect(getSandboxManager().drainBeforeDestroy).toBe(sandboxDrainHook);
    await shutdownSandboxDesktop();
  });
});

describe("deleting a chat", () => {
  it("deletes its deliverables under every owner key and never writes for it again; other chats are untouched", async () => {
    const deliveries = getSandboxDeliveries();
    const mine = await deliveries.drain(
      { sessionId: randomUUID(), chatId: "doomed", workspaceId: "ws-1", mode: "managed", source: outbox().driver },
      AbortSignal.timeout(5_000),
    );
    await deliveries.drain(
      { sessionId: randomUUID(), chatId: "doomed", folder: "/elsewhere", mode: "managed", source: outbox().driver },
      AbortSignal.timeout(5_000),
    );
    const theirs = await deliveries.drain(
      { sessionId: randomUUID(), chatId: "survivor", workspaceId: "ws-1", mode: "managed", source: outbox().driver },
      AbortSignal.timeout(5_000),
    );
    // A live sync for the doomed chat.
    const live = outbox();
    const liveSession = randomUUID();
    await deliveries.start({ sessionId: liveSession, chatId: "doomed", folder: "/x", mode: "managed", source: live.driver });

    deleteSandboxChatData("doomed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(mine.files[0].path)).toBe(false);
    expect(await deliveries.forChat("doomed", {})).toEqual([]);
    expect(deliveries.isLive(liveSession)).toBe(false);
    expect(existsSync(theirs.files[0].path)).toBe(true);
    // A late drain for it (its session ending after the delete) copies nothing.
    const late = outbox();
    expect(
      (await deliveries.drain({ sessionId: randomUUID(), chatId: "doomed", mode: "managed", source: late.driver }, AbortSignal.timeout(5_000))).files,
    ).toEqual([]);
    expect(late.calls).toEqual([]);
  });
});

describe("kept-for-recovery settings", () => {
  it("keepHours (1–168, default 24) and maxKept (0–8, default 2) are bounded whole numbers", () => {
    expect(resolveSandboxSettings({})).toMatchObject({ keepHours: 24, maxKept: 2, deliverablesGb: 5 });
    expect(normalizeSandboxSettings({ deliverablesGb: 100 }, true)).toEqual({ deliverablesGb: 100 });
    expect(() => normalizeSandboxSettings({ deliverablesGb: 0 }, true)).toThrow(/deliverablesGb/);
    expect(SANDBOX_DESKTOP_BOUNDS.keepHours).toEqual({ min: 1, max: 168, default: 24 });
    expect(normalizeSandboxSettings({ keepHours: 72, maxKept: 0 }, true)).toEqual({ keepHours: 72, maxKept: 0 });
    for (const bad of [{ keepHours: 0 }, { keepHours: 169 }, { keepHours: 1.5 }, { maxKept: 9 }, { maxKept: -1 }])
      expect(() => normalizeSandboxSettings(bad, true)).toThrow(/keepHours|maxKept/);
    // Lenient read of the file: a bad value falls back to the default.
    expect(resolveSandboxSettings(normalizeSandboxSettings({ keepHours: 9999 }, false)).keepHours).toBe(24);
  });
});
