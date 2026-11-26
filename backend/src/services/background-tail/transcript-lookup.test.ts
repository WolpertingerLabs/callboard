import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Every positional read: [path, position, length]. */
const reads = vi.hoisted(() => [] as [string, number, number][]);
vi.mock("fs/promises", async (orig) => {
  const real = await orig<typeof import("fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const read = fh.read.bind(fh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).read = (buf: Buffer, off: number, len: number, pos: number) => {
        reads.push([String(args[0]), pos, len]);
        return read(buf, off, len, pos);
      };
      return fh;
    },
  };
});
const logPaths = vi.hoisted(() => new Map<string, string>());
vi.mock("../../utils/session-log.js", () => ({ findSessionLogPath: (sid: string) => logPaths.get(sid) ?? null }));

const { findToolCall, clearToolCallCache } = await import("./transcript-lookup.js");

const SID = "f17cfdb7-ee9f-4481-9b84-e5e037683103";
const SID2 = "22222222-2222-4222-8222-222222222222";
const TOOL = "toolu_01CrJVo2U7FaHMT34DvqgLRP";

const useLine = (sid = SID) =>
  JSON.stringify({
    type: "assistant",
    cwd: "/home/u/proj",
    sessionId: sid,
    message: { role: "assistant", content: [{ type: "tool_use", id: TOOL, name: "Bash", input: { command: "sleep 30", run_in_background: true } }] },
  });
const resultLine = (sid = SID) =>
  JSON.stringify({
    type: "user",
    cwd: "/home/u/proj",
    sessionId: sid,
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
  reads.length = 0;
  logPaths.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("findToolCall", () => {
  it("finds the tool_use and its result by id", async () => {
    writeFileSync(log, ["{}", "not json " + TOOL, useLine(), resultLine()].join("\n") + "\n");
    expect(await findToolCall(chat(), TOOL)).toEqual({
      sessionId: SID,
      sessionIds: [SID],
      cwd: "/home/u/proj",
      toolName: "Bash",
      command: "sleep 30",
      resultText: "Command running in background with ID: b1. Output is being written to: /x.output.",
      taskId: "b1",
    });
  });

  it("reads nothing once both halves are known", async () => {
    writeFileSync(log, useLine() + "\n" + resultLine() + "\n");
    await findToolCall(chat(), TOOL);
    const n = reads.length;
    appendFileSync(log, "{}\n");
    await findToolCall(chat(), TOOL);
    expect(reads.length).toBe(n);
  });

  it("before the tool_result exists, later calls read only the new bytes", async () => {
    writeFileSync(log, "x".repeat(5000) + "\n" + useLine() + "\n");
    const first = statSync(log).size;
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ resultText: null });
    expect(reads.at(-1)).toEqual([log, 0, first]);

    appendFileSync(log, resultLine() + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ taskId: "b1" });
    expect(reads.at(-1)).toEqual([log, first, statSync(log).size - first]);
  });

  it("waits for a line to be complete", async () => {
    writeFileSync(log, useLine() + "\n" + resultLine().slice(0, 40));
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ resultText: null });
    appendFileSync(log, resultLine().slice(40) + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ taskId: "b1" });
  });

  it("rescans a log that shrank", async () => {
    writeFileSync(log, "x".repeat(5000) + "\n");
    expect(await findToolCall(chat(), TOOL)).toBeNull();
    writeFileSync(log, useLine() + "\n" + resultLine() + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ taskId: "b1" });
  });

  it("returns null for an unknown id, and does not re-read the same bytes", async () => {
    writeFileSync(log, useLine() + "\n");
    expect(await findToolCall(chat(), "toolu_nope")).toBeNull();
    const n = reads.length;
    expect(await findToolCall(chat(), "toolu_nope")).toBeNull();
    expect(reads.length).toBe(n);
  });

  it("reads text blocks out of array results", async () => {
    const arr = JSON.parse(resultLine());
    arr.message.content[0].content = [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }];
    writeFileSync(log, useLine() + "\n" + JSON.stringify(arr) + "\n");
    expect(await findToolCall(chat(), TOOL)).toMatchObject({ resultText: "a\n\nb" });
  });

  it("takes the launch from the oldest session when a transcript was carried into a newer one", async () => {
    const older = join(dir, `${SID}.jsonl`);
    const newer = join(dir, `${SID2}.jsonl`);
    writeFileSync(older, useLine(SID) + "\n" + resultLine(SID) + "\n");
    writeFileSync(newer, useLine(SID2) + "\n" + resultLine(SID2) + "\n");
    logPaths.set(SID, older);
    const c = { id: "chat-2", session_id: SID2, session_log_path: newer, metadata: JSON.stringify({ session_ids: [SID, SID2] }) };
    expect(await findToolCall(c, TOOL)).toMatchObject({ sessionId: SID, sessionIds: [SID, SID2], taskId: "b1" });
  });
});
