/**
 * "Parent can answer": list_pending_requests / respond_to_request, the wait
 * notification, and start_chat_session's review-setting inheritance.
 *
 * Prompts are parked straight into `pendingRequests` in the shape
 * buildCanUseTool leaves them (claude.permissionReview.test.ts covers that
 * side), so each refusal can be pinned on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";
import type { DefaultPermissions, PermissionReviewSettings, StreamEvent } from "shared/types/index.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-parent-answers-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });

vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { buildCallboardToolsSpec, setCallboardMessageSender } = await import("./callboard-tools.js");
const { pendingRequests, respondToPermission } = await import("./pending-requests.js");
const { __resetActivityState } = await import("./chat-activity.js");
const { sessionRegistry } = await import("./session-registry.js");
const { notifyParentOfChildPrompt } = await import("./parent-answers.js");
import type { PendingRequest } from "./pending-requests.js";
import type { ToolDefinition } from "../agents/ports/tools.js";

const ALLOW_ALL: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" };
const ASK_EXEC: DefaultPermissions = { ...ALLOW_ALL, codeExecution: "ask" };

function writeChat(id: string, metadata: Record<string, unknown>): void {
  const chat = {
    id,
    folder: "/tmp/project",
    session_id: id,
    session_log_path: null,
    metadata: JSON.stringify(metadata),
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as Chat;
  writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify(chat, null, 2));
}

function tool(name: string, callerId: string, opts: { permissions?: DefaultPermissions; review?: PermissionReviewSettings } = {}): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => callerId, undefined, {
    includeJobTools: false,
    provider: "claude-code",
    getPermissions: () => opts.permissions ?? ALLOW_ALL,
    ...(opts.review && { getReviewSettings: () => opts.review! }),
  });
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not found`);
  return found as ToolDefinition<any>;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0].text!);
}

/** Park a prompt as buildCanUseTool would after offering it to `offeredToParent`. */
function park(chatId: string, overrides: Partial<PendingRequest> = {}): { resolve: ReturnType<typeof vi.fn>; requestId: string } {
  const resolve = vi.fn();
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  pendingRequests.set(chatId, {
    toolName: "Bash",
    input: { command: "npm test" },
    eventType: "permission_request",
    eventData: {},
    resolve,
    requestId,
    category: "codeExecution",
    offeredToParent: "parent",
    reviewerNotes: "Model reviewer — escalate: unsure",
    ...overrides,
  });
  return { resolve, requestId };
}

beforeEach(() => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  // root → parent → child (parentAnswers on); stranger is unrelated.
  writeChat("root", { title: "root" });
  writeChat("parent", { title: "parent", parentChatId: "root" });
  writeChat("child", { title: "child task", parentChatId: "parent", parentAnswers: true });
  writeChat("stranger", { title: "stranger" });
  writeChat("quiet-child", { title: "quiet", parentChatId: "parent" });
});

afterEach(() => {
  pendingRequests.clear();
  __resetActivityState();
});

describe("list_pending_requests", () => {
  it("lists a descendant's offered prompt with reviewer notes", async () => {
    const { requestId } = park("child");
    const result = payload(await tool("list_pending_requests", "parent").handler({}));
    expect(result.requests).toEqual([
      expect.objectContaining({ chatId: "child", title: "child task", requestId, toolName: "Bash", category: "codeExecution", reviewerNotes: expect.stringContaining("escalate") }),
    ]);
  });

  it("an ancestor further up sees it too; an unrelated chat does not", async () => {
    park("child");
    expect(payload(await tool("list_pending_requests", "root").handler({})).count).toBe(1);
    expect(payload(await tool("list_pending_requests", "stranger").handler({})).count).toBe(0);
  });

  it("omits human-only, un-offered and non-permission prompts", async () => {
    park("child", { humanOnly: true, reviewerVerdict: "kill" });
    park("quiet-child", { offeredToParent: undefined });
    expect(payload(await tool("list_pending_requests", "parent").handler({})).count).toBe(0);
  });
});

describe("respond_to_request — checks", () => {
  const respond = (callerId: string, args: Record<string, unknown>, permissions?: DefaultPermissions) =>
    tool("respond_to_request", callerId, { permissions }).handler({ reason: "looks fine", ...args }).then(payload);

  it("allows a descendant's prompt within the ceiling", async () => {
    const { resolve, requestId } = park("child");
    const emitter = new EventEmitter();
    const events: StreamEvent[] = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));
    sessionRegistry.register("child", { type: "web", abortController: new AbortController(), emitter, closeQuery: async () => {} });
    try {
      await expect(respond("parent", { chatId: "child", requestId, allow: true })).resolves.toMatchObject({ ok: true, allowed: true });
      expect(resolve).toHaveBeenCalledWith({ behavior: "allow", updatedInput: { command: "npm test" } });
      expect(pendingRequests.has("child")).toBe(false);
      // The human's open panel is told who answered.
      expect(events.find((e) => e.promptResolved)?.promptResolved).toMatchObject({ requestId, allowed: true });
    } finally {
      sessionRegistry.unregister("child");
    }
  });

  it("a deny reaches the child with the reason, without interrupting", async () => {
    const { resolve, requestId } = park("child");
    await expect(respond("parent", { chatId: "child", requestId, allow: false, reason: "use the test script" })).resolves.toMatchObject({ ok: true });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny", interrupt: false, message: expect.stringContaining("use the test script") }));
  });

  it("refuses a non-descendant", async () => {
    const { resolve, requestId } = park("child");
    await expect(respond("stranger", { chatId: "child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "not_descendant" });
    expect(resolve).not.toHaveBeenCalled();
    expect(pendingRequests.has("child")).toBe(true);
  });

  it("refuses a wrong requestId", async () => {
    const { resolve } = park("child");
    await expect(respond("parent", { chatId: "child", requestId: "stale", allow: true })).resolves.toMatchObject({ ok: false, error: "stale_request" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses when the child has parentAnswers off (re-read live)", async () => {
    const { requestId } = park("child");
    writeChat("child", { title: "child task", parentChatId: "parent" });
    await expect(respond("parent", { chatId: "child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "parent_answers_off" });
  });

  it("refuses a prompt that was never offered", async () => {
    const { requestId } = park("quiet-child", { offeredToParent: undefined });
    await expect(respond("parent", { chatId: "quiet-child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "parent_answers_off" });
  });

  it("refuses to ALLOW above the caller's own permission (ceiling), but still lets it deny", async () => {
    const { resolve, requestId } = park("child");
    const refused = await respond("parent", { chatId: "child", requestId, allow: true }, ASK_EXEC);
    expect(refused).toMatchObject({ ok: false, error: "permission_ceiling" });
    expect(refused.message).toMatch(/codeExecution permission is "ask"/);
    expect(resolve).not.toHaveBeenCalled();
    await expect(respond("parent", { chatId: "child", requestId, allow: false }, ASK_EXEC)).resolves.toMatchObject({ ok: true, allowed: false });
  });

  it("refuses to ALLOW an uncategorised call", async () => {
    const { requestId } = park("child", { category: null });
    await expect(respond("parent", { chatId: "child", requestId, allow: true })).resolves.toMatchObject({ ok: false, error: "permission_ceiling" });
  });

  it("refuses a human-only prompt (computer-use gate)", async () => {
    const { resolve, requestId } = park("child", { humanOnly: true });
    await expect(respond("parent", { chatId: "child", requestId, allow: true })).resolves.toMatchObject({ ok: false, error: "human_only" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a reviewer hard stop even to deny", async () => {
    const { requestId } = park("child", { humanOnly: true, reviewerVerdict: "kill" });
    const result = await respond("parent", { chatId: "child", requestId, allow: false });
    expect(result).toMatchObject({ ok: false, error: "human_only" });
    expect(result.message).toMatch(/HARD STOP/);
  });

  it("refuses questions and plan reviews", async () => {
    const { requestId } = park("child", { eventType: "user_question", toolName: "AskUserQuestion" });
    await expect(respond("parent", { chatId: "child", requestId, allow: true })).resolves.toMatchObject({ ok: false, error: "not_a_permission" });
  });
});

describe("first answer wins", () => {
  it("human first: the parent's answer is refused", async () => {
    const { resolve, requestId } = park("child");
    expect(respondToPermission("child", true, undefined, undefined, requestId).ok).toBe(true);
    const late = payload(await tool("respond_to_request", "parent").handler({ chatId: "child", requestId, allow: false, reason: "x" }));
    expect(late).toMatchObject({ ok: false, error: "not_found" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
  });

  it("parent first: the human's answer is refused", async () => {
    const { resolve, requestId } = park("child");
    payload(await tool("respond_to_request", "parent").handler({ chatId: "child", requestId, allow: false, reason: "no" }));
    expect(respondToPermission("child", true, undefined, undefined, requestId).ok).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe("notification", () => {
  it("ends the parent's wait early with a note naming the child and the tool", async () => {
    const wait = tool("wait", "parent").handler({ seconds: 300, flavor: "napping" });
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyParentOfChildPrompt("parent", "child", "Bash")).toBe(true);
    const result = payload(await wait);
    expect(result.endedEarly).toBe(true);
    expect(result.note).toMatch(/child chat child needs approval for Bash/);
    expect(result.note).toMatch(/list_pending_requests/);
  });

  it("a parent that is not waiting is left alone", () => {
    expect(notifyParentOfChildPrompt("parent", "child", "Bash")).toBe(false);
  });
});

describe("start_chat_session — review settings", () => {
  function stubSender(): { calls: any[] } {
    const calls: any[] = [];
    setCallboardMessageSender(async (opts) => {
      calls.push(opts);
      const emitter = new EventEmitter();
      setTimeout(() => emitter.emit("event", { type: "chat_created", chatId: "spawned" }), 0);
      return emitter;
    });
    return { calls };
  }

  it("a child inherits modelReview from the caller", async () => {
    const sender = stubSender();
    const result = payload(await tool("start_chat_session", "parent", { review: { modelReview: true, parentAnswers: false } }).handler({ prompt: "go", folder: "/tmp/project" }));
    expect(sender.calls[0]).toMatchObject({ modelReview: true });
    expect(result).toMatchObject({ modelReview: true, parentAnswers: false });
  });

  it("a caller without modelReview cannot turn it on for a child", async () => {
    const sender = stubSender();
    await tool("start_chat_session", "parent", { review: { modelReview: false, parentAnswers: false } }).handler({ prompt: "go", folder: "/tmp/project", modelReview: true });
    expect(sender.calls[0].modelReview).toBeUndefined();
  });

  it("parentAnswers is set by the new argument, for a linked child only", async () => {
    const sender = stubSender();
    await tool("start_chat_session", "parent").handler({ prompt: "go", folder: "/tmp/project", parentAnswers: true });
    expect(sender.calls[0]).toMatchObject({ parentAnswers: true, parentChatId: "parent" });
    await tool("start_chat_session", "parent").handler({ prompt: "go", folder: "/tmp/project", parentAnswers: true, independent: true });
    expect(sender.calls[1].parentAnswers).toBeUndefined();
  });
});
