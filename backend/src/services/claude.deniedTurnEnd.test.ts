/**
 * Run-loop wiring for permission-turn-end.ts: a turn the CLI ends because
 * callboard's own `canUseTool` denied with `interrupt: true` must reach the
 * user as a readable error, not as Claude Code's internal
 * `[ede_diagnostic] result_type=user …` string.
 *
 * The fake provider plays the CLI's part: it calls `canUseTool` for a Write
 * (the chat denies writes), then reports the result the real CLI reports in
 * that state — verbatim from production logs, 2026-11-18 → 11-26.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { DefaultPermissions, StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-denied-turn-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-denied-turn-work-"));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");

const EDE = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";

const WRITES_DENIED: DefaultPermissions = {
  fileRead: "allow",
  fileWrite: "deny",
  codeExecution: "allow",
  webAccess: "allow",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};

type CanUseTool = (tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => Promise<{ behavior: string }>;

/** A one-turn provider: optionally asks canUseTool about `tool`, then yields `result`. */
function provider(steps: { tool?: string; result: AgentEvent; thenThrow?: string }): AgentProvider {
  return {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      const canUseTool = (req.options as { canUseTool?: CanUseTool }).canUseTool;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "session_started", sessionId: `denied-${Math.random().toString(36).slice(2)}` } as AgentEvent;
          if (steps.tool) {
            yield { type: "tool_use", toolName: steps.tool, input: {}, callId: "toolu_1" } as AgentEvent;
            await canUseTool!(steps.tool, {}, { signal: new AbortController().signal });
          }
          yield steps.result;
          // The SDK's own follow-up when the CLI exits after an error result:
          // it rethrows the result text (sdk.mjs `readMessages`).
          if (steps.thenThrow) throw new Error(steps.thenThrow);
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {},
      };
    },
    buildToolServer: () => ({ mock: true }),
  };
}

async function run(p: AgentProvider): Promise<StreamEvent[]> {
  setAgentProviderForTesting(p);
  const emitter = await sendMessage({ prompt: "write a file", folder: workDir, triggered: true, defaultPermissions: WRITES_DENIED });
  return new Promise((resolve, reject) => {
    const events: StreamEvent[] = [];
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      events.push(e);
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });
}

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("a turn ended by an interrupting deny", () => {
  it("is reported in words, naming the denied tool", async () => {
    const events = await run(provider({ tool: "Write", result: { type: "result", status: "error", reason: EDE } }));
    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    expect(last.content).toContain("Write was denied");
    expect(last.content).toContain("Auto-denied by default fileWrite policy");
    expect(last.content).not.toContain("ede_diagnostic");
  });

  it("is reported in words when the SDK also rethrows the result text", async () => {
    // 3 of the 16 production cases took this path: the result was logged, then
    // the stream threw "Claude Code returned an error result: [ede_diagnostic] …"
    // and the catch block surfaced that raw.
    const events = await run(
      provider({ tool: "Write", result: { type: "result", status: "error", reason: EDE }, thenThrow: `Claude Code returned an error result: ${EDE}` }),
    );
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("Write was denied");
    expect(errors[0].content).not.toContain("ede_diagnostic");
  });

  it("leaves a real provider error alone, even after a deny", async () => {
    const reason = `${EDE}; API Error: 529 overloaded`;
    const events = await run(provider({ tool: "Write", result: { type: "result", status: "error", reason } }));
    expect(events.at(-1)).toMatchObject({ type: "error", content: reason });
  });

  it("leaves the diagnostic alone when no deny preceded it", async () => {
    const events = await run(provider({ result: { type: "result", status: "error", reason: EDE } }));
    expect(events.at(-1)).toMatchObject({ type: "error", content: EDE });
  });
});
