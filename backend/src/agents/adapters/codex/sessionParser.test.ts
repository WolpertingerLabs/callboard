/**
 * Unit tests for the Codex rollout parser — drives the well-understood line /
 * item shapes from the spike (§5) and asserts the ParsedMessage projection,
 * synthetic-lead filtering, and the filename → thread_id extraction.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractText,
  extractThreadIdFromFilename,
  parseCodexRollout,
  readCodexSessionMeta,
  readFirstUserPrompt,
} from "./sessionParser.js";

const THREAD_ID = "019ec7f2-cd5d-7823-b2d1-6683c42bfe32";

/** A representative rollout: meta, 2 synthetic leads, real turn with a tool. */
const ROLLOUT_LINES: unknown[] = [
  {
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      timestamp: "2026-06-14T17:03:58.000Z",
      cwd: "/home/cybil/project",
      originator: "codex_sdk_ts",
      cli_version: "0.139.0",
      base_instructions: { text: "you are codex" },
    },
  },
  {
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions> ..." }] },
  },
  {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context> cwd=..." }] },
  },
  {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "create hello.txt" }] },
    timestamp: "2026-06-14T17:04:00.000Z",
  },
  {
    type: "response_item",
    payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }] },
  },
  {
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "*** add hello.txt" },
  },
  {
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "call_1", output: "patched" },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Created hello.txt" }],
    },
  },
];

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-parser-"));
  filePath = join(dir, `rollout-2026-06-14T17-03-58-${THREAD_ID}.jsonl`);
  writeFileSync(filePath, ROLLOUT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("extractThreadIdFromFilename", () => {
  it("pulls the trailing UUID past the ISO timestamp", () => {
    expect(extractThreadIdFromFilename(`rollout-2026-06-14T17-03-58-${THREAD_ID}.jsonl`)).toBe(THREAD_ID);
  });
  it("rejects non-rollout filenames", () => {
    expect(extractThreadIdFromFilename("state.json")).toBeNull();
    expect(extractThreadIdFromFilename(`rollout-${THREAD_ID}.txt`)).toBeNull();
    expect(extractThreadIdFromFilename("rollout-2026-06-14T17-03-58-not-a-uuid.jsonl")).toBeNull();
  });
});

describe("readCodexSessionMeta", () => {
  it("reads id / cwd / timestamp / cli_version from the meta line", () => {
    const meta = readCodexSessionMeta(filePath);
    expect(meta).toEqual({
      id: THREAD_ID,
      cwd: "/home/cybil/project",
      timestamp: "2026-06-14T17:03:58.000Z",
      cliVersion: "0.139.0",
    });
  });
  it("returns null for a missing file", () => {
    expect(readCodexSessionMeta(join(dir, "nope.jsonl"))).toBeNull();
  });
});

describe("parseCodexRollout", () => {
  it("projects the rollout into ParsedMessage[], filtering the synthetic leads", () => {
    const messages = parseCodexRollout(filePath);
    expect(messages).toEqual([
      { role: "user", type: "text", content: "create hello.txt", timestamp: "2026-06-14T17:04:00.000Z" },
      { role: "assistant", type: "thinking", content: "thinking about it" },
      { role: "assistant", type: "tool_use", toolName: "apply_patch", content: "*** add hello.txt", toolUseId: "call_1" },
      { role: "user", type: "tool_result", content: "patched", toolUseId: "call_1" },
      { role: "assistant", type: "text", content: "Created hello.txt" },
    ]);
  });

  it("maps function_call/function_call_output the same as custom_tool_call", () => {
    const fn = [
      { type: "response_item", payload: { type: "function_call", call_id: "c2", name: "Bash", arguments: '{"cmd":"ls"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "file.txt" } },
    ];
    const p = join(dir, `rollout-2026-06-14T18-00-00-${THREAD_ID}.jsonl`);
    writeFileSync(p, fn.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
    expect(parseCodexRollout(p)).toEqual([
      { role: "assistant", type: "tool_use", toolName: "Bash", content: '{"cmd":"ls"}', toolUseId: "c2" },
      { role: "user", type: "tool_result", content: "file.txt", toolUseId: "c2" },
    ]);
  });

  it("returns [] for a missing file and skips torn lines", () => {
    expect(parseCodexRollout(join(dir, "missing.jsonl"))).toEqual([]);
    const p = join(dir, `rollout-2026-06-14T19-00-00-${THREAD_ID}.jsonl`);
    writeFileSync(p, '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n{not json', "utf-8");
    expect(parseCodexRollout(p)).toEqual([{ role: "user", type: "text", content: "hi" }]);
  });
});

describe("readFirstUserPrompt", () => {
  it("returns the first real user message, skipping environment_context", () => {
    expect(readFirstUserPrompt(filePath)).toBe("create hello.txt");
  });
  it("returns null when there is no real user message", () => {
    const p = join(dir, `rollout-2026-06-14T20-00-00-${THREAD_ID}.jsonl`);
    writeFileSync(
      p,
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "hi" } }),
      "utf-8",
    );
    expect(readFirstUserPrompt(p)).toBeNull();
  });
});

describe("extractText", () => {
  it("handles strings, block arrays, objects, and null", () => {
    expect(extractText("plain")).toBe("plain");
    expect(extractText([{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }])).toBe("a\nb");
    expect(extractText([{ type: "image" }])).toBe("[image]");
    expect(extractText({ text: "obj" })).toBe("obj");
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });
});
