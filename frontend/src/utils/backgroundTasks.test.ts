/**
 * Which background tasks read as still running.
 *
 * The failure this guards against is quiet in both directions: a task wrongly
 * called pending spins forever in a finished transcript, and one wrongly called
 * finished makes the longest-running call in the chat look like the fastest.
 */
import { describe, it, expect } from "vitest";
import type { ParsedMessage } from "../api";
import { pendingBackgroundTaskIds } from "./backgroundTasks";

/** The `tool_result` that launched a background task. */
const launch = (taskId: string): ParsedMessage => ({
  role: "assistant",
  type: "tool_result",
  content: `Command running in background with ID: ${taskId}.`,
  toolUseId: `toolu_${taskId}`,
  backgroundTaskId: taskId,
});

/** The system marker that later reports its outcome. */
const report = (taskId: string, status = "completed"): ParsedMessage => ({
  role: "system",
  type: "system",
  content: `Background command completed`,
  subtype: "background_task",
  backgroundTaskStatus: status,
  backgroundTaskId: taskId,
});

const text = (content: string): ParsedMessage => ({ role: "assistant", type: "text", content });

describe("pendingBackgroundTaskIds", () => {
  it("reports a launched task with no outcome as pending", () => {
    expect([...pendingBackgroundTaskIds([launch("a")])]).toEqual(["a"]);
  });

  it("clears a task once its outcome arrives", () => {
    expect(pendingBackgroundTaskIds([launch("a"), report("a")]).size).toBe(0);
  });

  it("clears a task that failed, not just one that succeeded", () => {
    // "Finished" is about having an outcome, not about the outcome being good.
    expect(pendingBackgroundTaskIds([launch("a"), report("a", "failed")]).size).toBe(0);
  });

  it("tracks several tasks independently", () => {
    const messages = [launch("a"), launch("b"), launch("c"), report("b")];
    expect([...pendingBackgroundTaskIds(messages)].sort()).toEqual(["a", "c"]);
  });

  it("pairs across unrelated conversation in between", () => {
    // The two ends are usually turns apart — a task started in one turn is
    // reported in a later one.
    const messages = [launch("a"), text("working on it"), text("still going"), report("a")];
    expect(pendingBackgroundTaskIds(messages).size).toBe(0);
  });

  it("cancels a task even when its marker precedes its launch", () => {
    // Order-independent on purpose: a transcript stitched across a resume can
    // present the two ends out of order.
    expect(pendingBackgroundTaskIds([report("a"), launch("a")]).size).toBe(0);
  });

  it("ignores messages with no task id", () => {
    expect(pendingBackgroundTaskIds([text("hello"), { role: "assistant", type: "tool_result", content: "ok", toolUseId: "t1" }]).size).toBe(0);
  });

  it("does not treat a marker alone as something pending", () => {
    // The orphan summary arrives with no launch beside it in this transcript.
    expect(pendingBackgroundTaskIds([report("ghost", "stopped")]).size).toBe(0);
  });

  it("returns nothing for an empty transcript", () => {
    expect(pendingBackgroundTaskIds([]).size).toBe(0);
  });

  it("settles every task named by a multi-task orphan notice", () => {
    // The resume-time orphan summary reports several tasks at once and names
    // no single one, so it carries only the plural field. Reading just the
    // singular one left all of them pending for the rest of the chat's life.
    const orphanSummary: ParsedMessage = {
      role: "system",
      type: "system",
      content: "2 background shell command task(s) from the previous session have no completion record.",
      subtype: "background_task",
      backgroundTaskStatus: "stopped",
      backgroundTaskIds: ["a", "b"],
    };
    expect(pendingBackgroundTaskIds([launch("a"), launch("b"), orphanSummary]).size).toBe(0);
  });

  it("leaves tasks the orphan notice did not name still pending", () => {
    const orphanSummary: ParsedMessage = {
      role: "system",
      type: "system",
      content: "1 background shell command task(s) have no completion record.",
      subtype: "background_task",
      backgroundTaskIds: ["a"],
    };
    expect([...pendingBackgroundTaskIds([launch("a"), launch("c"), orphanSummary])]).toEqual(["c"]);
  });

  it("still settles a marker parsed before the plural field existed", () => {
    // Transcripts are re-parsed on every load, but a client may hold a
    // response from an older daemon.
    const legacy: ParsedMessage = {
      role: "system",
      type: "system",
      content: "Background command completed",
      subtype: "background_task",
      backgroundTaskId: "a",
    };
    expect(pendingBackgroundTaskIds([launch("a"), legacy]).size).toBe(0);
  });
});
