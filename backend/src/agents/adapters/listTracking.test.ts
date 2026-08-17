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
import { translateClineEvent } from "./cline/messageAdapter.js";
import { translatePiEvent } from "./pi/messageAdapter.js";
import { AcpToolCallBuffer, translateAcpUpdate } from "./acp/messageAdapter.js";
import { AcpTranscriptWriter } from "./acp/transcript.js";
import { findAcpTranscript, parseAcpTranscript, planCallId } from "./acp/sessionParser.js";
import { BASE_CLIENT_CAPABILITIES } from "./acp/AcpAgentClient.js";
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

  it("cline and pi: no task list is invented for an engine that has none", () => {
    // Neither SDK has a per-response list concept — Cline's plan-ish surface is
    // a Plan/Act *mode* setting and a checkpoint-diff planner, and pi has
    // nothing. So the callboard-side rule is that their tool calls stay tool
    // calls, even when one is named plan-ishly and carries list-shaped
    // arguments. Anything else would mean callboard guessing at a list.
    //
    // This replaces an assertion on the two SDKs' exported symbol names, which
    // tested a third-party surface: it passed with this feature deleted and
    // broke on any unrelated release adding a matching export.
    const listShaped = { entries: EXPECTED.map((item) => ({ content: item.content, status: item.status })) };

    const cline = translateClineEvent({ type: "content_start", contentType: "tool", toolName: "plan_mode_respond", toolCallId: "c1", input: listShaped } as never);
    expect(cline).toMatchObject({ type: "tool_use", toolName: "plan_mode_respond" });

    const [pi] = translatePiEvent({ type: "tool_execution_start", toolCallId: "p1", toolName: "update_todos", args: listShaped } as never);
    expect(pi).toMatchObject({ type: "tool_use", toolName: "update_todos" });

    for (const event of [cline, pi]) {
      const call = event as Extract<AgentEvent, { type: "tool_use" }>;
      expect(parseTaskList(call.toolName, JSON.stringify(call.input))).toBeNull();
    }
  });
});

describe("the ACP plan capability is a prerequisite, not a toggle", () => {
  it("stays unadvertised while acp/messageAdapter.ts discards planId", () => {
    // Not a style rule — a tripwire, and the reason it is a test rather than a
    // comment. `plan_update` / `plan_removed` are gated on this capability and
    // are keyed by `planId`; `translatePlan` tracks none, rendering every update
    // as the whole list and every removal as "cleared". So two concurrent plans
    // would flip-flop over each other and removing one would blank the other.
    //
    // That bug is unreachable today only because of this line. Adding `plan: {}`
    // would ship it the same day with every other test still green, because no
    // other test in the suite exercises a path an agent can currently reach.
    //
    // If you are here because this failed: build the planId registry in
    // `translatePlan` FIRST, then change this assertion to match.
    expect(BASE_CLIENT_CAPABILITIES.plan ?? null).toBeNull();
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

  it("acp: each plan gets a distinct call id in callboard's reserved namespace", () => {
    // No tool ran, so there is no real call id. Without a synthetic one the
    // frontend's tool grouping falls back to trusting adjacency and pairs the
    // plan with whatever result follows it — consuming a real tool's output.
    //
    // This test asserts only what the parser mints. That the ids then *do*
    // protect the next tool's result is a property of the grouping, and it is
    // asserted where the grouping lives: `frontend/src/utils/toolGrouping.test.ts`.
    // It used to be claimed in this test's name and checked nowhere.
    const writer = new AcpTranscriptWriter("opencode", "s3", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "task_list", items: EXPECTED } as never);
    writer.writeEvent({ type: "task_list", items: [] } as never);
    writer.writeEvent({ type: "tool_result", callId: "c1", content: "not the plan's" } as never);

    const messages = parseAcpTranscript(findAcpTranscript("s3")!.filePath);
    const ids = messages.filter((m) => m.type === "tool_use").map((m) => m.toolUseId);
    expect(ids).toEqual([planCallId(0), planCallId(1)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("acp: an agent that picks callboard's own id shape is evicted from the namespace", () => {
    // ACP's ToolCallId is agent-chosen and callboard writes it through verbatim,
    // so a reserved prefix only reserves anything if ids coming the other way
    // are pushed out of it. Both halves of the pair must move together, or the
    // eviction breaks the tool's own result matching instead.
    const forged = planCallId(0);
    const writer = new AcpTranscriptWriter("opencode", "s4", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "task_list", items: EXPECTED } as never);
    writer.writeEvent({ type: "tool_use", toolName: "make_a_plan", callId: forged, input: {} } as never);
    writer.writeEvent({ type: "tool_result", callId: forged, content: "the agent's own output" } as never);

    const messages = parseAcpTranscript(findAcpTranscript("s4")!.filePath);
    const [planMessage, agentCall] = messages.filter((m) => m.type === "tool_use");
    const [agentResult] = messages.filter((m) => m.type === "tool_result");

    expect(planMessage.toolUseId).toBe(planCallId(0));
    expect(agentCall.toolUseId).not.toBe(planMessage.toolUseId);
    // Still paired with each other, just outside the namespace callboard owns.
    expect(agentResult.toolUseId).toBe(agentCall.toolUseId);
  });
});
