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
    for (const id of ["gemini", "fake-session-1", "a.b_c-1", "A1"]) expect(isSafePathSegment(id)).toBe(true);
  });

  it("rejects anything that could escape the transcript root", () => {
    for (const id of ["..", ".", "../etc", "a/b", "a\\b", "/abs", "C:\\x", "a\0b", "", " leading", ".hidden", "x".repeat(200)]) {
      expect(isSafePathSegment(id)).toBe(false);
    }
    expect(isSafePathSegment(null)).toBe(false);
    expect(isSafePathSegment(42)).toBe(false);
  });

  it("returns null from acpTranscriptPath when either id is unsafe", () => {
    expect(acpTranscriptPath("gemini", "../../../etc/passwd")).toBeNull();
    expect(acpTranscriptPath("../..", "s1")).toBeNull();
    expect(acpTranscriptPath("gemini", "s1")).toBe(join(dataDir, "acp-sessions", "gemini", "s1.jsonl"));
  });
});

describe("AcpTranscriptWriter", () => {
  it("writes a header then appends events as JSONL", () => {
    const writer = new AcpTranscriptWriter("gemini", "s1", "/work/repo");
    writer.writeHeader({ name: "gemini", version: "2.0" });
    writer.writeEvent({ type: "text", content: "hello" });
    writer.writeEvent({ type: "result", status: "success" });

    const lines = readFileSync(writer.filePath!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "session_meta", providerId: "gemini", sessionId: "s1", cwd: "/work/repo", agentInfo: { name: "gemini" } });
    expect(lines[1]).toMatchObject({ type: "event", event: { type: "text", content: "hello" } });
    expect(typeof lines[1].timestamp).toBe("string");
  });

  it("writes the header only once, so a resumed session is not two sessions", () => {
    const writer = new AcpTranscriptWriter("gemini", "s1", "/work/repo");
    writer.writeHeader(null);
    writer.writeHeader(null);
    const headers = readFileSync(writer.filePath!, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.includes("session_meta"));
    expect(headers).toHaveLength(1);
  });

  it("appends to an existing transcript rather than truncating it", () => {
    const first = new AcpTranscriptWriter("gemini", "s1", "/work/repo");
    first.writeHeader(null);
    first.writeEvent({ type: "text", content: "turn one" });

    // A follow-up turn constructs a fresh writer for the same session.
    const second = new AcpTranscriptWriter("gemini", "s1", "/work/repo");
    second.writeEvent({ type: "text", content: "turn two" });

    const content = readFileSync(first.filePath!, "utf8");
    expect(content).toContain("turn one");
    expect(content).toContain("turn two");
  });

  it("refuses to write at all when an id is unsafe", () => {
    const writer = new AcpTranscriptWriter("gemini", "../escape", "/work");
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
    seed("gemini", "s1", "/work", [
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
    seed("gemini", "s1", "/work", [
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
    seed("gemini", "s1", "/work", [{ type: "text", content: "good" }]);
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

  it("previews the first agent text", () => {
    seed("gemini", "s1", "/work", [
      { type: "thinking", content: "not this" },
      { type: "text", content: "  the preview  " },
    ]);
    expect(readAcpTranscriptPreview(findAcpTranscript("s1")!.filePath)).toBe("the preview");
  });
});

describe("listAcpTranscripts", () => {
  it("returns nothing when the root does not exist", () => {
    expect(listAcpTranscripts()).toEqual([]);
  });

  it("walks exactly two levels and ignores stray content", () => {
    const writer = new AcpTranscriptWriter("gemini", "s1", "/work");
    writer.writeHeader(null);
    const root = resolveAcpSessionsRoot();
    // Stray file at the provider level, a non-jsonl file, and a nested dir —
    // none of these may become phantom sessions.
    writeFileSync(join(root, "loose.jsonl"), "{}\n");
    writeFileSync(join(root, "gemini", "notes.txt"), "hi");
    mkdirSync(join(root, "gemini", "nested"), { recursive: true });
    writeFileSync(join(root, "gemini", "nested", "deep.jsonl"), "{}\n");

    const found = listAcpTranscripts();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ providerId: "gemini", sessionId: "s1" });
  });

  it("finds a session across provider directories and rejects unsafe lookups", () => {
    new AcpTranscriptWriter("gemini", "alpha", "/a").writeHeader(null);
    new AcpTranscriptWriter("other-vendor", "beta", "/b").writeHeader(null);
    expect(findAcpTranscript("beta")?.providerId).toBe("other-vendor");
    expect(findAcpTranscript("../alpha")).toBeNull();
    expect(findAcpTranscript("missing")).toBeNull();
  });
});
