import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const readSpy = vi.hoisted(() => ({ count: 0 }));
vi.mock("fs/promises", async (orig) => {
  const real = await orig<typeof import("fs/promises")>();
  return {
    ...real,
    readFile: (...args: Parameters<typeof real.readFile>) => {
      readSpy.count++;
      return real.readFile(...args);
    },
  };
});
vi.mock("../../utils/session-log.js", () => ({ findSessionLogPath: () => null }));

const { findToolCall, clearToolCallCache } = await import("./transcript-lookup.js");

const SID = "f17cfdb7-ee9f-4481-9b84-e5e037683103";
const TOOL = "toolu_01CrJVo2U7FaHMT34DvqgLRP";

const useLine = JSON.stringify({
  type: "assistant",
  cwd: "/home/u/proj",
  sessionId: SID,
  message: { role: "assistant", content: [{ type: "tool_use", id: TOOL, name: "Bash", input: { command: "sleep 30", run_in_background: true } }] },
});
const resultLine = JSON.stringify({
  type: "user",
  cwd: "/home/u/proj",
  sessionId: SID,
  message: {
    role: "user",
    content: [{ tool_use_id: TOOL, type: "tool_result", content: "Command running in background with ID: b1. Output is being written to: /x.output." }],
  },
  toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "b1" },
});

let dir: string;
let log: string;
const chat = () => ({ id: "chat-1", session_id: SID, session_log_path: log, metadata: JSON.stringify({ session_ids: [SID] }) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bgtail-lookup-"));
  log = join(dir, `${SID}.jsonl`);
  clearToolCallCache();
  readSpy.count = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("findToolCall", () => {
  it("finds the tool_use and its result by id", async () => {
    writeFileSync(log, ["{}", "not json " + TOOL, useLine, resultLine].join("\n") + "\n");
    expect(await findToolCall(chat(), TOOL)).toEqual({
      sessionId: SID,
      cwd: "/home/u/proj",
      toolName: "Bash",
      command: "sleep 30",
      resultText: "Command running in background with ID: b1. Output is being written to: /x.output.",
      taskId: "b1",
    });
  });

  it("caches once both halves are written", async () => {
    writeFileSync(log, useLine + "\n" + resultLine + "\n");
    await findToolCall(chat(), TOOL);
    await findToolCall(chat(), TOOL);
    expect(readSpy.count).toBe(1);
  });

  it("does not cache before the tool_result exists", async () => {
    writeFileSync(log, useLine + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ resultText: null });
    appendFileSync(log, resultLine + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ taskId: "b1" });
    expect(readSpy.count).toBe(2);
  });

  it("returns null for an unknown id", async () => {
    writeFileSync(log, useLine + "\n");
    expect(await findToolCall(chat(), "toolu_nope")).toBeNull();
  });

  it("reads text blocks out of array results", async () => {
    const arr = JSON.parse(resultLine);
    arr.message.content[0].content = [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }];
    writeFileSync(log, useLine + "\n" + JSON.stringify(arr) + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ resultText: "a\n\nb" });
  });
});
