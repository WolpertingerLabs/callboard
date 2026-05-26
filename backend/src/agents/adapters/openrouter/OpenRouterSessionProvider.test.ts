/**
 * Integration tests for the OR SessionProvider against a fixture log tree
 * laid down in a tmpdir.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterSessionProvider } from "./OpenRouterSessionProvider.js";

const SETTINGS_MODULE = "../../../services/agent-settings.js";

vi.mock("../../../services/agent-settings.js", () => ({
  getAgentSettings: vi.fn(),
}));

let TMP_LOGS: string;

beforeEach(() => {
  TMP_LOGS = join(tmpdir(), `or-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TMP_LOGS, { recursive: true });
});

afterEach(async () => {
  rmSync(TMP_LOGS, { recursive: true, force: true });
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReset();
});

async function pointSettingsAtTmp() {
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReturnValue({ openRouterLogsRoot: TMP_LOGS });
}

function writeSession(sessionId: string, opts: { cwd?: string; messages?: unknown[]; firstPrompt?: string } = {}) {
  const sessionDir = join(TMP_LOGS, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  if (opts.cwd !== undefined) {
    writeFileSync(
      join(sessionDir, "session.json"),
      JSON.stringify({ sessionId, startedAt: new Date().toISOString(), cwd: opts.cwd }),
    );
  }
  if (opts.messages) {
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: sessionId, messages: opts.messages, status: "completed" }),
    );
  }
  if (opts.firstPrompt) {
    const reqDir = join(sessionDir, "req_first");
    mkdirSync(reqDir);
    writeFileSync(
      join(reqDir, "request.json"),
      JSON.stringify({
        sessionId,
        requestId: "req_first",
        prompt: opts.firstPrompt,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  return sessionDir;
}

describe("OpenRouterSessionProvider — discovery", () => {
  it("returns empty when logsRoot does not exist", async () => {
    const { getAgentSettings } = await import(SETTINGS_MODULE);
    vi.mocked(getAgentSettings).mockReturnValue({ openRouterLogsRoot: "/nonexistent/path" });
    const provider = new OpenRouterSessionProvider();
    expect(provider.discoverSessions({ limit: 10, offset: 0 })).toEqual({ sessions: [], total: 0 });
  });

  it("discovers sessions and reads cwd from session.json", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_a", { cwd: "/home/user/projectA" });
    writeSession("sess_b", { cwd: "/home/user/projectB" });
    const provider = new OpenRouterSessionProvider();
    const result = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.sessions.map((s) => s.sessionId).sort()).toEqual(["sess_a", "sess_b"]);
    const a = result.sessions.find((s) => s.sessionId === "sess_a")!;
    expect(a.folder).toBe("/home/user/projectA");
    expect(a.displayFolder).toBe("/home/user/projectA");
  });

  it("excludes subagent dirs from the top-level listing", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_main", { cwd: "/work" });
    writeSession("sess_main:sub:child1", { cwd: "/work" });
    const provider = new OpenRouterSessionProvider();
    const result = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["sess_main"]);
  });

  it("excludes dirs without session.json or state.json (ghost-dir filter)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    writeSession("real_session", { cwd: "/work" });
    // A stale dir from a crashed process or unrelated junk in logsRoot
    mkdirSync(join(TMP_LOGS, ".tmp"));
    mkdirSync(join(TMP_LOGS, "partial_session"));
    writeFileSync(join(TMP_LOGS, "partial_session", "junk.txt"), "x");
    const provider = new OpenRouterSessionProvider();
    const result = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["real_session"]);
  });

  it("paginates by mtime DESC", async () => {
    await pointSettingsAtTmp();
    writeSession("first", { cwd: "/work" });
    writeSession("second", { cwd: "/work" });
    writeSession("third", { cwd: "/work" });
    const provider = new OpenRouterSessionProvider();
    const page1 = provider.discoverSessions({ limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.sessions).toHaveLength(2);
  });
});

describe("OpenRouterSessionProvider — resolve / preview / subagents", () => {
  it("resolveSession returns null for missing sessionId", async () => {
    await pointSettingsAtTmp();
    const provider = new OpenRouterSessionProvider();
    expect(provider.resolveSession("nope")).toBeNull();
  });

  it("resolveSession returns the cwd from session.json", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_x", { cwd: "/work" });
    const provider = new OpenRouterSessionProvider();
    const resolved = provider.resolveSession("sess_x");
    expect(resolved).toMatchObject({ folder: "/work", displayFolder: "/work" });
  });

  it("getSessionPreview returns the first user prompt, truncated", async () => {
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_p", { firstPrompt: "this is a fairly long opening message that needs truncation" });
    const provider = new OpenRouterSessionProvider();
    const preview = provider.getSessionPreview(join(sessionDir, "session.json"), 20);
    expect(preview).toBe("this is a fairly lon…");
  });

  it("findSubagentFiles enumerates :sub: sibling dirs with state.json", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_main");
    writeSession("sess_main:sub:abc", { messages: [{ role: "user", content: "child" }] });
    writeSession("sess_main:sub:def"); // No state.json — should be filtered out
    const provider = new OpenRouterSessionProvider();
    const subs = provider.findSubagentFiles("sess_main");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.agentId).toBe("sub:abc");
    expect(subs[0]!.filePath).toContain("sess_main:sub:abc");
  });
});

describe("OpenRouterSessionProvider — parseSessionMessages", () => {
  it("interleaves user prompts (from request.json) with state.messages (assistant/tool items)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    // Reproduce the real-world shape: OR uses previousResponseId chaining so
    // state.messages has only assistant/tool items, NO user-role items.
    const sessionDir = writeSession("sess_real", {
      cwd: "/work",
      messages: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello!" }],
        },
        { type: "function_call", callId: "c1", name: "read_file", arguments: '{"p":"x"}' },
        { type: "function_call_output", callId: "c1", output: "file contents" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Found it." }],
        },
      ],
    });
    // Two requests, each a user turn.
    const req1 = join(sessionDir, "req_001");
    mkdirSync(req1);
    writeFileSync(
      join(req1, "request.json"),
      JSON.stringify({ sessionId: "sess_real", requestId: "req_001", prompt: "hi", timestamp: "2026-05-26T17:00:00Z" }),
    );
    // Force req_002's mtime to be later than req_001's so the chronological
    // sort lands them in the right order.
    await new Promise((r) => setTimeout(r, 10));
    const req2 = join(sessionDir, "req_002");
    mkdirSync(req2);
    writeFileSync(
      join(req2, "request.json"),
      JSON.stringify({ sessionId: "sess_real", requestId: "req_002", prompt: "show me x", timestamp: "2026-05-26T17:01:00Z" }),
    );

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_real"]);

    // Turn 1: user "hi" → assistant "Hello!"
    // Turn 2: user "show me x" → function_call → function_call_output → assistant "Found it."
    expect(messages).toEqual([
      { role: "user", type: "text", content: "hi", timestamp: "2026-05-26T17:00:00Z" },
      { role: "assistant", type: "text", content: "Hello!" },
      { role: "user", type: "text", content: "show me x", timestamp: "2026-05-26T17:01:00Z" },
      { role: "assistant", type: "tool_use", toolName: "read_file", content: '{"p":"x"}', toolUseId: "c1" },
      { role: "user", type: "tool_result", content: "file contents", toolUseId: "c1" },
      { role: "assistant", type: "text", content: "Found it." },
    ]);
  });

  it("includes openrouter:* server-side tool items in their turn", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    // Reproduces the real state.json the user shared: an `openrouter:datetime`
    // item appears between two assistant messages — it belongs to the turn
    // whose assistant response uses the result.
    const sessionDir = writeSession("sess_dt", {
      cwd: "/work",
      messages: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
        {
          type: "openrouter:datetime",
          id: "st_dt",
          status: "completed",
          datetime: "2026-05-26T17:49:00.474Z",
          timezone: "UTC",
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Today is Tuesday." }] },
      ],
    });
    const req1 = join(sessionDir, "req_001");
    mkdirSync(req1);
    writeFileSync(join(req1, "request.json"), JSON.stringify({ sessionId: "sess_dt", requestId: "req_001", prompt: "hi", timestamp: "2026-05-26T17:48:00Z" }));
    await new Promise((r) => setTimeout(r, 10));
    const req2 = join(sessionDir, "req_002");
    mkdirSync(req2);
    writeFileSync(join(req2, "request.json"), JSON.stringify({ sessionId: "sess_dt", requestId: "req_002", prompt: "what day is it?", timestamp: "2026-05-26T17:49:00Z" }));

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_dt"]);

    // Turn 1: user "hi" → assistant "Hello!"
    // Turn 2: user "what day is it?" → openrouter:datetime (tool_use + tool_result) → assistant "Today is Tuesday."
    expect(messages.map((m) => ({ role: m.role, type: m.type, toolName: m.toolName }))).toEqual([
      { role: "user", type: "text", toolName: undefined },
      { role: "assistant", type: "text", toolName: undefined },
      { role: "user", type: "text", toolName: undefined },
      { role: "assistant", type: "tool_use", toolName: "datetime" },
      { role: "user", type: "tool_result", toolName: undefined },
      { role: "assistant", type: "text", toolName: undefined },
    ]);
    // The datetime payload should be in the tool_result content.
    expect(messages[4]!.content).toContain("2026-05-26T17:49:00.474Z");
    expect(messages[4]!.content).toContain("UTC");
  });

  it("falls back to state-only parser when no request.json files exist (legacy / compacted)", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_legacy", {
      cwd: "/work",
      messages: [
        { role: "user", content: "hi" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
    });
    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_legacy"]);
    // Without req_*/ files, the state-only fallback runs and the
    // user-role items in messages are honored.
    expect(messages).toEqual([
      { role: "user", type: "text", content: "hi" },
      { role: "assistant", type: "text", content: "hello" },
    ]);
  });

  it("emits user prompts even when state.messages is empty (in-flight turn)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_inflight", { cwd: "/work", messages: [] });
    const req1 = join(sessionDir, "req_001");
    mkdirSync(req1);
    writeFileSync(
      join(req1, "request.json"),
      JSON.stringify({ sessionId: "sess_inflight", requestId: "req_001", prompt: "just asked", timestamp: "2026-05-26T18:00:00Z" }),
    );
    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_inflight"]);
    expect(messages).toEqual([
      { role: "user", type: "text", content: "just asked", timestamp: "2026-05-26T18:00:00Z" },
    ]);
  });

  it("appends subagent transcripts after the parent", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_p", { messages: [{ role: "user", content: "parent ask" }] });
    writeSession("sess_p:sub:c1", { messages: [{ role: "user", content: "child task" }] });
    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_p"]);
    expect(messages.map((m) => m.content)).toEqual(["parent ask", "child task"]);
  });

  it("returns [] for sessions with no state.json (in-memory runs)", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_empty", { cwd: "/work" });
    const provider = new OpenRouterSessionProvider();
    expect(provider.parseSessionMessages(["sess_empty"])).toEqual([]);
  });
});

describe("OpenRouterSessionProvider — path-traversal hardening", () => {
  it.each(["", ".", "..", "../foo", "foo/bar", "foo\\bar", "/abs/path"])(
    "rejects unsafe sessionId %s in resolveSession",
    async (badId) => {
      await pointSettingsAtTmp();
      const provider = new OpenRouterSessionProvider();
      expect(provider.resolveSession(badId)).toBeNull();
    },
  );

  it("deleteSessionFiles with empty sessionId does NOT wipe logsRoot", async () => {
    const { existsSync } = await import("node:fs");
    await pointSettingsAtTmp();
    writeSession("survivor", { cwd: "/work" });
    const provider = new OpenRouterSessionProvider();
    provider.deleteSessionFiles("");
    expect(existsSync(TMP_LOGS)).toBe(true);
    expect(existsSync(join(TMP_LOGS, "survivor"))).toBe(true);
  });

  it("deleteSessionFiles with '..' does NOT escape logsRoot", async () => {
    const { existsSync, mkdirSync } = await import("node:fs");
    const sibling = join(TMP_LOGS, "..", `or-sibling-${Date.now()}`);
    mkdirSync(sibling, { recursive: true });
    try {
      await pointSettingsAtTmp();
      const provider = new OpenRouterSessionProvider();
      provider.deleteSessionFiles("..");
      expect(existsSync(sibling)).toBe(true);
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("findSubagentFiles returns [] for empty sessionId (no degenerate ':sub:' prefix)", async () => {
    await pointSettingsAtTmp();
    writeSession("sess", { cwd: "/work" });
    writeSession("sess:sub:c1", { cwd: "/work", messages: [{ role: "user", content: "child" }] });
    const provider = new OpenRouterSessionProvider();
    expect(provider.findSubagentFiles("")).toEqual([]);
  });
});

describe("OpenRouterSessionProvider — search / delete", () => {
  it("searchSessions filters by folder + grep", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_match", { cwd: "/proj", firstPrompt: "find the bug in foo.ts" });
    writeSession("sess_other", { cwd: "/proj", firstPrompt: "something unrelated" });
    writeSession("sess_wrongdir", { cwd: "/elsewhere", firstPrompt: "find the bug" });
    const provider = new OpenRouterSessionProvider();
    const res = provider.searchSessions({ folder: "/proj", grep: "find" });
    expect(res.chats.map((c) => c.sessionId)).toEqual(["sess_match"]);
  });

  it("deleteSessionFiles removes the session dir and its subagent siblings", async () => {
    const { existsSync } = await import("node:fs");
    await pointSettingsAtTmp();
    writeSession("victim", { cwd: "/x" });
    writeSession("victim:sub:c1", { cwd: "/x" });
    writeSession("survivor", { cwd: "/y" });
    const provider = new OpenRouterSessionProvider();
    provider.deleteSessionFiles("victim");
    expect(existsSync(join(TMP_LOGS, "victim"))).toBe(false);
    expect(existsSync(join(TMP_LOGS, "victim:sub:c1"))).toBe(false);
    expect(existsSync(join(TMP_LOGS, "survivor"))).toBe(true);
  });
});
