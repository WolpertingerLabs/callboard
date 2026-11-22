/**
 * An aside asked without quotes (`forkAtLatest`) against the REAL Claude Code
 * session provider: the route picks the fork point from the provider's own
 * parse of the log, and the provider's cut at that point copies the whole log
 * — including a turn still running, whose open tool_use is closed with a
 * synthetic interrupted tool_result so the aside resumes cleanly.
 *
 * Real chat records in a temp data dir and real JSONL in a temp projects dir;
 * only the first turn's start is stubbed (it is covered end to end by
 * chats.fork-aside.integration.test.ts).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const dataDir = mkdtempSync(join(tmpdir(), "cb-aside-latest-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const projectsDir = mkdtempSync(join(tmpdir(), "cb-aside-latest-projects-"));
const projDir = join(projectsDir, "proj");
mkdirSync(projDir, { recursive: true });
const h = vi.hoisted(() => ({ projectsDir: "" }));
h.projectsDir = projectsDir;

vi.mock("../utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/paths.js")>();
  return {
    ...actual,
    get CLAUDE_PROJECTS_DIR() {
      return h.projectsDir;
    },
    listClaudeProjectDirs: () => ["proj"],
  };
});
const turns = vi.hoisted(() => [] as any[]);
vi.mock("../services/chat-turn.js", () => ({
  startChatTurn: async (req: unknown) => {
    turns.push(req);
    return { ok: true, emitter: {} };
  },
}));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { setSessionProvidersForTesting } = await import("../agents/factory.js");
const { ClaudeCodeSessionProvider } = await import("../agents/adapters/claude-code/ClaudeCodeSessionProvider.js");

afterAll(() => {
  setSessionProvidersForTesting(null);
  for (const dir of [dataDir, projectsDir]) rmSync(dir, { recursive: true, force: true });
});

const forkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/fork" && layer.route.methods.post).route.stack[0].handle;

function post(id: string, body: Record<string, unknown>): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    forkHandler({ params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

describe("POST /:id/fork kind aside, forkAtLatest — real Claude Code session provider", () => {
  it("forks a log that ends in an open tool_use into a resumable session", async () => {
    const provider = new ClaudeCodeSessionProvider();
    setSessionProvidersForTesting([provider]);
    const sid = "parent-sess";
    const line = (uuid: string, parentUuid: string | null, timestamp: string, type: "user" | "assistant", content: unknown) => ({
      type,
      message: { role: type, content },
      uuid,
      parentUuid,
      timestamp,
      sessionId: sid,
    });
    // A turn still running: its last line is a tool call with no result yet.
    const lines = [
      line("u1", null, "2026-01-01T00:00:00.000Z", "user", "list the files"),
      line("a1", "u1", "2026-01-01T00:00:01.000Z", "assistant", [{ type: "text", text: "Looking." }]),
      line("a2", "a1", "2026-01-01T00:00:02.000Z", "assistant", [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }]),
    ];
    writeFileSync(join(projDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const parent = chatFileService.createChat("/repo", sid, JSON.stringify({ title: "Parent", session_ids: [sid] }));

    const res = await post(parent.id, { kind: "aside", forkAtLatest: true, prompt: "what is it doing?" });

    expect(res.code).toBe(201);
    expect(res.body.started).toBe(true);
    const meta = JSON.parse(res.body.metadata);
    expect(meta).toMatchObject({ chatRole: "aside", forkedAt: "2026-01-01T00:00:02.000Z", title: "Aside: what is it doing?" });
    expect(meta).not.toHaveProperty("asideQuotes");
    expect(turns[0]).toMatchObject({ chatId: res.body.id, prompt: "what is it doing?" });

    // The whole log came across, and the open call was closed the way the
    // SDK closes an interrupted one — so every tool_use has its result.
    const forked = readFileSync(join(projDir, `${res.body.session_id}.jsonl`), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(forked.map((l) => l.uuid).slice(0, 3)).toEqual(["u1", "a1", "a2"]);
    expect(forked.every((l) => l.sessionId === res.body.session_id)).toBe(true);
    const closing = forked[3];
    expect(closing.message.content).toEqual([{ type: "tool_result", tool_use_id: "tool-1", content: "[Request interrupted by user]", is_error: true }]);
    expect(closing.parentUuid).toBe("a2");
  });
});
