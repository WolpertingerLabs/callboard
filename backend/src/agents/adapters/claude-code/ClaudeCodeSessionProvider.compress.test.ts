/**
 * ClaudeCodeSessionProvider.compressSession — the native, raw-line-preserving
 * writer behind "compress earlier/later messages", over fixture JSONL logs in
 * a tmpdir (same harness as the forkSession suite).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeSessionProvider } from "./ClaudeCodeSessionProvider.js";
import { parseMessages } from "./sessionParser.js";

vi.mock("../../../agents/factory.js", () => ({ getSessionProviders: () => [] }));
const h = vi.hoisted(() => ({ projectsDir: "" }));
vi.mock("../../../utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/paths.js")>();
  return {
    ...actual,
    get CLAUDE_PROJECTS_DIR() {
      return h.projectsDir;
    },
    listClaudeProjectDirs: () => ["proj"],
  };
});

let TMP: string;
let PROJ_DIR: string;
const provider = new ClaudeCodeSessionProvider();

beforeEach(() => {
  TMP = join(tmpdir(), `cc-compress-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  PROJ_DIR = join(TMP, "proj");
  mkdirSync(PROJ_DIR, { recursive: true });
  h.projectsDir = TMP;
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
function writeSession(sessionId: string, lines: any[]) {
  writeFileSync(join(PROJ_DIR, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
function read(logPath: string): any[] {
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
let prev: string | null = null;
function chain<T extends { uuid: string }>(line: T): T & { parentUuid: string | null } {
  const out = { parentUuid: prev, sessionId: "orig", cwd: "/repo", version: "2.1.0", ...line };
  prev = line.uuid;
  return out;
}
const user = (uuid: string, s: number, content: any) => chain({ type: "user", message: { role: "user", content }, uuid, timestamp: ts(s) });
const assistant = (uuid: string, s: number, blocks: any[], id?: string) =>
  chain({ type: "assistant", message: { role: "assistant", ...(id && { id }), content: blocks }, uuid, timestamp: ts(s) });
const toolResult = (uuid: string, s: number, toolUseId: string, extra: Record<string, unknown> = {}) =>
  chain({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "result" }] },
    uuid,
    timestamp: ts(s),
    ...extra,
  });
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * u1 (0s) → a1 tool_use t1 (1s) → r1 result (2s) → a1b text (3s)
 * u2 (10s) → a2 text + tool_use t2 (11s, same message id) → r2 (12s) → a2b (13s)
 * u3 (20s) → a3 (21s)
 */
function fixture() {
  prev = null;
  writeSession("orig", [
    user("u1", 0, "first question"),
    assistant("a1", 1, [{ type: "tool_use", id: "t1", name: "Read", input: {} }], "m1"),
    toolResult("r1", 2, "t1", { toolUseResult: { agentId: "agentA" } }),
    assistant("a1b", 3, [{ type: "text", text: "first answer" }], "m1b"),
    user("u2", 10, "second question"),
    assistant("a2", 11, [{ type: "text", text: "looking" }], "m2"),
    assistant("a2t", 11, [{ type: "tool_use", id: "t2", name: "Bash", input: {} }], "m2"),
    toolResult("r2", 12, "t2"),
    assistant("a2b", 13, [{ type: "text", text: "second answer" }], "m2b"),
    user("u3", 20, "third question"),
    assistant("a3", 21, [{ type: "text", text: "third answer" }], "m3"),
  ]);
}

describe("compressSession — after", () => {
  it("keeps everything through the cutoff and appends a marked summary plus an ack, chained on the last kept line", () => {
    fixture();
    const out = provider.compressSession(["orig"], { cutoffTimestamp: ts(3), direction: "after", summary: "LATER SUMMARY", newSessionId: "new" })!;
    const lines = read(out.logPath);
    expect(lines.slice(0, 4).map((l) => l.uuid)).toEqual(["u1", "a1", "r1", "a1b"]);
    const [summary, ack] = lines.slice(4);
    expect(summary.type).toBe("user");
    expect(summary.message.content).toMatch(/^\[Summary of the later conversation, compressed by the user\]/);
    expect(summary.message.content).toContain("LATER SUMMARY");
    expect(summary.parentUuid).toBe("a1b");
    expect(ack.type).toBe("assistant");
    expect(ack.parentUuid).toBe(summary.uuid);
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => l.sessionId === "new")).toBe(true);
    // Sorts after the kept part.
    expect(new Date(summary.timestamp).getTime()).toBeGreaterThan(new Date(ts(3)).getTime());
  });

  it("extends through a tool_result the cutoff line's tool_use is waiting on", () => {
    fixture();
    const out = provider.compressSession(["orig"], { cutoffTimestamp: ts(11), direction: "after", summary: "S", newSessionId: "new" })!;
    const uuids = read(out.logPath).map((l) => l.uuid);
    expect(uuids.slice(0, 8)).toEqual(["u1", "a1", "r1", "a1b", "u2", "a2", "a2t", "r2"]);
  });

  it("closes a dangling tool_use with an interrupted result when the log ends mid-tool", () => {
    prev = null;
    writeSession("orig", [
      user("u1", 0, "q"),
      assistant("a1", 1, [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      user("u2", 5, "later, unrelated"),
    ]);
    const lines = read(provider.compressSession(["orig"], { cutoffTimestamp: ts(1), direction: "after", summary: "S", newSessionId: "new" })!.logPath);
    const interrupted = lines.find((l) => Array.isArray(l.message?.content) && l.message.content[0]?.tool_use_id === "t1");
    expect(interrupted.message.content[0].is_error).toBe(true);
    // The summary still chains onto the very last line.
    expect(lines[lines.length - 2].parentUuid).toBe(interrupted.uuid);
  });

  it("returns null when nothing comes after the cutoff", () => {
    fixture();
    expect(provider.compressSession(["orig"], { cutoffTimestamp: ts(21), direction: "after", summary: "S", newSessionId: "new" })).toBeNull();
  });
});

describe("compressSession — before", () => {
  it("writes a compact boundary and summary, then the kept lines verbatim, re-chained onto the summary", () => {
    fixture();
    const out = provider.compressSession(["orig"], { cutoffTimestamp: ts(10), direction: "before", summary: "EARLIER SUMMARY", newSessionId: "new" })!;
    const lines = read(out.logPath);
    const [boundary, summary, ack, ...kept] = lines;
    expect(boundary).toMatchObject({ type: "system", subtype: "compact_boundary", parentUuid: null, logicalParentUuid: "a1b" });
    expect(summary).toMatchObject({ type: "user", isCompactSummary: true, parentUuid: boundary.uuid });
    expect(summary.message.content).toContain("EARLIER SUMMARY");
    // The kept part opens with a user turn, so an ack keeps roles alternating.
    expect(ack).toMatchObject({ type: "assistant", parentUuid: summary.uuid });
    expect(kept.map((l) => l.uuid)).toEqual(["u2", "a2", "a2t", "r2", "a2b", "u3", "a3"]);
    expect(kept[0].parentUuid).toBe(ack.uuid);
    // Everything after the first kept line keeps its own chain.
    expect(kept.slice(1).map((l) => l.parentUuid)).toEqual(["u2", "a2", "a2t", "r2", "a2b", "u3"]);
    expect(lines.every((l) => l.sessionId === "new")).toBe(true);
    // The summarised lines are gone.
    expect(lines.some((l) => ["u1", "a1", "r1", "a1b"].includes(l.uuid))).toBe(false);
  });

  it("snaps the start back to the beginning of the API message the cutoff line belongs to", () => {
    fixture();
    // a2t shares message id m2 with a2: starting at a2t would split one response.
    const lines = read(provider.compressSession(["orig"], { cutoffTimestamp: ts(11), direction: "before", summary: "S", newSessionId: "new" })!.logPath);
    const kept = lines.filter((l) => l.type !== "system" && !l.isCompactSummary);
    expect(kept[0].uuid).toBe("a2");
    // An assistant-first kept part needs no ack.
    expect(lines.filter((l) => l.type === "assistant" && !l.message.id)).toHaveLength(0);
  });

  it("drops a tool_result whose tool_use was summarised away and re-chains its children past it", () => {
    fixture();
    // Cut between a1 (tool_use t1, 1s) and r1 (its result, 2s).
    const lines = read(provider.compressSession(["orig"], { cutoffTimestamp: ts(2), direction: "before", summary: "S", newSessionId: "new" })!.logPath);
    expect(lines.some((l) => l.uuid === "r1")).toBe(false);
    const a1b = lines.find((l) => l.uuid === "a1b");
    const summary = lines.find((l) => l.isCompactSummary);
    // a1b's parent was r1; r1 is gone, so it chains onto the summary — and,
    // being an assistant turn, with no ack in between.
    expect(a1b.parentUuid).toBe(summary.uuid);
    expect(lines.filter((l) => l.type === "assistant" && !l.message.id)).toHaveLength(0);
    // No tool_result anywhere names a tool_use that is not in the file.
    const uses = new Set(
      lines.flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id) : [])),
    );
    const results = lines.flatMap((l) =>
      Array.isArray(l.message?.content) ? l.message.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id) : [],
    );
    expect(results.every((id) => uses.has(id))).toBe(true);
  });

  it("strips only the orphan block from a mixed line, and its structured result with it", () => {
    prev = null;
    writeSession("orig", [
      user("u1", 0, "q"),
      assistant("a1", 1, [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
      chain({
        type: "user",
        uuid: "mixed",
        timestamp: ts(5),
        toolUseResult: { agentId: "x" },
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "r" },
            { type: "text", text: "and also this" },
          ],
        },
      }),
      assistant("a2", 6, [{ type: "text", text: "ok" }]),
    ]);
    const lines = read(provider.compressSession(["orig"], { cutoffTimestamp: ts(5), direction: "before", summary: "S", newSessionId: "new" })!.logPath);
    const mixed = lines.find((l) => l.uuid === "mixed");
    expect(mixed.message.content).toEqual([{ type: "text", text: "and also this" }]);
    expect(mixed).not.toHaveProperty("toolUseResult");
  });

  it("copies the subagent transcripts the kept lines reference", () => {
    fixture();
    mkdirSync(join(PROJ_DIR, "orig", "subagents"), { recursive: true });
    writeFileSync(join(PROJ_DIR, "orig", "subagents", "agent-agentA.jsonl"), "{}\n");
    provider.compressSession(["orig"], { cutoffTimestamp: ts(0), direction: "after", summary: "S", newSessionId: "kept-none" });
    expect(existsSync(join(PROJ_DIR, "kept-none", "subagents", "agent-agentA.jsonl"))).toBe(false);
    provider.compressSession(["orig"], { cutoffTimestamp: ts(1), direction: "after", summary: "S", newSessionId: "kept-r1" });
    expect(existsSync(join(PROJ_DIR, "kept-r1", "subagents", "agent-agentA.jsonl"))).toBe(true);
  });

  it("returns null when there is nothing before the cutoff", () => {
    fixture();
    expect(provider.compressSession(["orig"], { cutoffTimestamp: ts(0), direction: "before", summary: "S", newSessionId: "new" })).toBeNull();
  });

  it("parses into a compacted marker, the summary, and the kept conversation", () => {
    fixture();
    const out = provider.compressSession(["orig"], { cutoffTimestamp: ts(20), direction: "before", summary: "EARLIER", newSessionId: "new" })!;
    const parsed = parseMessages(read(out.logPath));
    expect(parsed[0]).toMatchObject({ type: "system", subtype: "compact_boundary" });
    const texts = parsed.filter((m) => m.type === "text").map((m) => m.content);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toMatch(/^\[Summary of the earlier conversation/);
    expect(texts[1]).toMatch(/^Understood/);
    expect(texts.slice(2)).toEqual(["third question", "third answer"]);
  });
});
