import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "./message.js";
import { COMPRESSION_SUMMARY_HEADINGS, findReplyPrompt, rerunnableReplies } from "./rerun.js";

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
];

describe("rerunnableReplies", () => {
  it("agrees with findReplyPrompt at every index", () => {
    const fast = rerunnableReplies(transcript);
    transcript.forEach((_, i) => expect([i, fast[i]]).toEqual([i, "index" in findReplyPrompt(transcript, i)]));
  });

  it("marks replies to a prompt, not replies to a slash command, a compaction or nothing", () => {
    const byContent = Object.fromEntries(transcript.map((msg, i) => [msg.content, rerunnableReplies(transcript)[i]]));
    expect(byContent).toMatchObject({ hello: false, a1: true, a1b: true, reviewed: false, "after boundary": false, ack: false, a3: true });
  });
});
