/**
 * Unit tests for the Claude-shaped → OpenRouter options translation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "@wolpertingerlabs/openrouter-agent-harness";
import { extractPluginDirs, translateOptions, type OpenRouterOptionsExtras } from "./optionsAdapter.js";
import { resolveSessionModel } from "../../../services/agent-settings.js";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";

/** Permissive policy — the shape most chats run under (6676 of 6778 in production). */
const allowAll: DefaultPermissions = {
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess: "allow",
};

const withWebAccess = (webAccess: PermissionLevel): DefaultPermissions => ({ ...allowAll, webAccess });

const defaultExtras: OpenRouterOptionsExtras = { apiKey: "sk-or-test", getPermissions: () => allowAll };

describe("translateOptions — required config", () => {
  it("throws when openRouter.apiKey is missing", () => {
    expect(() => translateOptions({}, "hi")).toThrow(/apiKey/);
    expect(() => translateOptions({ openRouter: { apiKey: "" } as unknown as OpenRouterOptionsExtras }, "hi")).toThrow();
  });

  it("returns required fields with sensible defaults", () => {
    const { orOpts, cwd } = translateOptions({ openRouter: defaultExtras }, "do thing");
    expect(orOpts.apiKey).toBe("sk-or-test");
    expect(orOpts.prompt).toBe("do thing");
    expect(orOpts.sessionId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(orOpts.appTitle).toBe("callboard");
    expect(orOpts.settingSources).toEqual(["user", "project", "local"]);
    expect(cwd).toBe(process.cwd());
  });
});

describe("translateOptions — sessionId resolution", () => {
  it("uses options.resume when provided (session resume)", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras, resume: "fixed-session-id" }, "hi");
    expect(orOpts.sessionId).toBe("fixed-session-id");
  });

  it("generates a fresh UUID when resume is absent", () => {
    const a = translateOptions({ openRouter: defaultExtras }, "hi").orOpts.sessionId;
    const b = translateOptions({ openRouter: defaultExtras }, "hi").orOpts.sessionId;
    expect(a).not.toBe(b);
  });
});

describe("translateOptions — systemPrompt resolution", () => {
  it("passes a plain string through verbatim", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, systemPrompt: "You are X." },
      "hi",
    );
    expect(orOpts.instructions).toBe("You are X.");
  });

  it("composes DEFAULT_INSTRUCTIONS + append for { preset, append }", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, systemPrompt: { type: "preset", preset: "claude_code", append: "extra" } },
      "hi",
    );
    expect(orOpts.instructions).toBe(`${DEFAULT_INSTRUCTIONS}\n\nextra`);
  });

  it("omits instructions entirely when preset has no append", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, systemPrompt: { type: "preset", preset: "claude_code" } },
      "hi",
    );
    expect(orOpts.instructions).toBeUndefined();
  });
});

describe("translateOptions — OR config passthrough", () => {
  it("threads baseUrl, model, logsRoot, appTitle into OR opts", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          baseUrl: "https://example.com",
          model: "google/gemini-2.0-flash",
          logsRoot: "/tmp/or-logs",
          appTitle: "custom-app",
        },
      },
      "hi",
    );
    expect(orOpts.baseUrl).toBe("https://example.com");
    expect(orOpts.model).toBe("google/gemini-2.0-flash");
    expect(orOpts.logsRoot).toBe("/tmp/or-logs");
    expect(orOpts.appTitle).toBe("custom-app");
  });

  it("forwards effort onto orOpts.effort when set", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          effort: "medium",
        },
      },
      "hi",
    );
    expect(orOpts.effort).toBe("medium");
  });

  it("omits effort entirely when unset (preserves model default behavior)", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test" },
      },
      "hi",
    );
    expect(orOpts.effort).toBeUndefined();
  });

  it("always sets cacheControl to ephemeral (auto prompt caching for Anthropic; no-op elsewhere)", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test" },
      },
      "hi",
    );
    expect(orOpts.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("leaves serverTools unset so the harness injects its DEFAULT_SERVER_TOOLS when webAccess allows", () => {
    const { orOpts } = translateOptions({ openRouter: { apiKey: "sk-or-test", getPermissions: () => allowAll } }, "hi");
    expect(orOpts.serverTools).toBeUndefined();
  });

  it("forwards configured serverTools (including an empty array to disable all) when webAccess allows", () => {
    const tools = [{ type: "openrouter:web_search", parameters: { max_results: 5 } }];
    const { orOpts } = translateOptions(
      { openRouter: { apiKey: "sk-or-test", serverTools: tools, getPermissions: () => allowAll } },
      "hi",
    );
    expect(orOpts.serverTools).toEqual(tools);

    const { orOpts: empty } = translateOptions(
      { openRouter: { apiKey: "sk-or-test", serverTools: [], getPermissions: () => allowAll } },
      "hi",
    );
    expect(empty.serverTools).toEqual([]);
  });

  it("forwards maxBudgetUsd onto orOpts.maxBudgetUsd when set", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          maxBudgetUsd: 5.5,
        },
      },
      "hi",
    );
    expect(orOpts.maxBudgetUsd).toBe(5.5);
  });

  it("omits maxBudgetUsd when unset so the OR library falls back to its default", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test" },
      },
      "hi",
    );
    expect(orOpts.maxBudgetUsd).toBeUndefined();
  });

  it("rejects non-finite maxBudgetUsd values (NaN, Infinity) so a corrupt setting can't poison the run", () => {
    const { orOpts: withNaN } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test", maxBudgetUsd: Number.NaN },
      },
      "hi",
    );
    expect(withNaN.maxBudgetUsd).toBeUndefined();

    const { orOpts: withInf } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test", maxBudgetUsd: Number.POSITIVE_INFINITY },
      },
      "hi",
    );
    expect(withInf.maxBudgetUsd).toBeUndefined();
  });
});

describe("translateOptions — Claude option passthrough", () => {
  it("threads maxTurns, cwd, allowedTools/disallowedTools, canUseTool, onHook, signal", () => {
    const ac = new AbortController();
    const canUseTool = async () => ({ behavior: "allow" as const });
    const onHook = async () => undefined;

    const { orOpts, cwd } = translateOptions(
      {
        openRouter: defaultExtras,
        cwd: "/tmp/work",
        maxTurns: 7,
        allowedTools: ["read_file"],
        disallowedTools: ["bash"],
        canUseTool,
        onHook,
        abortController: ac,
      },
      "hi",
    );
    expect(cwd).toBe("/tmp/work");
    expect(orOpts.cwd).toBe("/tmp/work");
    expect(orOpts.maxTurns).toBe(7);
    expect(orOpts.allowedTools).toEqual(["read_file"]);
    expect(orOpts.disallowedTools).toEqual(["bash"]);
    expect(orOpts.canUseTool).toBe(canUseTool);
    expect(orOpts.onHook).toBe(onHook);
    expect(orOpts.signal).toBe(ac.signal);
  });

  it("forwards stderr-level warnings through OR's logger", () => {
    const captured: string[] = [];
    const stderr = (msg: string) => captured.push(msg);
    const { orOpts } = translateOptions({ openRouter: defaultExtras, stderr }, "hi");
    expect(orOpts.logger).toBeDefined();
    orOpts.logger!("debug", "low");
    orOpts.logger!("info", "info");
    orOpts.logger!("warn", "warn msg");
    orOpts.logger!("error", "error msg");
    expect(captured).toEqual(["warn msg", "error msg"]);
  });

  it("appends the harness logger's structured fields to forwarded messages", () => {
    // The harness reports failures as a bare label + fields, e.g.
    // ('error', 'OpenRouterAgentRun stream errored', { message }) — dropping
    // the third argument would forward a log line with no error in it.
    const captured: string[] = [];
    const stderr = (msg: string) => captured.push(msg);
    const { orOpts } = translateOptions({ openRouter: defaultExtras, stderr }, "hi");
    orOpts.logger!("error", "OpenRouterAgentRun stream errored", {
      message: "server_error: Internal Server Error",
      detail: { responseId: "resp_abc" },
    });
    orOpts.logger!("warn", "no fields warn");
    orOpts.logger!("warn", "empty fields warn", {});
    expect(captured).toEqual([
      'OpenRouterAgentRun stream errored {"message":"server_error: Internal Server Error","detail":{"responseId":"resp_abc"}}',
      "no fields warn",
      "empty fields warn",
    ]);
  });

  it("drops empty allowedTools/disallowedTools arrays", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, allowedTools: [], disallowedTools: [] },
      "hi",
    );
    expect(orOpts.allowedTools).toBeUndefined();
    expect(orOpts.disallowedTools).toBeUndefined();
  });

  it("forwards persistSession: false so ephemeral calls write no session record", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, persistSession: false },
      "hi",
    );
    expect(orOpts.persistSession).toBe(false);
  });

  it("forwards persistSession: true explicitly", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, persistSession: true },
      "hi",
    );
    expect(orOpts.persistSession).toBe(true);
  });

  it("leaves persistSession undefined when not specified (OR library default applies)", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, "hi");
    expect(orOpts.persistSession).toBeUndefined();
  });
});

describe("translateOptions — env is deliberately not forwarded", () => {
  it("never populates skillEnv from opts.env (claude.ts env carries process.env + API keys; generic ${VAR} skill substitution would render secrets into prompts)", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, env: { OPENROUTER_API_KEY: "sk-secret", HOME: "/home/u" } },
      "hi",
    );
    expect(orOpts.skillEnv).toBeUndefined();
  });

  it("leaves skillEnv undefined when no env is supplied", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, "hi");
    expect(orOpts.skillEnv).toBeUndefined();
  });
});

describe("translateOptions — MCP server translation", () => {
  const inProcessServer = { tools: [{ type: "function", function: { name: "fake_tool" } }] };

  it("splices in-process .tools bundles into orOpts.tools (unchanged behavior)", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, mcpServers: { "callboard-tools": inProcessServer } },
      "hi",
    );
    // Default OR client tools + the bundled tool; never a bridge config.
    expect(orOpts.tools?.some((t) => (t as { function?: { name?: string } }).function?.name === "fake_tool")).toBe(true);
    expect(orOpts.mcpServers).toBeUndefined();
  });

  it("translates Claude stdio configs into harness bridge entries with args/env passthrough", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: defaultExtras,
        mcpServers: {
          drawlatch: { command: "npx", args: ["-y", "drawlatch"], env: { MCP_KEY_ALIAS: "default" } },
        },
      },
      "hi",
    );
    expect(orOpts.mcpServers).toEqual([
      {
        transport: "stdio",
        name: "drawlatch",
        command: "npx",
        args: ["-y", "drawlatch"],
        env: { MCP_KEY_ALIAS: "default" },
        source: "callboard:options",
      },
    ]);
  });

  it("omits args/env on stdio entries when the source config has none", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, mcpServers: { bare: { command: "/usr/bin/server" } } },
      "hi",
    );
    expect(orOpts.mcpServers).toEqual([
      { transport: "stdio", name: "bare", command: "/usr/bin/server", source: "callboard:options" },
    ]);
  });

  it("translates http configs with headers passthrough", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: defaultExtras,
        mcpServers: {
          remote: { type: "http", url: "https://mcp.example.com/rpc", headers: { Authorization: "Bearer t" } },
        },
      },
      "hi",
    );
    expect(orOpts.mcpServers).toEqual([
      {
        transport: "http",
        name: "remote",
        url: "https://mcp.example.com/rpc",
        headers: { Authorization: "Bearer t" },
        source: "callboard:options",
      },
    ]);
  });

  it("maps sse configs onto the http transport (harness bridge handles SSE fallback)", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, mcpServers: { legacy: { type: "sse", url: "https://sse.example.com" } } },
      "hi",
    );
    expect(orOpts.mcpServers).toEqual([
      { transport: "http", name: "legacy", url: "https://sse.example.com", source: "callboard:options" },
    ]);
  });

  it("mixes in-process and external servers without cross-contamination", () => {
    const stderrLines: string[] = [];
    const { orOpts } = translateOptions(
      {
        openRouter: defaultExtras,
        stderr: (msg: string) => stderrLines.push(msg),
        mcpServers: {
          "callboard-tools": inProcessServer,
          external: { command: "node", args: ["server.js"] },
        },
      },
      "hi",
    );
    expect(orOpts.tools?.some((t) => (t as { function?: { name?: string } }).function?.name === "fake_tool")).toBe(true);
    expect(orOpts.mcpServers).toHaveLength(1);
    expect(orOpts.mcpServers?.[0]).toMatchObject({ transport: "stdio", name: "external" });
    expect(stderrLines.join("\n")).toContain("wired external MCP servers: external(stdio)");
  });

  it("still warns (and drops) genuinely untranslatable server shapes", () => {
    const stderrLines: string[] = [];
    const { orOpts } = translateOptions(
      {
        openRouter: defaultExtras,
        stderr: (msg: string) => stderrLines.push(msg),
        mcpServers: { mystery: { type: "websocket", address: "wss://x" } as never },
      },
      "hi",
    );
    expect(orOpts.mcpServers).toBeUndefined();
    expect(stderrLines.join("\n")).toContain("unrecognized config shape: mystery");
  });
});

describe("translateOptions — bareToolset (quick-completion utility runs)", () => {
  const inProcessServer = { tools: [{ type: "function", function: { name: "return_result" } }] };
  const toolNames = (orOpts: { tools?: readonly unknown[] }) =>
    (orOpts.tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name);

  it("exposes ONLY the supplied in-process tools — no default client toolset", () => {
    const { orOpts } = translateOptions(
      { openRouter: { apiKey: "sk-or-test", bareToolset: true }, mcpServers: { qc: inProcessServer } },
      "hi",
    );
    // This is the capture fix: with bareToolset, the model sees just
    // return_result, so it answers instead of going off to read/write/bash.
    expect(toolNames(orOpts)).toEqual(["return_result"]);
    expect(toolNames(orOpts)).not.toContain("read_file");
    expect(toolNames(orOpts)).not.toContain("bash");
    expect(toolNames(orOpts)).not.toContain("write_file");
  });

  it("disables OR server tools for a bare-toolset run", () => {
    const { orOpts } = translateOptions(
      { openRouter: { apiKey: "sk-or-test", bareToolset: true }, mcpServers: { qc: inProcessServer } },
      "hi",
    );
    expect(orOpts.serverTools).toEqual([]);
  });

  it("pins an explicit empty tools array (text-only) when bareToolset is set with no in-process tools", () => {
    const { orOpts } = translateOptions({ openRouter: { apiKey: "sk-or-test", bareToolset: true } }, "hi");
    // An explicit [] flips the harness's hasCustomTools so it does NOT fall back
    // to its full default bundle — a true zero-tool, text-only completion.
    expect(orOpts.tools).toEqual([]);
    expect(orOpts.serverTools).toEqual([]);
  });

  it("still injects the default client toolset when bareToolset is NOT set (real chats)", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, mcpServers: { qc: inProcessServer } },
      "hi",
    );
    expect(toolNames(orOpts)).toContain("return_result");
    // The bundled tool sits alongside OR's default client tools — more than one.
    expect((orOpts.tools ?? []).length).toBeGreaterThan(1);
  });
});

describe("extractPluginDirs — plugin descriptor → loadPlugins dirs", () => {
  it("returns [] when no plugins are present", () => {
    expect(extractPluginDirs({})).toEqual([]);
    expect(extractPluginDirs({ plugins: undefined })).toEqual([]);
    expect(extractPluginDirs({ plugins: [] })).toEqual([]);
  });

  it("pulls .path from local plugin descriptors (the Claude-shaped form)", () => {
    const dirs = extractPluginDirs({
      plugins: [
        { type: "local", path: "/abs/plugin-a", name: "a" },
        { type: "local", path: "/abs/plugin-b", name: "b" },
      ],
    });
    expect(dirs).toEqual(["/abs/plugin-a", "/abs/plugin-b"]);
  });

  it("treats a missing type as local (path is enough)", () => {
    expect(extractPluginDirs({ plugins: [{ path: "/abs/p", name: "p" }] })).toEqual(["/abs/p"]);
  });

  it("skips descriptors with no usable path or a non-local source type", () => {
    const dirs = extractPluginDirs({
      plugins: [
        { type: "local", path: "/abs/keep", name: "keep" },
        { type: "local", name: "no-path" },
        { type: "remote", path: "/abs/remote", name: "remote" },
        { type: "local", path: "", name: "empty" },
      ],
    });
    expect(dirs).toEqual(["/abs/keep"]);
  });
});

describe("translateOptions — prompt translation", () => {
  it("passes a string prompt through unchanged", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, "hello");
    expect(orOpts.prompt).toBe("hello");
  });

  it("translates AsyncIterable<{type:'user', message:{content}}> → OR UserInput stream", async () => {
    async function* claudePrompt() {
      yield { type: "user", message: { role: "user", content: "first" } };
      yield { type: "user", message: { role: "user", content: "second" } };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, claudePrompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{ content: string }>) {
      items.push(item);
    }
    expect(items).toEqual([{ content: "first" }, { content: "second" }]);
  });

  it("skips non-user-message items in the prompt iterable", async () => {
    async function* mixed() {
      yield { type: "user", message: { role: "user", content: "ok" } };
      yield { type: "assistant", message: { role: "assistant", content: "hi" } };
      yield "garbage";
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, mixed());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{ content: string }>) {
      items.push(item);
    }
    expect(items).toEqual([{ content: "ok" }]);
  });

  it("collapses text-only ContentBlock[] into a single string", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    expect(items).toEqual([{ content: "line one\nline two" }]);
  });

  it("forwards base64 image blocks as OR input_image with data: URI", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    expect(items).toEqual([
      {
        content: [
          { type: "input_text", text: "describe this" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("forwards url image blocks as OR input_image with the URL passed through", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://x/y.png" } },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    expect(items).toEqual([
      {
        content: [{ type: "input_image", image_url: "https://x/y.png" }],
      },
    ]);
  });

  it("falls back to a text placeholder for image blocks with an unrecognized source", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "weird", media_type: "image/heic" } },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    // No image survived, so this collapses back to a plain string.
    expect(items).toEqual([{ content: "hi\n[image:image/heic]" }]);
  });
});

describe("translateOptions — webAccess gating of OpenRouter server tools", () => {
  const typesOf = (tools: readonly { type: string }[] | undefined) => tools?.map((t) => t.type);

  const translate = (webAccess: PermissionLevel, serverTools?: OpenRouterOptionsExtras["serverTools"]) =>
    translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          ...(serverTools && { serverTools }),
          getPermissions: () => withWebAccess(webAccess),
        },
      },
      "hi",
    ).orOpts;

  // ── The default path: config undefined. This is the case that is live today
  // and the one a fix is most likely to miss, because `undefined` reads like
  // "nothing to filter" when it actually means "let the harness inject its
  // DEFAULT_SERVER_TOOLS" — web_search and web_fetch included.
  it.each(["deny", "ask"] as const)(
    "strips web_search/web_fetch from the DEFAULT (unconfigured) set under webAccess=%s",
    (webAccess) => {
      const orOpts = translate(webAccess);
      // An explicit array, NOT undefined: leaving it unset would hand the
      // harness's own defaults straight through and re-open the hole.
      expect(orOpts.serverTools).toBeDefined();
      expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:datetime"]);
    },
  );

  it("leaves the default set to the harness under webAccess=allow", () => {
    expect(translate("allow").serverTools).toBeUndefined();
  });

  // ── datetime survives every policy. It returns a clock reading and egresses
  // nothing the request did not already carry, so it is not on the webAccess
  // axis at all.
  it.each(["allow", "ask", "deny"] as const)("keeps datetime under webAccess=%s", (webAccess) => {
    const orOpts = translate(webAccess, [{ type: "openrouter:datetime" }]);
    expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:datetime"]);
  });

  // ── A configured set is INTERSECTED, never replaced. The user setting stays
  // authoritative for intent; the policy decides what they may have.
  it.each(["deny", "ask"] as const)(
    "intersects a configured set rather than replacing it under webAccess=%s",
    (webAccess) => {
      const orOpts = translate(webAccess, [
        { type: "openrouter:datetime" },
        { type: "openrouter:web_search", parameters: { max_results: 5 } },
        { type: "openrouter:web_fetch" },
      ]);
      expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:datetime"]);
    },
  );

  it("does not let a user setting re-enable web_search under webAccess=deny", () => {
    const orOpts = translate("deny", [{ type: "openrouter:web_search" }]);
    expect(orOpts.serverTools).toEqual([]);
  });

  it("preserves per-tool parameters on the tools that survive the gate", () => {
    const orOpts = translate("allow", [{ type: "openrouter:web_search", parameters: { max_results: 5 } }]);
    expect(orOpts.serverTools).toEqual([{ type: "openrouter:web_search", parameters: { max_results: 5 } }]);
  });

  // ── The nested-web-access tools. Each is documented as running its
  // panel/advisor/worker with openrouter:web_search available, so allowing one
  // under a restrictive policy would be a side door onto the same axis.
  it.each([
    ["openrouter:fusion"],
    ["openrouter:advisor"],
    ["openrouter:subagent"],
  ])("withholds %s under webAccess=deny (it can nest web_search)", (type) => {
    expect(translate("deny", [{ type }]).serverTools).toEqual([]);
  });

  it("keeps server tools that genuinely never reach the web under webAccess=deny", () => {
    const orOpts = translate("deny", [
      { type: "openrouter:image_generation" },
      { type: "openrouter:apply_patch" },
    ]);
    expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:image_generation", "openrouter:apply_patch"]);
  });

  // ── Fail-closed on the unknown. A tool OpenRouter ships after this catalog
  // was last updated must be withheld, not waved through.
  it("withholds an unknown/new server tool under a restrictive policy", () => {
    const orOpts = translate("deny", [
      { type: "openrouter:datetime" },
      { type: "openrouter:some_future_tool" },
    ]);
    expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:datetime"]);
  });

  // ── No policy at all is restrictive, matching decidePermission's collapse of
  // a missing policy to "ask". A caller that forgets to wire getPermissions
  // loses web search visibly instead of silently reopening the gap.
  it("treats an absent permission accessor as restrictive", () => {
    const { orOpts } = translateOptions({ openRouter: { apiKey: "sk-or-test" } }, "hi");
    expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:datetime"]);
  });

  it("treats a null permission policy as restrictive", () => {
    const { orOpts } = translateOptions(
      { openRouter: { apiKey: "sk-or-test", getPermissions: () => null } },
      "hi",
    );
    expect(typesOf(orOpts.serverTools)).toEqual(["openrouter:datetime"]);
  });

  // ── bareToolset still wins outright: [] is strictly narrower than anything
  // the gate could produce, so it skips the intersection rather than joining it.
  it.each(["allow", "ask", "deny"] as const)("bareToolset disables everything under webAccess=%s", (webAccess) => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          bareToolset: true,
          serverTools: [{ type: "openrouter:web_search" }],
          getPermissions: () => withWebAccess(webAccess),
        },
      },
      "hi",
    );
    expect(orOpts.serverTools).toEqual([]);
  });

  it("reports withheld tools through the stderr diagnostic channel", () => {
    const lines: string[] = [];
    translateOptions(
      {
        openRouter: { apiKey: "sk-or-test", getPermissions: () => withWebAccess("ask") },
        stderr: (d: string) => lines.push(d),
      },
      "hi",
    );
    const notice = lines.find((l) => l.includes("withheld"));
    expect(notice).toBeDefined();
    expect(notice).toContain("webAccess=ask");
    expect(notice).toContain("openrouter:web_search");
    expect(notice).toContain("openrouter:web_fetch");
  });

  it("says nothing when the policy withholds nothing", () => {
    const lines: string[] = [];
    translateOptions(
      {
        openRouter: { apiKey: "sk-or-test", getPermissions: () => allowAll },
        stderr: (d: string) => lines.push(d),
      },
      "hi",
    );
    expect(lines.find((l) => l.includes("withheld"))).toBeUndefined();
  });

  it("reads the policy at request-assembly time, not when the options blob was built", () => {
    // A mid-conversation tightening must apply to the next request. Holding the
    // accessor rather than a snapshot is what makes that true.
    let webAccess: PermissionLevel = "allow";
    const options = { openRouter: { apiKey: "sk-or-test", getPermissions: () => withWebAccess(webAccess) } };

    expect(translateOptions(options, "hi").orOpts.serverTools).toBeUndefined();
    webAccess = "deny";
    expect(typesOf(translateOptions(options, "hi").orOpts.serverTools)).toEqual(["openrouter:datetime"]);
  });
});

describe("translateOptions — webAccess gating of OpenRouter plugins", () => {
  /**
   * `modelParams.plugins` reaches OpenRouter by a different route than
   * `serverTools` — it rides `Partial<ResponsesRequest>` — so the server-tool
   * gate never saw it. Two catalog plugins are live web access, and a plugin is
   * the worse case of the two channels: it runs once per request whether the
   * model asked or not, so an ungated `web` plugin searches on every turn with
   * no model decision involved at all.
   */
  const translate = (webAccess: PermissionLevel, modelParams?: Record<string, unknown>) =>
    translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          ...(modelParams && { modelParams }),
          getPermissions: () => withWebAccess(webAccess),
        },
      },
      "hi",
    ).orOpts;

  const pluginIdsOf = (orOpts: { modelParams?: unknown }) => {
    const plugins = (orOpts.modelParams as { plugins?: { id: string }[] } | undefined)?.plugins;
    return plugins?.map((p) => p.id);
  };

  // ── The headline: the two web-carrying plugins.
  it.each(["deny", "ask"] as const)("withholds the web plugin under webAccess=%s", (webAccess) => {
    const orOpts = translate(webAccess, { plugins: [{ id: "web", maxResults: 5 }] });
    // The key is dropped entirely, not sent empty — that is what
    // `resolveModelParams` emits for a profile with no plugins.
    expect(pluginIdsOf(orOpts)).toBeUndefined();
  });

  it.each(["deny", "ask"] as const)("withholds the fusion plugin under webAccess=%s", (webAccess) => {
    const orOpts = translate(webAccess, { plugins: [{ id: "fusion", maxToolCalls: 8 }] });
    expect(pluginIdsOf(orOpts)).toBeUndefined();
  });

  it("injects web and fusion under webAccess=allow, params intact", () => {
    const plugins = [{ id: "web", maxResults: 5 }, { id: "fusion", maxToolCalls: 8 }];
    const orOpts = translate("allow", { plugins });
    expect(orOpts.modelParams).toEqual({ plugins });
  });

  // ── A plugin that reaches nothing survives every policy.
  it.each(["allow", "ask", "deny"] as const)(
    "keeps a non-web plugin under webAccess=%s",
    (webAccess) => {
      const orOpts = translate(webAccess, { plugins: [{ id: "response-healing" }] });
      expect(pluginIdsOf(orOpts)).toEqual(["response-healing"]);
    },
  );

  // ── Intersected, never replaced. The user's setting stays authoritative for
  // intent; the policy decides what they may have.
  it.each(["deny", "ask"] as const)(
    "intersects a configured plugin set rather than replacing it under webAccess=%s",
    (webAccess) => {
      const orOpts = translate(webAccess, {
        plugins: [
          { id: "web" },
          { id: "response-healing" },
          { id: "fusion" },
          { id: "context-compression" },
        ],
      });
      expect(pluginIdsOf(orOpts)).toEqual(["response-healing", "context-compression"]);
    },
  );

  it("does not let a user setting re-enable the web plugin under webAccess=deny", () => {
    expect(pluginIdsOf(translate("deny", { plugins: [{ id: "web" }] }))).toBeUndefined();
  });

  // ── Fail closed on the unknown: a plugin OpenRouter ships after this catalog
  // was last updated is withheld, not waved through.
  it("withholds an unknown/new plugin under a restrictive policy", () => {
    const orOpts = translate("deny", {
      plugins: [{ id: "response-healing" }, { id: "some-future-plugin" }],
    });
    expect(pluginIdsOf(orOpts)).toEqual(["response-healing"]);
  });

  // ── Absent/null policy is restrictive, matching decidePermission's collapse
  // of a missing policy to "ask".
  it("treats an absent permission accessor as restrictive", () => {
    const { orOpts } = translateOptions(
      { openRouter: { apiKey: "sk-or-test", modelParams: { plugins: [{ id: "web" }] } } },
      "hi",
    );
    expect(pluginIdsOf(orOpts)).toBeUndefined();
  });

  it("treats a null permission policy as restrictive", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          modelParams: { plugins: [{ id: "web" }] },
          getPermissions: () => null,
        },
      },
      "hi",
    );
    expect(pluginIdsOf(orOpts)).toBeUndefined();
  });

  // ── Sampling knobs are generation parameters, not a channel to anything. The
  // gate must not touch them, and must not lose them when it strips a plugin.
  it("leaves sampling params untouched while withholding a web plugin", () => {
    const orOpts = translate("deny", { temperature: 0.7, topP: 0.9, plugins: [{ id: "web" }] });
    expect(orOpts.modelParams).toEqual({ temperature: 0.7, topP: 0.9 });
  });

  it.each(["allow", "ask", "deny"] as const)(
    "forwards a plugin-free params bag verbatim under webAccess=%s",
    (webAccess) => {
      const orOpts = translate(webAccess, { temperature: 0.7, seed: 42 });
      expect(orOpts.modelParams).toEqual({ temperature: 0.7, seed: 42 });
    },
  );

  it("omits modelParams entirely when the withheld plugin was all it carried", () => {
    // Sending `{}` would be harmless but dishonest — it is not what a profile
    // with nothing in it produces.
    expect(translate("deny", { plugins: [{ id: "web" }] }).modelParams).toBeUndefined();
  });

  it("does not mutate the caller's modelParams object", () => {
    // claude.ts hands over the resolved settings profile; the gate reassembles
    // rather than deleting keys out of it.
    const modelParams = { temperature: 0.7, plugins: [{ id: "web" }] };
    translate("deny", modelParams);
    expect(modelParams).toEqual({ temperature: 0.7, plugins: [{ id: "web" }] });
  });

  it("drops a malformed non-array plugins value instead of forwarding it", () => {
    // Only reachable via a hand-edited settings file. The SDK's Zod schema would
    // reject it anyway; dropping it keeps the failure legible.
    const orOpts = translate("allow", { temperature: 0.7, plugins: "web" });
    expect(orOpts.modelParams).toEqual({ temperature: 0.7 });
  });

  // ── Diagnostics: a user who set "ask" and finds web search missing must be
  // able to see which axis took it and what to set instead.
  it("reports withheld plugins through the stderr diagnostic channel", () => {
    const lines: string[] = [];
    translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          modelParams: { plugins: [{ id: "web" }, { id: "fusion" }] },
          getPermissions: () => withWebAccess("ask"),
        },
        stderr: (d: string) => lines.push(d),
      },
      "hi",
    );
    const notice = lines.find((l) => l.includes("plugin(s)"));
    expect(notice).toBeDefined();
    expect(notice).toContain("webAccess=ask");
    expect(notice).toContain("web");
    expect(notice).toContain("fusion");
  });

  it("says nothing when the policy withholds no plugin", () => {
    const lines: string[] = [];
    translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          modelParams: { plugins: [{ id: "response-healing" }] },
          getPermissions: () => allowAll,
        },
        stderr: (d: string) => lines.push(d),
      },
      "hi",
    );
    expect(lines.find((l) => l.includes("withheld"))).toBeUndefined();
  });

  it("reads the policy at request-assembly time, not when the options blob was built", () => {
    let webAccess: PermissionLevel = "allow";
    const options = {
      openRouter: {
        apiKey: "sk-or-test",
        modelParams: { plugins: [{ id: "web" }] },
        getPermissions: () => withWebAccess(webAccess),
      },
    };
    expect(pluginIdsOf(translateOptions(options, "hi").orOpts)).toEqual(["web"]);
    webAccess = "deny";
    expect(pluginIdsOf(translateOptions(options, "hi").orOpts)).toBeUndefined();
  });
});

describe("translateOptions — webAccess gating of the :online model-slug variant", () => {
  /**
   * The third route onto the same axis, and the one neither other gate could
   * see: it rides the model string rather than `serverTools` or `modelParams`.
   * OpenRouter calls `:online` "a shortcut for using the `web` plugin … exactly
   * equivalent to" sending it, so an ungated `<model>:online` is precisely what
   * the plugin gate exists to withhold, spelled differently.
   */
  const translate = (webAccess: PermissionLevel | null, model?: string, stderr?: (d: string) => void) =>
    translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          ...(model !== undefined && { model }),
          // `null` here stands for a caller that wires no accessor at all.
          ...(webAccess !== null && { getPermissions: () => withWebAccess(webAccess) }),
        },
        ...(stderr && { stderr }),
      },
      "hi",
    ).orOpts;

  // ── The headline.
  it.each(["deny", "ask"] as const)("strips :online under webAccess=%s", (webAccess) => {
    expect(translate(webAccess, "anthropic/claude-sonnet-4:online").model).toBe("anthropic/claude-sonnet-4");
  });

  it("preserves :online under webAccess=allow", () => {
    expect(translate("allow", "anthropic/claude-sonnet-4:online").model).toBe(
      "anthropic/claude-sonnet-4:online",
    );
  });

  it("treats an absent permission accessor as restrictive", () => {
    // Same collapse as the other two gates: a caller that forgets to wire
    // `getPermissions` loses web access visibly rather than reopening the hole.
    expect(translate(null, "anthropic/claude-sonnet-4:online").model).toBe("anthropic/claude-sonnet-4");
  });

  // ── The regression that would quietly cost money. Every other variant is
  // routing, pricing or model identity — never web access.
  it.each(["allow", "ask", "deny"] as const)(
    "never touches :free/:extended/:thinking/:nitro/:floor/:exacto under webAccess=%s",
    (webAccess) => {
      for (const suffix of ["free", "extended", "thinking", "nitro", "floor", "exacto"]) {
        const slug = `openai/gpt-oss-20b:${suffix}`;
        expect(translate(webAccess, slug).model).toBe(slug);
      }
    },
  );

  it("removes only :online from a chained slug, leaving the paid/free choice alone", () => {
    // OpenRouter's own chaining example is `openai/gpt-oss-20b:free:online`.
    // Dropping `:free` along with `:online` would silently move the run onto the
    // PAID copy of the model.
    expect(translate("deny", "openai/gpt-oss-20b:free:online").model).toBe("openai/gpt-oss-20b:free");
  });

  it.each(["x/y:ONLINE", "x/y:Online", "x/y: online "])(
    "matches the variant regardless of case or padding (%s)",
    (slug) => {
      expect(translate("deny", slug).model).toBe("x/y");
    },
  );

  it("forwards a variant it does not recognize rather than rewriting the slug", () => {
    // The deliberate divergence from the sibling gates' fail-closed default:
    // the action here is a rewrite of the model id, so an uncatalogued variant
    // is reported (see the log assertions below), never removed.
    expect(translate("deny", "x/y:someFutureVariant").model).toBe("x/y:someFutureVariant");
  });

  it("leaves a plain slug untouched under every policy", () => {
    for (const webAccess of ["allow", "ask", "deny"] as const) {
      expect(translate(webAccess, "anthropic/claude-sonnet-4").model).toBe("anthropic/claude-sonnet-4");
    }
  });

  it("omits the model entirely when the slug was nothing but :online", () => {
    // Degenerate, but it must not send `model: ""`.
    expect(translate("deny", ":online").model).toBeUndefined();
  });

  // ── Surfacing. A stripped suffix that nobody is told about is
  // indistinguishable from a model that simply chose not to search.
  it("names both slugs and the policy on stderr when it strips", () => {
    const lines: string[] = [];
    translate("deny", "anthropic/claude-sonnet-4:online", (d) => lines.push(d));
    const line = lines.find((l) => l.includes("stripped"));
    expect(line).toBeDefined();
    expect(line).toContain(":online");
    expect(line).toContain("anthropic/claude-sonnet-4:online");
    expect(line).toContain("webAccess=deny");
    // Says what to change, like the server-tool and plugin lines do.
    expect(line).toContain('Set webAccess to "allow"');
  });

  it("says nothing when there was nothing to strip", () => {
    const lines: string[] = [];
    translate("deny", "openai/gpt-oss-20b:free", (d) => lines.push(d));
    expect(lines.find((l) => l.includes("stripped"))).toBeUndefined();
    translate("allow", "anthropic/claude-sonnet-4:online", (d) => lines.push(d));
    expect(lines.find((l) => l.includes("stripped"))).toBeUndefined();
  });

  it("reads the policy at request-assembly time, not when the options blob was built", () => {
    // Same live-accessor contract as the other two gates: tightening webAccess
    // mid-conversation takes effect on the next message.
    let webAccess: PermissionLevel = "allow";
    const options = {
      openRouter: {
        apiKey: "sk-or-test",
        model: "anthropic/claude-sonnet-4:online",
        getPermissions: () => withWebAccess(webAccess),
      },
    };
    expect(translateOptions(options, "hi").orOpts.model).toBe("anthropic/claude-sonnet-4:online");
    webAccess = "deny";
    expect(translateOptions(options, "hi").orOpts.model).toBe("anthropic/claude-sonnet-4");
  });

  // ── Provenance is irrelevant to the gate, which is the point: models arrive
  // programmatically (agents via start_chat_session, job steps, routed chats,
  // alias targets), so the caller that wrote `:online` is frequently not the
  // person who set the policy.
  it("gates an alias-resolved slug identically to a typed one", () => {
    // claude.ts resolves cross-harness aliases BEFORE handing the slug over
    // (`resolveSessionModel` → `openRouter.model`), so what arrives here is
    // already a real slug — which is exactly why the gate sits after resolution.
    // This is the value an alias whose openrouter target is `…:online` produces.
    const fromAlias = resolveSessionModel("fast-web", undefined, "openrouter", {
      modelAliases: [{ name: "fast-web", targets: { openrouter: "anthropic/claude-sonnet-4:online" } }],
    } as unknown as Parameters<typeof resolveSessionModel>[3]);
    expect(fromAlias).toBe("anthropic/claude-sonnet-4:online");
    expect(translate("deny", fromAlias).model).toBe("anthropic/claude-sonnet-4");
  });

  it("gates a model pinned by a job step or start_chat_session identically", () => {
    // Both land in chat metadata and reach the adapter through the same field;
    // there is no per-origin branch, and there must not be one.
    expect(translate("deny", "perplexity/sonar:online").model).toBe("perplexity/sonar");
  });
});
