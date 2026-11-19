/**
 * The aside auto-start end to end, without stubbing the turn: POST /:id/fork
 * (kind aside, with a prompt) → the real `startChatTurn` → the real
 * `sendMessage` → the mock agent provider. Real chat records in a temp data
 * dir and a real git checkout, so the branch-drift guard runs for real: the
 * aside inherits the parent's stale `lastBranch`, and the route's
 * `acknowledgeBranchDrift: true` must let the turn start and record the
 * current branch.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { AgentEvent } from "../agents/ports/events.js";

const dataDir = mkdtempSync(join(tmpdir(), "cb-aside-int-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const repo = mkdtempSync(join(tmpdir(), "cb-aside-int-repo-"));
execFileSync("git", ["init", "-q", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);

vi.mock("../services/quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateChatTitleFromTranscript: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { setAgentProviderForTesting, setSessionProvidersForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { ASIDE_INSTRUCTION } = await import("../services/aside.js");

afterAll(() => {
  setAgentProviderForTesting(null);
  setSessionProvidersForTesting(null);
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
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

/** The text the session was prompted with: a string, or (with MCP servers attached) a one-message stream. */
async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  let text = "";
  for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
    const content = message.message.content;
    text += typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("");
  }
  return text;
}

describe("POST /:id/fork kind aside — first turn through the real startChatTurn", () => {
  it("starts the turn despite the inherited stale branch, and records the current one", async () => {
    const T = "2026-01-01T00:05:00.000Z";
    // Same-harness fork: a stub session provider "copies" the log.
    const forked: string[] = [];
    setSessionProvidersForTesting([
      {
        kind: "claude-code",
        forkSession: (_ids: string[], _ts: string, newSessionId: string) => {
          forked.push(newSessionId);
          return { logPath: join(dataDir, `${newSessionId}.jsonl`) };
        },
        getSessionPreview: () => "preview",
      } as never,
    ]);
    const events: AgentEvent[] = [
      { type: "session_started", sessionId: "aside-run" },
      { type: "text", content: "ok" },
      { type: "result", status: "success" },
    ];
    const provider = new MockAgentProvider({ events });
    setAgentProviderForTesting(provider);

    const parent = chatFileService.createChat(repo, "parent-sess", JSON.stringify({ title: "Parent", session_ids: ["parent-sess"], lastBranch: "old-branch" }));
    const res = await post(parent.id, {
      timestamp: T,
      kind: "aside",
      quotes: [{ timestamp: T, role: "assistant", text: "the passage" }],
      prompt: "why?",
      timeZone: "UTC",
    });

    expect(res.code).toBe(201);
    expect(res.body.runError).toBeUndefined();
    expect(res.body.started).toBe(true);
    expect(forked).toHaveLength(1);

    // The mock provider received the rendered question, with the aside instruction.
    await vi.waitFor(() => expect(provider.queryRecords).toHaveLength(1));
    const request = provider.queryRecords[0]!.request as any;
    expect(await promptText(request.prompt)).toBe("> **Assistant, Jan 1, 00:05:**\n> the passage\n\nwhy?");
    expect(request.options.systemPrompt.append).toContain(ASIDE_INSTRUCTION);

    // Drift acknowledged: the aside now records the branch it actually ran on;
    // the parent's record is untouched.
    const asideMeta = JSON.parse(chatFileService.getChat(res.body.id)!.metadata);
    expect(asideMeta).toMatchObject({ chatRole: "aside", parentChatId: parent.id, lastBranch: "main" });
    expect(JSON.parse(chatFileService.getChat(parent.id)!.metadata).lastBranch).toBe("old-branch");
  });
});
