/**
 * `GET /api/chats/:id/background-tasks/:toolUseId/tail`.
 *
 * The handler is pulled off the router stack and driven with a fake req/res,
 * like held.test.ts. The chat lookup is faked; the transcript, the engine
 * output file and the redirect targets are real files in a scratch dir.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const chats = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../utils/chat-lookup.js", () => ({ findChat: (id: string) => chats.get(id) ?? null }));
vi.mock("../utils/session-log.js", () => ({ findSessionLogPath: () => null }));

const base = mkdtempSync(join(tmpdir(), "bgtail-route-"));
process.env.CLAUDE_CODE_TMPDIR = base;

const { backgroundTasksRouter } = await import("./background-tasks.js");
const { clearToolCallCache } = await import("../services/background-tail/transcript-lookup.js");
const { claudeTasksRoot } = await import("../services/background-tail/engine-output.js");
const { folderToProjectDir } = await import("../utils/paths.js");

const SID = "f17cfdb7-ee9f-4481-9b84-e5e037683103";
const CWD = join(base, "proj");
const BG = "toolu_bg";
const DETACHED = "toolu_detached";
const PLAIN = "toolu_plain";
const READ = "toolu_read";
const TASK = "bh0skech1";

let outputFile: string;
let logDir: string;

function line(type: "assistant" | "user", content: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type, cwd: CWD, sessionId: SID, message: { role: type, content }, ...extra });
}

beforeAll(() => {
  mkdirSync(CWD, { recursive: true });
  logDir = join(base, "logs");
  mkdirSync(logDir);
  const root = claudeTasksRoot();
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const tasks = join(root, folderToProjectDir(CWD), SID, "tasks");
  mkdirSync(tasks, { recursive: true });
  outputFile = join(tasks, `${TASK}.output`);

  const transcript = join(base, `${SID}.jsonl`);
  const cmd = `L=${logDir}; nohup rsync -a src/ dst/ > $L/rsync.log 2> $L/rsync.err &`;
  writeFileSync(
    transcript,
    [
      line("assistant", [{ type: "tool_use", id: BG, name: "Bash", input: { command: `${cmd}\nsleep 60`, run_in_background: true } }]),
      line(
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: BG,
            content: `Command running in background with ID: ${TASK}. Output is being written to: ${outputFile}. You will be notified.`,
          },
        ],
        {
          toolUseResult: { backgroundTaskId: TASK },
        },
      ),
      line("assistant", [{ type: "tool_use", id: DETACHED, name: "Bash", input: { command: cmd } }]),
      line("user", [{ type: "tool_result", tool_use_id: DETACHED, content: "" }]),
      line("assistant", [{ type: "tool_use", id: PLAIN, name: "Bash", input: { command: "ls > files.txt" } }]),
      line("user", [{ type: "tool_result", tool_use_id: PLAIN, content: "" }]),
      line("assistant", [{ type: "tool_use", id: READ, name: "Read", input: { file_path: "/etc/hosts" } }]),
      line("user", [{ type: "tool_result", tool_use_id: READ, content: "" }]),
    ].join("\n") + "\n",
  );
  chats.set("chat-1", { id: "chat-1", folder: CWD, session_id: SID, session_log_path: transcript, metadata: JSON.stringify({ session_ids: [SID] }) });
  chats.set("chat-codex", { id: "chat-codex", folder: CWD, session_id: SID, metadata: JSON.stringify({ provider: "codex" }) });
  chats.set("chat-ambiguous", { id: "chat-ambiguous", folder: CWD, _provider_resolution_error: "ambiguous session owner" });
});

afterAll(() => {
  delete process.env.CLAUDE_CODE_TMPDIR;
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  clearToolCallCache();
  const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
  writeFileSync(outputFile, "engine line\n");
  utimesSync(outputFile, t(1), t(1));
  writeFileSync(join(logDir, "rsync.log"), "sent 1\nsent 2\n");
  utimesSync(join(logDir, "rsync.log"), t(5), t(5));
  writeFileSync(join(logDir, "rsync.err"), "warn\n");
  utimesSync(join(logDir, "rsync.err"), t(3), t(3));
});

type Handler = (req: Request, res: Response) => unknown;
const layer = (backgroundTasksRouter as any).stack.find((l: any) => l.route?.path === "/:id/background-tasks/:toolUseId/tail");
const handler: Handler = layer.route.stack[0].handle;

async function get(id: string, toolUseId: string, query: Record<string, string> = {}) {
  const state = { status: 200, body: undefined as any, headers: {} as Record<string, string> };
  const res = {
    set(k: string, v: string) {
      state.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  await handler({ params: { id, toolUseId }, query } as unknown as Request, res);
  return state;
}

describe("GET /:id/background-tasks/:toolUseId/tail", () => {
  it("returns every stream, picks the newest as default, and tails it", async () => {
    const r = await get("chat-1", BG);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.taskId).toBe(TASK);
    expect(r.body.streams.map((s: any) => [s.id, s.kind, s.label, s.exists])).toEqual([
      ["output", "engine", "output", true],
      ["r0", "redirect", "stdout → rsync.log", true],
      ["r1", "redirect", "stderr → rsync.err", true],
    ]);
    expect(r.body.defaultStream).toBe("r0");
    expect(r.body.tail).toMatchObject({ stream: "r0", lines: ["sent 1", "sent 2"] });
  });

  it("tails the requested stream", async () => {
    const r = await get("chat-1", BG, { stream: "output" });
    expect(r.body.tail).toMatchObject({ stream: "output", lines: ["engine line"] });
  });

  it("answers unchanged when since matches", async () => {
    const first = await get("chat-1", BG, { stream: "r1" });
    const since = `${first.body.tail.size}-${first.body.tail.mtimeMs}`;
    const again = await get("chat-1", BG, { stream: "r1", since });
    expect(again.body.tail).toEqual({ stream: "r1", size: first.body.tail.size, mtimeMs: first.body.tail.mtimeMs, unchanged: true });
    writeFileSync(join(logDir, "rsync.err"), "warn\nmore\n");
    const changed = await get("chat-1", BG, { stream: "r1", since });
    expect(changed.body.tail.lines).toEqual(["warn", "more"]);
  });

  it("serves a detached foreground launch with redirects", async () => {
    const r = await get("chat-1", DETACHED);
    expect(r.status).toBe(200);
    expect(r.body.taskId).toBeUndefined();
    expect(r.body.streams.map((s: any) => s.id)).toEqual(["r0", "r1"]);
  });

  it("reports a cleaned-up engine file as missing", async () => {
    rmSync(outputFile);
    const r = await get("chat-1", BG, { stream: "output" });
    expect(r.body.streams[0]).toMatchObject({ id: "output", exists: false, error: "missing" });
    expect(r.body.tail).toBeNull();
  });

  it("ignores a path= query parameter", async () => {
    const r = await get("chat-1", BG, { path: "/etc/passwd", stream: "output" });
    expect(r.body.tail.lines).toEqual(["engine line"]);
    expect(JSON.stringify(r.body)).not.toContain("/etc/passwd");
  });

  it.each([
    ["bad tool use id", "chat-1", "../etc", {}],
    ["bad stream", "chat-1", BG, { stream: "/etc/passwd" }],
    ["stream the call does not have", "chat-1", BG, { stream: "r5" }],
    ["bad chat id", "../x", BG, {}],
  ])("400 for a %s", async (_name, id, tool, query) => {
    expect((await get(id, tool, query as Record<string, string>)).status).toBe(400);
  });

  it("404 for an unknown chat", async () => {
    expect(await get("nope", BG)).toMatchObject({ status: 404, body: { error: "Not found" } });
  });

  it("404 for a non-Bash call, plain Bash, and an unknown call", async () => {
    for (const tool of [READ, PLAIN, "toolu_missing"]) {
      expect(await get("chat-1", tool)).toMatchObject({ status: 404, body: { error: "tool_call_not_found" } });
    }
  });

  it("404 for a Codex chat", async () => {
    expect(await get("chat-codex", BG)).toMatchObject({ status: 404, body: { error: "unsupported_provider" } });
  });

  it("409 when the session owner is ambiguous", async () => {
    expect((await get("chat-ambiguous", BG)).status).toBe(409);
  });
});
