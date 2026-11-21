/**
 * Secret vault values must not leave the agent's context on a permission
 * "ask": not to the model reviewer, not to drawlatch's audit log, and not to a
 * parent agent's list_pending_requests. The tool call itself — what the daemon
 * receives once approved — keeps them.
 *
 * Driven through the real buildCanUseTool chain with the reviewer and the
 * audit emitter injected, the way pi reaches it (bare tool names) and the way
 * Claude Code would (`mcp__mcp-proxy__` names, only via a hook "ask", since
 * the server is otherwise pre-approved).
 */
import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";

// Every log line any module writes, so a test can check none quotes a secret.
const logLines = vi.hoisted(() => [] as string[]);
vi.mock("../utils/logger.js", () => ({
  createLogger: () =>
    new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            logLines.push(args.map(String).join(" "));
          },
      },
    ),
}));
import type { DefaultPermissions } from "shared/types/index.js";
import { ToolPermissionPolicy } from "../agents/permissions/ToolPermissionPolicy.js";
import { buildCanUseTool, getPendingRequest, respondToPermission, type PermissionReviewHooks } from "./claude.js";
import { listAnswerableRequests } from "./parent-answers.js";
import { buildReviewPrompt, detectHardStop } from "./permission-review.js";
import { startReviewAudit } from "./permission-review-audit.js";
import type { AuditRecordInput } from "./audit-log.js";
import { REDACTED, redactToolInputForReview } from "./tool-input-redaction.js";

const SECRET = "hunter2-correct-horse";
const FULL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" };

function vaultInput(): Record<string, unknown> {
  return { name: "gh", kind: "password", values: { value: SECRET, username: "octocat" }, notes: "CI token" };
}

describe("redactToolInputForReview", () => {
  it.each(["vault_create", "vault_update", "mcp__mcp-proxy__vault_create", "mcp__mcp-proxy__vault_update"])("redacts every value of %s and keeps the field names", (tool) => {
    const input = vaultInput();
    const out = redactToolInputForReview(tool, input);
    expect(out).toEqual({ name: "gh", kind: "password", values: { value: REDACTED, username: REDACTED }, notes: "CI token" });
    // The original — what the tool runs with — is untouched.
    expect(input.values).toEqual({ value: SECRET, username: "octocat" });
  });

  it("matches the tool name under any MCP server prefix", () => {
    // A drawlatch server mounted under another name is still drawlatch.
    for (const tool of ["mcp__other__vault_create", "mcp__my_vault__vault_update"]) {
      expect(redactToolInputForReview(tool, vaultInput()).values).toEqual({ value: REDACTED, username: REDACTED });
    }
    // Only a qualified name is split: an unqualified one must match exactly.
    const input = vaultInput();
    expect(redactToolInputForReview("xmcp__a__vault_create", input)).toBe(input);
  });

  it("redacts a malformed values field whole", () => {
    expect(redactToolInputForReview("vault_create", { name: "x", values: SECRET })).toEqual({ name: "x", values: REDACTED });
    expect(redactToolInputForReview("vault_update", { name: "x", values: [SECRET] })).toEqual({ name: "x", values: REDACTED });
  });

  it("leaves other tools and value-less vault calls alone (same object)", () => {
    const bash = { command: "echo hi", values: { a: "b" } };
    expect(redactToolInputForReview("Bash", bash)).toBe(bash);
    expect(redactToolInputForReview("mcp__other__vault_list", bash)).toBe(bash);
    const rename = { name: "gh", rename: "github" };
    expect(redactToolInputForReview("vault_update", rename)).toBe(rename);
  });
});

function setup(hookAskOverride?: { reason: string }) {
  const emitter = new EventEmitter();
  const events: unknown[] = [];
  emitter.on("event", (e: unknown) => events.push(e));
  // A temp tracking id: parent-answers reads no chat record for it.
  const trackingId = `new-vault-${Math.random().toString(36).slice(2)}`;
  const reviewer = vi.fn(async () => ({ verdict: "escalate" as const, reason: "unsure", source: "model" as const }));
  const records: AuditRecordInput[] = [];
  const hooks: PermissionReviewHooks = {
    getSettings: () => ({ modelReview: true, parentAnswers: true }),
    getParentChatId: () => "parent-1",
    cwd: "/repo",
    reviewer,
    notifyParent: vi.fn(),
    audit: { getCallerAlias: () => "default", emit: (_alias, build) => records.push(build()) },
  };
  const policy = new ToolPermissionPolicy(() => "fileWrite", () => FULL_ASK);
  const canUseTool = buildCanUseTool(emitter, policy, () => trackingId, hookAskOverride, hooks);
  const call = (toolName: string, input: Record<string, unknown>) => canUseTool(toolName, input, { signal: new AbortController().signal });
  return { trackingId, reviewer, records, events, call };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a vault secret on the permission-review path", () => {
  it.each(["vault_create", "mcp__mcp-proxy__vault_update"])("%s: reaches neither the reviewer, the audit log nor the parent's listing, but does reach the tool", async (tool) => {
    const { call, reviewer, records, trackingId } = setup();
    const promise = call(tool, vaultInput());
    await flush();

    expect(reviewer).toHaveBeenCalledOnce();
    const reviewed = (reviewer.mock.calls[0] as unknown[])[0] as { input: Record<string, unknown> };
    expect(JSON.stringify(reviewed)).not.toContain(SECRET);
    expect(reviewed.input.values).toEqual({ value: REDACTED, username: REDACTED });

    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).toContain(REDACTED);

    const rows = listAnswerableRequests("parent-1", null).filter((r) => r.chatId === trackingId);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(rows[0].input.values).toEqual({ value: REDACTED, username: REDACTED });

    // Approved: the call runs with the real values.
    expect(respondToPermission(trackingId, true).ok).toBe(true);
    const result = await promise;
    expect(result).toMatchObject({ behavior: "allow" });
    expect((result as { updatedInput: Record<string, unknown> }).updatedInput.values).toEqual({ value: SECRET, username: "octocat" });
  });

  it("a secret that would trip the hard-stop pre-check is not quoted anywhere", async () => {
    // A field named `path` is screened as a write target, and `.git/…` is a
    // protected one: on the raw input the pre-check kills, quoting the value.
    const input = { name: "deploy", kind: "key-value", values: { path: `.git/${SECRET}`, token: SECRET } };
    expect(detectHardStop("vault_create", input)?.evidence).toContain(SECRET);

    logLines.length = 0;
    const { call, reviewer, records, events, trackingId } = setup();
    const promise = call("vault_create", input);
    await flush();

    // Screened on the redacted copy: no hard stop, so the model reviewer ran.
    expect(reviewer).toHaveBeenCalledOnce();
    const pending = getPendingRequest(trackingId);
    expect(pending?.eventData.reviewerVerdict).toBe("escalate");
    expect(String(pending?.eventData.reviewerNotes)).not.toContain(SECRET);
    // The human's own prompt carries the raw `input` on purpose; only the
    // reviewer fields riding along with it are checked here.
    expect(JSON.stringify(events.map((e) => ({ ...(e as object), input: undefined })))).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(listAnswerableRequests("parent-1", null).filter((r) => r.chatId === trackingId))).not.toContain(SECRET);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(SECRET);

    expect(respondToPermission(trackingId, true).ok).toBe(true);
    expect(((await promise) as { updatedInput: Record<string, unknown> }).updatedInput).toEqual(input);
  });

  it("Claude Code hook-ask path: no review or parent offer, so no listing either", async () => {
    const { call, reviewer, records, trackingId } = setup({ reason: "user hook" });
    const promise = call("mcp__mcp-proxy__vault_create", vaultInput());
    await flush();
    expect(reviewer).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(listAnswerableRequests("parent-1", null).filter((r) => r.chatId === trackingId)).toHaveLength(0);
    respondToPermission(trackingId, false);
    await promise;
  });

  it("the sinks redact on their own too, for any other caller", async () => {
    const prompt = buildReviewPrompt({ toolName: "vault_create", input: vaultInput(), cwd: "/repo", category: "fileWrite" });
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain("username");

    const records: AuditRecordInput[] = [];
    startReviewAudit({
      hooks: { getCallerAlias: () => "default", emit: (_a, build) => records.push(build()) },
      screen: "model",
      chatId: "c1",
      toolName: "mcp__mcp-proxy__vault_update",
      toolUseId: undefined,
      input: vaultInput(),
      category: "fileWrite",
      cwd: "/repo",
      settings: { modelReview: true, parentAnswers: false },
      settingsFallback: false,
    });
    await flush(); // records are emitted on setImmediate
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });
});
