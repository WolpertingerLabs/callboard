/**
 * Route-level tests for POST /api/chats/:id/regenerate-title.
 *
 * The whole point of the endpoint is that it titles from the chat's CURRENT
 * contents rather than from its opening message — the new-chat auto-title
 * already did the latter — so what these tests pin is the transcript the
 * titler is handed, and the write+notify pair that makes the new title visible
 * without a refetch:
 *
 *  - only the parent conversation's user/assistant TEXT survives the condense
 *    (tool traffic and subagent chatter are most of a working chat's bytes and
 *    none of its subject);
 *  - a transcript over budget keeps BOTH ends, because a head-only excerpt of a
 *    long chat would re-derive approximately the title being replaced;
 *  - the title is persisted through `upsertChat`, so a chat that only exists as
 *    a session log gets a record instead of a silently dropped write;
 *  - and every failure mode answers with its own status rather than a 200 and a
 *    stale title.
 *
 * Same no-supertest style as chats.fork.test.ts: the handler is pulled off the
 * router stack and driven with a fake req/res.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { ParsedMessage } from "shared/types/index.js";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-regen-title-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

/** The chat findChat resolves, or null for "no such chat". */
let chat: any;
/** What the stub provider's parseSessionMessages hands back. */
let messages: ParsedMessage[] = [];
/** Session id sets the route asked the provider to parse. */
let parsedSessionIds: string[][] = [];
/** Transcripts handed to the titler, and what it answers with. */
let transcripts: string[] = [];
let generatedTitle: string | null = "A Regenerated Title";

const upsertChat = vi.fn((id: string, folder: string, sessionId: string, updates: Record<string, unknown>) => ({
  id,
  folder,
  session_id: sessionId,
  ...updates,
}));
const notifyMetadata = vi.fn();

vi.mock("../utils/chat-lookup.js", () => ({ findChat: () => chat }));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: { upsertChat: (...args: any[]) => (upsertChat as any)(...args), getChat: () => chat },
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: (...args: unknown[]) => notifyMetadata(...args) } }));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      parseSessionMessages: (sessionIds: string[]) => {
        parsedSessionIds.push(sessionIds);
        return messages;
      },
    },
  ],
}));
vi.mock("../services/quick-completion.js", () => ({
  generateChatTitleFromTranscript: (transcript: string) => {
    transcripts.push(transcript);
    return Promise.resolve(generatedTitle);
  },
}));

/**
 * The real record store, alongside the spy above rather than instead of it.
 *
 * Most of these tests only care *what* the route asked to be written, and the
 * spy answers that without touching a disk. But "a chat that only exists as a
 * session log gets a record" is a claim about the store itself — the spy cannot
 * tell an upsert that created from one that updated — so that one test swaps
 * the real service in for a call and looks for the file. It writes under
 * `DATA_DIR` above, which is this run's temp dir.
 */
const { chatFileService: realChatFileService } = await vi.importActual<typeof import("../services/chat-file-service.js")>("../services/chat-file-service.js");

const { chatsRouter } = await import("./chats.js");

const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/regenerate-title" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => void;

function regenerate(id = "chat-1"): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    handler({ params: { id } } as unknown as Request, res as unknown as Response);
  });
}

function text(role: "user" | "assistant", content: string): ParsedMessage {
  return { role, type: "text", content };
}

function setChat(meta: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  chat = {
    id: "chat-1",
    folder: "/repo",
    session_id: "session-2",
    session_log_path: "/tmp/session-2.jsonl",
    metadata: JSON.stringify({ session_ids: ["session-1", "session-2"], title: "Stale Opening Title", ...meta }),
    ...fields,
  };
}

/** The metadata blob the route wrote, parsed. */
const writtenMeta = () => JSON.parse((upsertChat.mock.calls.at(-1)![3] as any).metadata);

beforeEach(() => {
  upsertChat.mockClear();
  notifyMetadata.mockClear();
  parsedSessionIds = [];
  transcripts = [];
  generatedTitle = "A Regenerated Title";
  messages = [text("user", "add a dark mode toggle"), text("assistant", "done — it lives in the settings page")];
  setChat();
});

describe("POST /api/chats/:id/regenerate-title", () => {
  it("writes the new title and notifies open clients", async () => {
    const res = await regenerate();

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ title: "A Regenerated Title" });

    expect(upsertChat).toHaveBeenCalledTimes(1);
    expect(upsertChat.mock.calls[0].slice(0, 3)).toEqual(["chat-1", "/repo", "session-2"]);
    expect(writtenMeta().title).toBe("A Regenerated Title");
    // A metadata write here replaces the whole blob, so the rest of it has to
    // survive the round trip.
    expect(writtenMeta().session_ids).toEqual(["session-1", "session-2"]);

    // The write alone leaves every open tab showing the old title until its
    // next poll; the notify is the half that makes it live.
    expect(notifyMetadata).toHaveBeenCalledWith("chat-1", { title: "A Regenerated Title" });
  });

  it("titles from every session the chat has resumed under, not just the current one", async () => {
    await regenerate();
    expect(parsedSessionIds).toEqual([["session-1", "session-2"]]);
  });

  it("appends a current session id that metadata does not list", async () => {
    setChat({ session_ids: ["session-1"] });
    await regenerate();
    expect(parsedSessionIds).toEqual([["session-1", "session-2"]]);
  });

  it("creates a record on disk for a chat that only exists on the filesystem", async () => {
    // The real store for this one call: `updateChatMetadata` returns false for
    // a chat with no record and drops the write on the floor — and those are
    // exactly the chats most likely to be carrying a stale title. Asserting
    // that against the spy would prove nothing, since it cannot distinguish an
    // upsert that created from one that updated. So the file has to be there
    // afterwards, in a data dir where it provably was not before.
    upsertChat.mockImplementationOnce((...args: any[]) => (realChatFileService.upsertChat as any)(...args));
    setChat({ session_ids: ["session-2"] });

    const record = join(DATA_DIR, "chats", "session-2.json");
    expect(existsSync(record)).toBe(false);

    const res = await regenerate();

    expect(res.code).toBe(200);
    // Filed under the session id, which is how every other reader finds it.
    const written = JSON.parse(readFileSync(record, "utf8"));
    expect(written.id).toBe("chat-1");
    expect(written.folder).toBe("/repo");
    expect(JSON.parse(written.metadata).title).toBe("A Regenerated Title");
    // And reachable through the store's own lookup, not just as bytes.
    expect(JSON.parse(realChatFileService.getChat("chat-1")!.metadata).title).toBe("A Regenerated Title");
  });

  it("sends the model conversation text and nothing else", async () => {
    messages = [
      text("user", "why is the build failing"),
      { role: "assistant", type: "thinking", content: "SECRET_THINKING" },
      { role: "assistant", type: "tool_use", content: "SECRET_TOOL_INPUT", toolName: "Bash" },
      { role: "user", type: "tool_result", content: "SECRET_TOOL_OUTPUT", toolUseId: "t1" },
      text("assistant", "a missing peer dependency"),
      text("assistant", "   "),
    ];
    await regenerate();

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toBe("[user] why is the build failing\n\n[assistant] a missing peer dependency");
  });

  it("leaves subagent traffic out of the transcript", async () => {
    // The session parsers splice subagent messages into the timeline in
    // timestamp order, stamped only with a teamName, so a brief reads as a
    // plain [user] turn and a report as a plain [assistant] one. On a chat that
    // fanned out they are most of the bytes, and a transcript carrying them
    // titles the agents' errand instead of the conversation.
    messages = [
      text("user", "add a dark mode toggle"),
      { role: "user", type: "text", content: "SUBAGENT_BRIEF", teamName: "explorer" },
      { role: "assistant", type: "text", content: "SUBAGENT_REPORT", teamName: "explorer" },
      text("assistant", "done — it lives in the settings page"),
    ];
    await regenerate();

    expect(transcripts[0]).toBe("[user] add a dark mode toggle\n\n[assistant] done — it lives in the settings page");
  });

  it("refuses a chat from a removed harness by name instead of calling it unreadable", async () => {
    // The provider lookup falls back to claude-code for an unknown kind, which
    // would go looking for these session ids under ~/.claude/projects, find
    // nothing, and answer "no readable conversation" — false of a chat that has
    // one. ~155 records name this harness. Same refusal as the fork route.
    setChat({ provider: "openrouter" });
    const res = await regenerate();

    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/OpenRouter/);
    expect(res.body.error).not.toMatch(/no readable conversation/i);
    expect(parsedSessionIds).toEqual([]);
    expect(transcripts).toEqual([]);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });

  it("keeps both ends of a conversation too long to send whole", async () => {
    // The property the whole feature rests on: cutting the tail off would show
    // the titler exactly the opening the auto-title already used, so a long
    // chat would regenerate roughly the title it started with.
    const filler = "x".repeat(8000);
    messages = [text("user", `OPENING_ASK ${filler}`), text("assistant", `${filler} CLOSING_STATE`)];
    await regenerate();

    const transcript = transcripts[0];
    expect(transcript).toContain("OPENING_ASK");
    expect(transcript).toContain("CLOSING_STATE");
    expect(transcript).toContain("middle of the conversation omitted");
    // Budget plus the marker — the cap is real, not just decorative.
    expect(transcript.length).toBeLessThan(6200);
  });

  it("404s for a chat that does not exist", async () => {
    chat = null;
    const res = await regenerate("nope");

    expect(res.code).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(transcripts).toEqual([]);
    expect(upsertChat).not.toHaveBeenCalled();
  });

  it("refuses a chat with no readable conversation instead of titling the void", async () => {
    messages = [{ role: "assistant", type: "tool_use", content: "ls -la", toolName: "Bash" }];
    const res = await regenerate();

    expect(res.code).toBe(422);
    expect(res.body.error).toMatch(/no readable conversation/i);
    // Nothing was asked of the model, and nothing was written.
    expect(transcripts).toEqual([]);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });

  it("reports a failed generation rather than storing an empty title", async () => {
    generatedTitle = null;
    const res = await regenerate();

    expect(res.code).toBe(502);
    expect(res.body.error).toMatch(/could not generate/i);
    expect(upsertChat).not.toHaveBeenCalled();
    expect(notifyMetadata).not.toHaveBeenCalled();
  });
});
