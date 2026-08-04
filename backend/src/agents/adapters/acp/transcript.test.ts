/**
 * Tests for the callboard-owned transcript: path safety, append semantics, and
 * the read-back projection.
 *
 * The path-safety cases matter more than they look. A session id is chosen by a
 * **remote agent process** and becomes a filename — so `../../..` in a session
 * id is an arbitrary-file-write primitive if the writer trusts it. The provider
 * id is only marginally better (it comes from settings). Both are validated as
 * opaque segments rather than sanitized, because rejecting is auditable and
 * sanitizing is a source of near-miss bugs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpTranscriptWriter, acpTranscriptPath, isSafePathSegment, resolveAcpSessionsRoot } from "./transcript.js";
import { findAcpTranscript, listAcpTranscripts, parseAcpTranscript, readAcpTranscriptCwd, readAcpTranscriptPreview } from "./sessionParser.js";

let dataDir: string;
let original: string | undefined;

beforeEach(() => {
  original = process.env.CALLBOARD_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cb-acp-transcript-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
});

afterEach(() => {
  if (original === undefined) delete process.env.CALLBOARD_DATA_DIR;
  else process.env.CALLBOARD_DATA_DIR = original;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("resolveAcpSessionsRoot", () => {
  it("reads CALLBOARD_DATA_DIR at call time, not at import time", () => {
    // The whole reason this is a function: utils/paths.ts freezes DATA_DIR at
    // import, which would send test writes to the developer's real ~/.callboard.
    expect(resolveAcpSessionsRoot()).toBe(join(dataDir, "acp-sessions"));
    process.env.CALLBOARD_DATA_DIR = join(dataDir, "moved");
    expect(resolveAcpSessionsRoot()).toBe(join(dataDir, "moved", "acp-sessions"));
  });
});

describe("path segment safety", () => {
  it("accepts ordinary ids", () => {
    for (const id of ["opencode", "fake-session-1", "a.b_c-1", "A1"]) expect(isSafePathSegment(id)).toBe(true);
  });

  it("rejects anything that could escape the transcript root", () => {
    for (const id of ["..", ".", "../etc", "a/b", "a\\b", "/abs", "C:\\x", "a\0b", "", " leading", ".hidden", "x".repeat(200)]) {
      expect(isSafePathSegment(id)).toBe(false);
    }
    expect(isSafePathSegment(null)).toBe(false);
    expect(isSafePathSegment(42)).toBe(false);
  });

  it("returns null from acpTranscriptPath when either id is unsafe", () => {
    expect(acpTranscriptPath("opencode", "../../../etc/passwd")).toBeNull();
    expect(acpTranscriptPath("../..", "s1")).toBeNull();
    expect(acpTranscriptPath("opencode", "s1")).toBe(join(dataDir, "acp-sessions", "opencode", "s1.jsonl"));
  });
});

describe("AcpTranscriptWriter", () => {
  it("writes a header then appends events as JSONL", () => {
    const writer = new AcpTranscriptWriter("opencode", "s1", "/work/repo");
    writer.writeHeader({ name: "opencode", version: "2.0" });
    writer.writeEvent({ type: "text", content: "hello" });
    writer.writeEvent({ type: "result", status: "success" });

    const lines = readFileSync(writer.filePath!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "session_meta", providerId: "opencode", sessionId: "s1", cwd: "/work/repo", agentInfo: { name: "opencode" } });
    expect(lines[1]).toMatchObject({ type: "event", event: { type: "text", content: "hello" } });
    expect(typeof lines[1].timestamp).toBe("string");
  });

  it("writes the header only once, so a resumed session is not two sessions", () => {
    const writer = new AcpTranscriptWriter("opencode", "s1", "/work/repo");
    writer.writeHeader(null);
    writer.writeHeader(null);
    const headers = readFileSync(writer.filePath!, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.includes("session_meta"));
    expect(headers).toHaveLength(1);
  });

  it("appends to an existing transcript rather than truncating it", () => {
    const first = new AcpTranscriptWriter("opencode", "s1", "/work/repo");
    first.writeHeader(null);
    first.writeEvent({ type: "text", content: "turn one" });

    // A follow-up turn constructs a fresh writer for the same session.
    const second = new AcpTranscriptWriter("opencode", "s1", "/work/repo");
    second.writeEvent({ type: "text", content: "turn two" });

    const content = readFileSync(first.filePath!, "utf8");
    expect(content).toContain("turn one");
    expect(content).toContain("turn two");
  });

  it("refuses to write at all when an id is unsafe", () => {
    const writer = new AcpTranscriptWriter("opencode", "../escape", "/work");
    expect(writer.filePath).toBeNull();
    // Must not throw — a rejected id degrades to "no transcript", never a crash.
    expect(() => {
      writer.writeHeader(null);
      writer.writeEvent({ type: "text", content: "x" });
    }).not.toThrow();
    expect(existsSync(join(dataDir, "acp-sessions", "escape.jsonl"))).toBe(false);
  });
});

describe("reading transcripts back", () => {
  function seed(providerId: string, sessionId: string, cwd: string, events: unknown[]): void {
    const writer = new AcpTranscriptWriter(providerId, sessionId, cwd);
    writer.writeHeader(null);
    for (const e of events) writer.writeEvent(e as never);
  }

  it("coalesces streamed text chunks into one assistant message", () => {
    seed("opencode", "s1", "/work", [
      { type: "session_started", sessionId: "s1" },
      { type: "text", content: "Hel" },
      { type: "text", content: "lo" },
      { type: "thinking", content: "pondering" },
      { type: "text", content: "again" },
      { type: "result", status: "success" },
    ]);
    const messages = parseAcpTranscript(findAcpTranscript("s1")!.filePath);
    expect(messages.map((m) => `${m.type}:${m.content}`)).toEqual(["text:Hello", "thinking:pondering", "text:again"]);
  });

  it("coalesces streamed thinking chunks the same way", () => {
    // Not cosmetic. OpenCode streams reasoning a word at a time, so 1:1 rendered
    // one turn as ~30 collapsed "Thinking..." rows stacked above the reply. The
    // double emits one thought per turn, which is why nothing caught it here.
    seed("opencode", "s2", "/work", [
      { type: "thinking", content: "The" },
      { type: "thinking", content: " user" },
      { type: "thinking", content: " wants" },
      { type: "text", content: "Done." },
      { type: "result", status: "success" },
    ]);
    const messages = parseAcpTranscript(findAcpTranscript("s2")!.filePath);
    expect(messages.map((m) => `${m.type}:${m.content}`)).toEqual(["thinking:The user wants", "text:Done."]);
  });

  it("never merges reasoning into the reply when the two interleave", () => {
    // Separate buffers, not one "pending block": an agent may think, speak, and
    // think again, and a shared buffer would splice reasoning into the answer.
    seed("opencode", "s3", "/work", [
      { type: "thinking", content: "first " },
      { type: "thinking", content: "thought" },
      { type: "text", content: "Answer " },
      { type: "text", content: "one." },
      { type: "thinking", content: "second thought" },
      { type: "text", content: "Answer two." },
    ]);
    const messages = parseAcpTranscript(findAcpTranscript("s3")!.filePath);
    expect(messages.map((m) => `${m.type}:${m.content}`)).toEqual([
      "thinking:first thought",
      "text:Answer one.",
      "thinking:second thought",
      "text:Answer two.",
    ]);
  });

  it("flushes a trailing thought when the turn ends without a reply", () => {
    seed("opencode", "s4", "/work", [{ type: "thinking", content: "unfinished" }]);
    const messages = parseAcpTranscript(findAcpTranscript("s4")!.filePath);
    expect(messages.map((m) => `${m.type}:${m.content}`)).toEqual(["thinking:unfinished"]);
  });

  it("projects tool events and skips non-renderable ones", () => {
    seed("opencode", "s1", "/work", [
      { type: "tool_use", toolName: "read_file", input: { path: "a" }, callId: "c1" },
      { type: "tool_result", callId: "c1", content: "contents" },
      { type: "slash_commands", commands: ["a"] },
      { type: "adapter_specific", adapter: "acp", payload: { kind: "plan" } },
    ]);
    const messages = parseAcpTranscript(findAcpTranscript("s1")!.filePath);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "assistant", type: "tool_use", toolName: "read_file", toolUseId: "c1", content: '{"path":"a"}' });
    expect(messages[1]).toMatchObject({ role: "user", type: "tool_result", toolUseId: "c1", content: "contents" });
  });

  it("skips a truncated tail line instead of failing the whole read", () => {
    seed("opencode", "s1", "/work", [{ type: "text", content: "good" }]);
    const path = findAcpTranscript("s1")!.filePath;
    // A partially-flushed line is NORMAL while an agent is mid-turn, not corruption.
    writeFileSync(path, '{"type":"event","timesta', { flag: "a" });
    expect(parseAcpTranscript(path).map((m) => m.content)).toEqual(["good"]);
  });

  it("returns empty for a missing file rather than throwing", () => {
    expect(parseAcpTranscript(join(dataDir, "nope.jsonl"))).toEqual([]);
    expect(readAcpTranscriptCwd(join(dataDir, "nope.jsonl"))).toBe("");
    expect(readAcpTranscriptPreview(join(dataDir, "nope.jsonl"))).toBeNull();
  });

  it("previews the prompt when the transcript records one", () => {
    const writer = new AcpTranscriptWriter("opencode", "s6", "/work");
    writer.writeHeader(null);
    writer.writeUserMessage("  what does this do?  ");
    writer.writeEvent({ type: "text", content: "It does things." } as never);
    expect(readAcpTranscriptPreview(findAcpTranscript("s6")!.filePath)).toBe("what does this do?");
  });

  it("falls back to the first agent text for a transcript with no prompt line", () => {
    // Every transcript written before user turns were recorded. Previewing
    // nothing would blank rows that render fine today.
    seed("opencode", "s1", "/work", [
      { type: "thinking", content: "not this" },
      { type: "text", content: "  the preview  " },
    ]);
    expect(readAcpTranscriptPreview(findAcpTranscript("s1")!.filePath)).toBe("the preview");
  });
});

describe("per-turn metrics", () => {
  // None of this rides on an event about a message: ACP puts the model on a
  // session config option, tokens on the turn's terminal result, and spend on a
  // cumulative beacon. Without this projection an ACP chat showed no model under
  // its replies and produced zero rows in the debug panel, whose whole selector
  // is `role === "assistant" && usage`.
  function turn(
    writer: AcpTranscriptWriter,
    opts: { model?: string; prompt: string; reply: string; cumulativeCost?: number; usage?: { inputTokens: number; outputTokens: number } },
  ) {
    writer.writeEvent({ type: "session_started", sessionId: "s" } as never);
    if (opts.model) writer.writeEvent({ type: "adapter_specific", adapter: "acp", payload: { kind: "turn_model", model: opts.model } } as never);
    writer.writeUserMessage(opts.prompt);
    writer.writeEvent({ type: "text", content: opts.reply } as never);
    if (opts.cumulativeCost != null) {
      writer.writeEvent({ type: "adapter_specific", adapter: "acp", payload: { kind: "turn_cost", costUsd: opts.cumulativeCost } } as never);
    }
    writer.writeEvent({ type: "result", status: "success", ...(opts.usage && { usage: opts.usage }) } as never);
  }

  it("labels a turn's messages with the model it ran on", () => {
    const writer = new AcpTranscriptWriter("opencode", "m1", "/work");
    writer.writeHeader(null);
    turn(writer, { model: "opencode/big-pickle", prompt: "hi", reply: "hello", usage: { inputTokens: 10, outputTokens: 3 } });

    const messages = parseAcpTranscript(findAcpTranscript("m1")!.filePath);
    const reply = messages.find((m) => m.role === "assistant");
    expect(reply?.model).toBe("opencode/big-pickle");
    expect(reply?.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
    // The prompt is not the agent's output and carries no model.
    expect(messages.find((m) => m.role === "user")?.model).toBeUndefined();
  });

  it("attributes tokens to the reply of the turn that reported them", () => {
    const writer = new AcpTranscriptWriter("opencode", "m2", "/work");
    writer.writeHeader(null);
    turn(writer, { model: "a", prompt: "one", reply: "first", usage: { inputTokens: 1, outputTokens: 2 } });
    turn(writer, { model: "b", prompt: "two", reply: "second", usage: { inputTokens: 30, outputTokens: 40 } });

    const replies = parseAcpTranscript(findAcpTranscript("m2")!.filePath).filter((m) => m.role === "assistant");
    expect(replies.map((m) => [m.model, m.usage?.input_tokens, m.usage?.output_tokens])).toEqual([
      ["a", 1, 2],
      ["b", 30, 40],
    ]);
  });

  it("differences the cumulative spend beacon into a per-turn cost", () => {
    // The beacon is cumulative for the SESSION. Attaching it verbatim would
    // report the running total as the price of every individual turn.
    const writer = new AcpTranscriptWriter("opencode", "m3", "/work");
    writer.writeHeader(null);
    turn(writer, { prompt: "one", reply: "first", cumulativeCost: 0.01 });
    turn(writer, { prompt: "two", reply: "second", cumulativeCost: 0.03 });

    const replies = parseAcpTranscript(findAcpTranscript("m3")!.filePath).filter((m) => m.role === "assistant");
    expect(replies[0].costUsd).toBeCloseTo(0.01, 10);
    // Not 0.03 — the second turn cost the step, not the running total. Compared
    // approximately because differencing floats is what a subtraction of
    // decimal money does; the UI formats to five places either way.
    expect(replies[1].costUsd).toBeCloseTo(0.02, 10);
  });

  it("reports a genuinely free turn as free rather than as no data", () => {
    const writer = new AcpTranscriptWriter("opencode", "m4", "/work");
    writer.writeHeader(null);
    turn(writer, { prompt: "hi", reply: "hello", cumulativeCost: 0 });
    expect(parseAcpTranscript(findAcpTranscript("m4")!.filePath).find((m) => m.role === "assistant")?.costUsd).toBe(0);
  });

  it("treats a counter that went backwards as a fresh baseline, not a refund", () => {
    // A resumed session whose agent restarted its own accounting.
    const writer = new AcpTranscriptWriter("opencode", "m5", "/work");
    writer.writeHeader(null);
    turn(writer, { prompt: "one", reply: "first", cumulativeCost: 0.05 });
    turn(writer, { prompt: "two", reply: "second", cumulativeCost: 0.01 });

    const replies = parseAcpTranscript(findAcpTranscript("m5")!.filePath).filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.costUsd)).toEqual([0.05, 0.01]);
  });

  it("annotates the tool call when a turn ends without a reply", () => {
    const writer = new AcpTranscriptWriter("opencode", "m6", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "session_started", sessionId: "s" } as never);
    writer.writeUserMessage("do it");
    writer.writeEvent({ type: "tool_use", toolName: "bash", input: { command: "ls" }, callId: "c1" } as never);
    writer.writeEvent({ type: "result", status: "success", usage: { inputTokens: 5, outputTokens: 1 } } as never);

    const messages = parseAcpTranscript(findAcpTranscript("m6")!.filePath);
    expect(messages.find((m) => m.type === "tool_use")?.usage).toEqual({ input_tokens: 5, output_tokens: 1 });
  });

  it("attaches nothing when a turn produced no assistant message at all", () => {
    const writer = new AcpTranscriptWriter("opencode", "m7", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "session_started", sessionId: "s" } as never);
    writer.writeUserMessage("do it");
    writer.writeEvent({ type: "result", status: "error", reason: "agent exited" } as never);

    // The prompt must not be annotated as though the user's message billed.
    expect(parseAcpTranscript(findAcpTranscript("m7")!.filePath).every((m) => m.usage === undefined)).toBe(true);
  });

  it("still parses a transcript written before metrics existed", () => {
    const writer = new AcpTranscriptWriter("opencode", "m8", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "text", content: "bare" } as never);
    const messages = parseAcpTranscript(findAcpTranscript("m8")!.filePath);
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual(["assistant:bare"]);
    expect(messages[0].model).toBeUndefined();
  });
});

describe("user turns in the transcript", () => {
  it("renders each prompt as a user message, in conversation order", () => {
    // Both halves of the chat, and the ordering is the point: the UI retires the
    // composer's optimistic bubble by matching a `role: "user"` message in the
    // fetched transcript, so a transcript without one leaves the message the
    // user just sent pinned below the reply streaming in above it.
    const writer = new AcpTranscriptWriter("opencode", "s7", "/work");
    writer.writeHeader(null);
    writer.writeUserMessage("first question");
    writer.writeEvent({ type: "text", content: "first " } as never);
    writer.writeEvent({ type: "text", content: "answer" } as never);
    writer.writeEvent({ type: "result", status: "success" } as never);
    writer.writeUserMessage("second question");
    writer.writeEvent({ type: "text", content: "second answer" } as never);

    const messages = parseAcpTranscript(findAcpTranscript("s7")!.filePath);
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:first question",
      "assistant:first answer",
      "user:second question",
      "assistant:second answer",
    ]);
  });

  it("closes a streaming reply before the next prompt rather than swallowing it", () => {
    // A turn the user interrupted has no `result` to flush the pending text.
    const writer = new AcpTranscriptWriter("opencode", "s8", "/work");
    writer.writeHeader(null);
    writer.writeEvent({ type: "text", content: "half a repl" } as never);
    writer.writeUserMessage("stop, do this instead");

    const messages = parseAcpTranscript(findAcpTranscript("s8")!.filePath);
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual(["assistant:half a repl", "user:stop, do this instead"]);
  });

  it("skips an empty prompt instead of writing a blank bubble", () => {
    // `resolveAcpPrompt` synthesizes one empty text block when a prompt flattens
    // to nothing, because ACP rejects an empty `prompt` array.
    const writer = new AcpTranscriptWriter("opencode", "s9", "/work");
    writer.writeHeader(null);
    writer.writeUserMessage("   ");
    writer.writeEvent({ type: "text", content: "hi" } as never);

    expect(parseAcpTranscript(findAcpTranscript("s9")!.filePath).map((m) => m.role)).toEqual(["assistant"]);
  });
});

describe("listAcpTranscripts", () => {
  it("returns nothing when the root does not exist", () => {
    expect(listAcpTranscripts()).toEqual([]);
  });

  it("walks exactly two levels and ignores stray content", () => {
    const writer = new AcpTranscriptWriter("opencode", "s1", "/work");
    writer.writeHeader(null);
    const root = resolveAcpSessionsRoot();
    // Stray file at the provider level, a non-jsonl file, and a nested dir —
    // none of these may become phantom sessions.
    writeFileSync(join(root, "loose.jsonl"), "{}\n");
    writeFileSync(join(root, "opencode", "notes.txt"), "hi");
    mkdirSync(join(root, "opencode", "nested"), { recursive: true });
    writeFileSync(join(root, "opencode", "nested", "deep.jsonl"), "{}\n");

    const found = listAcpTranscripts();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ providerId: "opencode", sessionId: "s1" });
  });

  it("finds a session across provider directories and rejects unsafe lookups", () => {
    new AcpTranscriptWriter("opencode", "alpha", "/a").writeHeader(null);
    new AcpTranscriptWriter("other-vendor", "beta", "/b").writeHeader(null);
    expect(findAcpTranscript("beta")?.providerId).toBe("other-vendor");
    expect(findAcpTranscript("../alpha")).toBeNull();
    expect(findAcpTranscript("missing")).toBeNull();
  });
});
