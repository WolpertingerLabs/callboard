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
const calls = vi.hoisted(() => ({ forkSession: [] as unknown[][], seedSession: [] as unknown[][], createChat: [] as unknown[][], deleted: [] as string[] }));

/** History the source provider hands back to the handoff projection (and to the fork-at-latest pick). */
const defaultSourceMessages = [
  { role: "user", type: "text", content: "carried question", timestamp: "2026-01-01T00:00:00Z" },
  { role: "assistant", type: "text", content: "carried answer", timestamp: "2026-01-01T00:00:00Z" },
];
const sourceMessages: unknown[] = [...defaultSourceMessages];

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
      deleteSessionFiles: (id: string) => calls.deleted.push(id),
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
/** Settings → Codex sandbox mode as the route reads it — never the real settings file. */
const settings = vi.hoisted(() => ({ codexSandboxMode: undefined as string | undefined }));
vi.mock("../services/agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/agent-settings.js")>()),
  getAgentSettings: () => ({ ...(settings.codexSandboxMode && { codexSandboxMode: settings.codexSandboxMode }) }),
}));
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
/** Upload ids that "exist": loadImageBuffers answers for these only, never touching the real images dir. */
const storedImages = vi.hoisted(() => new Set<string>());
vi.mock("../services/image-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/image-storage.js")>()),
  loadImageBuffers: (ids: string[]) => ids.filter((id) => storedImages.has(id)).map((id) => ({ id, buffer: Buffer.from(""), mimeType: "image/png" })),
}));

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
  calls.deleted = [];
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
  storedImages.clear();
  sourceMessages.splice(0, sourceMessages.length, ...defaultSourceMessages);
  settings.codexSandboxMode = undefined;
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

  it("stores which repeat of a passage each quote is, and refuses a malformed one", async () => {
    setParent({});
    const res = await aside({ quotes: [{ ...quote(T0, "again"), occurrence: 1 }, quote(T1, "second")] });
    expect(res.code).toBe(201);
    expect(res.meta.asideQuotes).toEqual([{ ...quote(T0, "again"), occurrence: 1 }, quote(T1, "second")]);

    const refused = await aside({ quotes: [{ ...quote(T1, "x"), occurrence: -1 }] });
    expect(refused.code).toBe(400);
  });

  it("keeps a system message's quote as system, labelled so in the prompt", async () => {
    setParent({});
    const res = await aside({ quotes: [{ timestamp: T1, role: "system", text: "notice" }], prompt: "why?" });
    expect(res.code).toBe(201);
    expect(res.meta.asideQuotes).toEqual([{ timestamp: T1, role: "system", text: "notice" }]);
    expect(turns.calls[0].prompt).toMatch(/^> \*\*System, /);
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

    it("maps readOnly to ask on writes and runs, deny on computer control, and drops the model reviewer", async () => {
      setParent({ defaultPermissions: { ...parentPerms, computerControl: "allow", webAccess: "allow" }, modelReview: true });
      const res = await aside({ readOnly: true });
      expect(res.meta.defaultPermissions).toEqual({ fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "allow", computerControl: "deny" });
      expect(res.meta).not.toHaveProperty("modelReview");
    });

    it("keeps a parent's stricter axes under readOnly, and the reviewer without it", async () => {
      setParent({ defaultPermissions: { ...parentPerms, fileWrite: "deny" }, modelReview: true });
      const ro = await aside({ readOnly: true, permissions: { fileWrite: "allow" } });
      expect(ro.meta.defaultPermissions).toMatchObject({ fileWrite: "deny", codeExecution: "ask", computerControl: "deny" });
      const plain = await aside();
      expect(plain.meta.modelReview).toBe(true);
    });

    it("re-applies readOnly in the late re-cap", async () => {
      setParent({ defaultPermissions: parentPerms });
      effortContexts.mockImplementationOnce(() => setParent({ defaultPermissions: { ...parentPerms, fileRead: "ask" } }));
      const res = await aside({ readOnly: true });
      expect(res.meta.defaultPermissions).toEqual({ ...parentPerms, fileRead: "ask", fileWrite: "ask", codeExecution: "ask" });
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

  it("marks a refusal of the target harness or effort with fork_target_invalid, and no other", async () => {
    setParent({});
    expect((await aside({ provider: "acp" })).meta).toMatchObject({ code: "fork_target_invalid" });
    expect((await aside({ provider: "codex", effort: "ultra" })).meta).toMatchObject({ code: "fork_target_invalid" });
    expect((await aside({ quotes: [quote(T0)] })).meta).not.toHaveProperty("code");
  });

  describe("Codex sandbox setting", () => {
    const loose = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" };

    it("refuses a Read only Codex aside under workspace-write, writing nothing", async () => {
      setParent({ defaultPermissions: loose });
      settings.codexSandboxMode = "workspace-write";
      const res = await aside({ provider: "codex", readOnly: true, prompt: "why?" });
      expect(res.code).toBe(400);
      expect(res.meta.code).toBe("codex_sandbox_exceeds_ceiling");
      expect(res.meta.error).toMatch(/codexSandboxMode="workspace-write"/);
      expect(calls.seedSession).toHaveLength(0);
      expect(calls.createChat).toHaveLength(0);
      expect(turns.calls).toHaveLength(0);
    });

    it("refuses any Codex aside the setting would loosen, Read only or not", async () => {
      setParent({ defaultPermissions: { ...loose, codeExecution: "ask" } });
      settings.codexSandboxMode = "danger-full-access";
      expect((await aside({ provider: "codex" })).code).toBe(400);
    });

    it("allows a Read only Codex aside with no explicit sandbox mode, or one that fits", async () => {
      setParent({ defaultPermissions: loose });
      const plain = await aside({ provider: "codex", readOnly: true });
      expect(plain.code).toBe(201);
      settings.codexSandboxMode = "read-only";
      expect((await aside({ provider: "codex", readOnly: true })).code).toBe(201);
    });

    it("leaves other harnesses alone", async () => {
      setParent({ defaultPermissions: loose });
      settings.codexSandboxMode = "danger-full-access";
      expect((await aside({ readOnly: true })).code).toBe(201);
    });

    it("refuses when the parent is tightened during the request, removing the written session", async () => {
      setParent({ defaultPermissions: loose, provider: "codex" });
      settings.codexSandboxMode = "workspace-write";
      // Fits at first (allow-all → full access ≥ workspace-write); the parent then drops to ask.
      effortContexts.mockImplementationOnce(() => setParent({ defaultPermissions: { ...loose, fileWrite: "ask", codeExecution: "ask" }, provider: "codex" }));
      const res = await aside();
      expect(res.code).toBe(400);
      expect(res.meta.code).toBe("codex_sandbox_exceeds_ceiling");
      expect(calls.seedSession).toHaveLength(1);
      expect(calls.deleted).toEqual([(calls.seedSession[0]![1] as { newSessionId: string }).newSessionId]);
      expect(calls.createChat).toHaveLength(0);
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
      expect(turns.calls[0].prompt).toMatch(/^> \*\*Assistant, Jan 1( 2026)?, 05:35:\*\*/);
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

  describe("forkAtLatest — no quotes", () => {
    const latest = (body: Record<string, unknown> = {}) => fork({ timestamp: undefined, kind: "aside", forkAtLatest: true, ...body });

    it("forks at the newest message of the daemon's read of the log, stores no quotes, and titles off the question", async () => {
      setParent({});
      // Out of stamp order on purpose: the newest wins, not the last.
      sourceMessages.splice(
        0,
        sourceMessages.length,
        { role: "user", type: "text", content: "q", timestamp: T0 },
        { role: "assistant", type: "text", content: "a", timestamp: "2026-01-01T00:09:00.000Z" },
        { role: "assistant", type: "tool_use", content: "Read", timestamp: "2026-01-01T00:08:00.000Z" },
        { role: "system", type: "system", content: "no stamp" },
      );
      const res = await latest({ prompt: "  what now?  " });
      expect(res.code).toBe(201);
      expect(res.meta.chatRole).toBe("aside");
      expect(res.meta.forkedAt).toBe("2026-01-01T00:09:00.000Z");
      expect(res.meta).not.toHaveProperty("asideQuotes");
      expect(res.meta.title).toBe("Aside: what now?");
      expect(calls.forkSession).toHaveLength(1);
      expect(calls.forkSession[0]![1]).toBe("2026-01-01T00:09:00.000Z");
      // No quotes: the question goes out as typed.
      expect(turns.calls[0].prompt).toBe("what now?");
      expect(res.chat.started).toBe(true);
      expect(res.chat).not.toHaveProperty("attachedImages");
    });

    it("accepts an empty quote list as no quotes", async () => {
      setParent({});
      expect((await latest({ quotes: [], prompt: "why?" })).code).toBe(201);
    });

    it("refuses an empty chat: nothing to fork at", async () => {
      setParent({});
      sourceMessages.splice(0, sourceMessages.length);
      const res = await latest({ prompt: "why?" });
      expect(res.code).toBe(400);
      expect(res.meta.error).toMatch(/no messages found/);
      expect(calls.createChat).toHaveLength(0);
    });

    it.each([
      ["quotes with it", { quotes: [quote()], prompt: "why?" }, /quotes are not accepted with forkAtLatest/],
      ["a timestamp with it", { timestamp: T1, prompt: "why?" }, /timestamp is not accepted with forkAtLatest/],
      ["nothing asked", {}, /an aside needs a question/],
      ["a blank question", { prompt: "   " }, /an aside needs a question/],
      ["a non-boolean forkAtLatest", { forkAtLatest: "yes", timestamp: T1, quotes: [quote()] }, /forkAtLatest must be a boolean/],
    ])("refuses %s", async (_label, body, error) => {
      setParent({});
      const res = await latest(body);
      expect(res.code).toBe(400);
      expect(res.meta.error).toMatch(error);
      expect(calls.forkSession).toHaveLength(0);
      expect(calls.createChat).toHaveLength(0);
      expect(turns.calls).toHaveLength(0);
    });

    it("still needs a timestamp without forkAtLatest", async () => {
      setParent({});
      expect((await fork({ timestamp: undefined, kind: "aside", quotes: [quote()] })).meta.error).toBe("timestamp is required");
      expect((await fork({ timestamp: undefined, kind: "aside", forkAtLatest: false, prompt: "why?" })).meta.error).toBe("timestamp is required");
    });
  });

  describe("attachments (imageIds)", () => {
    const IMG_A = "11111111-1111-4111-8111-111111111111";
    const IMG_B = "22222222-2222-4222-8222-222222222222";

    it("passes them to the first turn and reports how many went", async () => {
      setParent({});
      storedImages.add(IMG_A).add(IMG_B);
      const res = await aside({ prompt: "what is this?", imageIds: [IMG_A, IMG_B], activePlugins: ["p"] });
      expect(res.code).toBe(201);
      expect(turns.calls[0].imageIds).toEqual([IMG_A, IMG_B]);
      expect(res.chat.attachedImages).toBe(2);
      expect(res.chat.started).toBe(true);
    });

    it("starts an attachments-only aside, titled plain Aside when unquoted", async () => {
      setParent({});
      storedImages.add(IMG_A);
      const res = await fork({ timestamp: undefined, kind: "aside", forkAtLatest: true, imageIds: [IMG_A], activePlugins: ["p"] });
      expect(res.code).toBe(201);
      expect(res.meta.title).toBe("Aside");
      expect(turns.calls[0]).toMatchObject({ prompt: "", imageIds: [IMG_A], activePlugins: ["p"] });
      expect(res.chat.attachedImages).toBe(1);
    });

    it("reports the count beside a start that failed, too", async () => {
      setParent({});
      storedImages.add(IMG_A);
      turns.result = { ok: false, status: 409, body: { message: "busy" } };
      const res = await aside({ prompt: "why?", imageIds: [IMG_A] });
      expect(res.chat).toMatchObject({ runError: "busy", attachedImages: 1 });
    });

    it("refuses a malformed id (400) and a missing upload (409), writing nothing", async () => {
      setParent({});
      storedImages.add(IMG_A);
      const bad = await aside({ prompt: "why?", imageIds: ["../../etc/passwd"] });
      expect(bad.code).toBe(400);
      expect(bad.meta.error).toMatch(/imageIds must be an array of upload ids/);
      expect((await aside({ prompt: "why?", imageIds: IMG_A })).code).toBe(400);
      const missing = await aside({ prompt: "why?", imageIds: [IMG_A, IMG_B] });
      expect(missing.code).toBe(409);
      expect(calls.forkSession).toHaveLength(0);
      expect(calls.createChat).toHaveLength(0);
      expect(turns.calls).toHaveLength(0);
    });
  });

  describe("refusals — nothing is written", () => {
    it.each([
      ["a quote after the fork point", { quotes: [quote(T0), quote("2026-01-01T00:05:00.001Z")] }, /after the fork point/],
      ["no quotes", { quotes: [] }, /at least one quote/],
      ["missing quotes", { quotes: undefined }, /array/],
      ["a malformed quote", { quotes: [{ timestamp: T0, role: "robot", text: "x" }] }, /role/],
      ["a non-boolean readOnly", { readOnly: "yes" }, /readOnly must be a boolean/],
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
      expect((await fork({ readOnly: true })).meta.error).toBe('readOnly is only accepted with kind "aside"');
      expect((await fork({ forkAtLatest: true, imageIds: [] })).meta.error).toBe('forkAtLatest, imageIds are only accepted with kind "aside"');
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
