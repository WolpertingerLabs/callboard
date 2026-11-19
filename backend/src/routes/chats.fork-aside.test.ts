/**
 * POST /api/chats/:id/fork with `kind: "aside"`: the role, title and stored
 * quotes, the permission clamp, the auto-started first turn, and refusal of
 * bad input — all before anything is written. Same stubbing as
 * chats.fork.test.ts (fake req/res, stubbed lookup, file service, providers);
 * the first turn's start (`startChatTurn`, shared with POST /:id/message) is
 * stubbed and asserted on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const effortContexts = vi.hoisted(() => vi.fn());
/** Which check the route ran for each call: "explicit" (fail-closed) or "stored". */
const effortChecks = vi.hoisted(() => vi.fn());
/** Set to simulate a Codex route probe that cannot answer (timeout, bad cwd). */
const probeUnknown = vi.hoisted(() => ({ value: false }));

vi.mock("../services/reasoning-capabilities.js", () => {
  const verify = (input: { provider?: string; effort?: unknown; cwd?: string }) => {
    const { provider, effort } = input;
    effortContexts(input);
    if (effort === "ultra" && input.cwd !== "/trusted-project") throw new Error("global base-model does not support ultra");
    if (effort && provider === "claude-code") throw new Error("Reasoning effort is not supported for claude-code");
  };
  return {
    assertReasoningEffort: async (input: { provider?: string; effort?: unknown; cwd?: string }) => {
      effortChecks("explicit");
      if (input.effort && probeUnknown.value) throw new Error(`Reasoning effort "${String(input.effort)}" is not supported for codex/unknown`);
      verify(input);
    },
    assertStoredReasoningEffort: async (input: { provider?: string; effort?: unknown; cwd?: string }) => {
      effortChecks("stored");
      if (probeUnknown.value) return; // cannot verify: the stored value goes through
      verify(input);
    },
  };
});

let parentChat: any;

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => parentChat,
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    // walkToRootId validates the parent's stored root before stamping the
    // fork. Return the parent itself and, when its fixture names one, a
    // minimal existing ancestor.
    getChat: (id: string) => {
      if (!parentChat) return null;
      if (id === parentChat.id || id === parentChat.session_id) return parentChat;
      const meta = JSON.parse(parentChat.metadata || "{}");
      if (id === meta.parentChatId || id === meta.forkedFrom || id === meta.rootChatId) {
        return { ...parentChat, id, session_id: id, metadata: "{}" };
      }
      return null;
    },
    // Echoes the composed metadata back so the test can assert on it, plus the
    // top-level workspaceId argument (which is a Chat field, not metadata).
    // Recorded, so the refusal cases can assert that no record was written.
    createChat: (folder: string, sessionId: string, metadata: string, workspaceId?: string) => {
      calls.createChat.push([folder, sessionId, metadata, workspaceId]);
      return { id: "fork-chat", folder, session_id: sessionId, metadata, ...(workspaceId && { workspaceId }) };
    },
  },
}));
/** Calls recorded by the stub providers, so tests can assert which path ran. */
const calls = vi.hoisted(() => ({ forkSession: [] as unknown[][], seedSession: [] as unknown[][], createChat: [] as unknown[][] }));

/** History the source provider hands back to the handoff projection. */
const sourceMessages: unknown[] = [
  { role: "user", type: "text", content: "carried question", timestamp: "2026-01-01T00:00:00Z" },
  { role: "assistant", type: "text", content: "carried answer", timestamp: "2026-01-01T00:00:00Z" },
];

vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      forkSession: (...args: unknown[]) => {
        calls.forkSession.push(args);
        return { logPath: "/tmp/fork.jsonl" };
      },
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      kind: "codex",
      // No forkSession — Codex has no native fork, which is exactly why a
      // codex→codex fork must fall through to the seed path.
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-codex.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      // pi implements seedSession AND forkSession for real —
      // `agents/handoff.roundtrip.test.ts` drives the actual provider. Here it
      // is a stub like the rest, so these cases assert the ROUTE offers it
      // rather than re-proving the provider works.
      kind: "pi",
      forkSession: (...args: unknown[]) => {
        calls.forkSession.push(args);
        return { logPath: "/tmp/fork-pi.jsonl" };
      },
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-pi.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      // The ACP harness is retired and its session provider is gone from the
      // real registry. Stubbed here WITH a seedSession anyway, on purpose: it
      // makes the rejection below prove the ROUTE refuses "acp" as a target on
      // the routable allowlist alone, even if something registered a provider
      // under the retired kind.
      kind: "acp",
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-acp.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
  ],
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
/** What the aside's auto-start was asked to send, and what it answers. */
const turns = vi.hoisted(() => ({ calls: [] as any[], result: { ok: true, emitter: {} } as any, throws: null as Error | null }));
vi.mock("../services/chat-turn.js", () => ({
  startChatTurn: async (req: unknown) => {
    turns.calls.push(req);
    if (turns.throws) throw turns.throws;
    return turns.result;
  },
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { chatsRouter } = await import("./chats.js");

const forkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/fork" && layer.route.methods.post).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

/** Invoke POST /:id/fork and resolve with the status code, the fork's parsed metadata, and the raw record. */
function fork(body: Record<string, unknown> = {}): Promise<{ code: number; meta: any; chat: any }> {
  calls.forkSession = [];
  calls.seedSession = [];
  calls.createChat = [];
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, meta: payload.metadata ? JSON.parse(payload.metadata) : payload, chat: payload });
        return this;
      },
    };
    forkHandler({ params: { id: "parent-chat" }, body: { timestamp: "2026-01-01T00:00:00Z", ...body } } as unknown as Request, res as unknown as Response);
  });
}

/**
 * Build a parent chat whose metadata is `meta` merged over the defaults.
 * `fields` sets top-level Chat columns (e.g. workspaceId, which is not metadata).
 */
function setParent(meta: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  parentChat = {
    id: "parent-chat",
    folder: "/repo",
    session_id: "session-1",
    session_log_path: "/tmp/parent.jsonl",
    metadata: JSON.stringify({ session_ids: ["session-1"], title: "Parent", ...meta }),
    ...fields,
  };
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:05:00.000Z";
const quote = (timestamp = T1, text = "the passage") => ({ timestamp, role: "assistant", text });
const aside = (body: Record<string, unknown> = {}) => fork({ timestamp: T1, kind: "aside", quotes: [quote()], ...body });

afterEach(() => {
  turns.calls = [];
  turns.result = { ok: true, emitter: {} };
  turns.throws = null;
});

describe("POST /api/chats/:id/fork kind aside", () => {
  it("creates an aside child at the fork point, with its quotes and a question title", async () => {
    setParent({});
    const res = await aside({ quotes: [quote(T0, "first"), quote(T1, "second")] });
    expect(res.code).toBe(201);
    expect(res.meta.chatRole).toBe("aside");
    expect(res.meta.parentChatId).toBe("parent-chat");
    expect(res.meta.forkedAt).toBe(T1);
    expect(res.meta.asideQuotes).toEqual([quote(T0, "first"), quote(T1, "second")]);
    // No prompt: titled off the first quote, and nothing is started.
    expect(res.meta.title).toBe("Aside: first");
    expect(turns.calls).toHaveLength(0);
    expect(res.chat).not.toHaveProperty("started");
  });

  it("titles off the question, truncated", async () => {
    setParent({});
    const res = await aside({ prompt: `what does ${"x".repeat(100)} mean?` });
    expect(res.meta.title.startsWith("Aside: what does x")).toBe(true);
    expect(res.meta.title.endsWith("…")).toBe(true);
  });

  it("stays an aside across a harness handoff", async () => {
    setParent({});
    const res = await aside({ provider: "codex", model: "gpt-5" });
    expect(res.code).toBe(201);
    expect(res.meta.chatRole).toBe("aside");
    expect(res.meta.provider).toBe("codex");
    expect(res.meta.model).toBe("gpt-5");
    expect(calls.seedSession).toHaveLength(1);
  });

  describe("permissions", () => {
    const parentPerms = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "ask", computerControl: "deny" };

    it("inherits the parent's when none are given", async () => {
      setParent({ defaultPermissions: parentPerms });
      expect((await aside()).meta.defaultPermissions).toEqual(parentPerms);
    });

    it("applies a stricter partial set (read only)", async () => {
      setParent({ defaultPermissions: parentPerms });
      const res = await aside({ permissions: { fileWrite: "ask", codeExecution: "ask" } });
      expect(res.meta.defaultPermissions).toEqual({ ...parentPerms, fileWrite: "ask", codeExecution: "ask" });
    });

    it("clamps a looser set to the parent's", async () => {
      setParent({ defaultPermissions: parentPerms });
      const res = await aside({ permissions: { webAccess: "allow", computerControl: "allow" } });
      expect(res.code).toBe(201);
      expect(res.meta.defaultPermissions).toEqual(parentPerms);
    });

    it("re-caps against the parent as it is just before the aside is written", async () => {
      setParent({ defaultPermissions: parentPerms });
      // The parent is tightened while the route awaits its effort check.
      const tighter = { ...parentPerms, fileRead: "ask", fileWrite: "deny" };
      effortContexts.mockImplementationOnce(() => setParent({ defaultPermissions: tighter }));
      expect((await aside()).meta.defaultPermissions).toEqual(tighter);
      effortContexts.mockImplementationOnce(() => setParent({ defaultPermissions: tighter }));
      const res = await aside({ permissions: { fileRead: "allow", codeExecution: "ask" } });
      expect(res.meta.defaultPermissions).toEqual({ ...tighter, codeExecution: "ask" });
    });

    it("clamps to ask-everywhere under a parent with no permissions", async () => {
      setParent({});
      const res = await aside({ permissions: { fileRead: "allow" } });
      expect(res.meta.defaultPermissions).toEqual({ fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" });
    });
  });

  describe("auto-start", () => {
    it("starts the first turn with the quotes as blockquotes and the question", async () => {
      setParent({});
      const res = await aside({ prompt: "  why this?  " });
      expect(res.code).toBe(201);
      expect(res.chat.started).toBe(true);
      expect(turns.calls).toHaveLength(1);
      const turn = turns.calls[0];
      expect(turn.chatId).toBe("fork-chat");
      expect(turn.acknowledgeBranchDrift).toBe(true);
      expect(turn.prompt).toMatch(/^> \*\*Assistant, (\w+ \d+( \d{4})?, )?\d\d:\d\d:\*\*\n> the passage\n\nwhy this\?$/);
    });

    it("writes the origin-line times in the asker's zone, else the daemon's", async () => {
      setParent({});
      await aside({ prompt: "why?", timeZone: "Asia/Kolkata" }); // T1 is 00:05 UTC
      expect(turns.calls[0].prompt).toMatch(/^> \*\*Assistant, Jan 1, 05:35:\*\*/);
      await aside({ prompt: "why?", timeZone: "Not/AZone" });
      expect(turns.calls[1].prompt).toMatch(/^> \*\*Assistant, (\w+ \d+( \d{4})?, )?\d\d:\d\d:\*\*/);
      expect((await fork({ timeZone: "UTC" })).meta.error).toBe('timeZone is only accepted with kind "aside"');
    });

    it("passes the composer's plugins to the first turn", async () => {
      setParent({});
      await aside({ prompt: "why?", activePlugins: ["plug-a", "plug-b"] });
      expect(turns.calls[0].activePlugins).toEqual(["plug-a", "plug-b"]);
      await aside({ prompt: "why?" });
      expect(turns.calls[1]).not.toHaveProperty("activePlugins");
    });

    it("keeps the aside and reports a refused start with the text", async () => {
      setParent({});
      // The aside was deleted (another tab) between its creation and the start.
      turns.result = { ok: false, status: 404, body: { error: "Chat not found" } };
      const res = await aside({ prompt: "why?" });
      expect(res.code).toBe(201);
      expect(res.chat.id).toBe("fork-chat");
      expect(res.chat.runError).toBe("Chat not found");
      expect(res.chat.promptText).toMatch(/why\?$/);
      expect(res.chat).not.toHaveProperty("started");
    });

    it("keeps the aside and reports a start that threw", async () => {
      setParent({});
      turns.throws = new Error("engine down");
      const res = await aside({ prompt: "why?" });
      expect(res.code).toBe(201);
      expect(res.chat.runError).toBe("engine down");
    });

    it("starts nothing for a blank question", async () => {
      setParent({});
      const res = await aside({ prompt: "   " });
      expect(res.code).toBe(201);
      expect(turns.calls).toHaveLength(0);
    });
  });

  describe("refusals — nothing is written", () => {
    it.each([
      ["a quote after the fork point", { quotes: [quote(T0), quote("2026-01-01T00:05:00.001Z")] }, /after the fork point/],
      ["no quotes", { quotes: [] }, /at least one quote/],
      ["missing quotes", { quotes: undefined }, /array/],
      ["a malformed quote", { quotes: [{ timestamp: T0, role: "robot", text: "x" }] }, /role/],
      ["too many quotes", { quotes: Array.from({ length: 21 }, () => quote()) }, /at most 20/],
      ["an overlong quote", { quotes: [quote(T0, "x".repeat(10_001))] }, /longer than/],
      ["an overlong question", { prompt: "x".repeat(20_001) }, /longer than/],
      ["a non-string question", { prompt: 42 }, /prompt must be a string/],
      ["bad permissions", { permissions: { fileRead: "sure" } }, /allow, ask, deny/],
      ["an invalid fork point", { timestamp: "later" }, /not a valid date/],
      ["a fork point later than the latest quote", { quotes: [quote(T0)] }, /must be the latest quote timestamp/],
      ["activePlugins without a question", { activePlugins: ["p"] }, /only accepted with a prompt/],
      ["malformed activePlugins", { prompt: "why?", activePlugins: "p" }, /array of strings/],
      ["an unknown kind", { kind: "tangent" }, /kind must be/],
    ])("refuses %s", async (_label, body, error) => {
      setParent({});
      const res = await aside(body);
      expect(res.code).toBe(400);
      expect(res.meta.error).toMatch(error);
      expect(calls.forkSession).toHaveLength(0);
      expect(calls.seedSession).toHaveLength(0);
      expect(calls.createChat).toHaveLength(0);
      expect(turns.calls).toHaveLength(0);
    });

    it("compares the fork point as an instant, not as a string", async () => {
      setParent({});
      const res = await aside({ timestamp: "2026-01-01T00:05:00Z" });
      expect(res.code).toBe(201);
      expect(res.meta.forkedAt).toBe("2026-01-01T00:05:00Z");
    });

    it("refuses aside fields on a plain fork rather than ignoring them", async () => {
      setParent({});
      const res = await fork({ quotes: [quote()], prompt: "why?" });
      expect(res.code).toBe(400);
      expect(res.meta.error).toBe('quotes, prompt are only accepted with kind "aside"');
      expect(calls.forkSession).toHaveLength(0);
      expect(calls.createChat).toHaveLength(0);
      expect((await fork({ activePlugins: ["p"] })).meta.error).toBe('activePlugins is only accepted with kind "aside"');
    });

    it("leaves a plain fork as it was", async () => {
      setParent({});
      const res = await fork({ kind: "fork" });
      expect(res.code).toBe(201);
      expect(res.meta.chatRole).toBe("fork");
      expect(res.meta).not.toHaveProperty("asideQuotes");
    });
  });
});
