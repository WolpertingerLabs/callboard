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
import { execFileSync } from "node:child_process";
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

/** The text the child is actually started with — the prompt iterable, drained. */
async function promptText(sent: { prompt: AsyncIterable<any> }): Promise<string> {
  let text = "";
  for await (const message of sent.prompt) text += message.message.content;
  return text;
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

  /**
   * The same silence, in a real repository. `useWorktree` is the only one of
   * the three branch fields the schema requires an agent to think about — the
   * other two are optional and easy to leave off — and without a branch to
   * create or check out, every rung of `resolveBranch` was skipped and the
   * request came back as a chatId in the caller's own checkout.
   *
   * This one is only reachable here: the branch box always sends a base branch
   * or an `autoCreateBranch` the route turns into a name (see
   * `stream.branch-config.test.ts`).
   */
  it("reports a worktree with no branch instead of starting the session in the checkout", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();
    const repo = mkdtempSync(join(tmpdir(), "callboard-tools-bare-worktree-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });

    const result = payload(await startChat().handler({ prompt: "go", folder: repo, useWorktree: true }));

    expect(result).toMatchObject({ ok: false, error: "no_branch_for_worktree" });
    expect(result.message).toContain(repo);
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

/**
 * `independent` drops the tree edge, and only the tree edge.
 *
 * A spawned chat was unconditionally filed under its spawner, which makes it a
 * node in someone else's card rather than a card of its own — there was no way
 * for an agent to start top-level work. The other two paths to "detached" are
 * both worse: the HTTP route can do it but no tool exposes it, and `deploy_agent`
 * marks its chats `triggered`, which makes them card-ineligible outright.
 *
 * The distinction these tests hold is breadcrumb vs edge. The child is still
 * *told* who spawned it — that line is how it reaches back across engines, and
 * dropping it would strand a detached child with no way to find its caller — it
 * is just not filed underneath them. Everything hanging off the caller's id
 * rather than off the parentage link (onComplete, above all) keeps working.
 */
describe("start_chat_session independent spawns", () => {
  it("files the child under the caller by default", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", role: "subagent" }));

    expect(sender.calls[0]).toMatchObject({ parentChatId: CALLER_CHAT_ID, chatRole: "subagent" });
    expect(result).toMatchObject({ parentChatId: CALLER_CHAT_ID, role: "subagent" });
    expect(result.independent).toBeUndefined();
  });

  it("omits the parent link when independent, and says so in the result", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", independent: true }));

    // No edge: the route only links when it is handed a parent id, so the key
    // must be absent, not undefined.
    expect("parentChatId" in sender.calls[0]).toBe(false);
    expect("chatRole" in sender.calls[0]).toBe(false);
    // And the result distinguishes a deliberate detach from the other way the
    // link goes missing — a caller with no stored record, which reports neither.
    expect(result).toMatchObject({ chatId: "child-chat", status: "started", independent: true, spawnedBy: CALLER_CHAT_ID });
    expect(result.parentChatId).toBeUndefined();
  });

  it("keeps the spawner breadcrumb in the prompt when detached, marked as not a parent", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();

    await startChat().handler({ prompt: "do the thing", folder: "/tmp/project", independent: true });

    const text = await promptText(sender.calls[0]);
    expect(text).toContain("do the thing");
    // The pointer survives: a detached child can still read its spawner.
    expect(text).toContain(`Spawned by chat ${CALLER_CHAT_ID}`);
    expect(text).toContain(`read_session_messages with chatId "${CALLER_CHAT_ID}"`);
    // But it is told the edge is not there, so a get_chat_tree over itself
    // returning a lone root does not read as a stale or broken breadcrumb.
    expect(text).toContain("not linked to it");
  });

  it("still registers the onComplete callback against the caller when detached", async () => {
    // The one collapse a future refactor would plausibly make: onComplete hangs
    // off getChatId(), not off the parentage link, and folding it into the
    // `parentChat &&` branch would silently strand every detached spawn — the
    // spawner would wait for a notification that was never registered.
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", independent: true, onComplete: true }));

    expect("parentChatId" in sender.calls[0]).toBe(false);
    expect(result.onComplete).toMatchObject({ registered: true });
  });

  it("refuses a role on an independent spawn instead of dropping the label", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", independent: true, role: "subagent" }));

    expect(result).toMatchObject({ ok: false, error: "role_requires_parent" });
    // Refused before the spawn, not after: a started session the caller has to
    // clean up is a worse answer than an error it can retry.
    expect(sender.calls).toHaveLength(0);
  });

  it("treats independent:false as the default rather than a detach", async () => {
    writeCallerChat({ title: "spawner" });
    const sender = stubSender();

    const result = payload(await startChat().handler({ prompt: "go", folder: "/tmp/project", independent: false }));

    expect(sender.calls[0]).toMatchObject({ parentChatId: CALLER_CHAT_ID });
    expect(result).toMatchObject({ parentChatId: CALLER_CHAT_ID });
    expect(result.independent).toBeUndefined();
  });
});
