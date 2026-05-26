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
    writeSession("sess_main");
    writeSession("sess_main:sub:child1");
    const provider = new OpenRouterSessionProvider();
    const result = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["sess_main"]);
  });

  it("paginates by mtime DESC", async () => {
    await pointSettingsAtTmp();
    writeSession("first");
    writeSession("second");
    writeSession("third");
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
  it("parses state.json into ParsedMessage[]", async () => {
    await pointSettingsAtTmp();
    writeSession("sess_q", {
      cwd: "/work",
      messages: [
        { role: "user", content: "hi" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    });
    const provider = new OpenRouterSessionProvider();
    const messages = provider.parseSessionMessages(["sess_q"]);
    expect(messages).toEqual([
      { role: "user", type: "text", content: "hi" },
      { role: "assistant", type: "text", content: "hello" },
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
