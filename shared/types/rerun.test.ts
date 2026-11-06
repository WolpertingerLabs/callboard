import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "./message.js";
import { COMPRESSION_SUMMARY_HEADINGS, findReplyPrompt, isHandoffPreambleText, isLocalCommandText, isRerunPrompt, rerunnableReplies } from "./rerun.js";

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
const m = (x: Partial<ParsedMessage> & Pick<ParsedMessage, "role" | "type">): ParsedMessage => ({ content: "x", timestamp: t(0), ...x });

const transcript: ParsedMessage[] = [
  m({ role: "assistant", type: "text", content: "hello" }),
  m({ role: "user", type: "text", content: "q1" }),
  m({ role: "assistant", type: "tool_use" }),
  m({ role: "assistant", type: "tool_result" }),
  m({ role: "assistant", type: "text", content: "a1" }),
  m({ role: "user", type: "text", content: "teammate", teamName: "t" }),
  m({ role: "assistant", type: "text", content: "a1b" }),
  m({ role: "user", type: "text", content: "/review", isBuiltInCommand: true }),
  m({ role: "assistant", type: "text", content: "reviewed" }),
  m({ role: "user", type: "text", content: "q2" }),
  m({ role: "system", type: "system", subtype: "compact_boundary" }),
  m({ role: "assistant", type: "text", content: "after boundary" }),
  m({ role: "user", type: "text", content: `${COMPRESSION_SUMMARY_HEADINGS.before}\nsummary` }),
  m({ role: "assistant", type: "text", content: "ack" }),
  m({ role: "user", type: "text", content: "q3" }),
  m({ role: "assistant", type: "text", content: "a3" }),
  m({ role: "user", type: "text", content: "<local-command-stdout>Compacted </local-command-stdout>", isCommandOutput: true }),
  m({ role: "assistant", type: "text", content: "after stdout" }),
  m({ role: "user", type: "text", content: '<conversation_handoff from="Claude Code" to="Codex">\nbody\n</conversation_handoff>' }),
  m({ role: "assistant", type: "text", content: "Understood — handoff ack" }),
  m({ role: "user", type: "text", content: "q4" }),
  m({ role: "assistant", type: "text", content: "a4" }),
];

describe("rerunnableReplies", () => {
  it("agrees with findReplyPrompt at every index", () => {
    const fast = rerunnableReplies(transcript);
    transcript.forEach((_, i) => expect([i, fast[i]]).toEqual([i, "index" in findReplyPrompt(transcript, i)]));
  });

  it("marks replies to a prompt, not replies to a slash command, a compaction or nothing", () => {
    const byContent = Object.fromEntries(transcript.map((msg, i) => [msg.content, rerunnableReplies(transcript)[i]]));
    expect(byContent).toMatchObject({
      hello: false,
      a1: true,
      a1b: true,
      reviewed: false,
      "after boundary": false,
      ack: false,
      a3: true,
      "after stdout": false,
      "Understood — handoff ack": false,
      a4: true,
    });
  });
});

describe("rows written in the user's seat", () => {
  it("recognises a local command's output and an unprojected envelope, not prose that mentions them", () => {
    expect(isLocalCommandText("<local-command-stdout>Compacted </local-command-stdout>")).toBe(true);
    expect(isLocalCommandText("  <local-command-stderr>boom</local-command-stderr>\n")).toBe(true);
    expect(isLocalCommandText("<command-name>/x</command-name><command-args>y</command-args>")).toBe(true);
    expect(isLocalCommandText("what does <local-command-stdout> mean?")).toBe(false);
    expect(isLocalCommandText("<local-command-stdout>never closed")).toBe(false);
  });

  it("recognises the handoff preamble, not a message quoting its tag", () => {
    expect(isHandoffPreambleText('<conversation_handoff from="Codex" to="Codex">\nx\n</conversation_handoff>')).toBe(true);
    expect(isHandoffPreambleText("why is there a <conversation_handoff> tag?")).toBe(false);
  });

  it("none of them is a prompt, flagged or not", () => {
    const at = { role: "user" as const, type: "text" as const, timestamp: t(0) };
    expect(isRerunPrompt({ ...at, content: "<local-command-stdout>ok</local-command-stdout>" })).toBe(false);
    expect(isRerunPrompt({ ...at, content: "anything", isCommandOutput: true })).toBe(false);
    expect(isRerunPrompt({ ...at, content: '<conversation_handoff from="A" to="B">\n</conversation_handoff>' })).toBe(false);
    expect(isRerunPrompt({ ...at, content: "a real question" })).toBe(true);
  });
});
