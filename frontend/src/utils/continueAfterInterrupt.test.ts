import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../api";
import { actionWithdrawnNotice, formatRideAlongBlock } from "shared/types/rideAlong.js";
import { INTERRUPTED_NOTICE } from "../hooks/useStopController";
import { CONTINUE_PROMPT, endsWithInterruption, isContinuePrompt } from "./continueAfterInterrupt";
import { endsWithInterruptMarker } from "./inFlightMessages";

const user = (content: string): ParsedMessage => ({ role: "user", type: "text", content });
const assistant = (content: string, extra: Partial<ParsedMessage> = {}): ParsedMessage => ({ role: "assistant", type: "text", content, ...extra });
const system = (content: string, subtype?: string): ParsedMessage => ({ role: "system", type: "system", content, ...(subtype && { subtype }) });
const harnessMarker = system("Interrupted by user", "interrupted");

describe("endsWithInterruption", () => {
  it("is true for the harness's persisted marker at the end", () => {
    expect(endsWithInterruption([user("go"), assistant("partial"), harnessMarker])).toBe(true);
  });

  it("is true for the page's local notice when the harness wrote none", () => {
    expect(endsWithInterruption([user("go"), assistant("partial"), INTERRUPTED_NOTICE])).toBe(true);
  });

  it("looks past other trailing system rows (an abandoned-task marker, a compaction)", () => {
    const messages = [assistant("partial"), INTERRUPTED_NOTICE, system("1 background task was stopped", "background_task"), system("Compacted", "compact_boundary")];
    expect(endsWithInterruption(messages)).toBe(true);
  });

  it("is true for a last message pi recorded as aborted", () => {
    expect(endsWithInterruption([user("go"), assistant("partial", { stopReason: "aborted" })])).toBe(true);
    expect(endsWithInterruption([user("go"), assistant("partial", { stopReason: "aborted" }), system("Compacted", "compact_boundary")])).toBe(true);
  });

  it("is false once anything real follows the interruption", () => {
    expect(endsWithInterruption([harnessMarker, user("next")])).toBe(false);
    expect(endsWithInterruption([harnessMarker, user(CONTINUE_PROMPT), assistant("resumed")])).toBe(false);
    expect(endsWithInterruption([assistant("partial", { stopReason: "aborted" }), user("next")])).toBe(false);
  });

  it("is false for an uninterrupted or empty transcript", () => {
    expect(endsWithInterruption([])).toBe(false);
    expect(endsWithInterruption([user("hi"), assistant("done", { stopReason: "end_turn" })])).toBe(false);
    expect(endsWithInterruption([user("hi"), assistant("done"), system("Agent reached the maximum turn limit (50).")])).toBe(false);
  });
});

describe("INTERRUPTED_NOTICE", () => {
  it("is what endsWithInterruptMarker already treats as a marker", () => {
    // The local notice now carries the subtype; the dedupe callers only ever
    // test a freshly fetched transcript, so this does not hide a needed notice.
    expect(endsWithInterruptMarker([assistant("partial"), INTERRUPTED_NOTICE])).toBe(true);
  });
});

describe("isContinuePrompt", () => {
  it("recognises the Continue prompt as a user message", () => {
    expect(isContinuePrompt(user(CONTINUE_PROMPT))).toBe(true);
    expect(isContinuePrompt(user(`  ${CONTINUE_PROMPT}\n`))).toBe(true);
  });

  it("sees past a ride-along notice the daemon put in front of it", () => {
    const block = formatRideAlongBlock([actionWithdrawnNotice("click", "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", "stopped")]);
    expect(isContinuePrompt(user(`${block}\n\n${CONTINUE_PROMPT}`))).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isContinuePrompt(user("Please continue."))).toBe(false);
    expect(isContinuePrompt(user(`${CONTINUE_PROMPT} Also fix the tests.`))).toBe(false);
    expect(isContinuePrompt(assistant(CONTINUE_PROMPT))).toBe(false);
    expect(isContinuePrompt({ ...user(CONTINUE_PROMPT), imageIds: ["img"] })).toBe(false);
  });
});
