/**
 * Unit tests for the Claude-shaped → OpenRouter options translation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "@wolpertingerlabs/openrouter-agent-harness";
import { extractPluginDirs, translateOptions, type OpenRouterOptionsExtras } from "./optionsAdapter.js";

const defaultExtras: OpenRouterOptionsExtras = { apiKey: "sk-or-test" };

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

  it("leaves serverTools unset so the harness injects its DEFAULT_SERVER_TOOLS", () => {
    const { orOpts } = translateOptions({ openRouter: { apiKey: "sk-or-test" } }, "hi");
    expect(orOpts.serverTools).toBeUndefined();
  });

  it("forwards configured serverTools (including an empty array to disable all)", () => {
    const tools = [{ type: "openrouter:web_search", parameters: { max_results: 5 } }];
    const { orOpts } = translateOptions({ openRouter: { apiKey: "sk-or-test", serverTools: tools } }, "hi");
    expect(orOpts.serverTools).toEqual(tools);

    const { orOpts: empty } = translateOptions({ openRouter: { apiKey: "sk-or-test", serverTools: [] } }, "hi");
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
