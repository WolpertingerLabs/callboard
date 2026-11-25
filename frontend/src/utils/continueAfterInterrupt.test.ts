import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../api";
import { actionWithdrawnNotice, formatRideAlongBlock } from "shared/types/rideAlong.js";
import { CONTINUE_PROMPT, INTERRUPTED_NOTICE, endsWithUserStop, isContinuePrompt } from "./continueAfterInterrupt";
import { endsWithInterruptMarker } from "./inFlightMessages";

const T0 = "2026-11-25T10:00:00.000Z";
const STOPPED = "2026-11-25T10:05:00.000Z";
const LATER = "2026-11-25T10:06:00.000Z";

const user = (content: string, timestamp = T0): ParsedMessage => ({ role: "user", type: "text", content, timestamp });
const assistant = (content: string, extra: Partial<ParsedMessage> = {}): ParsedMessage => ({
  role: "assistant",
  type: "text",
  content,
  timestamp: T0,
  ...extra,
});
const system = (content: string, subtype?: string): ParsedMessage => ({ role: "system", type: "system", content, ...(subtype && { subtype }) });
/** What the parsers persist for a harness-recorded interruption — including a permission denial. */
const harnessMarker = system("Interrupted by user", "interrupted");

describe("endsWithUserStop — the persisted flag", () => {
  it("offers Continue after a reload when the chat record says the user stopped it", () => {
    // What a reload sees for Claude Code and Codex: Callboard's Stop leaves
    // nothing in the session log, so the transcript just ends mid-work.
    expect(endsWithUserStop([user("go"), assistant("partial")], STOPPED)).toBe(true);
    expect(endsWithUserStop([user("go"), assistant("partial"), harnessMarker], STOPPED)).toBe(true);
  });

  it("is withdrawn by a user prompt sent after the stop, before the cleared flag is seen", () => {
    expect(endsWithUserStop([user("go"), assistant("partial"), user("next", LATER)], STOPPED)).toBe(false);
    expect(endsWithUserStop([user("go"), assistant("partial"), user(CONTINUE_PROMPT, LATER), assistant("resumed")], STOPPED)).toBe(false);
  });

  it("ignores a malformed flag", () => {
    expect(endsWithUserStop([user("go"), assistant("partial")], "not a time")).toBe(false);
  });

  it("is false with no flag and no local notice", () => {
    expect(endsWithUserStop([], undefined)).toBe(false);
    expect(endsWithUserStop([user("hi"), assistant("done")], undefined)).toBe(false);
  });
});

describe("endsWithUserStop — the page's local notice", () => {
  it("does not offer Continue on its own: every abort appends it, not only a user's Stop", () => {
    // A job cancel, a superseded job attempt, a teardown, Send now, a newer
    // message from another tab: all end aborted, all get the notice.
    expect(endsWithUserStop([user("go"), assistant("partial"), INTERRUPTED_NOTICE], undefined)).toBe(false);
    expect(endsWithUserStop([assistant("partial"), system("1 background task was stopped", "background_task"), INTERRUPTED_NOTICE], undefined)).toBe(false);
  });

  it("does not get in the way when the user did stop it", () => {
    expect(endsWithUserStop([user("go"), assistant("partial"), INTERRUPTED_NOTICE], STOPPED)).toBe(true);
  });
});

describe("endsWithUserStop — what never offers Continue", () => {
  it("is false for the harness's marker alone — a permission denial writes the same one", () => {
    // "[Request interrupted by user for tool use]" after a Deny or a policy
    // auto-deny: "run it again" would undo the denial.
    expect(endsWithUserStop([user("go"), assistant("rm -rf", { type: "tool_use" }), harnessMarker], undefined)).toBe(false);
  });

  it("is false for a pi turn recorded as aborted, without the flag", () => {
    expect(endsWithUserStop([user("go"), assistant("partial", { stopReason: "aborted" }), harnessMarker], undefined)).toBe(false);
  });

  it("is false for other end-of-run notices", () => {
    expect(endsWithUserStop([user("hi"), assistant("done"), system("Agent reached the maximum turn limit (50).")], undefined)).toBe(false);
  });
});

describe("INTERRUPTED_NOTICE", () => {
  it("is what endsWithInterruptMarker already treats as a marker", () => {
    // The dedupe callers only ever test a freshly fetched transcript, so the
    // subtype on the local notice does not hide a notice that is needed.
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
