import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "shared/types/index.js";
import { isRerunPrompt, planRerun } from "./chat-rerun.js";

const t = (s: number, ms = 0) => new Date(Date.UTC(2026, 0, 1, 10, 0, s, ms)).toISOString();
const msg = (m: Partial<ParsedMessage> & Pick<ParsedMessage, "role" | "type">): ParsedMessage => ({ content: "", ...m });

const history: ParsedMessage[] = [
  msg({ role: "user", type: "text", content: "q1", timestamp: t(0) }),
  msg({ role: "assistant", type: "text", content: "a1", timestamp: t(1) }),
  msg({ role: "user", type: "text", content: "q2", timestamp: t(10) }),
  msg({ role: "assistant", type: "tool_use", content: "{}", toolName: "Bash", timestamp: t(11) }),
  msg({ role: "user", type: "tool_result", content: "ok", timestamp: t(12) }),
  msg({ role: "assistant", type: "text", content: "a2", timestamp: t(13) }),
];

describe("planRerun", () => {
  it("reruns a user prompt from strictly before it", () => {
    const plan = planRerun(history, t(10));
    expect(plan).toMatchObject({ ok: true, forkCutoff: t(9, 999), supersedeAt: t(1) });
    expect(plan.ok && plan.prompt.content).toBe("q2");
  });

  it("resolves an assistant message to the user prompt it answers, past tool results", () => {
    const plan = planRerun(history, t(13), "assistant");
    expect(plan.ok && plan.prompt.content).toBe("q2");
    expect(plan).toMatchObject({ forkCutoff: t(9, 999), supersedeAt: t(1) });
  });

  it("reruns the opening prompt with nothing to fork", () => {
    const plan = planRerun(history, t(1), "assistant");
    expect(plan.ok && plan.prompt.content).toBe("q1");
    expect(plan).toMatchObject({ forkCutoff: null, supersedeAt: t(-1, 999) });
  });

  it("refuses a timestamp with no message, and an assistant message with no prompt before it", () => {
    expect(planRerun(history, t(30))).toMatchObject({ ok: false });
    expect(planRerun(history, "not a date")).toMatchObject({ ok: false });
    expect(planRerun([msg({ role: "assistant", type: "text", content: "hi", timestamp: t(0) })], t(0))).toMatchObject({ ok: false });
  });

  it("honours the role when a user and an assistant message share a timestamp", () => {
    const shared = [
      msg({ role: "user", type: "text", content: "q", timestamp: t(0) }),
      msg({ role: "assistant", type: "text", content: "a", timestamp: t(0) }),
    ];
    expect(planRerun(shared, t(0), "user")).toMatchObject({ ok: true });
    // Picked as the assistant, it walks back to the prompt sharing its timestamp.
    const plan = planRerun(shared, t(0), "assistant");
    expect(plan.ok && plan.prompt.content).toBe("q");
  });
});

describe("isRerunPrompt", () => {
  it("is a user text turn with something to send, not a team member's", () => {
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "x", timestamp: t(0) }))).toBe(true);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "", imageIds: ["img"], timestamp: t(0) }))).toBe(true);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "  ", timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "tool_result", content: "x", timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "x", teamName: "t", timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "x" }))).toBe(false);
  });
});
