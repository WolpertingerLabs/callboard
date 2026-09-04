/**
 * `start_chat_session` model inheritance — the end-to-end slice of
 * plans/callboard-chat-default-current-model.md: when the caller omits
 * `model`, the child spawn receives the calling chat's current per-chat model
 * override (metadata.model) and the tool result reports where the model came
 * from. The resolver itself is covered exhaustively in
 * tool-provider-args.test.ts; this file proves the wiring — the getter opts
 * thread from the spec builder into the resolver, and the resolved model
 * reaches sendMessage and the result JSON.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-tools-start-chat-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });

const CALLER_CHAT_ID = "caller-chat";

// Same cycle break as callboard-tools.card.test.ts: callboard-tools imports
// claude.ts, which registers back into it at module load.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { buildCallboardToolsSpec, setCallboardMessageSender } = await import("./callboard-tools.js");
const { chatFileService } = await import("./chat-file-service.js");
import type { ToolDefinition } from "../agents/ports/tools.js";

function writeCallerChat(metadata: Record<string, unknown>): void {
  const chat: Chat = {
    id: CALLER_CHAT_ID,
    folder: "/tmp/project",
    session_id: CALLER_CHAT_ID,
    session_log_path: null,
    metadata: JSON.stringify(metadata),
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as Chat;
  writeFileSync(join(chatsDir, `${CALLER_CHAT_ID}.json`), JSON.stringify(chat, null, 2));
}

function startChat(): ToolDefinition<any> {
  // Mirrors the spec claude.ts builds: the engine this session runs on, plus
  // the live model-override getter over the chat record.
  const spec = buildCallboardToolsSpec(() => CALLER_CHAT_ID, undefined, {
    includeJobTools: false,
    provider: "codex",
    getModel: () => chatFileService.getModelOverride(CALLER_CHAT_ID),
  });
  const found = spec.tools.find((t) => t.name === "start_chat_session");
  if (!found) throw new Error("start_chat_session not found");
  return found as ToolDefinition<any>;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0].text!);
}

/** Records every send, and answers the chat_created handshake. */
function stubSender(): { calls: any[] } {
  const calls: any[] = [];
  setCallboardMessageSender(async (opts) => {
    calls.push(opts);
    const emitter = new EventEmitter();
    // Macrotask, not microtask: the caller attaches its chat_created listener
    // in the continuation after this promise resolves, and a queued microtask
    // would fire before that.
    setTimeout(() => emitter.emit("event", { type: "chat_created", chatId: "child-chat" }), 0);
    return emitter;
  });
  return { calls };
}

describe("start_chat_session model inheritance", () => {
  it("passes the caller's current model to the child and reports it as inherited", async () => {
    writeCallerChat({ model: "gpt-5.5" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project" }));

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toMatchObject({ provider: "codex", model: "gpt-5.5", folder: "/tmp/project" });
    expect(result).toMatchObject({ chatId: "child-chat", status: "started", model: "gpt-5.5", modelSource: "inherited" });
    expect(result.inheritanceNote).toBeUndefined();
  });

  it("passes no model when the caller has no override, and reports the default", async () => {
    writeCallerChat({ title: "no model pinned" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project" }));

    expect(sender.calls).toHaveLength(1);
    // No model key at all — the child stays dynamic on the provider default.
    expect(sender.calls[0].model).toBeUndefined();
    expect("model" in sender.calls[0]).toBe(false);
    expect(result).toMatchObject({ status: "started", modelSource: "default" });
    expect(result.model).toBeUndefined();
    expect(result.inheritanceNote).toBeUndefined();
  });

  it("lets an explicit model win over the caller's override", async () => {
    writeCallerChat({ model: "gpt-5.5" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", model: "gpt-5.2" }));

    expect(sender.calls[0]).toMatchObject({ model: "gpt-5.2" });
    expect(result).toMatchObject({ model: "gpt-5.2", modelSource: "explicit" });
  });

  it("does not leak a raw model id across engines and reports why", async () => {
    writeCallerChat({ model: "gpt-5.5" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", provider: "claude-code" }));

    expect(sender.calls[0]).toMatchObject({ provider: "claude-code" });
    expect("model" in sender.calls[0]).toBe(false);
    expect(result).toMatchObject({ modelSource: "default", inheritanceNote: expect.stringContaining("gpt-5.5") });
    expect(result.model).toBeUndefined();
  });

  /**
   * The tool has no `is_git_repo` gate — the UI's, which guards the HTTP route,
   * is not in this path at all. So `resolveBranch`'s non-repo no-op landed here
   * as a chatId with no worktree and nothing saying so: `{ok: true}` carrying
   * the folder unchanged is indistinguishable from "no worktree was asked for".
   * It threw before this PR, and the tool reported the throw.
   */
  it("reports a worktree it could not create instead of starting the session anyway", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();
    const plain = mkdtempSync(join(tmpdir(), "callboard-tools-not-a-repo-"));

    const result = payload(await startChat().handler({ prompt: "go", folder: plain, useWorktree: true, newBranch: "feat/x" }));

    expect(result).toMatchObject({ ok: false, error: "not_a_git_repo" });
    expect(result.message).toContain(plain);
    // And no child: a session started in the unisolated folder is the outcome
    // the agent asked not to have.
    expect(sender.calls).toHaveLength(0);
  });

  it("reads the model live: a record written after the spec was built is seen", async () => {
    // The getter is built once at spec time but must consult the record at
    // tool-call time — a model switch mid-session changes what the next
    // spawned child runs on.
    writeCallerChat({ model: "gpt-5.5" });
    const sender = stubSender();
    await startChat().handler({ prompt: "go", folder: "/tmp/project" });
    expect(sender.calls[0]).toMatchObject({ model: "gpt-5.5" });

    writeCallerChat({ model: "gpt-5.2" });
    await startChat().handler({ prompt: "go again", folder: "/tmp/project" });
    expect(sender.calls[1]).toMatchObject({ model: "gpt-5.2" });
  });
});
