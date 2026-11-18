/**
 * Tool pairing: by id first, adjacency only for histories that predate ids, and
 * never a guess when ids are ambiguous.
 *
 * (The retired ACP harness's synthetic `plan` snapshots were once excluded from
 * pairing here; with the harness gone a tool named `plan` pairs like any other.)
 */
import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../api";
import { groupToolMessages, type ToolGroup } from "./toolGrouping";

const toolUse = (toolUseId: string, toolName = "Bash"): ParsedMessage =>
  ({ role: "assistant", type: "tool_use", toolName, toolUseId, content: JSON.stringify({ command: "ls" }) }) as ParsedMessage;

const toolResult = (toolUseId: string, content: string): ParsedMessage => ({ role: "user", type: "tool_result", toolUseId, content }) as ParsedMessage;

const groups = (items: ReturnType<typeof groupToolMessages>): ToolGroup[] => items.filter((item): item is ToolGroup => item.kind === "tool_group");

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

describe("stable IDs across mixed and replayed histories", () => {
  const text = { role: "assistant", type: "text", content: "intervening text" } as ParsedMessage;
  const gap = Array.from({ length: 30 }, () => text);

  it.each([false, true])("pairs distant results, reversed=%s, exactly once", (reversed) => {
    const calls = [toolUse("image", "render_file"), toolUse("canvas-1", "create_canvas"), toolUse("canvas-2", "update_canvas")];
    const results = [toolResult("canvas-2", "v2"), toolResult("image", "png"), toolResult("canvas-1", "v1")];
    const messages = reversed ? [...results, ...gap, ...calls] : [...calls, ...gap, ...results];
    const items = groupToolMessages(messages);
    expect(groups(items).map((g) => g.toolResult?.content)).toEqual(["png", "v1", "v2"]);
    expect(items.filter((i) => i.kind === "single")).toHaveLength(gap.length);
    const indices = items.flatMap((i) => (i.kind === "single" ? [i.originalIndex] : i.originalIndices.filter((n) => n !== null)));
    expect(indices.sort((a, b) => a - b)).toEqual(messages.map((_, i) => i));
    for (const group of groups(items)) expect(group.toolResult).toBe(messages[group.originalIndices[1]!]);
  });

  it.each([
    [toolUse("same"), toolResult("same", "one"), toolUse("same"), toolResult("same", "two")],
    [toolUse("same"), toolResult("same", "one"), toolResult("same", "one")],
    [toolUse("same"), toolUse("same"), toolResult("same", "one")],
    [toolResult("same", "one"), toolUse("same"), toolUse("same")],
    [toolUse("same"), toolResult("", "idless"), toolUse("same")],
    [toolUse(""), toolResult("same", "one"), toolResult("same", "two")],
  ])("does not guess or hide results with ambiguous/replayed IDs %#", (...messages) => {
    const items = groupToolMessages(messages);
    expect(groups(items).every((g) => g.toolResult === null)).toBe(true);
    expect(items.filter((i) => i.kind === "single")).toHaveLength(messages.filter((m) => m.type === "tool_result").length);
  });

  it.each([
    ["", ""],
    ["known", ""],
    ["", "known"],
  ])("retains legacy adjacency (%s, %s)", (useId, resultId) => {
    expect(groups(groupToolMessages([toolUse(useId), toolResult(resultId, "legacy")]))[0].toolResult?.content).toBe("legacy");
  });

  it.each([false, true])("reserves stable pairs before ID-less adjacency, reversed=%s", (reversed) => {
    const messages = reversed
      ? [toolUse(""), toolResult("stable", "owned"), ...gap, toolUse("stable")]
      : [toolUse("stable"), ...gap, toolUse(""), toolResult("stable", "owned")];
    const paired = groups(groupToolMessages(messages));
    expect(paired.find((g) => g.toolUse.toolUseId === "")?.toolResult).toBeNull();
    expect(paired.find((g) => g.toolUse.toolUseId === "stable")?.toolResult?.content).toBe("owned");
  });

  it("prefers a distant stable result over an adjacent ID-less result", () => {
    const messages = [toolUse("stable"), toolResult("", "not owned"), ...gap, toolResult("stable", "owned")];
    const items = groupToolMessages(messages);
    expect(groups(items)[0].toolResult?.content).toBe("owned");
    expect(items[1]).toMatchObject({ kind: "single", originalIndex: 1, message: { content: "not owned" } });
  });

  it("pairs a tool named plan like any other, by id and by legacy adjacency", () => {
    const byId = groupToolMessages([toolUse("p1", "plan"), toolResult("p1", "planned")]);
    expect(groups(byId)[0].toolResult?.content).toBe("planned");
    const idless = groupToolMessages([toolUse("", "plan"), toolResult("", "legacy output")]);
    expect(groups(idless)[0].toolResult?.content).toBe("legacy output");
  });

  it("does not use message IDs, mismatched IDs, or non-adjacent ID-less fallback", () => {
    const messages = [{ ...toolUse(""), id: "same" }, text, { ...toolResult("", "orphan"), id: "same" }, toolUse("a"), toolResult("b", "foreign")];
    expect(groups(groupToolMessages(messages)).every((g) => g.toolResult === null)).toBe(true);
  });
});
