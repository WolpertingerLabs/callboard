/**
 * Transcript round-trip, fork and cross-harness seed.
 *
 * Every case sets `CALLBOARD_DATA_DIR` to a temp dir before touching anything.
 * That is not hygiene, it is the fix for a shipped bug: the ACP suite once
 * wrote its fake sessions into the developer's real chat list (#302), and the
 * transcript root is resolved at call time precisely so a test can move it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider asks Cline to delete its own copy of a session. That would boot
// a real ClineCore, so the shared instance is stubbed for the whole file.
const deleteSession = vi.fn().mockResolvedValue(true);
vi.mock("./ClineAgentQuery.js", () => ({
  getClineCore: () => Promise.resolve({ delete: deleteSession }),
}));

import { ClineSessionProvider } from "./ClineSessionProvider.js";
import { ClineTranscriptWriter, clineSeedPath, readSeededMessages } from "./transcript.js";
import { parseClineTranscript } from "./sessionParser.js";

let dataDir: string;
let provider: ClineSessionProvider;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-cline-test-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
  provider = new ClineSessionProvider();
  deleteSession.mockClear();
});

afterEach(() => {
  delete process.env.CALLBOARD_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** A two-turn session: prompt, reply, tool call, result. */
function writeSession(sessionId: string, cwd = "/repo"): ClineTranscriptWriter {
  const w = new ClineTranscriptWriter(sessionId, cwd);
  w.writeHeader({ providerId: "anthropic", modelId: "claude-sonnet-4-6" });
  w.writeUserMessage("first question");
  w.writeEvent({ type: "session_started", sessionId });
  w.writeEvent({ type: "text", content: "first answer" });
  w.writeEvent({ type: "result", status: "success", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.1 } });
  return w;
}

describe("transcript round-trip", () => {
  it("renders both sides of the conversation", () => {
    writeSession("sess1");
    const messages = provider.parseSessionMessages(["sess1"]);
    expect(messages.map((m) => [m.role, m.type, m.content])).toEqual([
      ["user", "text", "first question"],
      ["assistant", "text", "first answer"],
    ]);
  });

  it("annotates the assistant message with the model from the header", () => {
    writeSession("sess1");
    const [, assistant] = provider.parseSessionMessages(["sess1"]);
    expect(assistant.model).toBe("claude-sonnet-4-6");
  });

  /**
   * Cline reports session *totals*, so attaching the raw figure would make
   * every turn appear to cost what the whole chat has.
   */
  it("differences cumulative usage into a per-turn cost", () => {
    const w = writeSession("sess1");
    w.writeUserMessage("second question");
    w.writeEvent({ type: "session_started", sessionId: "sess1" });
    w.writeEvent({ type: "text", content: "second answer" });
    w.writeEvent({ type: "result", status: "success", usage: { inputTokens: 250, outputTokens: 45, costUsd: 0.3 } });

    const messages = provider.parseSessionMessages(["sess1"]);
    const answers = messages.filter((m) => m.role === "assistant");
    expect(answers[0].costUsd).toBeCloseTo(0.1);
    expect(answers[1].costUsd).toBeCloseTo(0.2); // 0.3 total − 0.1 already spent
    expect(answers[1].usage).toEqual({ input_tokens: 150, output_tokens: 25 });
  });

  it("survives a half-written final line", () => {
    writeSession("sess1");
    // What a crash mid-append leaves behind. Normal, not corruption.
    const path = join(dataDir, "cline-sessions", "sess1.jsonl");
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, `${raw}{"type":"event","timesta`, "utf8");
    expect(provider.parseSessionMessages(["sess1"])).toHaveLength(2);
  });

  it("does not write a second header when a later turn resumes", () => {
    writeSession("sess1");
    new ClineTranscriptWriter("sess1", "/repo").writeHeader({ providerId: "anthropic" });
    const raw = readFileSync(join(dataDir, "cline-sessions", "sess1.jsonl"), "utf8");
    expect(raw.split("\n").filter((l) => l.includes("session_meta"))).toHaveLength(1);
  });

  it("refuses a session id that would escape the transcript root", () => {
    const w = new ClineTranscriptWriter("../../etc/passwd", "/repo");
    expect(w.filePath).toBeNull();
    w.writeHeader();
    w.writeEvent({ type: "text", content: "should not be written" });
  });
});

describe("discovery and search", () => {
  it("lists sessions with the folder from the header", () => {
    writeSession("sess1", "/repo/one");
    writeSession("sess2", "/repo/two");
    const { sessions, total } = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(sessions.map((s) => s.folder).sort()).toEqual(["/repo/one", "/repo/two"]);
  });

  it("filters by folder and by grep over the opening prompt", () => {
    writeSession("sess1", "/repo/one");
    writeSession("sess2", "/repo/two");
    expect(provider.searchSessions({ folder: "/repo/one" }).chats.map((c) => c.sessionId)).toEqual(["sess1"]);
    expect(provider.searchSessions({ folder: "", grep: "first question" }).total).toBe(2);
    expect(provider.searchSessions({ folder: "", grep: "nothing matches this" }).total).toBe(0);
  });

  it("previews the opening prompt, not the agent's reply", () => {
    writeSession("sess1");
    const resolved = provider.resolveSession("sess1");
    expect(resolved).not.toBeNull();
    expect(provider.getSessionPreview(resolved!.logPath)).toBe("first question");
  });
});

describe("deleteSessionFiles", () => {
  it("removes callboard's transcript and asks Cline to drop its own copy", async () => {
    writeSession("sess1");
    provider.deleteSessionFiles("sess1");
    expect(provider.resolveSession("sess1")).toBeNull();
    // Fire-and-log, so let the microtask queue drain before asserting.
    await new Promise((r) => setImmediate(r));
    expect(deleteSession).toHaveBeenCalledWith("sess1");
  });

  it("refuses an unsafe id rather than unlinking outside the root", () => {
    provider.deleteSessionFiles("../../etc/passwd");
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe("forkSession", () => {
  /**
   * Both halves matter and they answer different questions: the transcript is
   * what the user sees, the seed is what the model is given. Writing only the
   * first is the failure `AcpSessionProvider` describes — a fork that renders
   * correctly and then answers as though the conversation never happened.
   */
  it("copies history up to the cutoff and seeds the model with it", async () => {
    const w = writeSession("sess1");
    const cutoff = new Date().toISOString();
    // A real millisecond of separation. The contract is "at or before the
    // cutoff", so an entry stamped in the same millisecond is legitimately
    // kept — writing the two halves in one tick would test the boundary rather
    // than the behaviour.
    await new Promise((r) => setTimeout(r, 2));
    // Everything below is after the cutoff and must not be inherited.
    w.writeUserMessage("later question");
    w.writeEvent({ type: "text", content: "later answer" });

    const result = provider.forkSession(["sess1"], cutoff, "fork1");
    expect(result).not.toBeNull();

    const rendered = provider.parseSessionMessages(["fork1"]).map((m) => m.content);
    expect(rendered).toEqual(["first question", "first answer"]);
    expect(rendered).not.toContain("later question");

    const seeded = readSeededMessages("fork1");
    expect(seeded).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("gives the fork its own header rather than the source's id", () => {
    writeSession("sess1", "/repo/one");
    provider.forkSession(["sess1"], new Date().toISOString(), "fork1");
    const raw = readFileSync(join(dataDir, "cline-sessions", "fork1.jsonl"), "utf8");
    const header = JSON.parse(raw.split("\n")[0]);
    expect(header).toMatchObject({ type: "session_meta", sessionId: "fork1", cwd: "/repo/one" });
    expect(raw).not.toContain('"sessionId":"sess1","cwd"');
  });

  it("returns null when nothing falls at or before the cutoff", () => {
    writeSession("sess1");
    expect(provider.forkSession(["sess1"], "1999-01-01T00:00:00.000Z", "fork1")).toBeNull();
  });

  it("returns null for an unparseable cutoff or an unsafe target", () => {
    writeSession("sess1");
    expect(provider.forkSession(["sess1"], "not a date", "fork1")).toBeNull();
    expect(provider.forkSession(["sess1"], new Date().toISOString(), "../escape")).toBeNull();
  });
});

describe("seedSession", () => {
  /**
   * The write half of a cross-harness handoff. This is what makes Cline a valid
   * *target* — the capability `AcpSessionProvider` documents the absence of as
   * its reason for implementing neither fork nor seed.
   */
  it("writes both a readable transcript and a resumable seed", () => {
    const result = provider.seedSession(
      [
        { role: "user", text: "port this to rust", timestamp: "2026-08-01T10:00:00.000Z" },
        { role: "assistant", text: "here is the plan", timestamp: "2026-08-01T10:00:05.000Z" },
      ],
      { folder: "/repo", newSessionId: "handoff1" },
    );
    expect(result).not.toBeNull();

    expect(provider.parseSessionMessages(["handoff1"]).map((m) => [m.role, m.content])).toEqual([
      ["user", "port this to rust"],
      ["assistant", "here is the plan"],
    ]);
    expect(readSeededMessages("handoff1")).toEqual([
      { role: "user", content: "port this to rust" },
      { role: "assistant", content: "here is the plan" },
    ]);
  });

  it("carries images on user turns as Cline's flat image block", () => {
    provider.seedSession([{ role: "user", text: "what is this", images: [{ mimeType: "image/png", base64: "AAAA" }] }], {
      folder: "/repo",
      newSessionId: "handoff2",
    });
    // Flat `{ type, data, mediaType }` — NOT Anthropic's nested `source` object.
    expect(readSeededMessages("handoff2")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", data: "AAAA", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("returns null for no turns or an unsafe target", () => {
    expect(provider.seedSession([], { folder: "/repo", newSessionId: "handoff3" })).toBeNull();
    expect(provider.seedSession([{ role: "user", text: "hi" }], { folder: "/repo", newSessionId: "../escape" })).toBeNull();
    expect(clineSeedPath("../escape")).toBeNull();
  });

  it("starts an ordinary chat with no seed at all", () => {
    writeSession("sess1");
    expect(readSeededMessages("sess1")).toBeUndefined();
  });
});

describe("parseClineTranscript", () => {
  it("coalesces consecutive text into one message", () => {
    const w = new ClineTranscriptWriter("sess1", "/repo");
    w.writeHeader();
    w.writeEvent({ type: "text", content: "one " });
    w.writeEvent({ type: "text", content: "two " });
    w.writeEvent({ type: "text", content: "three" });
    const messages = parseClineTranscript(join(dataDir, "cline-sessions", "sess1.jsonl"));
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("one two three");
  });

  it("keeps reasoning out of the reply", () => {
    const w = new ClineTranscriptWriter("sess1", "/repo");
    w.writeHeader();
    w.writeEvent({ type: "thinking", content: "let me check" });
    w.writeEvent({ type: "text", content: "the answer" });
    const messages = parseClineTranscript(join(dataDir, "cline-sessions", "sess1.jsonl"));
    expect(messages.map((m) => [m.type, m.content])).toEqual([
      ["thinking", "let me check"],
      ["text", "the answer"],
    ]);
  });

  it("renders tool traffic as a call and its result", () => {
    const w = new ClineTranscriptWriter("sess1", "/repo");
    w.writeHeader();
    w.writeEvent({ type: "tool_use", toolName: "run_commands", input: { commands: ["ls"] }, callId: "t1" });
    w.writeEvent({ type: "tool_result", callId: "t1", content: "a.txt" });
    const messages = parseClineTranscript(join(dataDir, "cline-sessions", "sess1.jsonl"));
    expect(messages.map((m) => [m.role, m.type, m.toolName ?? m.content])).toEqual([
      ["assistant", "tool_use", "run_commands"],
      ["user", "tool_result", "a.txt"],
    ]);
  });
});
