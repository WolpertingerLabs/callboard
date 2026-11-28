/**
 * H-01: a chat's permission policy governs Callboard's own tools.
 *
 * Callboard's in-process servers used to be pre-approved by an
 * `mcp__<key>__*` wildcard, so the SDK ran them before `canUseTool` was ever
 * asked: a chat denied `fileRead` could still copy `~/.ssh/id_rsa` into
 * storage, one denied `webAccess` could call any service through
 * `secure_request`, and any chat could read a vault secret.
 *
 * This drives `sendMessage` end to end with a recording provider and checks
 * both layers on what it actually built:
 *  - the `canUseTool` it hands the SDK (the per-call gate), and
 *  - the real tool handlers it registered (the handler-side guard), called
 *    directly with the same arguments, proving nothing happened on disk and
 *    no outbound call was made.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { ToolCallResult, ToolServerSpec } from "../agents/ports/tools.js";
import type { DefaultPermissions, StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-mcp-policy-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-mcp-policy-work-"));
const secretDir = mkdtempSync(join(tmpdir(), "callboard-mcp-policy-secret-"));
const SECRET = `TOP-SECRET-${Date.now()}`;
const secretFile = join(secretDir, "id_rsa");
writeFileSync(secretFile, SECRET);

// Drawlatch: no daemon. Every proxy tool call goes through this spy.
const proxyCallTool = vi.fn(async () => ({ ok: true }));
vi.mock("./proxy-singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proxy-singleton.js")>()),
  ensureCallerEnrolled: async () => true,
  getProxy: () => ({ callTool: proxyCallTool }),
}));
vi.mock("./agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-settings.js")>()),
  resolveDefaultCaller: () => "default-caller",
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { chatFileService } = await import("./chat-file-service.js");
const { pendingRequests } = await import("./pending-requests.js");

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal },
) => Promise<{ behavior: "allow" | "deny"; message?: string; interrupt?: boolean }>;

let sessionCounter = 0;

function recordingProvider() {
  const requests: AgentQueryRequest[] = [];
  const specs = new Map<string, ToolServerSpec>();
  const sessionId = `mcp-policy-${++sessionCounter}`;
  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      requests.push(req);
      let ended = false;
      const waiter: { wake: (() => void) | null } = { wake: null };
      const nudge = () => {
        const w = waiter.wake;
        waiter.wake = null;
        w?.();
      };
      const queued: AgentEvent[] = [
        { type: "session_started", sessionId },
        { type: "text", content: "ok" },
        { type: "result", status: "success" },
      ];
      void (async () => {
        for await (const _message of req.prompt as AsyncIterable<unknown>) {
          // drain
        }
        ended = true;
        nudge();
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queued.length > 0) yield queued.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => {
              waiter.wake = resolve;
            });
          }
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          ended = true;
          nudge();
        },
      };
    },
    // Keep the real (guarded) spec so its handlers can be called directly.
    buildToolServer: (spec: ToolServerSpec) => {
      specs.set(spec.name, spec);
      return { mock: spec.name };
    },
  };
  return { provider, requests, specs, sessionId };
}

const ALLOW: DefaultPermissions = {
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess: "allow",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};

/** One finished turn of a new chat under `defaultPermissions`. */
async function chat(defaultPermissions: DefaultPermissions) {
  const ctrl = recordingProvider();
  setAgentProviderForTesting(ctrl.provider, "claude-code");
  const emitter = await sendMessage({ prompt: "hello", folder: workDir, defaultPermissions } as never);
  const events: StreamEvent[] = [];
  emitter.on("event", (e: StreamEvent) => events.push(e));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const options = ctrl.requests[0].options as { canUseTool: CanUseTool; allowedTools?: string[] };
  const tool = (server: string, name: string) => {
    const found = ctrl.specs.get(server)?.tools.find((t) => t.name === name);
    if (!found) throw new Error(`no ${server}/${name} registered`);
    return (args: Record<string, unknown>) => found.handler(args) as Promise<ToolCallResult>;
  };
  const ask = (name: string, input: Record<string, unknown>) => options.canUseTool(name, input, { signal: new AbortController().signal });
  return { options, tool, ask, events, sessionId: ctrl.sessionId };
}

const resultJson = (r: ToolCallResult) => JSON.parse((r.content[0] as { text: string }).text);

/** Every file under `dir` whose content includes `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) hits.push(...filesContaining(p, needle));
    else if (st.size < 5_000_000 && readFileSync(p, "utf8").includes(needle)) hits.push(p);
  }
  return hits;
}

beforeEach(() => proxyCallTool.mockClear());
afterEach(() => {
  setAgentProviderForTesting(null);
  pendingRequests.clear();
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
});

describe("fileRead: deny", () => {
  it("save_storage_item(source_path) is denied by canUseTool (interrupt:false) and by its handler, and copies nothing", async () => {
    const c = await chat({ ...ALLOW, fileRead: "deny" });
    const input = { key: "loot", name: "id_rsa", source_path: secretFile, create_key: true };
    const decision = await c.ask("mcp__callboard-tools__save_storage_item", input);
    expect(decision).toMatchObject({ behavior: "deny", interrupt: false });
    expect(decision.message).toMatch(/fileRead/);

    const result = await c.tool("callboard-tools", "save_storage_item")(input);
    expect(resultJson(result)).toMatchObject({ ok: false, error: "permission_policy", category: "fileRead" });
    expect(filesContaining(dataDir, SECRET)).toEqual([]);
    expect(filesContaining(dataDir, '"loot"')).toEqual([]);
  });

  it("read_session_messages is denied on both layers", async () => {
    const c = await chat({ ...ALLOW, fileRead: "deny" });
    expect(await c.ask("mcp__callboard-tools__read_session_messages", { chatId: "x" })).toMatchObject({ behavior: "deny", interrupt: false });
    expect(resultJson(await c.tool("callboard-tools", "read_session_messages")({ chatId: "x" }))).toMatchObject({ error: "permission_policy" });
  });
});

describe("webAccess: deny", () => {
  it("secure_request is denied and never reaches the proxy", async () => {
    const c = await chat({ ...ALLOW, webAccess: "deny" });
    const input = { method: "GET", url: "https://example.com" };
    expect(await c.ask("mcp__mcp-proxy__secure_request", input)).toMatchObject({ behavior: "deny", interrupt: false });
    expect(resultJson(await c.tool("mcp-proxy", "secure_request")(input))).toMatchObject({ error: "permission_policy", category: "webAccess" });
    expect(proxyCallTool).not.toHaveBeenCalled();
  });
});

describe("codeExecution: deny", () => {
  it("vault_get is denied and never reaches the vault", async () => {
    const c = await chat({ ...ALLOW, codeExecution: "deny" });
    expect(await c.ask("mcp__mcp-proxy__vault_get", { name: "github" })).toMatchObject({ behavior: "deny" });
    expect(resultJson(await c.tool("mcp-proxy", "vault_get")({ name: "github" }))).toMatchObject({ error: "permission_policy" });
    expect(proxyCallTool).not.toHaveBeenCalled();
  });
});

describe("fileWrite: deny", () => {
  it("write_custom_skill is denied and writes no skill", async () => {
    const c = await chat({ ...ALLOW, fileWrite: "deny" });
    const marker = `SKILL-${Date.now()}`;
    const input = { name: "planted", description: "d", content: marker };
    expect(await c.ask("mcp__callboard-tools__write_custom_skill", input)).toMatchObject({ behavior: "deny" });
    expect(resultJson(await c.tool("callboard-tools", "write_custom_skill")(input))).toMatchObject({ error: "permission_policy" });
    expect(filesContaining(dataDir, marker)).toEqual([]);
  });
});

describe("ask", () => {
  it("raises a permission_request for a gated Callboard tool instead of running it", async () => {
    const c = await chat({ ...ALLOW, fileRead: "ask" });
    const controller = new AbortController();
    const pending = c.options.canUseTool("mcp__callboard-tools__read_session_messages", { chatId: "x" }, { signal: controller.signal });
    await vi.waitFor(() => expect(c.events.some((e) => e.type === "permission_request")).toBe(true));
    const request = c.events.find((e) => e.type === "permission_request") as StreamEvent & { toolName?: string };
    expect(request.toolName).toBe("mcp__callboard-tools__read_session_messages");
    controller.abort();
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("all allow — no regression", () => {
  it("canUseTool allows and the handler runs", async () => {
    const c = await chat(ALLOW);
    const input = { key: "notes", name: "copy", source_path: secretFile, create_key: true };
    expect(await c.ask("mcp__callboard-tools__save_storage_item", input)).toMatchObject({ behavior: "allow" });
    const result = await c.tool("callboard-tools", "save_storage_item")(input);
    expect(resultJson(result).error).toBeUndefined();
    expect(filesContaining(dataDir, SECRET).length).toBeGreaterThan(0);
    rmSync(join(dataDir, "storage"), { recursive: true, force: true });
  });

  it("ungated tools are pre-approved by exact name and never reach canUseTool's policy", async () => {
    const c = await chat({ ...ALLOW, fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny" });
    expect(c.options.allowedTools).toContain("mcp__callboard-tools__set_chat_title");
    expect(await c.ask("mcp__callboard-tools__set_chat_title", { title: "t" })).toMatchObject({ behavior: "allow" });
  });
});

describe("the policy is live during a new chat's first session", () => {
  it("a permission change written to the record after the rekey applies to the next call", async () => {
    const c = await chat(ALLOW);
    expect(await c.ask("mcp__callboard-tools__read_session_messages", { chatId: "x" })).toMatchObject({ behavior: "allow" });
    const record = chatFileService.getChatBySessionId(c.sessionId);
    expect(record).toBeTruthy();
    chatFileService.updateChatMetadata(record!.id, { defaultPermissions: { ...ALLOW, fileRead: "deny" } });
    expect(await c.ask("mcp__callboard-tools__read_session_messages", { chatId: "x" })).toMatchObject({ behavior: "deny" });
    expect(resultJson(await c.tool("callboard-tools", "read_session_messages")({ chatId: "x" }))).toMatchObject({ error: "permission_policy" });
  });
});
