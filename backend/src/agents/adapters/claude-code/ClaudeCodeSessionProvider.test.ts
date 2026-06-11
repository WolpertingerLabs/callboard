/**
 * Tests for ClaudeCodeSessionProvider.forkSession against fixture JSONL
 * session logs laid down in a tmpdir.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeSessionProvider } from "./ClaudeCodeSessionProvider.js";

// The provider resolves session logs via CLAUDE_PROJECTS_DIR and
// listClaudeProjectDirs at call time. Point both at a tmpdir set in
// beforeEach via a hoisted holder (mock factories run before beforeEach).
const h = vi.hoisted(() => ({ projectsDir: "" }));

vi.mock("../../../utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/paths.js")>();
  return {
    ...actual,
    get CLAUDE_PROJECTS_DIR() {
      return h.projectsDir;
    },
    listClaudeProjectDirs: () => ["proj"],
  };
});

let TMP: string;
let PROJ_DIR: string;
const provider = new ClaudeCodeSessionProvider();

beforeEach(() => {
  TMP = join(tmpdir(), `cc-fork-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  PROJ_DIR = join(TMP, "proj");
  mkdirSync(PROJ_DIR, { recursive: true });
  h.projectsDir = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeSession(sessionId: string, lines: any[]) {
  writeFileSync(join(PROJ_DIR, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readForked(logPath: string): any[] {
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function userLine(sessionId: string, uuid: string, timestamp: string, text: string) {
  return { type: "user", message: { role: "user", content: text }, uuid, timestamp, sessionId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assistantLine(sessionId: string, uuid: string, timestamp: string, blocks: any[]) {
  return { type: "assistant", message: { role: "assistant", content: blocks }, uuid, timestamp, sessionId };
}

function toolResultLine(sessionId: string, uuid: string, timestamp: string, toolUseId: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "result" }] },
    uuid,
    timestamp,
    sessionId,
  };
}

describe("forkSession", () => {
  it("truncates at the cutoff timestamp and rewrites every line's sessionId", () => {
    writeSession("orig", [
      userLine("orig", "u1", "2026-01-01T10:00:00.000Z", "hello"),
      assistantLine("orig", "a1", "2026-01-01T10:00:05.000Z", [{ type: "text", text: "hi there" }]),
      userLine("orig", "u2", "2026-01-01T10:01:00.000Z", "follow-up"),
      assistantLine("orig", "a2", "2026-01-01T10:01:05.000Z", [{ type: "text", text: "answer" }]),
    ]);

    const forked = provider.forkSession(["orig"], "2026-01-01T10:00:05.000Z", "new-id");
    expect(forked).not.toBeNull();
    expect(forked!.logPath).toBe(join(PROJ_DIR, "new-id.jsonl"));

    const lines = readForked(forked!.logPath);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.uuid)).toEqual(["u1", "a1"]);
    expect(lines.every((l) => l.sessionId === "new-id")).toBe(true);
    // Original untouched
    expect(readForked(join(PROJ_DIR, "orig.jsonl"))).toHaveLength(4);
  });

  it("extends past the cutoff to include tool_result lines resolving dangling tool_use", () => {
    writeSession("orig", [
      userLine("orig", "u1", "2026-01-01T10:00:00.000Z", "do a thing"),
      assistantLine("orig", "a1", "2026-01-01T10:00:05.000Z", [
        { type: "text", text: "running tools" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
      ]),
      toolResultLine("orig", "r1", "2026-01-01T10:00:06.000Z", "t1"),
      toolResultLine("orig", "r2", "2026-01-01T10:00:07.000Z", "t2"),
      assistantLine("orig", "a2", "2026-01-01T10:00:10.000Z", [{ type: "text", text: "done" }]),
    ]);

    // Fork at the tool-running assistant message — both result lines ride along
    const forked = provider.forkSession(["orig"], "2026-01-01T10:00:05.000Z", "new-id");
    const lines = readForked(forked!.logPath);
    expect(lines.map((l) => l.uuid)).toEqual(["u1", "a1", "r1", "r2"]);
  });

  it("synthesizes interrupted tool_results for tool_use that never resolved", () => {
    writeSession("orig", [
      userLine("orig", "u1", "2026-01-01T10:00:00.000Z", "do a thing"),
      assistantLine("orig", "a1", "2026-01-01T10:00:05.000Z", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      // Session aborted mid-tool: no tool_result for t1
    ]);

    const forked = provider.forkSession(["orig"], "2026-01-01T10:00:05.000Z", "new-id");
    const lines = readForked(forked!.logPath);
    expect(lines).toHaveLength(3);
    const synthetic = lines[2];
    expect(synthetic.parentUuid).toBe("a1");
    expect(synthetic.message.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "[Request interrupted by user]", is_error: true },
    ]);
    expect(synthetic.sessionId).toBe("new-id");
  });

  it("returns null when no line falls at or before the cutoff", () => {
    writeSession("orig", [userLine("orig", "u1", "2026-01-01T10:00:00.000Z", "hello")]);
    expect(provider.forkSession(["orig"], "2025-12-31T00:00:00.000Z", "new-id")).toBeNull();
    expect(existsSync(join(PROJ_DIR, "new-id.jsonl"))).toBe(false);
  });

  it("returns null when the session log is missing", () => {
    expect(provider.forkSession(["missing"], "2026-01-01T10:00:00.000Z", "new-id")).toBeNull();
  });

  it("concatenates multi-session chats in order before truncating", () => {
    writeSession("s1", [
      userLine("s1", "u1", "2026-01-01T10:00:00.000Z", "first session"),
      assistantLine("s1", "a1", "2026-01-01T10:00:05.000Z", [{ type: "text", text: "reply one" }]),
    ]);
    writeSession("s2", [
      userLine("s2", "u2", "2026-01-01T11:00:00.000Z", "second session"),
      assistantLine("s2", "a2", "2026-01-01T11:00:05.000Z", [{ type: "text", text: "reply two" }]),
    ]);

    const forked = provider.forkSession(["s1", "s2"], "2026-01-01T11:00:00.000Z", "new-id");
    const lines = readForked(forked!.logPath);
    expect(lines.map((l) => l.uuid)).toEqual(["u1", "a1", "u2"]);
    expect(lines.every((l) => l.sessionId === "new-id")).toBe(true);
  });

  it("copies subagent transcripts referenced by copied lines", () => {
    const taskResultLine = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "task1", content: "agent done" }] },
      toolUseResult: { agentId: "abc123" },
      uuid: "r1",
      timestamp: "2026-01-01T10:00:10.000Z",
      sessionId: "orig",
    };
    writeSession("orig", [
      userLine("orig", "u1", "2026-01-01T10:00:00.000Z", "spawn an agent"),
      assistantLine("orig", "a1", "2026-01-01T10:00:05.000Z", [{ type: "tool_use", id: "task1", name: "Task", input: { description: "explore" } }]),
      taskResultLine,
      assistantLine("orig", "a2", "2026-01-01T10:00:15.000Z", [{ type: "text", text: "the agent found things" }]),
    ]);
    const subagentsDir = join(PROJ_DIR, "orig", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-abc123.jsonl"), JSON.stringify(userLine("orig", "su1", "2026-01-01T10:00:06.000Z", "sub work")) + "\n");

    const forked = provider.forkSession(["orig"], "2026-01-01T10:00:15.000Z", "new-id");
    expect(forked).not.toBeNull();
    const copiedSubagent = join(PROJ_DIR, "new-id", "subagents", "agent-abc123.jsonl");
    expect(existsSync(copiedSubagent)).toBe(true);
  });
});
