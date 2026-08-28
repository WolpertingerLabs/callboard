/**
 * Unit tests for optimistic user-message reconciliation.
 *
 * The behaviour these protect: every message the user sends stays on screen
 * continuously — first as an optimistic bubble, then as the persisted
 * transcript entry — with no gap where it vanishes and no window where it is
 * rendered twice. Sending again mid-run is the case that used to break both.
 */
import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../api";
import { endsWithInterruptMarker, nextInFlightKey, settleInFlight, toInFlightList, visibleInFlight, type InFlightMessage } from "./inFlightMessages";

const pending = (...texts: string[]): InFlightMessage[] => texts.map((text) => ({ key: nextInFlightKey(), text, imageUrls: [] }));
const user = (content: string): ParsedMessage => ({ role: "user", type: "text", content });
/** A user turn the parser projected from a slash-command envelope. */
const command = (content: string): ParsedMessage => ({ role: "user", type: "text", content, isBuiltInCommand: true });
const assistant = (content: string): ParsedMessage => ({ role: "assistant", type: "text", content });
const system = (content: string, subtype?: string): ParsedMessage => ({ role: "system", type: "system", content, ...(subtype && { subtype }) });

describe("visibleInFlight", () => {
  it("keeps a message the transcript has not caught up with", () => {
    expect(visibleInFlight(pending("hello"), []).map((m) => m.text)).toEqual(["hello"]);
  });

  it("hides a message once the transcript shows it", () => {
    expect(visibleInFlight(pending("hello"), [user("hello"), assistant("hi")])).toEqual([]);
  });

  it("keeps the second of two rapid sends while only the first has persisted", () => {
    // The case that made a just-sent message disappear: one run's refetch
    // lands while the message that superseded it is still in flight.
    const visible = visibleInFlight(pending("first", "second"), [user("first"), assistant("partial")]);
    expect(visible.map((m) => m.text)).toEqual(["second"]);
  });

  it("hides both once both have persisted", () => {
    expect(visibleInFlight(pending("first", "second"), [user("first"), system("Interrupted by user"), user("second")])).toEqual([]);
  });

  it("still shows a message the user re-sent after an identical earlier one", () => {
    // Only the trailing user messages count, so the old copy can't stand in
    // for the new send.
    const messages = [user("run it"), assistant("done"), user("something else"), assistant("ok")];
    expect(visibleInFlight(pending("run it"), messages).map((m) => m.text)).toEqual(["run it"]);
  });

  it("ignores leading/trailing whitespace differences", () => {
    expect(visibleInFlight(pending("  hello  "), [user("hello")])).toEqual([]);
  });

  it("hides a slash command the transcript reassembled with different spacing", () => {
    // The harness records a command as name + arguments, so the transcript
    // spells it with single spaces however the user typed it. Matching
    // strictly stranded the bubble under a transcript already answering it.
    expect(visibleInFlight(pending("/skill   some   stuff"), [command("/skill some stuff")])).toEqual([]);
  });

  it("keeps a message that differs from the transcript's only by internal whitespace", () => {
    // The command leniency must not reach ordinary prose. Two sends differing
    // by a line break are two messages, and reading them as one takes the
    // second off screen for the rest of the running turn.
    const visible = visibleInFlight(pending("fix the bug in parser.ts"), [user("fix the bug\nin parser.ts")]);
    expect(visible.map((m) => m.text)).toEqual(["fix the bug in parser.ts"]);
  });

  it("keeps a superseding send that only resembles the persisted one", () => {
    // Both hazards at once: a second send is in flight while the first has
    // persisted, and the two differ only by a line break. The tail window is
    // wide enough to hold both, so a loose compare hides the message the user
    // sent most recently — for the rest of the running turn.
    const visible = visibleInFlight(pending("fix the bug\nin parser.ts", "fix the bug in parser.ts"), [user("earlier"), user("fix the bug\nin parser.ts")]);
    expect(visible.map((m) => m.text)).toEqual(["fix the bug in parser.ts"]);
  });

  it("does not stretch a command's spelling onto a non-command transcript entry", () => {
    // `isBuiltInCommand` is what says "the harness re-spelled this". Prose that
    // merely starts with a slash is compared literally, both ways.
    expect(visibleInFlight(pending("/not   a   command"), [user("/not a command")]).map((m) => m.text)).toEqual(["/not   a   command"]);
  });

  it("does not match against assistant or system text", () => {
    expect(visibleInFlight(pending("hello"), [assistant("hello"), system("hello")]).map((m) => m.text)).toEqual(["hello"]);
  });
});

describe("settleInFlight", () => {
  it("retires only what the fetched transcript accounts for", () => {
    const list = pending("first", "second");
    expect(settleInFlight(list, [user("first")]).map((m) => m.text)).toEqual(["second"]);
  });

  it("returns the same array when nothing settled, so React can skip the update", () => {
    const list = pending("first");
    expect(settleInFlight(list, [user("unrelated")])).toBe(list);
    expect(settleInFlight(list, [])).toBe(list);
  });

  it("keeps everything when the transcript comes back empty", () => {
    // A failed or racing refetch must not be read as "all messages landed".
    const list = pending("first", "second");
    expect(settleInFlight(list, [])).toBe(list);
  });

  it("is a no-op on an empty pending list", () => {
    const list: InFlightMessage[] = [];
    expect(settleInFlight(list, [user("x")])).toBe(list);
  });

  it("retires a slash command the transcript reassembled with different spacing", () => {
    // The new-chat path's only reconciliation point: `handleSend`'s cleanup is
    // deliberately detached at `chat_created`, so a command that fails to
    // settle here keeps its bubble for the life of the chat.
    expect(settleInFlight(pending("/skill  some stuff"), [command("/skill some stuff")])).toEqual([]);
  });

  it("keeps prose that differs from the transcript's only by internal whitespace", () => {
    // settleInFlight scans the whole transcript, not a tail window, so a
    // false match here is the widest-reaching one available: any older
    // message can swallow a send that only resembles it.
    const list = pending("fix the bug in parser.ts");
    expect(settleInFlight(list, [user("fix the bug\nin parser.ts")])).toBe(list);
  });

  it("keeps a re-sent code block whose indentation changed", () => {
    const list = pending("```\nif (x) {\n    go();\n}\n```");
    expect(settleInFlight(list, [user("```\nif (x) {\n  go();\n}\n```")])).toBe(list);
  });
});

describe("toInFlightList", () => {
  it("accepts the list form written by the current build", () => {
    expect(toInFlightList(["a", "b"]).map((m) => m.text)).toEqual(["a", "b"]);
  });

  it("accepts the bare string an older history entry may hold", () => {
    expect(toInFlightList("just one").map((m) => m.text)).toEqual(["just one"]);
  });

  it("drops empty and non-string entries", () => {
    expect(toInFlightList(["a", "", null, 7, "b"]).map((m) => m.text)).toEqual(["a", "b"]);
    expect(toInFlightList("")).toEqual([]);
    expect(toInFlightList(undefined)).toEqual([]);
    expect(toInFlightList({ nope: true })).toEqual([]);
  });

  it("assigns distinct keys", () => {
    const [a, b] = toInFlightList(["same", "same"]);
    expect(a.key).not.toBe(b.key);
  });
});

describe("endsWithInterruptMarker", () => {
  it("detects the persisted marker at the end of the transcript", () => {
    expect(endsWithInterruptMarker([user("hi"), assistant("partial"), system("Interrupted by user", "interrupted")])).toBe(true);
  });

  it("looks past other trailing boundary markers", () => {
    const messages = [assistant("partial"), system("Interrupted by user", "interrupted"), system("Conversation compacted", "compact_boundary")];
    expect(endsWithInterruptMarker(messages)).toBe(true);
  });

  it("ignores an interruption from an earlier turn", () => {
    const messages = [system("Interrupted by user", "interrupted"), user("next"), assistant("answer")];
    expect(endsWithInterruptMarker(messages)).toBe(false);
  });

  it("is false for an empty or uninterrupted transcript", () => {
    expect(endsWithInterruptMarker([])).toBe(false);
    expect(endsWithInterruptMarker([user("hi"), assistant("done")])).toBe(false);
  });
});
