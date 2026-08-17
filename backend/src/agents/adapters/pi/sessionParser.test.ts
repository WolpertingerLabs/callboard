/**
 * Reading pi's own session files.
 *
 * Fixtures are written in pi's real version-3 shape rather than a simplified
 * one — the spike proved that shape loads, resumes and round-trips through
 * `SessionManager.open()`, so a test that parsed something looser would not be
 * testing the thing that ships.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything reads `paths.ts` — #302.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-parser-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { CURRENT_SESSION_VERSION } = await import("@earendil-works/pi-coding-agent");
const { derivePreview, deriveSearchText, listPiSessions, parsePiSession, readPiSession, readPiSessionCwd, sessionIdFromFileName, extractText } =
  await import("./sessionParser.js");
const { resolvePiSessionsRoot, piSessionFileName, findPiSessionPath, isSafePathSegment } = await import("./paths.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const CWD = "/tmp/some-repo";
const TS = "2026-08-04T12:00:00.000Z";
const MS = Date.parse(TS);

function root(): string {
  const dir = resolvePiSessionsRoot();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: MS };
}

function assistantMessage(content: unknown[]) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "google/gemini-3.6-flash",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } },
    stopReason: "stop",
    timestamp: MS,
  };
}

/** Write a session file with the given entries, returning its path. */
function writeSession(sessionId: string, entries: Array<Record<string, unknown>>, opts: { cwd?: string; parentSession?: string } = {}): string {
  const path = join(root(), piSessionFileName(sessionId, new Date(TS)));
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: TS,
    cwd: opts.cwd ?? CWD,
    ...(opts.parentSession && { parentSession: opts.parentSession }),
  };
  writeFileSync(path, [header, ...entries].map((o) => `${JSON.stringify(o)}\n`).join(""), "utf8");
  return path;
}

/** A conversation with one user turn, one assistant turn, and a tool round-trip. */
function conversationEntries() {
  return [
    { type: "message", id: "e1", parentId: null, timestamp: TS, message: userMessage("read the readme please") },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: TS,
      message: assistantMessage([
        { type: "thinking", thinking: "I should read it" },
        { type: "text", text: "Reading it now." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      ]),
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: TS,
      message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "hello world" }], isError: false },
    },
    { type: "message", id: "e4", parentId: "e3", timestamp: TS, message: assistantMessage([{ type: "text", text: "It says hello world." }]) },
  ];
}

beforeEach(() => rmSync(resolvePiSessionsRoot(), { recursive: true, force: true }));

describe("readPiSession", () => {
  it("splits the header from the entries", () => {
    const path = writeSession("s1", conversationEntries());
    const { header, entries } = readPiSession(path);
    expect(header).toMatchObject({ type: "session", id: "s1", cwd: CWD, version: CURRENT_SESSION_VERSION });
    expect(entries).toHaveLength(4);
    // The header is split out, never left among the entries.
    expect(entries.map((e) => e.type)).not.toContain("session");
  });

  it("returns empty rather than throwing on a missing file", () => {
    expect(readPiSession(join(root(), "nope.jsonl"))).toEqual({ header: null, entries: [] });
  });

  it("returns empty rather than throwing on garbage", () => {
    // pi flushes lazily — a session with no assistant message yet leaves nothing
    // or a partial file on disk. A chat list that 500s over one bad file is worse
    // than one that omits it.
    const path = join(root(), "broken.jsonl");
    writeFileSync(path, "this is not jsonl at all\n{{{\n", "utf8");
    expect(() => readPiSession(path)).not.toThrow();
    expect(readPiSession(path).entries).toEqual([]);
  });

  it("tolerates a file with a header and nothing else", () => {
    const path = writeSession("empty", []);
    expect(readPiSession(path).entries).toEqual([]);
    expect(readPiSessionCwd(path)).toBe(CWD);
  });

  it("reports an empty cwd when the header is missing", () => {
    const path = join(root(), "headerless.jsonl");
    writeFileSync(path, "", "utf8");
    expect(readPiSessionCwd(path)).toBe("");
  });
});

describe("listPiSessions", () => {
  it("returns an empty list when no pi chat has ever run", () => {
    rmSync(resolvePiSessionsRoot(), { recursive: true, force: true });
    expect(listPiSessions()).toEqual([]);
  });

  it("reads the session id off the filename, without opening the file", () => {
    writeSession("chat-abc-123", conversationEntries());
    expect(listPiSessions().map((f) => f.sessionId)).toEqual(["chat-abc-123"]);
  });

  it("sorts newest first", () => {
    const older = writeSession("older", conversationEntries());
    const newer = writeSession("newer", conversationEntries());
    utimesSync(older, new Date("2020-01-01"), new Date("2020-01-01"));
    utimesSync(newer, new Date("2030-01-01"), new Date("2030-01-01"));
    expect(listPiSessions().map((f) => f.sessionId)).toEqual(["newer", "older"]);
  });

  it("ignores non-jsonl files", () => {
    writeSession("real", conversationEntries());
    writeFileSync(join(root(), "notes.txt"), "hi", "utf8");
    expect(listPiSessions()).toHaveLength(1);
  });
});

describe("sessionIdFromFileName", () => {
  it.each([
    ["2026-08-04T12-00-00-000Z_chat-abc-123.jsonl", "chat-abc-123"],
    ["bare-id.jsonl", "bare-id"],
    ["2026-08-04T12-00-00-000Z_id_with_underscores.jsonl", "id_with_underscores"],
  ])("%s → %s", (name, expected) => {
    expect(sessionIdFromFileName(name)).toBe(expected);
  });
});

describe("parsePiSession", () => {
  it("projects a whole conversation into ParsedMessages in file order", () => {
    const path = writeSession("s1", conversationEntries());
    const messages = parsePiSession(path);
    expect(messages.map((m) => [m.role, m.type])).toEqual([
      ["user", "text"],
      ["assistant", "thinking"],
      ["assistant", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
    ]);
  });

  it("preserves block order within an assistant turn", () => {
    // Reasoning, prose and the tool call interleave; regrouping them would
    // misrepresent what the model did in what order.
    const messages = parsePiSession(writeSession("s1", conversationEntries()));
    expect(messages[1]?.content).toBe("I should read it");
    expect(messages[2]?.content).toBe("Reading it now.");
  });

  it("carries the tool name, call id and JSON arguments onto tool_use", () => {
    const toolUse = parsePiSession(writeSession("s1", conversationEntries())).find((m) => m.type === "tool_use");
    expect(toolUse).toMatchObject({ toolName: "read", toolUseId: "call-1", content: '{"path":"README.md"}' });
  });

  it("gives a tool result the user role, as the other parsers do", () => {
    // A Claude-shaped convention the whole codebase follows; `handoff.ts`
    // depends on it when folding results into the assistant side.
    const result = parsePiSession(writeSession("s1", conversationEntries())).find((m) => m.type === "tool_result");
    expect(result).toMatchObject({ role: "user", type: "tool_result", content: "hello world", toolUseId: "call-1", toolName: "read" });
  });

  it("marks a failed tool result", () => {
    const path = writeSession("s1", [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: TS,
        message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "denied" }], isError: true },
      },
    ]);
    expect(parsePiSession(path)[0]).toMatchObject({ subtype: "error", content: "denied" });
  });

  it("carries the model name onto assistant messages", () => {
    const text = parsePiSession(writeSession("s1", conversationEntries())).find((m) => m.type === "text" && m.role === "assistant");
    expect(text?.model).toBe("google/gemini-3.6-flash");
  });

  /**
   * The regression this group guards.
   *
   * `ChatDebugPanel`'s entire row filter is `role === "assistant" && usage`, and
   * this parser used to set neither `usage` nor `stopReason` on anything — so a
   * pi chat's debug tab was not a table with gaps, it was the empty state. pi's
   * `AssistantMessage` carries both as **required** fields; every number below
   * was already sitting in the session file, unread.
   */
  describe("per-generation metrics", () => {
    /** The assistant entries of a conversation, in order. */
    const assistantsOf = (path: string) => parsePiSession(path).filter((m) => m.role === "assistant");
    /** The blocks of one pi entry, keyed by the generation they came from. */
    const blocksOfEntry = (path: string, entryId: string) => assistantsOf(path).filter((m) => m.generationKey === `pi:s1/${entryId}`);

    it("projects the usage pi records, so the debug panel has rows at all", () => {
      const carrier = blocksOfEntry(writeSession("s1", conversationEntries()), "e2").at(-1)!;
      expect(carrier.usage).toEqual({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      expect(carrier.costUsd).toBe(0.001);
    });

    it("surfaces the cache split and the reasoning subset rather than folding them into input", () => {
      // Cache tokens are billed separately and `cost.total` already accounts for
      // them; adding them to `input` would make the token figure disagree with
      // the cost beside it. `reasoning` is a subset of `output`, never an addend.
      const path = writeSession("s1", [
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: TS,
          message: {
            ...assistantMessage([{ type: "text", text: "hi" }]),
            usage: { input: 4, output: 120, cacheRead: 900, cacheWrite: 40, reasoning: 12, totalTokens: 1064, cost: { total: 0.0033 } },
          },
        },
      ]);
      expect(assistantsOf(path)[0].usage).toEqual({
        input_tokens: 4,
        output_tokens: 120,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 40,
        reasoning_tokens: 12,
      });
    });

    it("leaves a field pi did not write unset instead of defaulting it to zero", () => {
      // The panel renders `0` as a measurement and `undefined` as a dash. A
      // provider that reports no cache traffic has not read zero cached tokens.
      const path = writeSession("s1", [
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: TS,
          message: { ...assistantMessage([{ type: "text", text: "hi" }]), usage: { input: 4, output: 120 } },
        },
      ]);
      expect(assistantsOf(path)[0].usage).toEqual({ input_tokens: 4, output_tokens: 120 });
      expect(assistantsOf(path)[0].costUsd).toBeUndefined();
    });

    it("translates pi's model stop reasons into the vocabulary the field documents", () => {
      const stopped = (stopReason: string) =>
        assistantsOf(
          writeSession("s1", [
            {
              type: "message",
              id: "e1",
              parentId: null,
              timestamp: TS,
              message: { ...assistantMessage([{ type: "text", text: "hi" }]), stopReason },
            },
          ]),
        )[0].stopReason;

      // The same three facts Anthropic names, spelled pi's way.
      expect(stopped("stop")).toBe("end_turn");
      expect(stopped("length")).toBe("max_tokens");
      expect(stopped("toolUse")).toBe("tool_use");
      // No Anthropic counterpart: passed through rather than guessed at.
      expect(stopped("aborted")).toBe("aborted");
      expect(stopped("error")).toBe("error");
      expect(stopped("a_reason_pi_adds_later")).toBe("a_reason_pi_adds_later");
    });

    it("groups a generation's blocks together and keeps two generations apart", () => {
      // One pi entry IS one API call, so its thinking, prose and tool call share
      // a key and collapse to a single panel row — while the next entry gets its
      // own. Namespaced by session id: a chat is several files concatenated, and
      // pi's entry ids are only unique within one.
      const messages = parsePiSession(writeSession("s1", conversationEntries()));
      const assistants = messages.filter((m) => m.role === "assistant");
      expect(assistants.map((m) => m.generationKey)).toEqual(["pi:s1/e2", "pi:s1/e2", "pi:s1/e2", "pi:s1/e4"]);
    });

    it("uses the provider's own response id as the request id, and none when there is none", () => {
      const withId = writeSession("s1", [
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: TS,
          message: { ...assistantMessage([{ type: "text", text: "hi" }]), responseId: "resp_aaa" },
        },
      ]);
      expect(assistantsOf(withId)[0].requestId).toBe("resp_aaa");
      // A provider that returned no id gets no id — never a synthesized one, so
      // the Req ID column cannot show something a user might quote to support.
      expect(assistantsOf(writeSession("s2", conversationEntries()))[0].requestId).toBeUndefined();
    });

    it("puts a generation's cost on exactly one block, not on every block", () => {
      // `MessageBubble` renders `MessageMetadata` for thinking, tool_use *and*
      // text, and does no grouping — so a cost stamped on every block is printed
      // once per bubble. Entry e2 is thinking + prose + a tool call: stamping it
      // three times made a user summing a chat's per-message costs get 3× the
      // real spend. The panel would have hidden it (it regroups), the chat view
      // does not.
      const blocks = blocksOfEntry(writeSession("s1", conversationEntries()), "e2");
      expect(blocks).toHaveLength(3);
      expect(blocks.filter((m) => m.costUsd != null)).toHaveLength(1);
      expect(blocks.filter((m) => m.usage != null)).toHaveLength(1);
      expect(blocks.filter((m) => m.stopReason != null)).toHaveLength(1);
      // Summed across the entry's bubbles, the chat view now shows what the
      // generation actually cost — 0.001 once, not 0.003.
      expect(blocks.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)).toBe(0.001);
    });

    it("carries identity — model and grouping key — onto every block", () => {
      // The other half of the split: `model` and `generationKey` describe which
      // call a block came from rather than measuring it, so they belong on all
      // three. Without the key on the tool_use block the panel would file it as
      // its own row.
      const blocks = blocksOfEntry(writeSession("s1", conversationEntries()), "e2");
      expect(blocks.map((m) => m.type)).toEqual(["thinking", "text", "tool_use"]);
      expect(blocks.every((m) => m.model === "google/gemini-3.6-flash")).toBe(true);
    });

    it("shows the model that answered, not the alias that was asked for", () => {
      // A real entry from `~/.callboard/pi-sessions/` requests
      // `~anthropic/claude-sonnet-latest` and is served `anthropic/claude-sonnet-5`.
      // The Model column is a diagnostic; the two differ exactly when it matters.
      const path = writeSession("s1", [
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: TS,
          message: {
            ...assistantMessage([{ type: "text", text: "hi" }]),
            model: "~anthropic/claude-sonnet-latest",
            responseModel: "anthropic/claude-sonnet-5",
          },
        },
      ]);
      expect(assistantsOf(path)[0].model).toBe("anthropic/claude-sonnet-5");
    });

    it("annotates nothing when the entry carries no metrics at all", () => {
      // A session file written by an older pi, or a half-flushed entry.
      const path = writeSession("s1", [
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "bare" }], model: "m" },
        },
      ]);
      const bare = assistantsOf(path)[0];
      expect(bare.usage).toBeUndefined();
      expect(bare.stopReason).toBeUndefined();
      expect(bare.costUsd).toBeUndefined();
      // The grouping key is positional, not measured, so it survives — otherwise
      // an old transcript's rows would each become their own `__ungrouped_N`.
      expect(bare.generationKey).toBe("pi:s1/e1");
    });
  });

  it("stamps every message with the entry timestamp", () => {
    for (const message of parsePiSession(writeSession("s1", conversationEntries()))) {
      expect(message.timestamp).toBe(TS);
    }
  });

  it("renders a compaction entry as a boundary the UI can show", () => {
    const path = writeSession("s1", [
      { type: "compaction", id: "c1", parentId: null, timestamp: TS, summary: "summarized 40 turns", firstKeptEntryId: "e9", tokensBefore: 1000 },
    ]);
    expect(parsePiSession(path)[0]).toMatchObject({ role: "system", type: "system", subtype: "compact_boundary", content: "summarized 40 turns" });
  });

  it("renders a branch summary as a boundary too", () => {
    const path = writeSession("s1", [{ type: "branch_summary", id: "b1", parentId: null, timestamp: TS, fromId: "e2", summary: "abandoned branch" }]);
    expect(parsePiSession(path)[0]).toMatchObject({ subtype: "compact_boundary", content: "abandoned branch" });
  });

  it("keeps the usage of the call that wrote a compaction summary", () => {
    // `CompactionEntry.usage` is "Usage from the LLM call(s) that generated this
    // summary" — a real billed call. A chat that auto-compacted three times spent
    // three times, and dropping these made "Total cost" quietly short in the one
    // panel a user opens to find out what a chat cost.
    const path = writeSession("s1", [
      {
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: TS,
        summary: "summarized 40 turns",
        firstKeptEntryId: "e9",
        tokensBefore: 1000,
        usage: { input: 40000, output: 800, cacheRead: 0, cacheWrite: 0, totalTokens: 40800, cost: { total: 0.12 } },
      },
    ]);
    expect(parsePiSession(path)[0]).toMatchObject({
      subtype: "compact_boundary",
      usage: { input_tokens: 40000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      costUsd: 0.12,
      generationKey: "pi:s1/c1",
    });
  });

  it("keeps the usage of the call that wrote a branch summary", () => {
    const path = writeSession("s1", [
      {
        type: "branch_summary",
        id: "b1",
        parentId: null,
        timestamp: TS,
        fromId: "e2",
        summary: "abandoned branch",
        usage: { input: 900, output: 60, cost: { total: 0.004 } },
      },
    ]);
    expect(parsePiSession(path)[0]).toMatchObject({ usage: { input_tokens: 900, output_tokens: 60 }, costUsd: 0.004, generationKey: "pi:s1/b1" });
  });

  it("leaves a summary that records no usage unannotated", () => {
    // The common case for an older session file. A boundary with an empty
    // `usage` object would conjure a debug-panel row of dashes for a call
    // callboard knows nothing about.
    const path = writeSession("s1", [{ type: "compaction", id: "c1", parentId: null, timestamp: TS, summary: "s", firstKeptEntryId: "e9", tokensBefore: 10 }]);
    expect(parsePiSession(path)[0].usage).toBeUndefined();
    expect(parsePiSession(path)[0].generationKey).toBeUndefined();
  });

  /**
   * pi injects its own bookkeeping into any session callboard writes — the spike
   * watched `model_change` and `thinking_level_change` appear in a hand-written
   * file after a single resume.
   */
  it("skips pi's own bookkeeping entries", () => {
    const path = writeSession("s1", [
      { type: "model_change", id: "m1", parentId: null, timestamp: TS, provider: "openrouter", modelId: "x" },
      { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: TS, thinkingLevel: "minimal" },
      { type: "label", id: "l1", parentId: "t1", timestamp: TS, targetId: "m1", label: "bookmark" },
      { type: "session_info", id: "i1", parentId: "l1", timestamp: TS, name: "My chat" },
      { type: "custom", id: "x1", parentId: "i1", timestamp: TS, customType: "ext.state", data: { a: 1 } },
      { type: "message", id: "e1", parentId: "x1", timestamp: TS, message: userMessage("still here") },
    ]);
    expect(parsePiSession(path)).toEqual([expect.objectContaining({ content: "still here" })]);
  });

  it("shows a displayed custom_message but hides a hidden one", () => {
    const path = writeSession("s1", [
      { type: "custom_message", id: "c1", parentId: null, timestamp: TS, customType: "ext", content: "visible note", display: true },
      { type: "custom_message", id: "c2", parentId: "c1", timestamp: TS, customType: "ext", content: "hidden plumbing", display: false },
    ]);
    expect(parsePiSession(path).map((m) => m.content)).toEqual(["visible note"]);
  });

  it("renders nothing, rather than throwing, for an entry type pi has not shipped yet", () => {
    const path = writeSession("s1", [{ type: "some_future_entry", id: "f1", parentId: null, timestamp: TS, whatever: true }]);
    expect(() => parsePiSession(path)).not.toThrow();
    expect(parsePiSession(path)).toEqual([]);
  });

  /**
   * File order, not `buildSessionContext()`'s leaf-to-root walk. Callboard is
   * rendering a transcript of everything that happened; pi's context walk
   * follows one branch and drops what a compaction summarized away.
   */
  it("keeps entries a context walk would drop", () => {
    const path = writeSession("s1", [
      { type: "message", id: "e1", parentId: null, timestamp: TS, message: userMessage("first branch") },
      { type: "compaction", id: "c1", parentId: "e1", timestamp: TS, summary: "summary", firstKeptEntryId: "e2", tokensBefore: 10 },
      { type: "message", id: "e2", parentId: "c1", timestamp: TS, message: userMessage("after compaction") },
      // A sibling of e2: a branch the user navigated away from.
      { type: "message", id: "e3", parentId: "c1", timestamp: TS, message: userMessage("abandoned branch") },
    ]);
    expect(parsePiSession(path).map((m) => m.content)).toEqual(["first branch", "summary", "after compaction", "abandoned branch"]);
  });
});

describe("derivePreview — SessionInfo.firstMessage, re-derived", () => {
  it("returns the first user message", () => {
    expect(derivePreview(writeSession("s1", conversationEntries()))).toBe("read the readme please");
  });

  it("skips assistant turns to find it", () => {
    const path = writeSession("s1", [
      { type: "message", id: "e1", parentId: null, timestamp: TS, message: assistantMessage([{ type: "text", text: "I speak first" }]) },
      { type: "message", id: "e2", parentId: "e1", timestamp: TS, message: userMessage("the real first user message") },
    ]);
    expect(derivePreview(path)).toBe("the real first user message");
  });

  it("skips a whitespace-only user message", () => {
    const path = writeSession("s1", [
      { type: "message", id: "e1", parentId: null, timestamp: TS, message: userMessage("   \n  ") },
      { type: "message", id: "e2", parentId: "e1", timestamp: TS, message: userMessage("real content") },
    ]);
    expect(derivePreview(path)).toBe("real content");
  });

  it("returns null for a session with no user message at all", () => {
    expect(derivePreview(writeSession("s1", []))).toBeNull();
  });
});

describe("deriveSearchText — SessionInfo.allMessagesText, re-derived", () => {
  it("includes both sides of the conversation", () => {
    const text = deriveSearchText(writeSession("s1", conversationEntries()));
    expect(text).toContain("read the readme please");
    expect(text).toContain("It says hello world.");
  });

  it("includes compaction summaries, so old history stays findable", () => {
    const path = writeSession("s1", [
      { type: "compaction", id: "c1", parentId: null, timestamp: TS, summary: "we discussed the deploy pipeline", firstKeptEntryId: "e2", tokensBefore: 10 },
    ]);
    expect(deriveSearchText(path)).toContain("deploy pipeline");
  });

  it("returns an empty string for an empty session", () => {
    expect(deriveSearchText(writeSession("s1", []))).toBe("");
  });
});

describe("extractText", () => {
  it("joins text blocks and ignores others", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "thinking", thinking: "t" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("accepts the bare-string content form", () => {
    expect(extractText("plain")).toBe("plain");
  });

  it.each([[null], [undefined], [42]])("returns empty for %s", (value) => {
    expect(extractText(value)).toBe("");
  });
});

describe("path safety", () => {
  it.each([["../escape"], ["a/b"], ["/absolute"], [".."], ["."], ["C:\\win"], ["with\0nul"], [""], [null], [123]])("rejects %s as a path segment", (value) => {
    expect(isSafePathSegment(value)).toBe(false);
  });

  it.each([["chat-abc-123"], ["a"], ["019fcee0-462d-767a-8298-a6b7b94dbd41"], ["with.dots_and-dashes"]])("accepts %s", (value) => {
    expect(isSafePathSegment(value)).toBe(true);
  });

  it("refuses to resolve a traversing id to a path", () => {
    expect(findPiSessionPath("../../etc/passwd")).toBeNull();
  });

  it("finds a session by id suffix without opening any file", () => {
    const path = writeSession("chat-abc-123", conversationEntries());
    expect(findPiSessionPath("chat-abc-123")).toBe(path);
  });

  it("returns null for an id that does not exist", () => {
    expect(findPiSessionPath("no-such-session")).toBeNull();
  });

  it("does not match a session whose id merely ends with the query", () => {
    // The suffix is `_<id>.jsonl`, so "123" must not match "chat-abc-123".
    writeSession("chat-abc-123", conversationEntries());
    expect(findPiSessionPath("123")).toBeNull();
  });
});
