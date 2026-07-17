/**
 * Integration tests for the query loop's stream-closed auto-recovery
 * (claude.ts + stream-recovery.ts).
 *
 * Drives sendMessage() end-to-end with a scripted provider injected under the
 * "claude-code" slot and asserts the stop-and-resume behavior:
 *   1. Consecutive "Stream closed" tool failures → the broken query is closed
 *      and the session is resumed with a recovery prompt.
 *   2. A thrown transport error mid-iteration recovers the same way.
 *   3. Recoveries are capped — a persistently-broken stream stops retrying.
 *   4. A healthy tool result between failures resets the counter (no recovery).
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

// Isolate all chat-record writes into a throwaway data dir. Must be set
// before the dynamic imports below — DATA_DIR is resolved at module load.
const dataDir = mkdtempSync(join(tmpdir(), "callboard-stream-recovery-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-stream-recovery-work-"));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { MAX_STREAM_RECOVERIES } = await import("./stream-recovery.js");

const STREAM_CLOSED_TOOL_EVENTS = (callIdPrefix: string): AgentEvent[] => [
  { type: "tool_use", toolName: "Bash", input: { command: "ls" }, callId: `${callIdPrefix}-1` },
  { type: "tool_result", callId: `${callIdPrefix}-1`, content: "Error: Stream closed", isError: true },
  { type: "tool_use", toolName: "Read", input: { path: "/tmp/x" }, callId: `${callIdPrefix}-2` },
  { type: "tool_result", callId: `${callIdPrefix}-2`, content: "Error: Stream closed", isError: true },
];

const HEALTHY_FINISH: AgentEvent[] = [
  { type: "text", content: "recovered and continuing" },
  { type: "result", status: "success" },
];

/** Run sendMessage against the given provider and collect emitted events until done/error. */
async function runSession(provider: AgentProvider): Promise<StreamEvent[]> {
  setAgentProviderForTesting(provider);
  const events: StreamEvent[] = [];
  const emitter = await sendMessage({ prompt: "do the thing", folder: workDir, triggered: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      events.push(e);
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return events;
}

/** Drain an async-iterable prompt (the SDK wire shape) into its concatenated text. */
async function promptText(prompt: unknown): Promise<string> {
  let text = "";
  for await (const msg of prompt as AsyncIterable<{ message?: { content?: string } }>) {
    text += msg?.message?.content ?? "";
  }
  return text;
}

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("stream-closed auto-recovery", () => {
  it("stops the broken query and resumes the session after consecutive tool failures", async () => {
    const mock = new MockAgentProvider({
      eventScripts: [
        [
          { type: "session_started", sessionId: "sr-sess-1" },
          ...STREAM_CLOSED_TOOL_EVENTS("a"),
          // Never reached — the loop must bail at the threshold instead of
          // letting the model keep working against dead tools.
          { type: "text", content: "should not be consumed" },
          { type: "result", status: "success" },
        ],
        [{ type: "session_started", sessionId: "sr-sess-2" }, ...HEALTHY_FINISH],
      ],
    });

    const events = await runSession(mock);

    // Two queries: the broken one (closed early) and the resumed one.
    expect(mock.queryRecords).toHaveLength(2);
    expect(mock.queryRecords[0].closed).toBe(true);
    expect(mock.queryRecords[0].events.map((e) => e.type)).not.toContain("text");

    // The resume targets the session id the broken query established, and the
    // injected prompt is the automated "please continue".
    const resumed = mock.queryRecords[1].request;
    expect((resumed.options as { resume?: string }).resume).toBe("sr-sess-1");
    const text = await promptText(resumed.prompt);
    expect(text).toContain("Stream closed");
    expect(text.toLowerCase()).toContain("continue");

    const recoveries = events.filter((e) => e.type === "auto_recovery");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].reason).toBe(`stream_recovery_1_of_${MAX_STREAM_RECOVERIES}`);

    // The run still ends as a single healthy session.
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.reason).toBeUndefined();
  });

  it("recovers when the query throws a stream-closed transport error", async () => {
    const script2: AgentEvent[] = [{ type: "session_started", sessionId: "sr-throw-2" }, ...HEALTHY_FINISH];
    let calls = 0;
    const requests: AgentQueryRequest[] = [];
    const provider: AgentProvider = {
      kind: "mock",
      query(req: AgentQueryRequest): AgentQuery {
        requests.push(req);
        const first = calls++ === 0;
        return {
          async *[Symbol.asyncIterator]() {
            if (first) {
              yield { type: "session_started", sessionId: "sr-throw-1" } as AgentEvent;
              throw new Error("Stream closed");
            }
            yield* script2;
          },
          accountInfo: async () => null,
          supportedModels: async () => [],
          close: async () => {},
        };
      },
      buildToolServer: () => ({ mock: true }),
    };

    const events = await runSession(provider);

    expect(requests).toHaveLength(2);
    expect((requests[1].options as { resume?: string }).resume).toBe("sr-throw-1");
    expect(events.filter((e) => e.type === "auto_recovery")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
  });

  it("gives up after the recovery cap instead of restarting forever", async () => {
    // Every query hits the failure signature; after MAX_STREAM_RECOVERIES
    // restarts the loop must stop intervening and let the run end.
    const brokenScript = (n: number): AgentEvent[] => [
      { type: "session_started", sessionId: `sr-cap-${n}` },
      ...STREAM_CLOSED_TOOL_EVENTS(`cap-${n}`),
      { type: "result", status: "success" },
    ];
    const mock = new MockAgentProvider({
      eventScripts: Array.from({ length: MAX_STREAM_RECOVERIES + 1 }, (_, n) => brokenScript(n)),
    });

    const events = await runSession(mock);

    expect(mock.queryRecords).toHaveLength(MAX_STREAM_RECOVERIES + 1);
    expect(events.filter((e) => e.type === "auto_recovery")).toHaveLength(MAX_STREAM_RECOVERIES);
    expect(events.at(-1)!.type).toBe("done");
  });

  it("does not recover when a healthy result sits between two failures", async () => {
    const mock = new MockAgentProvider({
      eventScripts: [
        [
          { type: "session_started", sessionId: "sr-healthy-1" },
          { type: "tool_use", toolName: "Bash", input: {}, callId: "h-1" },
          { type: "tool_result", callId: "h-1", content: "Error: Stream closed", isError: true },
          { type: "tool_use", toolName: "Bash", input: {}, callId: "h-2" },
          { type: "tool_result", callId: "h-2", content: "file contents", isError: false },
          { type: "tool_use", toolName: "Bash", input: {}, callId: "h-3" },
          { type: "tool_result", callId: "h-3", content: "Error: Stream closed", isError: true },
          ...HEALTHY_FINISH,
        ],
      ],
    });

    const events = await runSession(mock);

    expect(mock.queryRecords).toHaveLength(1);
    expect(events.filter((e) => e.type === "auto_recovery")).toHaveLength(0);
    expect(events.at(-1)!.type).toBe("done");
  });
});
