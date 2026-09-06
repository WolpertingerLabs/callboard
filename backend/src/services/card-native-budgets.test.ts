/** Adapted from the independent PR #417 budget reviewer probes; scratch files only. */
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({ home: "" }));
vi.mock("./agent-settings.js", async (original) => ({
  ...(await original<typeof import("./agent-settings.js")>()),
  getAgentSettings: () => ({ codexHome: state.home }),
}));
vi.mock("./claude.js", () => ({ getPendingRequest: () => null, hasPendingRequest: () => false, getActiveSession: () => null }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof fs>();
  return { ...real, readSync: vi.fn(real.readSync), opendirSync: vi.fn(real.opendirSync) };
});
const { createCardContext } = await import("./card-context.js");
const { CodexSessionProvider } = await import("../agents/adapters/codex/CodexSessionProvider.js");
const { readCodexSessionMeta, clearCodexSessionMetaCache } = await import("../agents/adapters/codex/sessionParser.js");
const { readNativeLifecycle } = await import("./codex-native-agents.js");
const scratch = fs.mkdtempSync(join(tmpdir(), "review417-independent-"));
const root = "11111111-1111-1111-1111-111111111111";
const id = (n: number) => `22222222-2222-2222-2222-${String(n).padStart(12, "0")}`;
const record = (sessionId = root, meta = {}, path: string | null = null) => ({
  id: sessionId,
  session_id: sessionId,
  folder: "/scratch",
  metadata: JSON.stringify({ provider: "codex", title: "root", ...meta }),
  session_log_path: path,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
});
function write(n: number, extra = {}, events: string[] = ["task_complete"]) {
  const path = join(state.home, "sessions/2026/09/06", `rollout-2026-09-06T00-00-00-${id(n)}.jsonl`);
  fs.writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: id(n),
          cwd: "/scratch",
          source: { subagent: { thread_spawn: { parent_thread_id: root } } },
          subagent_history_start_ordinal: 1,
          ...extra,
        },
      }),
      ...events.map((type) => JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type } })),
    ].join("\n") + "\n",
  );
  return path;
}
const readBytes = () => vi.mocked(fs.readSync).mock.calls.reduce((n, a) => n + Number((a as unknown[])[3]), 0);
beforeEach(() => {
  state.home = fs.mkdtempSync(join(scratch, "case-"));
  fs.mkdirSync(join(state.home, "sessions/2026/09/06"), { recursive: true });
  clearCodexSessionMetaCache();
  vi.clearAllMocks();
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
it("cold metadata exhaustion recovers on next request with no repeated walk per child", () => {
  for (let n = 0; n < 2100; n++) write(n);
  let c = createCardContext([record()]);
  expect(c.summaries([])[0].chatCount).toBe(2049);
  expect(vi.mocked(fs.opendirSync)).toHaveBeenCalledTimes(4);
  expect(readBytes()).toBeLessThanOrEqual(24 * 1024 * 1024);
  vi.clearAllMocks();
  c = createCardContext([record()]);
  expect(c.summaries([])[0].chatCount).toBe(2101);
  expect(vi.mocked(fs.opendirSync)).toHaveBeenCalledTimes(4);
  expect(readBytes()).toBeLessThanOrEqual(24 * 1024 * 1024);
});
it("fallback metadata budget is enforced, hits are free, refusal does not poison cache", () => {
  const p = write(1, { padding: "x".repeat(9000) });
  let budget = { remainingBytes: 8192 };
  expect(readCodexSessionMeta(p, budget)).toBeNull();
  expect(budget.remainingBytes).toBe(0);
  expect(readBytes()).toBe(8192);
  budget = { remainingBytes: 8192 + 1024 * 1024 };
  expect(readCodexSessionMeta(p, budget)?.id).toBe(id(1));
  expect(budget.remainingBytes).toBe(0);
  vi.clearAllMocks();
  expect(readCodexSessionMeta(p, { remainingBytes: 0 })?.id).toBe(id(1));
  expect(readBytes()).toBe(0);
});
it("oversized first records remain absent within aggregate budget", () => {
  for (let n = 0; n < 25; n++) write(n, { padding: "x".repeat(1024 * 1024) });
  expect(new CodexSessionProvider().nativeDiscoveryEvidence()).toHaveLength(0);
  expect(readBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
});
it("new child, duplicate, mismatch and rewrite invalidation are reconsidered", () => {
  const p = write(1);
  expect(createCardContext([record()]).resolve(id(1))).toEqual({ rootChatId: root });
  write(1, { id: id(2) });
  expect(createCardContext([record()]).resolve(id(1))).toBeNull();
  write(1);
  fs.copyFileSync(p, p.replace("00-00-00", "00-00-01"));
  expect(createCardContext([record()]).resolve(id(1))).toBeNull();
  write(2);
  expect(createCardContext([record()]).resolve(id(2))).toEqual({ rootChatId: root });
});
it("terminal, interrupted, errors, active freshness and unknown replay are transient", () => {
  for (const [n, event, status] of [
    [1, "task_complete", "complete"],
    [2, "turn_aborted", "interrupted"],
    [3, "error", "error"],
    [4, "task_started", "active"],
  ] as const) {
    const p = write(n, {}, [event]);
    expect(readNativeLifecycle(p)).toBe(status);
    if (status === "active") expect(readNativeLifecycle(p, Date.now() + 31000)).toBe("unknown");
    write(n, {}, ["task_complete"]);
    expect(readNativeLifecycle(p)).toBe("complete");
  }
  const p = write(5, { subagent_history_start_ordinal: undefined });
  expect(readNativeLifecycle(p)).toBe("unknown");
});
it("stored native lifecycle must not replay a mismatched stored log path", () => {
  const path = write(1);
  const stale = record(id(1), { parentChatId: root, nativeAgent: { parentThreadId: root, lifecycle: "complete" } }, path);
  expect(
    createCardContext([record(), stale])
      .summaries([])[0]
      .memberChats.find((x) => x.chatId === id(1))?.nativeAgent?.lifecycle,
  ).toBe("complete");
  // Rewrite the header to a different native UUID while retaining the stored path.
  write(1, { id: id(2) }, ["task_started"]);
  expect(new CodexSessionProvider().nativeDiscoveryEvidence()).toHaveLength(0);
  const c = createCardContext([record(), stale]).summaries([])[0];
  const member = c.memberChats.find((x) => x.chatId === id(1));
  expect(member?.nativeAgent?.lifecycle).toBe("unknown");
});
it("fallback cold discovery converges across polls without exceeding 16 MiB per pass", () => {
  for (let n = 0; n < 40; n++) write(n, { padding: "x".repeat(9000) });
  let largest = 0;
  for (let poll = 0; poll < 4; poll++) {
    vi.clearAllMocks();
    const count = new CodexSessionProvider().nativeDiscoveryEvidence().length;
    expect(count).toBeGreaterThanOrEqual(largest);
    largest = count;
    expect(readBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
  }
  expect(largest).toBe(40);
});
it("filesystem enumeration stops at its 20000-entry cap", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  for (let n = 0; n < 20100; n++) fs.writeFileSync(join(state.home, "sessions/2026/09/06", `junk-${n}`), "");
  let yielded = 0;
  vi.mocked(fs.opendirSync).mockImplementation((...args: any[]) => {
    const handle = actual.opendirSync(...(args as Parameters<typeof fs.opendirSync>));
    const read = handle.readSync.bind(handle);
    handle.readSync = () => {
      const entry = read();
      if (entry) yielded++;
      return entry;
    };
    return handle;
  });
  const provider = new CodexSessionProvider();
  expect(provider.nativeDiscoveryEvidence()).toEqual([]);
  expect(provider.discoveryIncomplete).toBe(true);
  expect(yielded).toBe(20000);
  vi.mocked(fs.opendirSync).mockImplementation(actual.opendirSync);
});
