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
  return writeAt(n, extra, events);
}
/** Same rollout under a different filename timestamp, so one thread id can appear twice. */
function writeAt(n: number, extra = {}, events: string[] = ["task_complete"], stamp = "00-00-00") {
  const path = join(state.home, "sessions/2026/09/06", `rollout-2026-09-06T${stamp}-${id(n)}.jsonl`);
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
  // 2,100 headers of ~24 KB is ~50 MB, three times the 16 MB cold budget.
  for (let n = 0; n < 2100; n++) write(n, { padding: "x".repeat(24 * 1024) });
  let c = createCardContext([record()]);
  const cold = c.summaries([])[0].chatCount;
  expect(cold).toBeGreaterThan(1);
  expect(cold).toBeLessThan(2101);
  expect(vi.mocked(fs.opendirSync)).toHaveBeenCalledTimes(4);
  // 16 MB of metadata plus 8 MB of lifecycle replay, and nothing outside either budget.
  expect(readBytes()).toBeLessThanOrEqual(24 * 1024 * 1024);
  vi.clearAllMocks();
  c = createCardContext([record()]);
  expect(c.summaries([])[0].chatCount).toBeGreaterThan(cold);
  expect(vi.mocked(fs.opendirSync)).toHaveBeenCalledTimes(4);
  expect(readBytes()).toBeLessThanOrEqual(24 * 1024 * 1024);
  // Each pass reads what the last could not afford; a few passes see everything.
  for (let pass = 0; pass < 4; pass++) createCardContext([record()]);
  expect(createCardContext([record()]).summaries([])[0].chatCount).toBe(2101);
});
it("fallback metadata budget is enforced, hits are free, refusal does not poison cache", () => {
  const p = write(1, { padding: "x".repeat(9000) });
  const size = fs.statSync(p).size;
  let budget = { remainingBytes: 8192 };
  expect(readCodexSessionMeta(p, budget)).toBeNull();
  expect(budget.remainingBytes).toBe(0);
  expect(readBytes()).toBe(8192);
  budget = { remainingBytes: 8192 + 1024 * 1024 };
  expect(readCodexSessionMeta(p, budget)?.id).toBe(id(1));
  // Charged for what was read — the header — not for the size that was asked for.
  expect(8192 + 1024 * 1024 - budget.remainingBytes).toBe(size);
  vi.clearAllMocks();
  expect(readCodexSessionMeta(p, { remainingBytes: 0 })?.id).toBe(id(1));
  expect(readBytes()).toBe(0);
});
it("charges the budget for bytes read, never for the requested window, and reads no further than the header", () => {
  // 200 KB header (the median on a real device) followed by 3 MB of transcript:
  // a fixed 1 MB head read would charge 1 MB and read past the header.
  const p = write(1, { padding: "x".repeat(200 * 1024) }, Array.from({ length: 3000 }, () => "x".repeat(1024)));
  const header = fs.readFileSync(p, "utf8").indexOf("\n") + 1;
  const budget = { remainingBytes: 16 * 1024 * 1024 };
  expect(readCodexSessionMeta(p, budget)?.id).toBe(id(1));
  const charged = 16 * 1024 * 1024 - budget.remainingBytes;
  expect(charged).toBe(readBytes());
  expect(charged).toBeGreaterThanOrEqual(header);
  // Chunks double from 64 KB (8 KB, 64, 128, 256 …), so the overshoot past the
  // newline is bounded by the last chunk; a 200 KB header never costs 1 MB.
  expect(charged).toBeLessThan(header + 256 * 1024);
  expect(charged).toBeLessThan(1024 * 1024);
});
it("first records past 1 MB are read, and the aggregate budget still bounds a cold pass", () => {
  // A 1.4 MB `base_instructions` is what an uncapped agent prompt writes; the
  // rollout is still one record and must not vanish from discovery.
  for (let n = 0; n < 25; n++) write(n, { padding: "x".repeat(1024 * 1024 + 400 * 1024) });
  const cold = new CodexSessionProvider().nativeDiscoveryEvidence();
  expect(cold.length).toBeGreaterThan(0);
  expect(cold.length).toBeLessThan(25);
  expect(readBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
  vi.clearAllMocks();
  const warmer = new CodexSessionProvider().nativeDiscoveryEvidence();
  expect(warmer.length).toBeGreaterThan(cold.length);
  expect(readBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
  const walks = Math.ceil(25 / cold.length) + 1;
  for (let i = 0; i < walks; i++) new CodexSessionProvider().nativeDiscoveryEvidence();
  expect(new CodexSessionProvider().nativeDiscoveryEvidence()).toHaveLength(25);
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
