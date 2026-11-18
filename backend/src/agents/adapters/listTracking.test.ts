/**
 * Cross-engine task-list tracking: every engine that has a running task list
 * must get that list all the way to a `ParsedMessage` the chat UI renders.
 *
 * The per-adapter suites each prove one engine's mapping. This one is
 * deliberately a *table*, because the bug it was written for was not in any
 * single adapter: Codex's and the (since-retired) ACP harness's lists were
 * produced by the engine, translated by the adapter, and then dropped — Codex's
 * at the service layer, ACP's at the transcript parser — while Claude Code's
 * went through untouched.
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
import { translatePiEvent } from "./pi/messageAdapter.js";
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

  // Captured from the installed binary with `codex exec --json`: a todo_list
  // item arrives COMPLETE on item.started, updates once per step ticked off, and
  // repeats itself at item.completed. All three have to reach the emitter — the
  // event's whole job is to tell the browser when to refetch, so dropping the
  // first two means the plan appears only once the agent has finished working
  // through it, and a turn that plans and then reasons for two minutes shows
  // nothing at all.
  it.each(["item.started", "item.updated", "item.completed"])("codex: %s carries the todo_list to the wire, not just the last one", (type) => {
    expect(
      translateCodexEvent({
        type,
        item: {
          id: "t1",
          type: "todo_list",
          items: EXPECTED.map((item) => ({ text: item.content, completed: item.status === "completed" })),
        },
      } as never),
      // Widened: the SDK's `{text, completed}` has no in_progress to report.
    ).toEqual({ type: "task_list", items: EXPECTED_WITHOUT_IN_PROGRESS });
  });

  it("codex: partial agent text is still dropped mid-item, unlike the list", () => {
    // The rule the list is an exception to, pinned so re-emitting a snapshot is
    // not read as licence to re-emit deltas: text at item.updated would
    // double-count against the whole message arriving at item.completed. A
    // task_list is a replace-not-merge snapshot, so it has nothing to
    // double-count.
    for (const type of ["item.started", "item.updated"]) {
      expect(translateCodexEvent({ type, item: { id: "m1", type: "agent_message", text: "half a sen" } } as never)).toBeNull();
      expect(translateCodexEvent({ type, item: { id: "r1", type: "reasoning", text: "half a thou" } } as never)).toBeNull();
    }
  });

  it("pi: no task list is invented for an engine that has none", () => {
    // pi's SDK has no per-response list concept. So the callboard-side rule is
    // that its tool calls stay tool calls, even when one is named plan-ishly
    // and carries list-shaped arguments. Anything else would mean callboard guessing at a list.
    //
    // This replaces an assertion on the SDKs' exported symbol names, which
    // tested a third-party surface: it passed with this feature deleted and
    // broke on any unrelated release adding a matching export.
    const listShaped = { entries: EXPECTED.map((item) => ({ content: item.content, status: item.status })) };

    const [pi] = translatePiEvent({ type: "tool_execution_start", toolCallId: "p1", toolName: "update_todos", args: listShaped } as never);
    expect(pi).toMatchObject({ type: "tool_use", toolName: "update_todos" });

    const call = pi as Extract<AgentEvent, { type: "tool_use" }>;
    expect(parseTaskList(call.toolName, JSON.stringify(call.input))).toBeNull();
  });
});

describe("live: task_list → the wire", () => {
  it("projects onto tool_use, so no capability-gated StreamEvent type is needed", () => {
    const event = taskListStreamEvent(EXPECTED);
    expect(event).toMatchObject({ type: "tool_use", toolName: TASK_LIST_TOOLS.claudeCode });
    // The behavioural assertion, and the whole point of the projection: the name
    // and shape a bundle built before this change already renders. An older tab
    // against this daemon gets the list, not a raw JSON bubble.
    //
    // Deliberately not compared against a `JSON.stringify` literal — that pins
    // the key order of the serialized payload, which no reader depends on.
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

});
