import { describe, expect, it } from "vitest";
import { COMPRESSION_SUMMARY_HEADINGS, type ParsedMessage } from "shared/types/index.js";
import { isRerunPrompt, planRerun } from "./chat-rerun.js";

const t = (s: number, ms = 0) => new Date(Date.UTC(2026, 0, 1, 10, 0, s, ms)).toISOString();
const msg = (m: Partial<ParsedMessage> & Pick<ParsedMessage, "role" | "type">): ParsedMessage => ({ content: "", ...m });

const history: ParsedMessage[] = [
  msg({ role: "user", type: "text", content: "q1", timestamp: t(0) }),
  msg({ role: "assistant", type: "text", content: "a1", timestamp: t(1) }),
  msg({ role: "user", type: "text", content: "q2", timestamp: t(10) }),
  msg({ role: "assistant", type: "tool_use", content: "{}", toolName: "Bash", timestamp: t(11) }),
  msg({ role: "assistant", type: "tool_result", content: "ok", timestamp: t(12) }),
  msg({ role: "assistant", type: "text", content: "a2", timestamp: t(13) }),
];

describe("planRerun", () => {
  it("reruns a user prompt from strictly before it", () => {
    const plan = planRerun(history, t(10));
    expect(plan).toMatchObject({ ok: true, promptAt: t(10), text: "q2", imageIds: [], keepThrough: t(9, 999), hasHistory: true, markerAt: t(1) });
  });

  it("resolves an assistant message to the user prompt it answers, past tool use and results", () => {
    expect(planRerun(history, t(13), "assistant")).toMatchObject({ ok: true, promptAt: t(10), text: "q2", keepThrough: t(9, 999), markerAt: t(1) });
  });

  it("keeps the marker on the last text message but the cutoff just before the prompt", () => {
    // Tool traffic between the last reply and the prompt: N keeps it, so the
    // cutoff (stars, children, callbacks) is past the marker.
    const withTools = [...history.slice(0, 2), msg({ role: "assistant", type: "tool_use", content: "{}", timestamp: t(5) }), ...history.slice(2)];
    expect(planRerun(withTools, t(10))).toMatchObject({ markerAt: t(1), keepThrough: t(9, 999) });
  });

  it("reruns the opening prompt with nothing to fork", () => {
    expect(planRerun(history, t(1), "assistant")).toMatchObject({ ok: true, text: "q1", hasHistory: false, keepThrough: t(-1, 999), markerAt: t(-1, 999) });
  });

  it("joins every text block of a multi-block prompt and takes the images from whichever carries them", () => {
    const multi = [
      msg({ role: "assistant", type: "text", content: "hello", timestamp: t(0) }),
      msg({ role: "user", type: "text", content: "look at this", timestamp: t(5) }),
      msg({ role: "user", type: "text", content: "<attached file>", timestamp: t(5), imageIds: ["img-a", "img-b"] }),
      msg({ role: "assistant", type: "text", content: "nice", timestamp: t(6) }),
    ];
    const expected = { ok: true, promptAt: t(5), text: "look at this\n\n<attached file>", imageIds: ["img-a", "img-b"] };
    expect(planRerun(multi, t(6), "assistant")).toMatchObject(expected);
    // Picking either block gives the whole turn.
    expect(planRerun(multi, t(5), "user")).toMatchObject(expected);
  });

  it("reruns an images-only prompt", () => {
    const only = [msg({ role: "user", type: "text", content: "", timestamp: t(0), imageIds: ["img"] })];
    expect(planRerun(only, t(0))).toMatchObject({ ok: true, text: "", imageIds: ["img"] });
  });

  it("refuses a timestamp with no message, and an assistant message with no prompt before it", () => {
    expect(planRerun(history, t(30))).toMatchObject({ ok: false });
    expect(planRerun(history, "not a date")).toMatchObject({ ok: false });
    expect(planRerun([msg({ role: "assistant", type: "text", content: "hi", timestamp: t(0) })], t(0))).toMatchObject({ ok: false });
  });

  describe("compaction summaries", () => {
    const compacted = (summary: ParsedMessage): ParsedMessage[] => [
      msg({ role: "user", type: "text", content: "q0", timestamp: t(0) }),
      msg({ role: "system", type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: t(4) }),
      summary,
      msg({ role: "assistant", type: "text", content: "got it", timestamp: t(5) }),
      msg({ role: "user", type: "text", content: "q1", timestamp: t(6) }),
      msg({ role: "assistant", type: "text", content: "a1", timestamp: t(7) }),
    ];
    const cli = msg({
      role: "user",
      type: "text",
      content: "This session is being continued from a previous conversation…",
      isCompactSummary: true,
      timestamp: t(4),
    });
    const seeded = msg({ role: "user", type: "text", content: `${COMPRESSION_SUMMARY_HEADINGS.before}\nbody`, timestamp: t(4) });

    it.each([
      ["a CLI /compact summary", cli],
      ["a seeded compression summary", seeded],
    ])("%s is not a prompt, and a reply to it does not walk past it", (_label, summary) => {
      const messages = compacted(summary);
      expect(planRerun(messages, t(4), "user")).toMatchObject({ ok: false });
      expect(planRerun(messages, t(5), "assistant")).toMatchObject({ ok: false, error: expect.stringMatching(/compaction/) });
      // A prompt after the summary still reruns.
      expect(planRerun(messages, t(7), "assistant")).toMatchObject({ ok: true, text: "q1" });
    });

    it("a compact boundary stops the walk even with no summary bubble", () => {
      const messages = compacted(cli).filter((m) => !m.isCompactSummary);
      expect(planRerun(messages, t(5), "assistant")).toMatchObject({ ok: false, error: expect.stringMatching(/compaction/) });
    });
  });

  it("refuses a slash command, and a reply to one rather than walking past it", () => {
    const messages = [
      msg({ role: "user", type: "text", content: "q0", timestamp: t(0) }),
      msg({ role: "user", type: "text", content: "/review", isBuiltInCommand: true, timestamp: t(2) }),
      msg({ role: "assistant", type: "text", content: "reviewed", timestamp: t(3) }),
    ];
    expect(planRerun(messages, t(2), "user")).toMatchObject({ ok: false });
    expect(planRerun(messages, t(3), "assistant")).toMatchObject({ ok: false });
  });

  it("honours the role when a user and an assistant message share a timestamp", () => {
    const shared = [
      msg({ role: "user", type: "text", content: "q", timestamp: t(0) }),
      msg({ role: "assistant", type: "text", content: "a", timestamp: t(0) }),
    ];
    expect(planRerun(shared, t(0), "user")).toMatchObject({ ok: true, text: "q" });
    // Picked as the assistant, it walks back to the prompt sharing its timestamp.
    expect(planRerun(shared, t(0), "assistant")).toMatchObject({ ok: true, text: "q" });
  });
});

describe("isRerunPrompt", () => {
  it("is a user text turn the user typed, with something to send", () => {
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "x", timestamp: t(0) }))).toBe(true);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "", imageIds: ["img"], timestamp: t(0) }))).toBe(true);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "  ", timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "tool_result", content: "x", timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "x", teamName: "t", timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "x" }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "/clear", isBuiltInCommand: true, timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: "s", isCompactSummary: true, timestamp: t(0) }))).toBe(false);
    expect(isRerunPrompt(msg({ role: "user", type: "text", content: `${COMPRESSION_SUMMARY_HEADINGS.after}\nx`, timestamp: t(0) }))).toBe(false);
  });
});
