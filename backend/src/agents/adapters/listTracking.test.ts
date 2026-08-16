/**
 * Cross-engine task-list tracking: every engine that has a running task list
 * must get that list all the way to a `ParsedMessage` the chat UI renders.
 *
 * The per-adapter suites each prove one engine's mapping. This one is
 * deliberately a *table*, because the bug it was written for was not in any
 * single adapter: Codex's and ACP's lists were produced by the engine,
 * translated by the adapter, and then dropped — Codex's at the service layer,
 * ACP's at the transcript parser — while Claude Code's went through untouched.
 * A per-adapter test can't see that, since each adapter was doing its own job
 * correctly. Only laying the engines side by side shows the hole.
 *
 * There are two paths per engine and both are exercised:
 *
 *  - **Live** — engine event → {@link AgentEvent}. What arrives while the agent
 *    is working.
 *  - **Persisted** — whatever is on disk → `ParsedMessage`. What the chat shows
 *    after a reload, and the one that actually feeds the renderer: the browser
 *    answers an SSE `message_update` by refetching the transcript rather than
 *    by reading the event payload off the wire.
 *
 * The two disagree by design for Codex, and the reason is recorded below.
 *
 * @see frontend/src/components/listParity.test.tsx (the rendering half)
 * @see shared/types/taskList.ts (the payload shapes this produces)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskList, TASK_LIST_TOOLS, type TaskListItem } from "shared/types/index.js";
import { translateSdkMessages } from "./claude-code/messageAdapter.js";
import { translateCodexEvent } from "./codex/messageAdapter.js";
import { parseCodexRollout } from "./codex/sessionParser.js";
import { AcpToolCallBuffer, translateAcpUpdate } from "./acp/messageAdapter.js";
import { AcpTranscriptWriter } from "./acp/transcript.js";
import { findAcpTranscript, parseAcpTranscript } from "./acp/sessionParser.js";
import { taskListStreamEvent } from "../../services/claude.js";
import type { AgentEvent } from "../ports/events.js";

/** The one list every engine below is made to report, in callboard's vocabulary. */
const EXPECTED: TaskListItem[] = [
  { content: "Wire the adapter", status: "completed" },
  { content: "Render the list", status: "in_progress" },
  { content: "Prove it", status: "pending" },
];

/** Same list with the in-progress step demoted — what a lossier engine can say. */
const EXPECTED_WITHOUT_IN_PROGRESS: TaskListItem[] = EXPECTED.map((item) => (item.status === "in_progress" ? { ...item, status: "pending" } : item));

async function drain(messages: unknown[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of translateSdkMessages(
    (async function* () {
      for (const message of messages) yield message;
    })(),
  )) {
    out.push(event);
  }
  return out;
}

describe("live: engine event → AgentEvent", () => {
  it("claude-code: TodoWrite stays a tool_use — its list genuinely is a tool call", async () => {
    const events = await drain([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "TodoWrite",
              input: { todos: EXPECTED.map((item) => ({ ...item, activeForm: `${item.content}…` })) },
            },
          ],
        },
      },
    ]);
    // The one engine that is NOT normalized into `task_list`: Claude Code's
    // transcript is written by the CLI, so the tool call is what lands on disk
    // and inventing a second representation would only make the two disagree.
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_use", toolName: TASK_LIST_TOOLS.claudeCode }));
  });

  it("codex: todo_list becomes a task_list, widening `completed` into the shared status union", () => {
    expect(
      translateCodexEvent({
        type: "item.completed",
        item: {
          id: "t1",
          type: "todo_list",
          items: EXPECTED.map((item) => ({ text: item.content, completed: item.status === "completed" })),
        },
      } as never),
    ).toEqual({ type: "task_list", items: EXPECTED_WITHOUT_IN_PROGRESS });
  });

  it("acp: plan becomes a task_list, dropping the priority the list does not render", () => {
    expect(
      translateAcpUpdate({ sessionUpdate: "plan", entries: EXPECTED.map((item) => ({ ...item, priority: "high" })) } as never, new AcpToolCallBuffer()),
    ).toEqual([{ type: "task_list", items: EXPECTED }]);
  });

  it("acp: plan_update carries the complete list, so it replaces rather than merges", () => {
    // Verified against the installed SDK, not assumed: schema.json's `PlanItems`
    // says "the agent must send a complete list of all entries with their
    // current status. The client replaces that plan with each update."
    const [event] = translateAcpUpdate(
      {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: "p1", entries: [{ content: "Only this one now", priority: "low", status: "pending" }] },
      } as never,
      new AcpToolCallBuffer(),
    );
    expect(event).toEqual({ type: "task_list", items: [{ content: "Only this one now", status: "pending" }] });
  });

  it("acp: plan_removed clears the list instead of leaving the last one standing", () => {
    expect(translateAcpUpdate({ sessionUpdate: "plan_removed", planId: "p1" } as never, new AcpToolCallBuffer())).toEqual([{ type: "task_list", items: [] }]);
  });

  it("acp: a file or markdown plan is not a checklist and rides through untouched", () => {
    // The experimental `plan_update` has three content forms and only `items`
    // has entries. A URI and a blob of prose have no rows to render, so they
    // stay `adapter_specific` rather than being flattened into rows they aren't.
    for (const plan of [
      { type: "file", planId: "p1", uri: "file:///plan.md" },
      { type: "markdown", planId: "p1", content: "# Plan\n\n- do the thing" },
    ]) {
      const [event] = translateAcpUpdate({ sessionUpdate: "plan_update", plan } as never, new AcpToolCallBuffer());
      expect(event).toMatchObject({ type: "adapter_specific", adapter: "acp" });
    }
  });

  it("acp: entries with no text or an unknown status are dropped, not guessed at", () => {
    const [event] = translateAcpUpdate(
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Keep this", priority: "high", status: "pending" },
          { content: "", priority: "high", status: "pending" },
          { content: "Unknown status", priority: "high", status: "blocked" },
          null,
        ],
      } as never,
      new AcpToolCallBuffer(),
    );
    expect(event).toEqual({ type: "task_list", items: [{ content: "Keep this", status: "pending" }] });
  });

  it("cline and pi: neither SDK has a list concept, so there is nothing to track", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    expect(Object.keys(pi).filter((k) => /todo|plan|checklist/i.test(k))).toEqual([]);

    const cline = await import("@cline/sdk");
    // Every plan-ish export is either a Plan/Act *mode* setting accessor or the
    // checkpoint-diff planner. Neither is a per-response list, so a task list
    // for these two would have to be invented rather than reported.
    expect(
      Object.keys(cline)
        .filter((k) => /todo|plan|checklist/i.test(k))
        .sort(),
    ).toEqual(["createCheckpointComparePlan", "readPlanActModeGlobally", "setPlanActModeGlobally"]);
  });
});

describe("live: task_list → the wire", () => {
  it("projects onto tool_use, so no capability-gated StreamEvent type is needed", () => {
    const event = taskListStreamEvent(EXPECTED);
    expect(event).toEqual({ type: "tool_use", toolName: TASK_LIST_TOOLS.claudeCode, content: JSON.stringify({ todos: EXPECTED }) });
    // The name and shape a bundle built before this change already renders —
    // an older tab against this daemon gets the list, not a raw JSON bubble.
    expect(parseTaskList(event.toolName, event.content)).toEqual(EXPECTED);
  });
});

describe("persisted: on-disk transcript → ParsedMessage", () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.CALLBOARD_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "cb-list-tracking-"));
    process.env.CALLBOARD_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CALLBOARD_DATA_DIR;
    else process.env.CALLBOARD_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("codex: the rollout's update_plan call arrives as a renderable tool_use", () => {
    // Codex writes its own rollout, and it records the plan as the real
    // `update_plan` function call rather than as the SDK's `todo_list` item —
    // with a THREE-valued status, where the live stream's `{text, completed}`
    // has only two. So the persisted list can show the step Codex is on and the
    // live one cannot. Shape taken from real rollouts under ~/.codex/sessions.
    const path = join(dataDir, "rollout-2026-06-14T17-03-58-019ec7f2-cd5d-7823-b2d1-6683c42bfe32.jsonl");
    writeFileSync(
      path,
      [
        { type: "session_meta", payload: { id: "019ec7f2-cd5d-7823-b2d1-6683c42bfe32", cwd: "/work", cli_version: "0.146.0" } },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: TASK_LIST_TOOLS.codex,
            call_id: "call_1",
            arguments: JSON.stringify({ plan: EXPECTED.map((item) => ({ step: item.content, status: item.status })) }),
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const [message] = parseCodexRollout(path);
    expect(message).toMatchObject({ role: "assistant", type: "tool_use", toolName: TASK_LIST_TOOLS.codex, toolUseId: "call_1" });
    expect(parseTaskList(message.toolName, message.content)).toEqual(EXPECTED);
  });

  it("acp: a task_list event round-trips through the callboard-owned transcript", () => {
    const writer = new AcpTranscriptWriter("opencode", "s1", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "task_list", items: EXPECTED } as never);

    const [message] = parseAcpTranscript(findAcpTranscript("s1")!.filePath);
    expect(message).toMatchObject({ role: "assistant", type: "tool_use", toolName: TASK_LIST_TOOLS.acp });
    expect(parseTaskList(message.toolName, message.content)).toEqual(EXPECTED);
  });

  it("acp: a cleared plan is stored and read back as an empty list, not as nothing", () => {
    // If a removal parsed to no message, the *previous* list would still be the
    // newest thing in the transcript and would sit on screen as the agent's
    // current plan — which is the failure `plan_removed` exists to prevent.
    const writer = new AcpTranscriptWriter("opencode", "s2", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "task_list", items: EXPECTED } as never);
    writer.writeEvent({ type: "task_list", items: [] } as never);

    const messages = parseAcpTranscript(findAcpTranscript("s2")!.filePath);
    expect(messages).toHaveLength(2);
    expect(parseTaskList(messages[1].toolName, messages[1].content)).toEqual([]);
  });

  it("acp: each plan gets its own call id, so it cannot swallow the next tool's result", () => {
    // No tool ran, so there is no real call id. Without a synthetic one the
    // frontend's tool grouping falls back to trusting adjacency and pairs the
    // plan with whatever result follows it — consuming a real tool's output.
    const writer = new AcpTranscriptWriter("opencode", "s3", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "task_list", items: EXPECTED } as never);
    writer.writeEvent({ type: "task_list", items: [] } as never);
    writer.writeEvent({ type: "tool_result", callId: "c1", content: "not the plan's" } as never);

    const messages = parseAcpTranscript(findAcpTranscript("s3")!.filePath);
    const ids = messages.filter((m) => m.type === "tool_use").map((m) => m.toolUseId);
    expect(ids).toEqual([`${TASK_LIST_TOOLS.acp}-0`, `${TASK_LIST_TOOLS.acp}-1`]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
