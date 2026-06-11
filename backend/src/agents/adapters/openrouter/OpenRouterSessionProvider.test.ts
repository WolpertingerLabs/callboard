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
const PATHS_MODULE = "../../../utils/paths.js";

vi.mock("../../../services/agent-settings.js", () => ({
  getAgentSettings: vi.fn(),
}));

// Partial mock: only override isIgnoredProjectFolder (default: ignore nothing,
// so the rest of the suite behaves as before). Other paths.js exports are used
// transitively by the provider's deps (e.g. DATA_DIR via image-storage), so we
// must preserve them via importOriginal.
vi.mock("../../../utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/paths.js")>();
  return {
    ...actual,
    isIgnoredProjectFolder: vi.fn(() => false),
  };
});

async function setIgnoredFolder(fn: (folder: string) => boolean) {
  const { isIgnoredProjectFolder } = await import(PATHS_MODULE);
  vi.mocked(isIgnoredProjectFolder).mockImplementation(fn);
}

let TMP_LOGS: string;

beforeEach(() => {
  TMP_LOGS = join(tmpdir(), `or-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TMP_LOGS, { recursive: true });
});

afterEach(async () => {
  rmSync(TMP_LOGS, { recursive: true, force: true });
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReset();
  const { isIgnoredProjectFolder } = await import(PATHS_MODULE);
  vi.mocked(isIgnoredProjectFolder).mockReset();
  vi.mocked(isIgnoredProjectFolder).mockImplementation(() => false);
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

  it("excludes sessions whose cwd is an ignored project folder", async () => {
    await pointSettingsAtTmp();
    await setIgnoredFolder((folder) => folder === "/tmp/quick");
    writeSession("sess_keep", { cwd: "/home/user/projectA" });
    writeSession("sess_ignored", { cwd: "/tmp/quick" });
    const provider = new OpenRouterSessionProvider();
    const result = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["sess_keep"]);
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
      { role: "user", type: "tool_result", toolName: "datetime" },
      { role: "assistant", type: "text", toolName: undefined },
    ]);
    // Server-executed tools carry provenance so the UI can badge them.
    expect(messages[3]!.toolSource).toBe("openrouter_server");
    expect(messages[4]!.toolSource).toBe("openrouter_server");
    // The datetime payload should be in the tool_result content.
    expect(messages[4]!.content).toContain("2026-05-26T17:49:00.474Z");
    expect(messages[4]!.content).toContain("UTC");
  });

  it("renders server_tool transcript records with provenance (transcript-preferred path)", async () => {
    const { writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    // Transcript present → it is preferred over state.json, so the pair must
    // come out of the transcript's `server_tool` record, not the state items.
    const sessionDir = writeSession("sess_st", { cwd: "/work" });
    const records = [
      { v: 1, sessionId: "sess_st", ts: "2026-05-27T10:00:00Z", kind: "user", text: "what day is it?" },
      {
        v: 1,
        sessionId: "sess_st",
        ts: "2026-05-27T10:00:01Z",
        kind: "server_tool",
        toolType: "openrouter:datetime",
        callId: "st_dt_1",
        status: "completed",
        output: { datetime: "2026-05-27T10:00:01.000Z", timezone: "UTC" },
        isError: false,
      },
      {
        v: 1,
        sessionId: "sess_st",
        ts: "2026-05-27T10:00:02Z",
        kind: "assistant",
        turnNumber: 1,
        requestId: "req_x",
        model: "m",
        text: "Today is Wednesday.",
      },
    ];
    writeFileSync(join(sessionDir, "transcript.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_st"]);

    expect(messages.map((m) => ({ role: m.role, type: m.type, toolName: m.toolName, toolSource: m.toolSource }))).toEqual([
      { role: "user", type: "text", toolName: undefined, toolSource: undefined },
      { role: "assistant", type: "tool_use", toolName: "datetime", toolSource: "openrouter_server" },
      { role: "user", type: "tool_result", toolName: "datetime", toolSource: "openrouter_server" },
      { role: "assistant", type: "text", toolName: undefined, toolSource: undefined },
    ]);
    expect(messages[1]!.toolUseId).toBe("st_dt_1");
    expect(messages[2]!.content).toContain("UTC");
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

  it("prefers transcript.jsonl over the state.json/request.json path when present", async () => {
    const { writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    // Write BOTH a state.json-derived tree (which would yield "from state")
    // and a transcript.jsonl (which yields "from transcript") — the
    // transcript must win.
    const sessionDir = writeSession("sess_pref", {
      cwd: "/work",
      messages: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "from state" }] }],
      firstPrompt: "u from state",
    });
    writeFileSync(
      join(sessionDir, "transcript.jsonl"),
      [
        JSON.stringify({ v: 1, sessionId: "sess_pref", ts: "2026-05-27T10:00:00Z", kind: "user", text: "u from transcript" }),
        JSON.stringify({
          v: 1,
          sessionId: "sess_pref",
          ts: "2026-05-27T10:01:00Z",
          kind: "assistant",
          turnNumber: 1,
          requestId: "req_t",
          model: "anthropic/claude-3-5-sonnet",
          text: "from transcript",
          usage: { prompt: 1, completion: 1 },
          costUsd: 0.0001,
          durationMs: 500,
        }),
      ].join("\n"),
    );

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_pref"]);
    expect(messages).toEqual([
      { role: "user", type: "text", content: "u from transcript", timestamp: "2026-05-27T10:00:00Z" },
      {
        role: "assistant",
        type: "text",
        content: "from transcript",
        timestamp: "2026-05-27T10:01:00Z",
        model: "anthropic/claude-3-5-sonnet",
        requestId: "req_t",
        // generationKey = "<requestId>/<turnNumber>": unique per-generation identity
        // used by the debug panel to list each intra-cycle model call as its own row.
        generationKey: "req_t/1",
        costUsd: 0.0001,
        durationMs: 500,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
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

  it("searchSessions excludes sessions in ignored project folders", async () => {
    await pointSettingsAtTmp();
    await setIgnoredFolder((folder) => folder === "/tmp/quick");
    writeSession("sess_visible", { cwd: "/proj", firstPrompt: "find the bug" });
    writeSession("sess_ignored", { cwd: "/tmp/quick", firstPrompt: "find the bug" });
    const provider = new OpenRouterSessionProvider();
    const res = provider.searchSessions({ folder: "", grep: "find" });
    expect(res.chats.map((c) => c.sessionId)).toEqual(["sess_visible"]);
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

describe("OpenRouterSessionProvider — per-cycle response metadata", () => {
  async function writeCycleWithResponse(
    sessionId: string,
    reqName: string,
    opts: {
      prompt: string;
      requestTimestamp: string;
      responseTimestamp: string;
      response: Record<string, unknown>;
    },
  ): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const sessionDir = join(TMP_LOGS, sessionId);
    const reqDir = join(sessionDir, reqName);
    mkdirSync(reqDir, { recursive: true });
    writeFileSync(
      join(reqDir, "request.json"),
      JSON.stringify({ sessionId, requestId: reqName, prompt: opts.prompt, timestamp: opts.requestTimestamp }),
    );
    const genDir = join(reqDir, "gen_001");
    mkdirSync(genDir);
    writeFileSync(
      join(genDir, "response.json"),
      JSON.stringify({
        sessionId,
        requestId: reqName,
        generationId: "gen_001",
        timestamp: opts.responseTimestamp,
        response: opts.response,
      }),
    );
    return sessionDir;
  }

  it("attaches model, usage, cost, requestId, serviceTier, geo, stopReason to assistant messages", async () => {
    const { writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_meta", {
      cwd: "/work",
      messages: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer" }] },
      ],
    });
    // Overwrite state.json to drop the {role:"user", content:"hi"} shape —
    // writeSession's `messages` is used as-is; we set only the assistant
    // item so the test reads cleanly.
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: "sess_meta", messages: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer" }] },
      ] }),
    );
    await writeCycleWithResponse("sess_meta", "req_aaa", {
      prompt: "what is the answer?",
      requestTimestamp: "2026-05-26T17:00:00Z",
      responseTimestamp: "2026-05-26T17:00:03Z",
      response: {
        model: "anthropic/claude-sonnet-4-6",
        serviceTier: "standard",
        status: "completed",
        usage: {
          inputTokens: 1234,
          outputTokens: 700,
          inputTokensDetails: { cachedTokens: 1000 },
          outputTokensDetails: { reasoningTokens: 50 },
          cost: 0.0042,
        },
        openrouterMetadata: { region: "us-east" },
      },
    });

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_meta"]);

    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.model).toBe("anthropic/claude-sonnet-4-6");
    expect(assistant.requestId).toBe("req_aaa");
    expect(assistant.timestamp).toBe("2026-05-26T17:00:03Z");
    expect(assistant.serviceTier).toBe("standard");
    expect(assistant.inferenceGeo).toBe("us-east");
    expect(assistant.stopReason).toBe("end_turn");
    expect(assistant.costUsd).toBeCloseTo(0.0042, 6);
    // input_tokens reported as fresh (inputTokens - cachedTokens)
    expect(assistant.usage).toEqual({
      input_tokens: 234,
      output_tokens: 700,
      cache_read_input_tokens: 1000,
      reasoning_tokens: 50,
    });
  });

  it("maps incomplete responses' reason onto stopReason", async () => {
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_incomplete", { cwd: "/work" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: "sess_incomplete", messages: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "truncated" }] },
      ] }),
    );
    await writeCycleWithResponse("sess_incomplete", "req_x", {
      prompt: "go",
      requestTimestamp: "2026-05-26T17:00:00Z",
      responseTimestamp: "2026-05-26T17:00:03Z",
      response: {
        model: "anthropic/claude-sonnet-4-6",
        status: "incomplete",
        incompleteDetails: { reason: "max_output_tokens" },
        usage: { inputTokens: 100, outputTokens: 4096 },
      },
    });

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_incomplete"]);
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.stopReason).toBe("max_output_tokens");
  });

  it("picks the latest gen_*/response.json when multiple exist (intra-cycle turns)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_multi_gen", { cwd: "/work" });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: "sess_multi_gen", messages: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ] }),
    );
    const reqDir = join(sessionDir, "req_multi");
    mkdirSync(reqDir);
    writeFileSync(
      join(reqDir, "request.json"),
      JSON.stringify({ sessionId: "sess_multi_gen", requestId: "req_multi", prompt: "go", timestamp: "2026-05-26T17:00:00Z" }),
    );
    const gen1 = join(reqDir, "gen_001");
    mkdirSync(gen1);
    writeFileSync(
      join(gen1, "response.json"),
      JSON.stringify({
        sessionId: "sess_multi_gen", requestId: "req_multi", generationId: "gen_001",
        timestamp: "2026-05-26T17:00:01Z",
        response: { model: "intermediate-model", status: "completed", usage: { inputTokens: 10, outputTokens: 10 } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const gen2 = join(reqDir, "gen_002");
    mkdirSync(gen2);
    writeFileSync(
      join(gen2, "response.json"),
      JSON.stringify({
        sessionId: "sess_multi_gen", requestId: "req_multi", generationId: "gen_002",
        timestamp: "2026-05-26T17:00:02Z",
        response: { model: "final-model", status: "completed", usage: { inputTokens: 100, outputTokens: 200 } },
      }),
    );

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_multi_gen"]);
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.model).toBe("final-model");
    expect(assistant.usage).toMatchObject({ input_tokens: 100, output_tokens: 200 });
  });

  it("decorates assistant messages but not tool-result rows", async () => {
    const { writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_tool", { cwd: "/work" });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: "sess_tool", messages: [
        { type: "function_call", callId: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", callId: "c1", output: "contents" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ] }),
    );
    await writeCycleWithResponse("sess_tool", "req_t", {
      prompt: "read file",
      requestTimestamp: "2026-05-26T17:00:00Z",
      responseTimestamp: "2026-05-26T17:00:01Z",
      response: { model: "m", status: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
    });

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_tool"]);
    const toolResult = messages.find((m) => m.type === "tool_result")!;
    const toolUse = messages.find((m) => m.type === "tool_use")!;
    const finalText = messages.find((m) => m.type === "text" && m.role === "assistant")!;

    expect(toolResult.usage).toBeUndefined();
    expect(toolResult.model).toBeUndefined();
    // Both assistant-side rows (tool_use + text) carry the metadata.
    expect(toolUse.model).toBe("m");
    expect(finalText.model).toBe("m");
  });

  it("handles a missing response.json gracefully (in-flight cycle)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_pending", { cwd: "/work", messages: [] });
    const reqDir = join(sessionDir, "req_pending");
    mkdirSync(reqDir);
    writeFileSync(
      join(reqDir, "request.json"),
      JSON.stringify({ sessionId: "sess_pending", requestId: "req_pending", prompt: "in flight", timestamp: "2026-05-26T17:00:00Z" }),
    );

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_pending"]);
    expect(messages).toEqual([
      { role: "user", type: "text", content: "in flight", timestamp: "2026-05-26T17:00:00Z" },
    ]);
  });

  it("omits inferenceGeo when openrouterMetadata.region is empty", async () => {
    const { writeFileSync } = await import("node:fs");
    await pointSettingsAtTmp();
    const sessionDir = writeSession("sess_no_geo", { cwd: "/work" });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: "sess_no_geo", messages: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ] }),
    );
    await writeCycleWithResponse("sess_no_geo", "req_g", {
      prompt: "go",
      requestTimestamp: "2026-05-26T17:00:00Z",
      responseTimestamp: "2026-05-26T17:00:01Z",
      response: {
        model: "m",
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 1 },
        openrouterMetadata: { region: "" },
      },
    });

    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_no_geo"]);
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.inferenceGeo).toBeUndefined();
  });
});
