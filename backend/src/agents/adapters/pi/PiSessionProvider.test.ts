/**
 * The session port, and the two operations that make pi a fork and handoff
 * target.
 *
 * The load-bearing cases are the **round-trips**: every file this provider
 * writes is opened again with pi's own `SessionManager.open()` and
 * `parseSessionEntries`, so a fork or a seed that produces a file pi cannot
 * read fails here rather than in a chat. That is the check the spike's §5
 * retired the risk on, kept as a test rather than a memory.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything reads `paths.ts` — the ACP suite once wrote fake sessions into
// a developer's real chat list (#302).
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-provider-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { CURRENT_SESSION_VERSION, SessionManager, parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
const { PiSessionProvider, parentSessionIdOf, relinkChain } = await import("./PiSessionProvider.js");
const { resolvePiSessionsRoot, piSessionFileName } = await import("./paths.js");
const { buildHandoffTurns } = await import("../../handoff.js");
import type { ParsedMessage } from "shared/types/index.js";
import type { HandoffTurn } from "../../handoff.js";

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const CWD = "/repo/some-repo";
const T1 = "2026-08-04T12:00:00.000Z";
const T2 = "2026-08-04T13:00:00.000Z";
const T3 = "2026-08-04T14:00:00.000Z";

const provider = new PiSessionProvider();

function root(): string {
  const dir = resolvePiSessionsRoot();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function userEntry(id: string, parentId: string | null, timestamp: string, text: string) {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) } };
}

function assistantEntry(id: string, parentId: string | null, timestamp: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "openrouter",
      model: "google/gemini-3.6-flash",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
    },
  };
}

function writeSession(sessionId: string, entries: Array<Record<string, unknown>>, opts: { cwd?: string } = {}): string {
  const path = join(root(), piSessionFileName(sessionId, new Date(T1)));
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: T1, cwd: opts.cwd ?? CWD };
  writeFileSync(path, [header, ...entries].map((o) => `${JSON.stringify(o)}\n`).join(""), "utf8");
  return path;
}

/** A three-turn conversation spanning three timestamps, for cutoff tests. */
function threeTurns() {
  return [
    userEntry("e1", null, T1, "first question"),
    assistantEntry("e2", "e1", T1, "first answer"),
    userEntry("e3", "e2", T2, "second question"),
    assistantEntry("e4", "e3", T2, "second answer"),
    userEntry("e5", "e4", T3, "third question"),
    assistantEntry("e6", "e5", T3, "third answer"),
  ];
}

/** Open a file the way pi itself would, and report what it resolves to. */
function openWithPi(path: string): { id: string; roles: string[]; texts: string[] } {
  const manager = SessionManager.open(path, root(), CWD);
  const context = manager.buildSessionContext();
  return {
    id: manager.getSessionId(),
    roles: context.messages.map((m) => (m as { role: string }).role),
    texts: context.messages.map((m) => {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") return content;
      return Array.isArray(content)
        ? content
            .filter((b) => (b as { type?: string })?.type === "text")
            .map((b) => (b as { text?: string }).text ?? "")
            .join("")
        : "";
    }),
  };
}

beforeEach(() => rmSync(resolvePiSessionsRoot(), { recursive: true, force: true }));

// ── Discovery / resolution / reading ────────────────────────────────

describe("discoverSessions", () => {
  it("returns nothing when no pi chat has ever run", () => {
    expect(provider.discoverSessions({ limit: 10, offset: 0 })).toEqual({ sessions: [], total: 0 });
  });

  it("reports the folder from the session header", () => {
    writeSession("s1", threeTurns(), { cwd: "/repo/project-a" });
    const { sessions } = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(sessions[0]).toMatchObject({ sessionId: "s1", folder: "/repo/project-a", displayFolder: "/repo/project-a" });
  });

  it("paginates against the visible total, not the raw file count", () => {
    for (const id of ["a", "b", "c"]) writeSession(id, threeTurns());
    const page = provider.discoverSessions({ limit: 2, offset: 0 });
    expect(page.sessions).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(provider.discoverSessions({ limit: 2, offset: 2 }).sessions).toHaveLength(1);
  });

  /**
   * `-tmp` is a default ignored prefix, so a chat run in a temp directory is
   * hidden from the chat list for every provider. Worth pinning: it is the
   * reason a scratch-repo fixture must not live under /tmp.
   */
  it("hides sessions whose cwd matches an ignored prefix", () => {
    writeSession("visible", threeTurns(), { cwd: "/repo/real" });
    writeSession("hidden", threeTurns(), { cwd: "/tmp/scratch" });
    const { sessions, total } = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(sessions.map((s) => s.sessionId)).toEqual(["visible"]);
    expect(total).toBe(1);
  });

  it("sorts newest first", () => {
    const a = writeSession("older", threeTurns());
    const b = writeSession("newer", threeTurns());
    utimesSync(a, new Date("2020-01-01"), new Date("2020-01-01"));
    utimesSync(b, new Date("2030-01-01"), new Date("2030-01-01"));
    expect(provider.discoverSessions({ limit: 10, offset: 0 }).sessions.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });
});

describe("resolveSession", () => {
  it("resolves an id to its file and folder", () => {
    const path = writeSession("chat-1", threeTurns());
    expect(provider.resolveSession("chat-1")).toEqual({ logPath: path, folder: CWD, displayFolder: CWD });
  });

  it("returns null for an unknown id", () => {
    expect(provider.resolveSession("nope")).toBeNull();
  });

  it("returns null for a traversing id rather than resolving it", () => {
    expect(provider.resolveSession("../../etc/passwd")).toBeNull();
  });
});

describe("parseSessionMessages", () => {
  it("reads one session", () => {
    writeSession("s1", threeTurns());
    expect(provider.parseSessionMessages(["s1"]).map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "third question",
      "third answer",
    ]);
  });

  it("concatenates multi-session chats in the order given", () => {
    writeSession("s1", [userEntry("e1", null, T1, "from session one")]);
    writeSession("s2", [userEntry("e1", null, T2, "from session two")]);
    expect(provider.parseSessionMessages(["s1", "s2"]).map((m) => m.content)).toEqual(["from session one", "from session two"]);
  });

  it("skips ids it cannot find instead of failing the whole read", () => {
    writeSession("s1", [userEntry("e1", null, T1, "present")]);
    expect(provider.parseSessionMessages(["missing", "s1"]).map((m) => m.content)).toEqual(["present"]);
  });
});

describe("getSessionPreview", () => {
  it("returns the first user message", () => {
    const path = writeSession("s1", threeTurns());
    expect(provider.getSessionPreview(path)).toBe("first question");
  });

  it("truncates with an ellipsis at the requested length", () => {
    const path = writeSession("s1", [userEntry("e1", null, T1, "x".repeat(50))]);
    expect(provider.getSessionPreview(path, 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("returns null when there is nothing to preview", () => {
    expect(provider.getSessionPreview(writeSession("s1", []))).toBeNull();
  });
});

describe("findSubagentFiles", () => {
  it("is always empty — pi has no subagents", () => {
    expect(provider.findSubagentFiles("s1")).toEqual([]);
  });
});

// ── Search ──────────────────────────────────────────────────────────

describe("searchSessions", () => {
  it("filters by folder", () => {
    writeSession("a", threeTurns(), { cwd: "/repo/project-a" });
    writeSession("b", threeTurns(), { cwd: "/repo/project-b" });
    expect(provider.searchSessions({ folder: "/repo/project-a" }).chats.map((c) => c.sessionId)).toEqual(["a"]);
  });

  it("greps the conversation body, not just the preview", () => {
    writeSession("a", [userEntry("e1", null, T1, "hello"), assistantEntry("e2", "e1", T1, "a distinctive phrase deep in the reply")]);
    writeSession("b", [userEntry("e1", null, T1, "hello"), assistantEntry("e2", "e1", T1, "something else")]);
    expect(provider.searchSessions({ folder: "", grep: "distinctive phrase" }).chats.map((c) => c.sessionId)).toEqual(["a"]);
  });

  it("greps case-insensitively", () => {
    writeSession("a", [userEntry("e1", null, T1, "The Deploy Pipeline")]);
    expect(provider.searchSessions({ folder: "", grep: "deploy pipeline" }).chats).toHaveLength(1);
  });

  it("filters by updated bounds", () => {
    const path = writeSession("a", threeTurns());
    utimesSync(path, new Date("2026-06-01"), new Date("2026-06-01"));
    expect(provider.searchSessions({ folder: "", updatedAfter: "2026-07-01" }).chats).toHaveLength(0);
    expect(provider.searchSessions({ folder: "", updatedBefore: "2026-07-01" }).chats).toHaveLength(1);
  });

  it("honours the limit while reporting the true total", () => {
    for (const id of ["a", "b", "c"]) writeSession(id, threeTurns());
    const result = provider.searchSessions({ folder: "", limit: 2 });
    expect(result.chats).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it("leaves callboard-native metadata null for routes/chats.ts to join in", () => {
    writeSession("a", threeTurns());
    expect(provider.searchSessions({ folder: "" }).chats[0]).toMatchObject({ agentAlias: null, gitBranch: null, triggered: false });
  });
});

// ── Deletion ────────────────────────────────────────────────────────

describe("deleteSessionFiles", () => {
  it("removes the session file", () => {
    writeSession("s1", threeTurns());
    provider.deleteSessionFiles("s1");
    expect(provider.resolveSession("s1")).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    expect(() => provider.deleteSessionFiles("nope")).not.toThrow();
  });

  it("refuses a traversing id", () => {
    const path = writeSession("s1", threeTurns());
    provider.deleteSessionFiles("../../etc/passwd");
    expect(readFileSync(path, "utf8")).toContain("first question");
  });
});

// ── Fork ────────────────────────────────────────────────────────────

describe("forkSession", () => {
  it("keeps only entries at or before the cutoff", () => {
    writeSession("src", threeTurns());
    const forked = provider.forkSession(["src"], T2, "fork-1");
    expect(forked).not.toBeNull();
    const texts = provider.parseSessionMessages(["fork-1"]).map((m) => m.content);
    expect(texts).toEqual(["first question", "first answer", "second question", "second answer"]);
    expect(texts).not.toContain("third question");
  });

  /**
   * The check that matters: pi must be able to open what we wrote. A fork that
   * renders in callboard but that `SessionManager.open()` cannot resolve is the
   * failure `AcpSessionProvider` describes — correct-looking history, no context.
   */
  it("produces a file pi itself resumes, with our id and the kept history", () => {
    writeSession("src", threeTurns());
    const forked = provider.forkSession(["src"], T2, "fork-1")!;
    const opened = openWithPi(forked.logPath);
    expect(opened.id).toBe("fork-1");
    expect(opened.roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(opened.texts).toEqual(["first question", "first answer", "second question", "second answer"]);
  });

  it("records lineage as the source path, and parentSessionIdOf translates it back", () => {
    const sourcePath = writeSession("src", threeTurns());
    const forked = provider.forkSession(["src"], T3, "fork-1")!;
    // The plan claimed the two lineages "agree instead of being reconciled".
    // They do not: this is a path, and the translation is ours.
    const header = parseSessionEntries(readFileSync(forked.logPath, "utf8"))[0] as { parentSession?: string };
    expect(header.parentSession).toBe(sourcePath);
    expect(parentSessionIdOf(forked.logPath)).toBe("src");
  });

  it("returns null when nothing falls at or before the cutoff", () => {
    writeSession("src", threeTurns());
    expect(provider.forkSession(["src"], "2020-01-01T00:00:00.000Z", "fork-1")).toBeNull();
  });

  it("returns null for an unknown source", () => {
    expect(provider.forkSession(["nope"], T2, "fork-1")).toBeNull();
  });

  it("returns null for an unparseable cutoff", () => {
    writeSession("src", threeTurns());
    expect(provider.forkSession(["src"], "not a date", "fork-1")).toBeNull();
  });

  it("refuses to fork into a traversing id", () => {
    writeSession("src", threeTurns());
    expect(provider.forkSession(["src"], T3, "../../escape")).toBeNull();
  });

  /**
   * Merging two sessions naively would produce two roots, and pi walks leaf →
   * root, so it would silently follow only one of them — half the history gone
   * with no error.
   */
  it("merges multiple sessions into ONE chain pi can walk end to end", () => {
    writeSession("s1", [userEntry("e1", null, T1, "from one"), assistantEntry("e2", "e1", T1, "reply one")]);
    // Deliberately colliding entry ids, which is what makes re-linking necessary
    // rather than merely tidy.
    writeSession("s2", [userEntry("e1", null, T2, "from two"), assistantEntry("e2", "e1", T2, "reply two")]);

    const forked = provider.forkSession(["s1", "s2"], T3, "merged")!;
    const opened = openWithPi(forked.logPath);
    expect(opened.texts).toEqual(["from one", "reply one", "from two", "reply two"]);
  });

  it("gives every entry in a merged fork a unique id", () => {
    writeSession("s1", [userEntry("e1", null, T1, "a")]);
    writeSession("s2", [userEntry("e1", null, T2, "b")]);
    const forked = provider.forkSession(["s1", "s2"], T3, "merged")!;
    const ids = parseSessionEntries(readFileSync(forked.logPath, "utf8"))
      .filter((e) => e.type !== "session")
      .map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("relinkChain", () => {
  it("turns a flat list into a single parent chain", () => {
    const chain = relinkChain([{ id: "x" }, { id: "y" }, { id: "z" }]);
    expect(chain.map((e) => [e.id, e.parentId])).toEqual([
      ["fork-0", null],
      ["fork-1", "fork-0"],
      ["fork-2", "fork-1"],
    ]);
  });

  it("preserves everything else on the entry", () => {
    expect(relinkChain([{ id: "x", type: "message", message: { role: "user" } }])[0]).toMatchObject({ type: "message", message: { role: "user" } });
  });

  it("handles an empty list", () => {
    expect(relinkChain([])).toEqual([]);
  });
});

// ── Cross-harness handoff ───────────────────────────────────────────

describe("seedSession", () => {
  /**
   * A real handoff shape, not a synthetic turn: `buildHandoffTurns` prepends the
   * provenance preamble and its acknowledgement, folds tool traffic into
   * bracketed text, and merges consecutive same-role turns. Seeding from a
   * single hand-made turn would test none of that.
   */
  function realHandoffTurns(): HandoffTurn[] {
    const source: ParsedMessage[] = [
      { role: "user", type: "text", content: "please check the readme", timestamp: T1 },
      { role: "assistant", type: "text", content: "I will read it.", timestamp: T1 },
      { role: "assistant", type: "tool_use", content: '{"file_path":"README.md"}', toolName: "Read", toolUseId: "t1", timestamp: T1 },
      { role: "user", type: "tool_result", content: "hello world", toolUseId: "t1", timestamp: T1 },
      { role: "assistant", type: "text", content: "It says hello world.", timestamp: T2 },
      { role: "assistant", type: "thinking", content: "secret reasoning", timestamp: T2 },
      { role: "user", type: "text", content: "thanks", timestamp: T2 },
    ];
    return buildHandoffTurns(source, "claude-code", "pi" as never);
  }

  it("writes a session pi resumes, carrying the whole handed-off conversation", () => {
    const turns = realHandoffTurns();
    const seeded = provider.seedSession(turns, { folder: CWD, newSessionId: "handoff-1" })!;
    expect(seeded).not.toBeNull();

    const opened = openWithPi(seeded.logPath);
    expect(opened.id).toBe("handoff-1");
    expect(opened.roles).toEqual(turns.map((t) => t.role));
    // The preamble tells the model where this came from.
    expect(opened.texts[0]).toContain("conversation_handoff");
    expect(opened.texts[0]).toContain("Claude Code");
    // Tool traffic survives as bracketed text rather than as replayed calls.
    expect(opened.texts.join("\n")).toContain("[tool: Read]");
    expect(opened.texts.join("\n")).toContain("[tool result] hello world");
    expect(opened.texts.join("\n")).toContain("It says hello world.");
    // Reasoning is deliberately dropped by the projection.
    expect(opened.texts.join("\n")).not.toContain("secret reasoning");
  });

  it("alternates roles the way a real conversation does", () => {
    const opened = openWithPi(provider.seedSession(realHandoffTurns(), { folder: CWD, newSessionId: "handoff-2" })!.logPath);
    expect(opened.roles[0]).toBe("user");
    expect(opened.roles[1]).toBe("assistant");
    // buildHandoffTurns merges consecutive same-role turns, so no two adjacent
    // roles should match — some providers reject that outright.
    for (let i = 1; i < opened.roles.length; i++) expect(opened.roles[i]).not.toBe(opened.roles[i - 1]);
  });

  it("writes a valid version-3 header with the folder as cwd", () => {
    const seeded = provider.seedSession(realHandoffTurns(), { folder: "/repo/target-repo", newSessionId: "handoff-3" })!;
    const header = parseSessionEntries(readFileSync(seeded.logPath, "utf8"))[0];
    expect(header).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION, id: "handoff-3", cwd: "/repo/target-repo" });
  });

  it("is discoverable and readable through the provider immediately", () => {
    provider.seedSession(realHandoffTurns(), { folder: CWD, newSessionId: "handoff-4" });
    expect(provider.resolveSession("handoff-4")).not.toBeNull();
    expect(provider.parseSessionMessages(["handoff-4"]).length).toBeGreaterThan(3);
  });

  it("carries images on user turns as pi image blocks", () => {
    const turns: HandoffTurn[] = [{ role: "user", text: "look at this", images: [{ mimeType: "image/png", base64: "aGk=" }] }];
    const seeded = provider.seedSession(turns, { folder: CWD, newSessionId: "handoff-img" })!;
    const entries = parseSessionEntries(readFileSync(seeded.logPath, "utf8"));
    const content = (entries[1] as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
    expect(content).toContainEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
  });

  it("returns null for no turns rather than writing an empty session", () => {
    expect(provider.seedSession([], { folder: CWD, newSessionId: "empty" })).toBeNull();
  });

  it("refuses to seed into a traversing id", () => {
    expect(provider.seedSession(realHandoffTurns(), { folder: CWD, newSessionId: "../../escape" })).toBeNull();
  });

  it("survives a turn with no timestamp", () => {
    const seeded = provider.seedSession([{ role: "user", text: "no timestamp here" }], { folder: CWD, newSessionId: "no-ts" })!;
    expect(openWithPi(seeded.logPath).texts).toEqual(["no timestamp here"]);
  });
});

describe("parentSessionIdOf", () => {
  it("returns null for a session with no parent", () => {
    expect(parentSessionIdOf(writeSession("s1", threeTurns()))).toBeNull();
  });

  it("returns null for a file that does not exist", () => {
    expect(parentSessionIdOf(join(root(), "nope.jsonl"))).toBeNull();
  });
});
