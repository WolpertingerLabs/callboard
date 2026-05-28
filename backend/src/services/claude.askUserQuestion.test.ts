/**
 * Unit tests for buildOnAskUserQuestion() — the host handler that bridges the
 * OpenRouter library's ask_user_question tool to callboard's existing question
 * flow (user_question event + pending request resolved via respondToPermission).
 *
 * Exercises:
 *   1. Emits a Claude-shaped user_question event wrapping the single OR question.
 *   2. A selected option label maps back to the library's option id.
 *   3. A free-text / "Other" answer (no label match) returns freeTextAnswer.
 *   4. Deny and abort resolve with an answerless response (no hang).
 */
import { EventEmitter } from "events";
import { afterEach, describe, expect, it } from "vitest";

import type { StreamEvent } from "shared/types/index.js";
import { buildOnAskUserQuestion, respondToPermission, hasPendingRequest, stopSession } from "./claude.js";

const REQ = {
  questionId: "q-1",
  question: "Pick a language",
  options: [
    { id: "a", label: "Python" },
    { id: "b", label: "TypeScript" },
  ],
};

function setup(trackingId: string, signal: AbortSignal = new AbortController().signal) {
  const emitter = new EventEmitter();
  const events: StreamEvent[] = [];
  emitter.on("event", (e: StreamEvent) => events.push(e));
  const handler = buildOnAskUserQuestion(emitter, () => trackingId, signal);
  return { emitter, events, handler };
}

afterEach(() => {
  // Clean up any pending registrations parked under the test tracking ids.
  for (const id of ["t-emit", "t-select", "t-free", "t-deny", "t-abort"]) stopSession(id);
});

describe("buildOnAskUserQuestion", () => {
  it("emits a user_question event wrapping the single question", () => {
    const { events, handler } = setup("t-emit");
    void handler(REQ);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user_question");
    const questions = (events[0] as unknown as { questions: any[] }).questions;
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe("Pick a language");
    expect(questions[0].multiSelect).toBe(false);
    expect(questions[0].options.map((o: any) => o.label)).toEqual(["Python", "TypeScript"]);
    expect(hasPendingRequest("t-emit")).toBe(true);
  });

  it("maps a selected option label back to its option id", async () => {
    const { handler } = setup("t-select");
    const p = handler(REQ);
    respondToPermission("t-select", true, { answers: { "Pick a language": "TypeScript" } });
    await expect(p).resolves.toEqual({ questionId: "q-1", selectedOptionId: "b" });
  });

  it("returns freeTextAnswer when the answer matches no option label", async () => {
    const { handler } = setup("t-free");
    const p = handler({ ...REQ, allowFreeText: true });
    respondToPermission("t-free", true, { answers: { "Pick a language": "Rust" } });
    await expect(p).resolves.toEqual({ questionId: "q-1", freeTextAnswer: "Rust" });
  });

  it("resolves answerlessly on deny", async () => {
    const { handler } = setup("t-deny");
    const p = handler(REQ);
    respondToPermission("t-deny", false);
    await expect(p).resolves.toEqual({ questionId: "q-1" });
  });

  it("resolves answerlessly on abort (no hang)", async () => {
    const controller = new AbortController();
    const { handler } = setup("t-abort", controller.signal);
    const p = handler(REQ);
    controller.abort();
    await expect(p).resolves.toEqual({ questionId: "q-1" });
  });
});
