/**
 * Every send path records the git trail.
 *
 * The trail hangs off the session registry, and the only thing that registers
 * a chat turn is `claude.ts`'s `sendMessage`. So "every path records" is
 * three facts, each pinned here:
 *
 *   1. A real `sendMessage` run — existing chat or new — records the trail.
 *   2. Every send path reaches that same `sendMessage`: the HTTP routes and
 *      the queue import it directly; `continue_chat` / `start_chat_session`
 *      (callboard-tools), the agent tools, triggers and cron (agent-executor)
 *      and job steps (job-runner) are handed it by `claude.ts` at load — the
 *      handoff is intercepted below and compared by identity.
 *   3. Nothing else registers a session (besides the CLI watcher, which the
 *      hook also records), so no path can run a turn around the registry.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-trail-send-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "callboard-trail-send-"))), "repo");
execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "pipe" });

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

/** The sender each indirect path was handed when claude.ts loaded. */
const handed = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./callboard-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./callboard-tools.js")>();
  return { ...actual, setCallboardMessageSender: (fn: never) => (handed.set("callboard-tools", fn), actual.setCallboardMessageSender(fn)) };
});
vi.mock("./agent-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-tools.js")>();
  return { ...actual, setMessageSender: (fn: never) => (handed.set("agent-tools", fn), actual.setMessageSender(fn)) };
});
vi.mock("./agent-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-executor.js")>();
  return { ...actual, setExecutorMessageSender: (fn: never) => (handed.set("agent-executor", fn), actual.setExecutorMessageSender(fn)) };
});
vi.mock("./job-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-runner.js")>();
  return {
    ...actual,
    setJobRunnerDeps: (deps: { sendMessage: unknown }) => (handed.set("job-runner", deps.sendMessage), actual.setJobRunnerDeps(deps as never)),
  };
});

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { parseGitTrail } = await import("./git-trail.js");

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

let sessionCounter = 0;

async function run(opts: Record<string, unknown>): Promise<string> {
  const sessionId = `trail-sess-${++sessionCounter}`;
  const events: AgentEvent[] = [
    { type: "session_started", sessionId },
    { type: "text", content: "ok" },
    { type: "result", status: "success" },
  ];
  setAgentProviderForTesting(new MockAgentProvider({ events }));
  const emitter = await sendMessage({ prompt: "go", ...opts } as never);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  // The recorder runs a tick after the registry event.
  await new Promise((r) => setTimeout(r, 20));
  return sessionId;
}

const trailOf = (sessionId: string) => parseGitTrail(JSON.parse(chatFileService.getChatBySessionId(sessionId)!.metadata || "{}").gitTrail);

describe("sendMessage records the git trail", () => {
  it("for a new chat", async () => {
    const sessionId = await run({ folder: repo });
    expect(trailOf(sessionId)).toEqual([expect.objectContaining({ cwd: repo, repoPath: repo, branch: "main" })]);
  });

  it("for an existing chat, adding the branch it has moved to", async () => {
    const first = await run({ folder: repo });
    const chat = chatFileService.getChatBySessionId(first)!;
    execFileSync("git", ["checkout", "-q", "-b", "feat/later"], { cwd: repo });
    try {
      // Same chat, next turn — what the HTTP route, the queue, continue_chat and
      // a job step all do: sendMessage with the chat's id.
      const second = await run({ chatId: chat.id });
      const record = chatFileService.getChat(chat.id) ?? chatFileService.getChatBySessionId(second)!;
      expect(parseGitTrail(JSON.parse(record.metadata).gitTrail).map((e) => e.branch)).toEqual(["main", "feat/later"]);
    } finally {
      execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
    }
  });
});

describe("every send path reaches that sendMessage", () => {
  it.each(["callboard-tools", "agent-tools", "agent-executor", "job-runner"])("%s is handed claude.ts's sendMessage", (module) => {
    expect(handed.get(module)).toBe(sendMessage);
  });

  it("the HTTP routes and the queue import it from claude.ts", () => {
    for (const route of ["stream.ts", "chats.ts", "queue.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", "routes", route), "utf8");
      expect(source, route).toMatch(/import \{[^}]*\bsendMessage\b[^}]*\} from "\.\.\/services\/claude\.js"/);
    }
  });

  it("nothing but sendMessage and the CLI watcher registers a session", () => {
    const root = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && /sessionRegistry\.(register|migrate)\(/.test(readFileSync(path, "utf8"))) {
          offenders.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(["services/claude.ts", "services/cli-watcher.ts"]);
  });
});
