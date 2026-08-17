/**
 * Tool pairing, and specifically the property the ACP plan's synthetic call id
 * exists to protect: a plan snapshot must not capture the next real tool's
 * result.
 *
 * That claim was previously asserted only as "the two plans have different ids",
 * which is a fact about `sessionParser` and not about what happens to the tool
 * standing behind them. It would have held with the pairing completely broken.
 * So the assertions here are on the pairing itself, with the plan messages built
 * the way the parser actually mints them.
 *
 * @see backend/src/agents/adapters/acp/sessionParser.ts (where plan ids come from)
 */
import { describe, expect, it } from "vitest";
import { TASK_LIST_TOOLS } from "shared/types/index.js";
import type { ParsedMessage } from "../api";
import { groupToolMessages, type ToolGroup } from "./toolGrouping";

/** The reserved namespace `acp/sessionParser.ts` mints plan ids in. */
const planId = (n: number) => `\u0000callboard:${TASK_LIST_TOOLS.acp}-${n}`;

const plan = (n: number): ParsedMessage =>
  ({
    role: "assistant",
    type: "tool_use",
    toolName: TASK_LIST_TOOLS.acp,
    toolUseId: planId(n),
    content: JSON.stringify({ entries: [{ content: "Ship it", priority: "high", status: "in_progress" }] }),
  }) as ParsedMessage;

const toolUse = (toolUseId: string, toolName = "Bash"): ParsedMessage =>
  ({ role: "assistant", type: "tool_use", toolName, toolUseId, content: JSON.stringify({ command: "ls" }) }) as ParsedMessage;

const toolResult = (toolUseId: string, content: string): ParsedMessage => ({ role: "user", type: "tool_result", toolUseId, content }) as ParsedMessage;

const groups = (items: ReturnType<typeof groupToolMessages>): ToolGroup[] => items.filter((item): item is ToolGroup => item.kind === "tool_group");

describe("a plan snapshot cannot swallow a real tool's result", () => {
  it("the result goes to the tool that ran, not to the plan sitting in front of it", () => {
    // The transcript shape a plan-then-work turn produces: ACP sends the plan as
    // a session update (no tool ran), the agent then calls a tool, and the
    // tool's result arrives after. Nothing pairs the plan with anything.
    const items = groupToolMessages([plan(0), toolUse("c1"), toolResult("c1", "the real output")]);

    const [planGroup, bashGroup] = groups(items);
    expect(planGroup.toolUse.toolName).toBe(TASK_LIST_TOOLS.acp);
    expect(planGroup.toolResult).toBeNull();
    expect(bashGroup.toolUse.toolUseId).toBe("c1");
    expect(bashGroup.toolResult?.content).toBe("the real output");
  });

  it("a plan immediately followed by a foreign result leaves that result unclaimed", () => {
    // This is the case the synthetic id buys. With no id on the plan, the
    // adjacency fallback fires and the plan takes the result — and because the
    // checklist renders without ever reading `toolResult`, the output would not
    // be misplaced, it would be gone.
    const items = groupToolMessages([plan(0), toolResult("c1", "belongs to something else")]);

    const [planGroup] = groups(items);
    expect(planGroup.toolResult).toBeNull();
    expect(items.some((item) => item.kind === "single" && item.message.content === "belongs to something else")).toBe(true);
  });

  it("consecutive plans stay separate rather than collapsing into one", () => {
    // Two snapshots in a row is the normal case — a plan and its first update.
    const items = groupToolMessages([plan(0), plan(1), toolUse("c1"), toolResult("c1", "the real output")]);

    const paired = groups(items);
    expect(paired.map((g) => g.toolUse.toolUseId)).toEqual([planId(0), planId(1), "c1"]);
    expect(paired.filter((g) => g.toolResult !== null)).toHaveLength(1);
  });

  it("an agent tool that names itself plan-0 keeps its own result", () => {
    // The collision the reserved namespace rules out: ACP's ToolCallId is
    // agent-chosen, so `plan-0` is a name an agent can genuinely pick. Its
    // result must reach it and not the checklist above it.
    const items = groupToolMessages([plan(0), toolUse("plan-0", "make_a_plan"), toolResult("plan-0", "the agent's own output")]);

    const [planGroup, agentGroup] = groups(items);
    expect(planGroup.toolResult).toBeNull();
    expect(agentGroup.toolUse.toolName).toBe("make_a_plan");
    expect(agentGroup.toolResult?.content).toBe("the agent's own output");
  });
});

describe("ordinary tool pairing", () => {
  it("matches by id across intervening messages rather than by position", () => {
    const items = groupToolMessages([toolUse("c1"), toolUse("c2"), toolResult("c2", "second"), toolResult("c1", "first")]);

    const paired = groups(items);
    expect(paired.map((g) => [g.toolUse.toolUseId, g.toolResult?.content])).toEqual([
      ["c1", "first"],
      ["c2", "second"],
    ]);
  });

  it("falls back to adjacency only when an id is missing, for transcripts predating ids", () => {
    const idless = { role: "assistant", type: "tool_use", toolName: "Bash", content: "{}" } as ParsedMessage;
    const [group] = groups(groupToolMessages([idless, toolResult("", "legacy output")]));
    expect(group.toolResult?.content).toBe("legacy output");
  });
});
