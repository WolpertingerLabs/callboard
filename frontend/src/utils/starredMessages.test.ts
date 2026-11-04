import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../api";
import { isStarrable, resolveStarred, sameStarred, starKeysByIndex } from "./starredMessages";

const T1 = "2026-11-04T10:00:00.000Z";
const T2 = "2026-11-04T10:01:00.000Z";
const msg = (m: Partial<ParsedMessage>): ParsedMessage => ({ role: "assistant", type: "text", content: "x", timestamp: T1, ...m }) as ParsedMessage;

describe("isStarrable", () => {
  it("accepts user and assistant text on the main timeline", () => {
    expect(isStarrable(msg({ role: "user" }))).toBe(true);
    expect(isStarrable(msg({ role: "assistant" }))).toBe(true);
  });

  it("rejects tool calls, thinking, system rows, subagent messages and untimestamped ones", () => {
    expect(isStarrable(msg({ type: "tool_use" }))).toBe(false);
    expect(isStarrable(msg({ type: "thinking" }))).toBe(false);
    expect(isStarrable(msg({ role: "system", type: "system" }))).toBe(false);
    expect(isStarrable(msg({ teamName: "researcher" }))).toBe(false);
    expect(isStarrable(msg({ timestamp: undefined }))).toBe(false);
  });
});

describe("starKeysByIndex", () => {
  it("keys on role and timestamp, numbering blocks that share both", () => {
    const keys = starKeysByIndex([msg({ role: "user", timestamp: T1 }), msg({ timestamp: T1 }), msg({ timestamp: T1 }), msg({ timestamp: T2 })]);
    expect([...keys]).toEqual([
      [0, `user@${T1}#0`],
      [1, `assistant@${T1}#0`],
      [2, `assistant@${T1}#1`],
      [3, `assistant@${T2}#0`],
    ]);
  });

  it("is not moved by subagent or tool messages spliced in between", () => {
    // Claude Code merges subagent transcripts into the parent by timestamp, so
    // these appear and grow mid-run. The parent's keys must not shift.
    const before = starKeysByIndex([msg({ timestamp: T1 }), msg({ timestamp: T1 })]);
    const after = starKeysByIndex([
      msg({ timestamp: T1 }),
      msg({ timestamp: T1, teamName: "sub" }),
      msg({ timestamp: T1, type: "tool_use" }),
      msg({ timestamp: T1 }),
    ]);
    expect([...before.values()]).toEqual([...after.values()]);
  });
});

describe("resolveStarred", () => {
  it("returns starred messages present in the transcript, oldest first, skipping unknown keys", () => {
    const keys = starKeysByIndex([msg({ role: "user" }), msg({}), msg({ timestamp: T2 })]);
    const starred = new Set([`assistant@${T2}#0`, `user@${T1}#0`, "assistant@gone#0"]);
    expect(resolveStarred(keys, starred)).toEqual([
      { index: 0, key: `user@${T1}#0` },
      { index: 2, key: `assistant@${T2}#0` },
    ]);
  });
});

describe("sameStarred", () => {
  it("compares index and key, in order", () => {
    expect(sameStarred([{ index: 1, key: "a" }], [{ index: 1, key: "a" }])).toBe(true);
    expect(sameStarred([{ index: 1, key: "a" }], [{ index: 2, key: "a" }])).toBe(false);
    expect(sameStarred([{ index: 1, key: "a" }], [])).toBe(false);
  });
});
