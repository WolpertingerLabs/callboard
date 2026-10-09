/**
 * "Parent can answer": list_pending_requests / respond_to_request, the wait
 * notification, and start_chat_session's review settings.
 *
 * The scenario is the realistic one. A parent that allows codeExecution spawns
 * a child with `permissions: {codeExecution: "ask"}` and `parentAnswers: true`
 * — deliberate delegation — so the child's Bash asks are calls the parent has
 * the authority to approve. The child record is written from exactly what the
 * spawn handed sendMessage. A plain spawn (no `permissions`) is capped at the
 * parent's own policy, so a child of an asking parent asks where the parent
 * asks too: those prompts are deny-only for the parent, and must not wake it.
 *
 * Prompts are parked straight into `pendingRequests` in the shape
 * buildCanUseTool leaves them (claude.permissionReview.test.ts covers that
 * side), so each refusal can be pinned on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { chatFileService } = await import("./chat-file-service.js");
import type { PendingRequest } from "./pending-requests.js";
import type { ToolDefinition } from "../agents/ports/tools.js";
import type { SendMessageOptions } from "./claude.js";

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

/** The caller's live permissions are read from its stored record, as claude.ts does. */
function storedPermissions(id: string): DefaultPermissions | null {
  const chat = JSON.parse(readFileSync(join(chatsDir, `${id}.json`), "utf8"));
  return JSON.parse(chat.metadata).defaultPermissions ?? null;
}

function tool(name: string, callerId: string, opts: { review?: PermissionReviewSettings } = {}): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => callerId, undefined, {
    includeJobTools: false,
    provider: "claude-code",
    getPermissions: () => storedPermissions(callerId),
    ...(opts.review && { getReviewSettings: () => opts.review! }),
  });
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not found`);
  return found as ToolDefinition<any>;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0].text!);
}

function stubSender(childId = "spawned"): { calls: SendMessageOptions[] } {
  const calls: SendMessageOptions[] = [];
  setCallboardMessageSender(async (opts) => {
    calls.push(opts);
    const emitter = new EventEmitter();
    setTimeout(() => emitter.emit("event", { type: "chat_created", chatId: childId }), 0);
    return emitter;
  });
  return { calls };
}

/**
 * Spawn `childId` from `parentId` through the real tool, then persist the
 * child record from exactly what the tool handed sendMessage.
 */
async function spawn(parentId: string, childId: string, args: Record<string, unknown> = {}) {
  const sender = stubSender(childId);
  const result = payload(await tool("start_chat_session", parentId).handler({ prompt: "go", folder: "/tmp/project", ...args }));
  const sent = sender.calls[0];
  writeChat(childId, {
    title: `${childId} task`,
    defaultPermissions: sent.defaultPermissions,
    ...(sent.parentChatId && { parentChatId: sent.parentChatId }),
    ...(sent.parentAnswers && { parentAnswers: true }),
    ...(sent.modelReview && { modelReview: true }),
  });
  return { result, sent };
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

beforeEach(async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  // root → parent (allows everything) → child, spawned delegating codeExecution.
  writeChat("root", { title: "root", defaultPermissions: ALLOW_ALL });
  writeChat("parent", { title: "parent", parentChatId: "root", defaultPermissions: ALLOW_ALL });
  await spawn("parent", "child", { permissions: { codeExecution: "ask" }, parentAnswers: true });
  writeChat("stranger", { title: "stranger", defaultPermissions: ALLOW_ALL });
  await spawn("parent", "quiet-child", { permissions: { codeExecution: "ask" } });
  // An asking parent and its plain (capped) child: the child asks where the parent asks.
  writeChat("cautious", { title: "cautious", defaultPermissions: ASK_EXEC });
  await spawn("cautious", "capped-child", { parentAnswers: true });
});

afterEach(() => {
  pendingRequests.clear();
  __resetActivityState();
});

describe("start_chat_session — delegation", () => {
  it("permissions lets a parent make a child ask where the parent itself allows", async () => {
    const { result, sent } = await spawn("parent", "x", { permissions: { codeExecution: "ask", webAccess: "deny" }, parentAnswers: true });
    expect(sent.defaultPermissions).toEqual({ ...ALLOW_ALL, codeExecution: "ask", webAccess: "deny" });
    expect(result).toMatchObject({ parentAnswers: true, permissions: { codeExecution: "ask" } });
  });

  it("cannot be looser than the caller, and computer control stays denied", async () => {
    const { sent } = await spawn("cautious", "y", { permissions: { codeExecution: "allow", computerControl: "allow" } });
    expect(sent.defaultPermissions).toMatchObject({ codeExecution: "ask", computerControl: "deny" });
  });

  it("a plain spawn is capped at the caller (asks only where the caller asks)", () => {
    expect(storedPermissions("capped-child")).toMatchObject({ codeExecution: "ask", fileWrite: "allow" });
  });
});

describe("list_pending_requests", () => {
  it("lists a delegated child's prompt as approvable, with reviewer notes", async () => {
    const { requestId } = park("child");
    const result = payload(await tool("list_pending_requests", "parent").handler({}));
    expect(result.requests).toEqual([
      expect.objectContaining({ chatId: "child", title: "child task", requestId, toolName: "Bash", category: "codeExecution", canApprove: true, reviewerNotes: expect.stringContaining("escalate") }),
    ]);
  });

  it("lists a capped child's prompt with canApprove: false", async () => {
    park("capped-child", { offeredToParent: "cautious" });
    const result = payload(await tool("list_pending_requests", "cautious").handler({}));
    expect(result.requests).toEqual([expect.objectContaining({ chatId: "capped-child", canApprove: false })]);
  });

  it("only the direct parent sees it — not the grandparent, not a stranger", async () => {
    park("child");
    expect(payload(await tool("list_pending_requests", "root").handler({})).count).toBe(0);
    expect(payload(await tool("list_pending_requests", "stranger").handler({})).count).toBe(0);
    expect(payload(await tool("list_pending_requests", "parent").handler({})).count).toBe(1);
  });

  it("omits human-only, un-offered, and switched-off prompts", async () => {
    park("child", { humanOnly: true, reviewerVerdict: "kill" });
    park("quiet-child");
    expect(payload(await tool("list_pending_requests", "parent").handler({})).count).toBe(0);
  });

  it("a brand-new child on a temp id is listed without a per-row record scan", async () => {
    park("new-123", { offeredToParent: "parent" });
    const scan = vi.spyOn(chatFileService, "getChat");
    const all = vi.spyOn(chatFileService, "getAllChats");
    const result = payload(await tool("list_pending_requests", "parent").handler({}));
    expect(result.requests).toEqual([expect.objectContaining({ chatId: "new-123", title: null, canApprove: true })]);
    expect(scan).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled(); // a temp id never needs the snapshot
    scan.mockRestore();
    all.mockRestore();
  });

  it("several rows cost one snapshot, not one lookup each", async () => {
    park("child");
    pendingRequests.set("child-2", { ...pendingRequests.get("child")!, requestId: "r2" });
    writeChat("child-2", { title: "two", parentChatId: "parent", parentAnswers: true, defaultPermissions: ASK_EXEC });
    const scan = vi.spyOn(chatFileService, "getChat");
    const all = vi.spyOn(chatFileService, "getAllChats");
    expect(payload(await tool("list_pending_requests", "parent").handler({})).count).toBe(2);
    expect(scan).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(1);
    scan.mockRestore();
    all.mockRestore();
  });
});

describe("respond_to_request — checks", () => {
  const respond = (callerId: string, args: Record<string, unknown>) =>
    tool("respond_to_request", callerId).handler({ reason: "looks fine", ...args }).then(payload);

  it("the parent approves a delegated child's prompt", async () => {
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

  it("refuses the grandparent — only the direct parent answers", async () => {
    const { resolve, requestId } = park("child");
    await expect(respond("root", { chatId: "child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "not_parent" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses an unrelated chat", async () => {
    const { resolve, requestId } = park("child");
    await expect(respond("stranger", { chatId: "child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "not_parent" });
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
    writeChat("child", { title: "child task", parentChatId: "parent", defaultPermissions: ASK_EXEC });
    await expect(respond("parent", { chatId: "child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "parent_answers_off" });
  });

  it("refuses a prompt that was never offered", async () => {
    const { requestId } = park("quiet-child", { offeredToParent: undefined });
    await expect(respond("parent", { chatId: "quiet-child", requestId, allow: false })).resolves.toMatchObject({ ok: false, error: "parent_answers_off" });
  });

  it("refuses to ALLOW above the caller's own permission (capped spawn), but still lets it deny", async () => {
    const { resolve, requestId } = park("capped-child", { offeredToParent: "cautious" });
    const refused = await respond("cautious", { chatId: "capped-child", requestId, allow: true });
    expect(refused).toMatchObject({ ok: false, error: "permission_ceiling" });
    expect(refused.message).toMatch(/codeExecution permission is "ask"/);
    expect(resolve).not.toHaveBeenCalled();
    await expect(respond("cautious", { chatId: "capped-child", requestId, allow: false })).resolves.toMatchObject({ ok: true, allowed: false });
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
  it("ends the parent's wait early for a prompt it can approve", async () => {
    const wait = tool("wait", "parent").handler({ seconds: 300, flavor: "napping" });
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyParentOfChildPrompt("parent", "child", "Bash", "codeExecution")).toBe(true);
    const result = payload(await wait);
    expect(result.endedEarly).toBe(true);
    expect(result.note).toMatch(/child chat child needs approval for Bash/);
    expect(result.note).toMatch(/list_pending_requests/);
  });

  it("does NOT wake a parent for a prompt it could only deny", async () => {
    const wait = tool("wait", "cautious").handler({ seconds: 1, flavor: "napping" });
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyParentOfChildPrompt("cautious", "capped-child", "Bash", "codeExecution")).toBe(false);
    expect(notifyParentOfChildPrompt("parent", "child", "mystery", null)).toBe(false);
    const result = payload(await wait);
    expect(result.endedEarly).toBeUndefined();
  });

  it("a parent that is not waiting is left alone", () => {
    expect(notifyParentOfChildPrompt("parent", "child", "Bash", "codeExecution")).toBe(false);
  });
});

describe("start_chat_session — review settings", () => {
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
